//! `POST /api/tool`: one stateless tool call, with no LLM and no LLM key.
//!
//! This is the server half of "bring your own key". The browser runs the model loop
//! with the user's own key and calls this endpoint for the things only the server can
//! do: search the legal corpus, read a section or judgment, and run the Tavily web
//! search (whose key stays here). Nothing is remembered between calls: the research
//! agents' retrieved-section accumulator lives in the client, which gets the sections
//! back in every response and sends them to the cite step.
//!
//! The tool code is the same code the server-side chat loop runs, so behaviour is
//! identical for both paths.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    Extension, Json,
    body::Bytes,
    extract::{ConnectInfo, State, rejection::BytesRejection},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};
use tracing::warn;

use crate::AppState;
use crate::limits::{self, Reject, ToolPermit};
use crate::session::SessionId;
use crate::models::schemas::{LegislationCitation, SseEvent};
use crate::routers::chat::{
    build_cite_by_reference_result, build_judgment_findings_result, error_response, execute_search_tool,
    execute_sub_agent_tool, execute_tool_inner, merge_retrieved_section, run_isolated,
};
use crate::services::qdrant_store::ScoredSection;

/// Request body cap. Tool arguments are a query or a few identifiers.
pub const BODY_LIMIT: usize = 64 * 1024;
/// Serialized size cap for `args`.
const MAX_ARGS_BYTES: usize = 16 * 1024;
/// A single tool call never runs longer than this, whatever the upstreams do.
const CALL_TIMEOUT: Duration = Duration::from_secs(60);

/// Where a tool call comes from. This picks the collection searched and which tools are
/// allowed, so a client cannot reach a tool the matching server-side agent would not have.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Context {
    /// The top-level assistant.
    #[default]
    Orchestrator,
    /// Research sub-agents, each confined to one collection.
    ResearchLegislation,
    ResearchSubsidiary,
    ResearchJudiciary,
    /// The self-help agents.
    AgentLegislation,
    AgentJudiciary,
}

impl Context {
    fn label(self) -> &'static str {
        match self {
            Context::Orchestrator => "orchestrator",
            Context::ResearchLegislation => "research_legislation",
            Context::ResearchSubsidiary => "research_subsidiary",
            Context::ResearchJudiciary => "research_judiciary",
            Context::AgentLegislation => "agent_legislation",
            Context::AgentJudiciary => "agent_judiciary",
        }
    }

    fn allows(self, tool: &str) -> bool {
        let tools: &[&str] = match self {
            Context::Orchestrator => {
                &["get_section", "get_judgment", "search_legislation", "search_judiciary", "web_search_tavily"]
            }
            Context::ResearchLegislation | Context::ResearchSubsidiary | Context::AgentLegislation => {
                &["search_legislation", "get_section"]
            }
            Context::ResearchJudiciary => &["search_judiciary", "get_judgment"],
            Context::AgentJudiciary => &["search_judiciary"],
        };
        tools.contains(&tool)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ToolRequest {
    tool: String,
    #[serde(default)]
    args: Value,
    #[serde(default)]
    context: Context,
}

fn bad_request(message: &str) -> Response {
    error_response(Reject {
        status: StatusCode::BAD_REQUEST,
        code: "invalid_request",
        message: message.into(),
        retry_after: None,
    })
}

/// `args` must be a small JSON object. Returns a message for the client when it is not.
fn check_args(args: &Value) -> Result<(), &'static str> {
    if !args.is_object() {
        return Err("`args` must be an object.");
    }
    if serde_json::to_vec(args).map_or(usize::MAX, |v| v.len()) > MAX_ARGS_BYTES {
        return Err("`args` is too large.");
    }
    Ok(())
}

/// A request is refused up front while the server is shutting down.
fn draining() -> Option<Response> {
    crate::routers::health::DRAINING.load(std::sync::atomic::Ordering::Relaxed).then(|| {
        error_response(Reject {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "draining",
            message: "Server is restarting. Please retry in a moment.".into(),
            retry_after: Some(5),
        })
    })
}

fn too_large() -> Response {
    error_response(Reject {
        status: StatusCode::PAYLOAD_TOO_LARGE,
        code: "body_too_large",
        message: "That request is too large.".into(),
        retry_after: None,
    })
}

/// Admission is checked after validation so a malformed request never spends rate-limit tokens.
fn admit(
    state: &AppState,
    peer: SocketAddr,
    headers: &HeaderMap,
    session: &Option<Extension<SessionId>>,
    tool: &str,
) -> Result<ToolPermit, Response> {
    let ip = limits::client_ip(headers, peer, state.guard.limits.trust_proxy);
    let sid = session.as_ref().map(|Extension(s)| s.0.as_str());
    state.guard.tools.admit_session(ip, sid, tool).map_err(error_response)
}

enum Failure {
    Failed(String),
    TimedOut,
}

/// Run one call on its own task, holding `permit` until the work is done, and give up after
/// `CALL_TIMEOUT`. Dropping the caller (client disconnect) cancels the task and frees the permit.
async fn run_with_permit<T: Send + 'static>(
    permit: ToolPermit,
    work: impl std::future::Future<Output = Result<T, String>> + Send + 'static,
) -> Result<T, Failure> {
    let run = run_isolated(async move {
        let out = work.await;
        drop(permit);
        out
    });
    match tokio::time::timeout(CALL_TIMEOUT, run).await {
        Ok(Ok(Ok(v))) => Ok(v),
        Ok(Ok(Err(e))) => Err(Failure::Failed(e)),
        Ok(Err(e)) => Err(Failure::Failed(format!("task ended abnormally: {e}"))),
        Err(_) => Err(Failure::TimedOut),
    }
}

/// Failures are logged here and replaced by a fixed message: internal errors can name hosts
/// and collections, and the model only needs to know the call failed.
fn failure_json(f: Failure, extra: Value) -> Response {
    let message = match f {
        Failure::Failed(e) => {
            warn!("call failed: {e}");
            "[ERROR] This search is unavailable right now."
        }
        Failure::TimedOut => {
            warn!("call timed out");
            "[ERROR] The search took too long. Try a narrower query."
        }
    };
    let mut v = json!({ "result": message, "is_error": true });
    if let (Some(o), Some(e)) = (v.as_object_mut(), extra.as_object()) {
        o.extend(e.clone());
    }
    Json(v).into_response()
}

pub async fn tool_call(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    session: Option<Extension<SessionId>>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    if let Some(r) = draining() {
        return r;
    }
    let Ok(body) = body else { return too_large() };
    let Ok(mut req) = serde_json::from_slice::<ToolRequest>(&body) else {
        return bad_request("Invalid request.");
    };
    if req.args.is_null() {
        req.args = json!({});
    }
    if let Err(m) = check_args(&req.args) {
        return bad_request(m);
    }
    if !req.context.allows(&req.tool) {
        return bad_request("That tool is not available here.");
    }
    let permit = match admit(&state, peer, &headers, &session, &req.tool) {
        Ok(p) => p,
        Err(r) => return r,
    };

    let (tool_label, context) = (req.tool.clone(), req.context);
    let work = {
        let state = Arc::clone(&state);
        async move { run_tool(&state, req.context, &req.tool, &req.args).await }
    };
    let t0 = std::time::Instant::now();
    let result = run_with_permit(permit, work).await;
    // `tool` was validated against the context's allow-list, so the label set is bounded.
    let outcome = match &result {
        Ok(_) => "ok",
        Err(Failure::TimedOut) => "timeout",
        Err(Failure::Failed(_)) => "error",
    };
    crate::metrics::TOOL_CALLS_TOTAL.with_label_values(&[&tool_label, context.label(), outcome]).inc();
    crate::metrics::TOOL_LATENCY_SECONDS.with_label_values(&[&tool_label]).observe(t0.elapsed().as_secs_f64());
    match result {
        Ok(out) => Json(out.into_json()).into_response(),
        Err(f) => failure_json(f, json!({ "citations": [], "sections": [] })),
    }
}

/// Request body cap for the cite step: it carries the sections the research agent retrieved.
pub const CITE_BODY_LIMIT: usize = 4 * 1024 * 1024;
/// The sub-agent's reference list is a few lines of JSON.
const MAX_CITE_OUTPUT_BYTES: usize = 64 * 1024;
const MAX_CITE_SECTIONS: usize = 300;

/// What the research agent searched, which decides how its references are resolved.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
enum CiteKind {
    Legislation,
    SubsidiaryLegislation,
    Judiciary,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CiteRequest {
    kind: CiteKind,
    /// The research agent's final message: a JSON list of references.
    output: String,
    /// Every section `/api/tool` returned for this agent, in the order the calls were made.
    /// They are merged here exactly as the server-side loop merges them as it goes (a full
    /// read replaces a search fragment, consecutive pages of one section are joined).
    #[serde(default)]
    sections: Vec<ScoredSection>,
}

/// `POST /api/cite`: turn a research agent's references into findings that carry the exact
/// statute or judgment text from the corpus, so the model never has to reproduce it.
///
/// References are matched against the merged `sections` first and anything else is looked up in Qdrant.
/// The sections are the client's own: a client that alters them only changes the answer it
/// gets back.
pub async fn cite(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    session: Option<Extension<SessionId>>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    if let Some(r) = draining() {
        return r;
    }
    let Ok(body) = body else { return too_large() };
    let Ok(req) = serde_json::from_slice::<CiteRequest>(&body) else {
        return bad_request("Invalid request.");
    };
    if req.output.len() > MAX_CITE_OUTPUT_BYTES {
        return bad_request("`output` is too large.");
    }
    if req.sections.len() > MAX_CITE_SECTIONS {
        return bad_request("Too many sections.");
    }
    let permit = match admit(&state, peer, &headers, &session, "cite") {
        Ok(p) => p,
        Err(r) => return r,
    };

    let work = {
        let state = Arc::clone(&state);
        async move {
            let config = state.config.read().await.clone();
            let mut retrieved: Vec<ScoredSection> = Vec::new();
            for s in req.sections {
                merge_retrieved_section(&mut retrieved, s);
            }
            match req.kind {
                CiteKind::Legislation | CiteKind::SubsidiaryLegislation => {
                    build_cite_by_reference_result(&req.output, &retrieved, &state, &config).await
                }
                CiteKind::Judiciary => {
                    build_judgment_findings_result(&req.output, &retrieved, &state, &config).await
                }
            }
        }
    };
    match run_with_permit(permit, work).await {
        Ok(result) => {
            let is_error = result.starts_with("[ERROR]");
            Json(json!({ "result": result, "is_error": is_error })).into_response()
        }
        Err(f) => failure_json(f, json!({})),
    }
}

/// Longest text `/api/links` will scan.
const MAX_LINK_TEXT_BYTES: usize = 48 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LinksRequest {
    text: String,
}

/// `POST /api/links`: the Singapore Statutes Online links for the Acts and sections a piece of
/// answer text names. The server-side loop does this as the answer streams; a browser-run loop
/// asks for it here, because the act index lives on the server.
pub async fn links(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    session: Option<Extension<SessionId>>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    if let Some(r) = draining() {
        return r;
    }
    let Ok(body) = body else { return too_large() };
    let Ok(req) = serde_json::from_slice::<LinksRequest>(&body) else {
        return bad_request("Invalid request.");
    };
    if req.text.len() > MAX_LINK_TEXT_BYTES {
        return bad_request("`text` is too large.");
    }
    let _permit = match admit(&state, peer, &headers, &session, "links") {
        Ok(p) => p,
        Err(r) => return r,
    };
    // Pure CPU over a bounded text: no upstream, so no isolation or timeout is needed.
    let citations = crate::services::sso_links::citations_from_text(&req.text);
    Json(json!({ "citations": citations })).into_response()
}

struct ToolOutput {
    result: String,
    citations: Vec<Vec<LegislationCitation>>,
    sections: Vec<ScoredSection>,
}

impl ToolOutput {
    fn into_json(self) -> Value {
        let is_error = self.result.starts_with("[ERROR]");
        json!({
            "result": self.result,
            // One list per tool call the underlying code made, flattened for the client.
            "citations": self.citations.into_iter().flatten().collect::<Vec<_>>(),
            "sections": self.sections,
            "is_error": is_error,
        })
    }
}

async fn run_tool(state: &Arc<AppState>, ctx: Context, tool: &str, args: &Value) -> Result<ToolOutput, String> {
    // The shared code reports citations through an SSE channel and a per-turn list; with no
    // one listening on the channel those sends are no-ops, and the list is read back here.
    let (bcast, _rx) = tokio::sync::broadcast::channel::<SseEvent>(8);
    let pending = Arc::new(tokio::sync::Mutex::new(Vec::<Vec<LegislationCitation>>::new()));
    let acc = Arc::new(tokio::sync::Mutex::new(Vec::<ScoredSection>::new()));

    let (act, sl, judiciary) = {
        let c = state.config.read().await;
        (c.qdrant_act_collection.clone(), c.qdrant_sl_collection.clone(), c.qdrant_judiciary_collection.clone())
    };

    let result = match ctx {
        Context::Orchestrator => {
            execute_tool_inner(state, "", "legislation", tool, args, bcast, Arc::clone(&pending), None).await?
        }
        Context::ResearchLegislation => {
            execute_sub_agent_tool(state, tool, args, &bcast, &pending, Some(&act), Some(&acc)).await?
        }
        Context::ResearchSubsidiary => {
            execute_sub_agent_tool(state, tool, args, &bcast, &pending, Some(&sl), Some(&acc)).await?
        }
        Context::ResearchJudiciary => {
            execute_sub_agent_tool(state, tool, args, &bcast, &pending, Some(&judiciary), Some(&acc)).await?
        }
        Context::AgentLegislation => {
            execute_sub_agent_tool(state, tool, args, &bcast, &pending, None, Some(&acc)).await?
        }
        Context::AgentJudiciary => execute_search_tool(state, tool, args, "judiciary").await?,
    };

    let citations = std::mem::take(&mut *pending.lock().await);
    let sections = std::mem::take(&mut *acc.lock().await);
    Ok(ToolOutput { result, citations, sections })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contexts_only_allow_their_own_tools() {
        assert!(Context::Orchestrator.allows("web_search_tavily"));
        assert!(Context::Orchestrator.allows("get_section"));
        // Research agents are confined to reads in their own collection.
        assert!(Context::ResearchJudiciary.allows("get_judgment"));
        assert!(!Context::ResearchJudiciary.allows("search_legislation"));
        assert!(!Context::ResearchLegislation.allows("get_judgment"));
        assert!(!Context::ResearchLegislation.allows("web_search_tavily"));
        assert!(!Context::AgentJudiciary.allows("get_section"));
        // Tools that call an LLM or only make sense in the server loop are never exposed.
        for ctx in [
            Context::Orchestrator,
            Context::ResearchLegislation,
            Context::ResearchSubsidiary,
            Context::ResearchJudiciary,
            Context::AgentLegislation,
            Context::AgentJudiciary,
        ] {
            for t in [
                "research_legislation", "research_judiciary", "legislation_agent", "judiciary_agent",
                "web_search_deepseek", "classify_issue", "askquestion", "", "SEARCH_LEGISLATION",
            ] {
                assert!(!ctx.allows(t), "{ctx:?} must not allow {t:?}");
            }
        }
    }

    #[test]
    fn args_must_be_a_small_object() {
        assert!(check_args(&json!({"query": "tenant deposit"})).is_ok());
        assert!(check_args(&json!({})).is_ok());
        for bad in [json!([1]), json!("x"), json!(3), json!(true)] {
            assert!(check_args(&bad).is_err(), "{bad}");
        }
        let big = json!({"query": "a".repeat(MAX_ARGS_BYTES)});
        assert!(check_args(&big).is_err());
    }

    #[test]
    fn unknown_fields_and_contexts_are_rejected() {
        assert!(serde_json::from_str::<ToolRequest>(r#"{"tool":"get_section","extra":1}"#).is_err());
        assert!(serde_json::from_str::<ToolRequest>(r#"{"tool":"get_section","context":"admin"}"#).is_err());
        assert!(serde_json::from_str::<ToolRequest>(r#"{"context":"orchestrator"}"#).is_err());
        let ok: ToolRequest = serde_json::from_str(r#"{"tool":"get_section"}"#).unwrap();
        assert_eq!(ok.context, Context::Orchestrator);
    }

    #[test]
    fn output_json_flattens_citations_and_flags_errors() {
        let c = |s: &str| LegislationCitation {
            act_name: "Act".into(),
            section: s.into(),
            label: s.into(),
            url: String::new(),
            doc_type: String::new(),
        };
        let out = ToolOutput {
            result: "[ERROR] nope".into(),
            citations: vec![vec![c("1")], vec![c("2"), c("3")]],
            sections: vec![],
        };
        let v = out.into_json();
        assert_eq!(v["citations"].as_array().unwrap().len(), 3);
        assert_eq!(v["is_error"], json!(true));
    }
}

/// Requests through the real router (body limit, 404 fallback, rate limiting), with no
/// Qdrant, embedder or Tavily behind it: every upstream is unreachable on purpose.
#[cfg(all(test, not(miri)))]
mod http_tests {
    use super::*;
    use axum::body::Body;
    use axum::extract::ConnectInfo;
    use axum::http::{Request, header};
    use std::net::IpAddr;
    use tower::ServiceExt;

    use crate::limits::{Guard, Limits};
    use crate::services::{deepseek::DeepSeekClient, qdrant_store::QdrantStore};

    async fn state(burst: f64) -> Arc<AppState> {
        let mut l = Limits::from_env();
        l.tool_burst = burst;
        l.tool_rate_per_min = 0.6;
        l.tool_ip_concurrency = 8;
        l.tool_global_concurrency = 8;
        state_with(l).await
    }

    async fn state_with(mut l: Limits) -> Arc<AppState> {
        l.tool_ip_concurrency = 8;
        l.tool_global_concurrency = 8;
        let cfg: crate::config::AppConfig = serde_json::from_value(json!({})).unwrap();
        let qdrant = QdrantStore::new("http://127.0.0.1:1", &cfg).await.expect("lazy client");
        Arc::new(AppState {
            config: Arc::new(tokio::sync::RwLock::new(cfg)),
            qdrant,
            deepseek: DeepSeekClient::new("http://127.0.0.1:1", "k", "m"),
            guard: Guard::new(l),
        })
    }

    async fn call(state: &Arc<AppState>, from: [u8; 4], body: impl Into<Body>) -> (StatusCode, axum::http::HeaderMap, Value) {
        call_to(state, "/api/tool", from, body).await
    }

    async fn call_to(
        state: &Arc<AppState>,
        path: &str,
        from: [u8; 4],
        body: impl Into<Body>,
    ) -> (StatusCode, axum::http::HeaderMap, Value) {
        let app = crate::app::build(Arc::clone(state), None);
        let mut req = Request::post(path).header(header::CONTENT_TYPE, "application/json").body(body.into()).unwrap();
        req.extensions_mut().insert(ConnectInfo(SocketAddr::from((from, 4000))));
        let resp = app.oneshot(req).await.unwrap();
        let (parts, body) = resp.into_parts();
        let bytes = axum::body::to_bytes(body, 1 << 20).await.unwrap();
        (parts.status, parts.headers, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    fn get_section() -> String {
        json!({"tool": "get_section", "args": {"source_file": "x.json", "section_id": "1"}}).to_string()
    }

    #[tokio::test]
    async fn calls_are_counted_and_metrics_live_only_on_the_metrics_listener() {
        use crate::metrics::{HTTP_REQUESTS_TOTAL, REJECTIONS_TOTAL, TOOL_CALLS_TOTAL};
        let s = state(1.0).await;
        let http = || HTTP_REQUESTS_TOTAL.with_label_values(&["POST", "/api/tool", "200"]).get();
        let tool = || TOOL_CALLS_TOTAL.with_label_values(&["get_section", "orchestrator", "ok"]).get()
            + TOOL_CALLS_TOTAL.with_label_values(&["get_section", "orchestrator", "error"]).get();
        let limited = || REJECTIONS_TOTAL.with_label_values(&["/api/tool", "rate_limited"]).get();
        let (h0, t0, r0) = (http(), tool(), limited());

        let (status, _, _) = call(&s, [10, 7, 7, 7], get_section()).await;
        assert_eq!(status, StatusCode::OK);
        let (status, _, _) = call(&s, [10, 7, 7, 7], get_section()).await; // burst of 1 is spent
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        // Counters are process-wide and other tests run in parallel, so only growth is asserted.
        assert!(http() - h0 >= 1.0);
        assert!(tool() - t0 >= 1.0);
        assert!(limited() - r0 >= 1.0, "the refusal is counted by code");

        // Not on the API router, whatever the method.
        let app = crate::app::build(Arc::clone(&s), None);
        let mut req = Request::get("/metrics").body(Body::empty()).unwrap();
        req.extensions_mut().insert(ConnectInfo(SocketAddr::from(([10, 7, 7, 7], 1))));
        assert_eq!(app.oneshot(req).await.unwrap().status(), StatusCode::NOT_FOUND);

        // On the metrics router, with the scrape-time gauges present.
        let m = crate::routers::metrics_handler::router(Arc::clone(&s));
        let resp = m.oneshot(Request::get("/metrics").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let text = String::from_utf8(axum::body::to_bytes(resp.into_body(), 1 << 22).await.unwrap().to_vec()).unwrap();
        for name in ["lawbylaw_http_requests_total", "lawbylaw_active_clients", "lawbylaw_daily_token_budget", "lawbylaw_tool_calls_total"] {
            assert!(text.contains(name), "{name} missing from /metrics");
        }
        assert!(!text.contains("10.7.7.7"), "client addresses must never appear in metrics");
    }

    #[tokio::test]
    async fn a_read_returns_the_documented_shape_and_releases_its_slot() {
        let s = state(10.0).await;
        let (status, _, v) = call(&s, [10, 0, 0, 1], get_section()).await;
        assert_eq!(status, StatusCode::OK);
        assert!(v["result"].is_string());
        for k in ["citations", "sections"] {
            assert!(v[k].is_array(), "{k}");
        }
        assert!(v["is_error"].is_boolean());
        assert_eq!(s.guard.tools.active(), 0, "the permit must be released once the call is done");
    }

    #[tokio::test]
    async fn upstream_failures_become_a_fixed_message_that_leaks_nothing() {
        let s = state(10.0).await;
        let body = json!({"tool": "search_legislation", "args": {"query": "deposit"}}).to_string();
        let (status, _, v) = call(&s, [10, 0, 0, 1], body).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(v["is_error"], json!(true));
        let text = v.to_string();
        for leak in ["127.0.0.1", "qdrant", "Qdrant", "tcp", "refused"] {
            assert!(!text.contains(leak), "response leaks {leak:?}: {text}");
        }
        assert_eq!(s.guard.tools.active(), 0);
    }

    #[tokio::test]
    async fn bad_requests_are_rejected_and_never_spend_rate_limit_tokens() {
        let s = state(1.0).await; // a single token
        let bad = [
            "not json".to_string(),
            json!({"tool": "get_section", "extra": 1}).to_string(),
            json!({"tool": "research_legislation", "args": {"prompt": "x"}}).to_string(),
            json!({"tool": "get_section", "context": "research_judiciary"}).to_string(),
            json!({"tool": "get_section", "args": [1]}).to_string(),
            json!({"tool": "get_section", "args": {"q": "a".repeat(MAX_ARGS_BYTES)}}).to_string(),
        ];
        for b in bad {
            let (status, _, v) = call(&s, [10, 0, 0, 1], b.clone()).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{b:.60}");
            assert!(v["error"]["message"].is_string());
        }
        let (status, ..) = call(&s, [10, 0, 0, 1], get_section()).await;
        assert_eq!(status, StatusCode::OK, "the one token was still there");
    }

    #[tokio::test]
    async fn an_oversized_body_is_rejected() {
        let s = state(10.0).await;
        let (status, ..) = call(&s, [10, 0, 0, 1], vec![b' '; BODY_LIMIT + 1]).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn rate_limits_are_per_client_and_tell_the_client_when_to_retry() {
        let s = state(2.0).await;
        for _ in 0..2 {
            assert_eq!(call(&s, [10, 0, 0, 1], get_section()).await.0, StatusCode::OK);
        }
        let (status, headers, v) = call(&s, [10, 0, 0, 1], get_section()).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(v["error"]["code"], json!("rate_limited"));
        assert!(headers.get(header::RETRY_AFTER).is_some());
        // Someone else is unaffected, and cannot borrow the first client's address.
        assert_eq!(call(&s, [10, 0, 0, 2], get_section()).await.0, StatusCode::OK);
        let app = crate::app::build(Arc::clone(&s), None);
        let mut req = Request::post("/api/tool")
            .header("x-forwarded-for", "10.0.0.9")
            .body(Body::from(get_section()))
            .unwrap();
        req.extensions_mut().insert(ConnectInfo(SocketAddr::from(([10, 0, 0, 1], 4000))));
        let status = app.oneshot(req).await.unwrap().status();
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "X-Forwarded-For is ignored unless TRUST_PROXY is set");
    }

    #[tokio::test]
    async fn the_route_only_accepts_post_and_other_api_paths_stay_404() {
        let s = state(10.0).await;
        let app = crate::app::build(Arc::clone(&s), None);
        let mut req = Request::get("/api/tool").body(Body::empty()).unwrap();
        req.extensions_mut().insert(ConnectInfo(SocketAddr::from(([10, 0, 0, 1], 4000))));
        assert_eq!(app.oneshot(req).await.unwrap().status(), StatusCode::METHOD_NOT_ALLOWED);
        let app = crate::app::build(s, None);
        let mut req = Request::post("/api/tool/get_section").body(Body::empty()).unwrap();
        req.extensions_mut().insert(ConnectInfo(SocketAddr::from(([10, 0, 0, 1], 4000))));
        assert_eq!(app.oneshot(req).await.unwrap().status(), StatusCode::NOT_FOUND);
    }

    // ---- /api/cite ----

    const ACT: &str = "Medical (Therapy, Education and Research) Act 1972";

    fn act_section() -> Value {
        json!({
            "text": "Mode of executing gift\n\n8. A gift of all or any part of a body may be made in writing.",
            "score": 1.0,
            "section_id": "s8",
            "metadata": {"act_name": ACT, "source_file": format!("{ACT}.md"), "doc_type": "act", "chunk_index": 0}
        })
    }

    fn cite_body(kind: &str, output: Value, sections: Vec<Value>) -> String {
        json!({"kind": kind, "output": output.to_string(), "sections": sections}).to_string()
    }

    async fn cite(s: &Arc<AppState>, body: String) -> (StatusCode, Value) {
        let (status, _, v) = call_to(s, "/api/cite", [10, 0, 0, 1], body).await;
        (status, v)
    }

    #[tokio::test]
    async fn a_reference_is_resolved_to_the_exact_text_the_client_retrieved() {
        let s = state(10.0).await;
        let refs = json!([{"act_name": ACT, "section_id": "8", "relevance": "gift formalities"}]);
        let (status, v) = cite(&s, cite_body("legislation", refs, vec![act_section()])).await;
        assert_eq!(status, StatusCode::OK);
        let r = v["result"].as_str().unwrap();
        assert!(r.contains("Findings (1 relevant provisions)"), "{r}");
        assert!(r.contains(&format!("### {ACT}, Section 8")), "{r}");
        assert!(r.contains("Relevance: gift formalities"), "{r}");
        assert!(r.contains("A gift of all or any part of a body may be made in writing."), "{r}");
        assert_eq!(v["is_error"], json!(false));
        assert_eq!(s.guard.tools.active(), 0);
    }

    #[tokio::test]
    async fn sections_are_merged_in_call_order_like_the_server_loop_does() {
        let s = state(10.0).await;
        // A search hit that is only part 2 of a split section, then the full read of it.
        let fragment = json!({
            "text": "FRAGMENT-ONLY", "score": 0.5, "section_id": "s8",
            "metadata": {"act_name": ACT, "source_file": format!("{ACT}.md"), "doc_type": "act", "chunk_index": 2}
        });
        let full = json!({
            "text": "FULL SECTION TEXT", "score": 1.0, "section_id": "s8",
            "metadata": {"act_name": ACT, "source_file": format!("{ACT}.md"), "doc_type": "act",
                         "chunk_index": 1, "part_from": 1, "part_to": 2, "chunk_total": 2, "complete": true}
        });
        let refs = json!([{"act_name": ACT, "section_id": "8", "relevance": "r"}]);
        let (_, v) = cite(&s, cite_body("legislation", refs.clone(), vec![fragment.clone(), full.clone()])).await;
        let r = v["result"].as_str().unwrap();
        assert!(r.contains("FULL SECTION TEXT") && !r.contains("FRAGMENT-ONLY"), "{r}");
        // A later search hit never displaces the full text.
        let (_, v) = cite(&s, cite_body("legislation", refs, vec![full, fragment])).await;
        let r = v["result"].as_str().unwrap();
        assert!(r.contains("FULL SECTION TEXT") && !r.contains("FRAGMENT-ONLY"), "{r}");
    }

    #[tokio::test]
    async fn a_reference_that_matches_nothing_is_flagged_not_invented() {
        let s = state(10.0).await; // Qdrant is unreachable, so the fallback lookup finds nothing either
        let refs = json!([{"act_name": "Imaginary Act 2099", "section_id": "7", "relevance": "x"}]);
        let (_, v) = cite(&s, cite_body("legislation", refs, vec![act_section()])).await;
        let r = v["result"].as_str().unwrap();
        assert!(r.contains("Imaginary Act 2099, Section 7 [NOT FOUND]"), "{r}");
        assert!(!r.contains("A gift of all"), "an unrelated section must not be attached: {r}");
    }

    #[tokio::test]
    async fn output_that_is_not_references_comes_back_unchanged_and_empty_means_none() {
        let s = state(10.0).await;
        let body = json!({"kind": "legislation", "output": "Plain prose, no JSON list here.", "sections": []}).to_string();
        assert_eq!(cite(&s, body).await.1["result"], json!("Plain prose, no JSON list here."));
        let (_, v) = cite(&s, cite_body("legislation", json!([]), vec![])).await;
        assert_eq!(v["result"], json!("No relevant provisions found."));
        let (_, v) = cite(&s, cite_body("judiciary", json!([]), vec![])).await;
        assert_eq!(v["result"], json!("No relevant judgments found."));
    }

    #[tokio::test]
    async fn judgment_references_carry_the_retrieved_passage() {
        let s = state(10.0).await;
        let chunk = json!({
            "text": "The court held that the deposit was refundable.",
            "score": 0.9,
            "section_id": "2003_SGHC_152_chunk24",
            "metadata": {"neutral_citation": "[2003] SGHC 152", "source_file": "2003_SGHC_152.pdf",
                         "doc_type": "judgment", "case_name": "Bumi v Man", "topic_indexes": ""}
        });
        let refs = json!([
            {"chunk_id": "2003_SGHC_152_chunk24", "relevance": "deposit"},
            {"chunk_id": "2003_SGHC_152_meta", "relevance": "headnote, never quotable"}
        ]);
        let (_, v) = cite(&s, cite_body("judiciary", refs, vec![chunk])).await;
        let r = v["result"].as_str().unwrap();
        assert!(r.contains("The court held that the deposit was refundable."), "{r}");
        assert!(r.contains("[2003_SGHC_152_chunk24]"), "{r}");
        assert!(!r.contains("headnote, never quotable"), "a headnote reference must be skipped: {r}");
    }

    #[tokio::test]
    async fn the_number_of_references_resolved_is_capped() {
        let s = state(10.0).await;
        let refs: Vec<Value> = (0..200)
            .map(|i| json!({"act_name": format!("Ghost Act {i}"), "section_id": "1", "relevance": ""}))
            .collect();
        let (_, v) = cite(&s, cite_body("legislation", json!(refs), vec![])).await;
        let n = v["result"].as_str().unwrap().matches("[NOT FOUND]").count();
        assert_eq!(n, crate::routers::chat::MAX_CITE_REFS);
    }

    #[tokio::test]
    async fn bad_cite_requests_are_rejected_and_never_spend_rate_limit_tokens() {
        let s = state(1.0).await;
        let too_many: Vec<Value> = (0..=MAX_CITE_SECTIONS).map(|_| act_section()).collect();
        let bad = [
            "{}".to_string(),
            json!({"kind": "legislation", "output": "[]", "extra": 1}).to_string(),
            json!({"kind": "tax", "output": "[]"}).to_string(),
            json!({"kind": "legislation", "output": "x".repeat(MAX_CITE_OUTPUT_BYTES + 1)}).to_string(),
            cite_body("legislation", json!([]), too_many),
            json!({"kind": "legislation", "output": "[]", "sections": [{"text": 1}]}).to_string(),
        ];
        for b in bad {
            assert_eq!(cite(&s, b.clone()).await.0, StatusCode::BAD_REQUEST, "{b:.70}");
        }
        assert_eq!(cite(&s, cite_body("legislation", json!([]), vec![])).await.0, StatusCode::OK);
        // The one token is now spent: the endpoint shares the per-IP limit with /api/tool.
        assert_eq!(call(&s, [10, 0, 0, 1], get_section()).await.0, StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test]
    async fn an_oversized_cite_body_is_rejected() {
        let s = state(10.0).await;
        let (status, ..) = call_to(&s, "/api/cite", [10, 0, 0, 1], vec![b' '; CITE_BODY_LIMIT + 1]).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    }

    // ---- /api/links ----

    #[tokio::test]
    async fn links_are_found_for_the_acts_an_answer_names() {
        if !crate::services::sso_links::index_available() {
            eprintln!("skipping: data/sso_act_index.json not present");
            return;
        }
        let s = state(10.0).await;
        let body = json!({"text": format!("Under section 8 of the {ACT}, a gift may be made in writing.")}).to_string();
        let (status, _, v) = call_to(&s, "/api/links", [10, 0, 0, 1], body).await;
        assert_eq!(status, StatusCode::OK);
        let c = v["citations"].as_array().expect("citations array");
        assert!(c.iter().any(|x| x["act_name"] == json!(ACT) && x["url"].as_str().unwrap().contains("sso.agc.gov.sg")), "{v}");
        let (_, _, v) = call_to(&s, "/api/links", [10, 0, 0, 1], json!({"text": "Nothing legal here."}).to_string()).await;
        assert_eq!(v["citations"], json!([]));
        assert_eq!(s.guard.tools.active(), 0);
    }

    #[tokio::test]
    async fn bad_links_requests_are_rejected_and_share_the_limiter() {
        let s = state(1.0).await;
        for b in [
            "{}".to_string(),
            json!({"text": 1}).to_string(),
            json!({"text": "x", "extra": 1}).to_string(),
            json!({"text": "x".repeat(MAX_LINK_TEXT_BYTES + 1)}).to_string(),
        ] {
            assert_eq!(call_to(&s, "/api/links", [10, 0, 0, 1], b.clone()).await.0, StatusCode::BAD_REQUEST, "{b:.50}");
        }
        assert_eq!(call_to(&s, "/api/links", [10, 0, 0, 1], json!({"text": "x"}).to_string()).await.0, StatusCode::OK);
        assert_eq!(call_to(&s, "/api/links", [10, 0, 0, 1], json!({"text": "x"}).to_string()).await.0, StatusCode::TOO_MANY_REQUESTS);
    }

    // ---- reserved paths through the real router and static fallback ----

    async fn status_and_body(dir: &str, state: &Arc<AppState>, method: &str, path: &str) -> (StatusCode, String) {
        let app = crate::app::build(Arc::clone(state), Some(dir.to_string()));
        let mut req = Request::builder().method(method).uri(path).body(Body::empty()).unwrap();
        req.extensions_mut().insert(ConnectInfo(SocketAddr::from(([10, 9, 9, 9], 4000))));
        let resp = app.oneshot(req).await.unwrap();
        let (parts, body) = resp.into_parts();
        let bytes = axum::body::to_bytes(body, 1 << 20).await.unwrap();
        (parts.status, String::from_utf8_lossy(&bytes).into_owned())
    }

    #[tokio::test]
    async fn reserved_prefixes_never_reach_the_spa_shell_by_any_spelling_or_method() {
        let dir = std::env::temp_dir().join(format!("lbl-static-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("index.html"), "SPA-SHELL").unwrap();
        let d = dir.to_str().unwrap();
        let s = state(100.0).await;
        // The app itself still loads.
        let (st, body) = status_and_body(d, &s, "GET", "/").await;
        assert_eq!((st, body.as_str()), (StatusCode::OK, "SPA-SHELL"));
        let (st, body) = status_and_body(d, &s, "GET", "/chat/some-client-route").await;
        assert_eq!((st, body.as_str()), (StatusCode::OK, "SPA-SHELL"));
        for path in [
            "/admin", "/admin/", "/admin/users", "/adminfoo", "/administrator", "/ADMIN", "/Admin/x",
            "/admin.php", "/admin?x=1", "/api", "/api/", "/api/nope", "/API/nope",
            // encoded spellings: ServeDir decodes these, so they must not be the way around the check
            "/%61dmin", "/%41dmin/x", "/admin%2f", "/%2e/admin", "//admin", "/./admin", "/x/../admin",
            "/%61pi/chat",
        ] {
            for method in ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"] {
                let (st, body) = status_and_body(d, &s, method, path).await;
                assert!(
                    !body.contains("SPA-SHELL") && st != StatusCode::OK,
                    "{method} {path} -> {st} {body}"
                );
            }
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("lbl-{tag}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(dir.join("site")).unwrap();
        std::fs::write(dir.join("site/index.html"), "SPA-SHELL").unwrap();
        dir
    }

    async fn full(dir: Option<&str>, state: &Arc<AppState>, method: &str, path: &str, body: Vec<u8>) -> (StatusCode, axum::http::HeaderMap, String) {
        let app = crate::app::build(Arc::clone(state), dir.map(String::from));
        let mut req = Request::builder()
            .method(method)
            .uri(path)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body))
            .unwrap();
        req.extensions_mut().insert(ConnectInfo(SocketAddr::from(([10, 8, 8, 8], 4000))));
        let resp = app.oneshot(req).await.unwrap();
        let (parts, body) = resp.into_parts();
        let bytes = axum::body::to_bytes(body, 1 << 20).await.unwrap();
        (parts.status, parts.headers, String::from_utf8_lossy(&bytes).into_owned())
    }

    #[tokio::test]
    async fn api_answers_are_no_store_except_the_public_limits() {
        let s = state(100.0).await;
        for (m, p) in [("POST", "/api/tool"), ("POST", "/api/cite"), ("POST", "/api/links"), ("GET", "/api/health"), ("GET", "/api/nope"), ("GET", "/admin")] {
            let (_, h, _) = full(None, &s, m, p, b"{}".to_vec()).await;
            assert_eq!(h.get(header::CACHE_CONTROL).map(|v| v.to_str().unwrap()), Some("no-store"), "{m} {p}");
        }
        let (_, h, _) = full(None, &s, "GET", "/api/limits", vec![]).await;
        assert!(h[header::CACHE_CONTROL].to_str().unwrap().starts_with("public"));
    }

    #[tokio::test]
    async fn health_says_status_ok_and_nothing_else() {
        let s = state(100.0).await;
        let (st, _, body) = full(None, &s, "GET", "/api/health", vec![]).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(serde_json::from_str::<Value>(&body).unwrap(), json!({"status": "ok"}));
    }

    #[tokio::test]
    async fn every_method_on_admin_is_the_same_json_404() {
        let s = state(100.0).await;
        for method in ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] {
            for path in ["/admin", "/admin/x"] {
                let (st, _, _) = full(None, &s, method, path, vec![]).await;
                assert_eq!(st, StatusCode::NOT_FOUND, "{method} {path}");
            }
        }
    }

    #[tokio::test]
    async fn path_traversal_never_serves_a_file_outside_the_site_folder() {
        let dir = scratch("trav");
        std::fs::write(dir.join("secret.txt"), "TOP-SECRET-VALUE").unwrap();
        let site = dir.join("site");
        let s = state(100.0).await;
        for path in [
            "/../secret.txt", "/..%2fsecret.txt", "/%2e%2e/secret.txt", "/%2e%2e%2fsecret.txt",
            "/assets/../../secret.txt", "/..%5csecret.txt", "/%252e%252e/secret.txt", "/etc/passwd",
            "/%2e%2e/%2e%2e/%2e%2e/etc/passwd", "/.git/config", "/.env", "/index.html.bak",
        ] {
            let (st, _, body) = full(site.to_str(), &s, "GET", path, vec![]).await;
            assert!(!body.contains("TOP-SECRET-VALUE") && !body.contains("root:"), "{path} -> {st} {body}");
            assert!(st == StatusCode::OK && body == "SPA-SHELL" || st.is_client_error(), "{path} -> {st}");
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn security_headers_are_on_pages_404s_and_wrong_method_answers() {
        let dir = scratch("hdr");
        let site = dir.join("site");
        let s = state(100.0).await;
        for (method, path) in [
            ("GET", "/"), ("GET", "/admin"), ("GET", "/api/nope"), ("GET", "/api/chat"), ("DELETE", "/api/session"),
            ("PUT", "/api/tool"), ("POST", "/"), ("GET", "/api/health"), ("POST", "/api/tool"),
        ] {
            let (st, h, _) = full(site.to_str(), &s, method, path, vec![]).await;
            for name in ["content-security-policy", "x-content-type-options", "x-frame-options", "referrer-policy", "permissions-policy"] {
                assert!(h.contains_key(name), "{method} {path} ({st}) lacks {name}");
            }
            assert_eq!(h["x-content-type-options"], "nosniff");
            assert_eq!(h["x-frame-options"], "DENY");
            assert!(h["content-security-policy"].to_str().unwrap().contains("frame-ancestors 'none'"));
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn wrong_methods_and_junk_never_cause_a_server_error_or_leak_internals() {
        let s = state(100.0).await;
        let routes = ["/api/chat", "/api/compact", "/api/links", "/api/agent", "/api/tool", "/api/cite",
            "/api/session", "/api/limits", "/api/health", "/api/nope"];
        let junk: [&[u8]; 6] = [b"", b"{", b"null", b"[]", b"\xff\xfe\x00", b"{\"message\":123,\"tool\":{}}"];
        for path in routes {
            for method in ["GET", "POST", "PUT", "PATCH", "DELETE"] {
                for body in junk {
                    let (st, _, text) = full(None, &s, method, path, body.to_vec()).await;
                    assert!(!st.is_server_error() || st == StatusCode::SERVICE_UNAVAILABLE, "{method} {path} {body:?} -> {st}: {text}");
                    for needle in ["127.0.0.1", "panicked", "src/", "/usr/", "RUST_BACKTRACE", "qdrant", "sk-"] {
                        assert!(!text.contains(needle), "{method} {path} leaked {needle}: {text}");
                    }
                }
            }
        }
    }

    #[tokio::test]
    async fn oversized_bodies_are_refused_on_every_post_route() {
        let s = state(100.0).await;
        let huge = vec![b'a'; 3 * 1024 * 1024];
        for path in ["/api/chat", "/api/compact", "/api/links", "/api/tool", "/api/cite", "/api/session"] {
            let (st, _, _) = full(None, &s, "POST", path, huge.clone()).await;
            assert!(st == StatusCode::PAYLOAD_TOO_LARGE || st == StatusCode::BAD_REQUEST || st == StatusCode::UNAUTHORIZED, "{path} -> {st}");
            assert_ne!(st, StatusCode::OK, "{path}");
        }
    }

    #[tokio::test]
    async fn a_very_long_url_is_not_a_server_error() {
        let s = state(100.0).await;
        let path = format!("/{}", "a".repeat(60 * 1024));
        let (st, _, _) = full(None, &s, "GET", &path, vec![]).await;
        assert!(!st.is_server_error(), "{st}");
        let (st, _, _) = full(None, &s, "GET", &format!("/api/health?{}", "q=1&".repeat(10_000)), vec![]).await;
        assert!(!st.is_server_error(), "{st}");
    }

    // ---- forged and abusive direct calls ----

    use crate::session::{SESSION_HEADER, SessionGate};

    async fn enforced_call(
        state: &Arc<AppState>,
        gate: &Arc<SessionGate>,
        from: [u8; 4],
        session: Option<&str>,
        body: impl Into<Body>,
    ) -> (StatusCode, Value) {
        let app = crate::app::build_with_gate(Arc::clone(state), None, Arc::clone(gate));
        let mut b = Request::post("/api/tool").header(header::CONTENT_TYPE, "application/json");
        if let Some(t) = session {
            b = b.header(SESSION_HEADER, t);
        }
        let mut req = b.body(body.into()).unwrap();
        req.extensions_mut().insert(ConnectInfo(SocketAddr::from((from, 4000))));
        let resp = app.oneshot(req).await.unwrap();
        let (parts, body) = resp.into_parts();
        let bytes = axum::body::to_bytes(body, 1 << 20).await.unwrap();
        (parts.status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    fn now() -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()
    }

    #[tokio::test]
    async fn no_session_a_forged_session_or_an_expired_one_is_refused_before_any_tool_runs() {
        let s = state(100.0).await;
        let gate = Arc::new(SessionGate::enforcing_for_tests());
        let (good, _) = gate.issue(now(), IpAddr::from([10, 1, 1, 1]));
        let (expired, _) = gate.issue(1_000, IpAddr::from([10, 1, 1, 1]));
        let forged_mac = {
            let (rest, _) = good.rsplit_once('.').unwrap();
            format!("{rest}.{}", "0".repeat(64))
        };
        for (what, token) in [
            ("none", None),
            ("empty", Some("")),
            ("garbage", Some("not-a-token")),
            ("two parts", Some("1.deadbeef")),
            ("zeroed mac", Some(forged_mac.as_str())),
            ("expired", Some(expired.as_str())),
        ] {
            let (status, v) = enforced_call(&s, &gate, [10, 1, 1, 1], token, get_section()).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{what}");
            assert_eq!(v["error"]["code"], "session_required", "{what}");
        }
        assert_eq!(s.guard.tools.active(), 0, "a refused call must never hold a slot");
        let (status, _) = enforced_call(&s, &gate, [10, 1, 1, 1], Some(&good), get_section()).await;
        assert_eq!(status, StatusCode::OK, "a real session still works");
    }

    #[tokio::test]
    async fn tools_outside_the_allow_list_are_refused_even_with_a_valid_session() {
        let s = state(100.0).await;
        let gate = Arc::new(SessionGate::enforcing_for_tests());
        let (t, _) = gate.issue(now(), IpAddr::from([10, 2, 2, 2]));
        for tool in [
            "web_search_deepseek", "classify_issue", "research_legislation", "askquestion", "",
            "SEARCH_LEGISLATION", "get_section ", "../etc/passwd", "exec", "get_section\0",
        ] {
            let body = json!({"tool": tool, "args": {}}).to_string();
            let (status, v) = enforced_call(&s, &gate, [10, 2, 2, 2], Some(&t), body).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{tool:?}");
            assert_eq!(v["error"]["message"], "That tool is not available here.", "{tool:?}");
        }
        // A tool that exists, but not in this context.
        let body = json!({"tool": "web_search_tavily", "context": "research_judiciary"}).to_string();
        assert_eq!(enforced_call(&s, &gate, [10, 2, 2, 2], Some(&t), body).await.0, StatusCode::BAD_REQUEST);
        let body = json!({"tool": "get_judgment", "context": "agent_judiciary"}).to_string();
        assert_eq!(enforced_call(&s, &gate, [10, 2, 2, 2], Some(&t), body).await.0, StatusCode::BAD_REQUEST);
        assert_eq!(s.guard.tools.active(), 0);
    }

    #[tokio::test]
    async fn bad_contexts_and_malformed_bodies_are_rejected() {
        let s = state(100.0).await;
        let gate = Arc::new(SessionGate::enforcing_for_tests());
        let (t, _) = gate.issue(now(), IpAddr::from([10, 3, 3, 3]));
        for body in [
            json!({"tool": "get_section", "context": "admin"}).to_string(),
            json!({"tool": "get_section", "context": "ORCHESTRATOR"}).to_string(),
            json!({"tool": "get_section", "context": 7}).to_string(),
            json!({"tool": "get_section", "context": null}).to_string(),
            json!({"tool": "get_section", "extra": 1}).to_string(),
            json!({"context": "orchestrator"}).to_string(),
            json!({"tool": 5}).to_string(),
            "not json".to_string(),
            "[]".to_string(),
            String::new(),
        ] {
            let (status, v) = enforced_call(&s, &gate, [10, 3, 3, 3], Some(&t), body.clone()).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
            assert_eq!(v["error"]["code"], "invalid_request", "{body}");
        }
        assert_eq!(s.guard.tools.active(), 0);
    }

    #[tokio::test]
    async fn oversized_and_non_object_args_are_refused() {
        let s = state(100.0).await;
        let gate = Arc::new(SessionGate::enforcing_for_tests());
        let (t, _) = gate.issue(now(), IpAddr::from([10, 4, 4, 4]));
        // Over the args cap but under the body cap: refused by the args check.
        let big = json!({"tool": "search_legislation", "args": {"query": "a".repeat(MAX_ARGS_BYTES + 1)}}).to_string();
        let (status, v) = enforced_call(&s, &gate, [10, 4, 4, 4], Some(&t), big).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(v["error"]["message"], "`args` is too large.");
        // Over the body cap: refused before it is even parsed.
        let huge = json!({"tool": "search_legislation", "args": {"query": "a".repeat(BODY_LIMIT + 1)}}).to_string();
        let (status, _) = enforced_call(&s, &gate, [10, 4, 4, 4], Some(&t), huge).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
        // Deeply nested args do not hang or crash the parser.
        let deep = format!("{{\"tool\":\"get_section\",\"args\":{}1{}}}", "[".repeat(5000), "]".repeat(5000));
        let (status, _) = enforced_call(&s, &gate, [10, 4, 4, 4], Some(&t), deep).await;
        assert!(status.is_client_error(), "{status}");
        for args in [json!([1]), json!("x"), json!(3), json!(true)] {
            let body = json!({"tool": "search_legislation", "args": args}).to_string();
            let (status, v) = enforced_call(&s, &gate, [10, 4, 4, 4], Some(&t), body).await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
            assert_eq!(v["error"]["message"], "`args` must be an object.");
        }
        assert_eq!(s.guard.tools.active(), 0);
    }

    #[tokio::test]
    async fn limits_follow_the_session_not_the_ip() {
        let mut l = Limits::from_env();
        l.tool_burst = 1000.0;
        l.tool_rate_per_min = 0.6;
        l.session_tool_burst = 3.0;
        l.session_tool_rate_per_min = 0.6;
        let s = state_with(l).await;
        let gate = Arc::new(SessionGate::enforcing_for_tests());
        let home = IpAddr::from([10, 5, 5, 1]);
        let (a, _) = gate.issue(now(), home);
        let (b, _) = gate.issue(now(), home);
        for _ in 0..3 {
            assert_eq!(enforced_call(&s, &gate, [10, 5, 5, 1], Some(&a), get_section()).await.0, StatusCode::OK);
        }
        let (status, v) = enforced_call(&s, &gate, [10, 5, 5, 1], Some(&a), get_section()).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "the session limit holds even though the IP limit is huge");
        assert_eq!(v["error"]["code"], "rate_limited");
        // Another session behind the same IP is untouched.
        assert_eq!(enforced_call(&s, &gate, [10, 5, 5, 1], Some(&b), get_section()).await.0, StatusCode::OK);
        // A copied token does not work from another network, so rotating IPs cannot dodge the limit.
        let (status, v) = enforced_call(&s, &gate, [10, 5, 5, 99], Some(&b), get_section()).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(v["error"]["code"], "session_required");
        assert_eq!(s.guard.tools.active(), 0);
    }

    #[tokio::test]
    async fn a_session_has_a_small_web_search_allowance() {
        let mut l = Limits::from_env();
        l.tool_burst = 1000.0;
        l.session_tool_burst = 1000.0;
        l.session_web_searches = 2;
        let s = state_with(l).await;
        let gate = Arc::new(SessionGate::enforcing_for_tests());
        let (a, _) = gate.issue(now(), IpAddr::from([10, 6, 6, 6]));
        let (b, _) = gate.issue(now(), IpAddr::from([10, 6, 6, 6]));
        let web = json!({"tool": "web_search_tavily", "args": {"query": "x"}}).to_string();
        for _ in 0..2 {
            assert_eq!(enforced_call(&s, &gate, [10, 6, 6, 6], Some(&a), web.clone()).await.0, StatusCode::OK);
        }
        let (status, v) = enforced_call(&s, &gate, [10, 6, 6, 6], Some(&a), web.clone()).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(v["error"]["code"], "web_search_limit");
        // Ordinary reads are unaffected, and so is another session.
        assert_eq!(enforced_call(&s, &gate, [10, 6, 6, 6], Some(&a), get_section()).await.0, StatusCode::OK);
        assert_eq!(enforced_call(&s, &gate, [10, 6, 6, 6], Some(&b), web).await.0, StatusCode::OK);
        assert_eq!(s.guard.tools.active(), 0);
    }

}

