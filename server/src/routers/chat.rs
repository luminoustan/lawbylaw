//! Stateless chat endpoint — `POST /api/chat` (SSE).
//!
//! The client sends the whole conversation each turn; nothing is stored. All
//! limits (size, rate, concurrency, budget, tool rounds, wall clock) are
//! enforced here before any upstream call is made.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use axum::{
    Json,
    body::Bytes,
    extract::{ConnectInfo, State, rejection::BytesRejection},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{
        IntoResponse, Response,
        sse::{Event, KeepAlive, Sse},
    },
};
use serde_json::{Value, json};
use tokio::sync::{Mutex, broadcast};
use tokio_stream::StreamExt;
use tracing::{debug, error, info, warn};

use crate::AppState;
use crate::config::AppConfig;
use crate::limits::{self, Reject};
use crate::models::schemas::{ChatRequest, LegislationCitation, SseEvent as ChatSseEvent};
use crate::services::qdrant_store::{
    DB_SINK, DbSink, QUEUE_SINK, QueueInfo, QueueSink, db_timeout_tool_message, is_db_timeout,
};
use crate::services::deepseek;
use crate::services::gatekeeper;
use crate::services::sso_links;

type ToolExecutorFn = Arc<
    dyn Fn(
            String,
            Value,
        )
            -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send>>
        + Send
        + Sync,
>;

/// Aborts the task when dropped (client disconnect). A bare `JoinHandle` would only
/// detach it and leave it running.
struct AbortOnDrop<T>(tokio::task::JoinHandle<T>);
impl<T> Drop for AbortOnDrop<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Run `fut` on its own task so a panic in it surfaces as an `Err` instead of
/// unwinding the caller, but cancel that task if the caller is dropped first.
pub(crate) async fn run_isolated<T: Send + 'static>(
    fut: impl std::future::Future<Output = T> + Send + 'static,
) -> Result<T, tokio::task::JoinError> {
    let mut task = AbortOnDrop(tokio::spawn(fut));
    (&mut task.0).await
}

pub fn error_response(r: Reject) -> Response {
    let mut resp = (
        r.status,
        Json(json!({"error": {"code": r.code, "message": r.message}})),
    )
        .into_response();
    if let Some(s) = r.retry_after
        && let Ok(v) = HeaderValue::from_str(&s.to_string())
    {
        resp.headers_mut().insert(header::RETRY_AFTER, v);
    }
    resp.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    resp.extensions_mut().insert(crate::obs::RejectCode(r.code));
    resp
}

/// Records one chat turn's outcome when it ends, however it ends: normal finish, error, timeout,
/// or the task being aborted because the client went away (the future is dropped, so `Drop` runs).
struct TurnRecorder {
    mode: String,
    start: std::time::Instant,
    outcome: String,
    prompt_tokens: u64,
    completion_tokens: u64,
}

impl TurnRecorder {
    fn new(mode: &str) -> Self {
        Self { mode: mode.into(), start: std::time::Instant::now(), outcome: String::new(), prompt_tokens: 0, completion_tokens: 0 }
    }
}

impl Drop for TurnRecorder {
    fn drop(&mut self) {
        use crate::metrics::{CHAT_TURNS_TOTAL, CHAT_TURN_SECONDS, CHAT_TURN_TOKENS};
        let outcome = if self.outcome.is_empty() { "client_abort" } else { self.outcome.as_str() };
        let secs = self.start.elapsed().as_secs_f64();
        let tokens = self.prompt_tokens + self.completion_tokens;
        CHAT_TURNS_TOTAL.with_label_values(&[&self.mode, outcome]).inc();
        CHAT_TURN_SECONDS.with_label_values(&[&self.mode]).observe(secs);
        if tokens > 0 {
            CHAT_TURN_TOKENS.with_label_values(&[&self.mode]).observe(tokens as f64);
        }
        info!(
            mode = %self.mode,
            outcome,
            duration_ms = (secs * 1000.0) as u64,
            prompt_tokens = self.prompt_tokens,
            completion_tokens = self.completion_tokens,
            total_tokens = tokens,
            "turn_complete"
        );
    }
}

const GENERIC_ERROR: &str = "The assistant ran into a problem. Please try again.";

/// `POST /api/chat`
pub async fn chat_turn(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    if crate::routers::health::DRAINING.load(Ordering::Relaxed) {
        return error_response(Reject {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "draining",
            message: "Server is restarting. Please retry in a moment.".into(),
            retry_after: Some(5),
        });
    }
    let guard = Arc::clone(&state.guard);
    let l = &guard.limits;

    let body = match body {
        Ok(b) => b,
        Err(_) => {
            return error_response(Reject {
                status: StatusCode::PAYLOAD_TOO_LARGE,
                code: "body_too_large",
                message: format!(
                    "Your message is too large to send (limit {} KB). Please shorten it.",
                    l.body_bytes / 1024
                ),
                retry_after: None,
            });
        }
    };
    let request: ChatRequest = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(_) => {
            return error_response(Reject {
                status: StatusCode::BAD_REQUEST,
                code: "invalid_json",
                message: "Invalid request.".into(),
                retry_after: None,
            });
        }
    };
    let mode = match limits::validate(&request, l) {
        Ok(m) => m,
        Err(r) => return error_response(r),
    };

    let ip = limits::client_ip(&headers, peer, l.trust_proxy);
    let last_message = request.messages.last().map(|m| m.content.clone()).unwrap_or_default();
    let permit = match guard.admit(ip, &last_message) {
        Ok(p) => p,
        Err(r) => return error_response(r),
    };

    // ── Build model messages ───────────────────────────────────────────
    let config = state.config.read().await.clone();
    let act_names: Vec<String> = if mode == "legislation" {
        state
            .qdrant
            .indexed_act_names(&config.qdrant_act_collection)
            .await
            .unwrap_or_default()
    } else {
        vec![]
    };
    let active_tool_names = get_tool_names(&mode);
    // The system prompt stays static; the Act list follows it as its own message so
    // it can change (re-ingest) without touching the cached system prefix.
    let system_prompt = deepseek::build_system_prompt(&config, &mode, &[]);
    let acts_context = crate::services::prompts::indexed_acts_context(&act_names);
    let prior_summary = request.summary.clone().filter(|s| !s.trim().is_empty());
    let mut api_messages =
        build_api_messages(&system_prompt, acts_context.as_deref(), prior_summary.as_deref(), &request.messages, &active_tool_names);

    // Nothing summarises a chat on its own: the user does it with `/compact` (`POST /api/compact`).
    // Past the hard cap the oldest turns are dropped instead, and the user is told.
    let notice = trim_to_cap(&mut api_messages, l.context_tokens);
    let base_ctx_tokens = deepseek::estimate_tokens(&api_messages);
    let tools = crate::services::web_search::retain_available(
        deepseek::DeepSeekClient::get_tools(&mode),
        !config.tavily_api_key.is_empty(),
        crate::services::provider::Provider::from_base_url(&config.deepseek_base_url).has_deepseek_search(),
    );

    // ── Channel + tool executor ────────────────────────────────────────
    let (tx, mut rx) = broadcast::channel::<ChatSseEvent>(1024);
    let pending_citations: Arc<Mutex<Vec<Vec<LegislationCitation>>>> =
        Arc::new(Mutex::new(Vec::new()));
    let state_clone = Arc::clone(&state);
    let mode_clone = mode.clone();
    let tx_for_tool = tx.clone();
    let cit_for_tool = Arc::clone(&pending_citations);
    let read_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let web_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let tool_executor: ToolExecutorFn = Arc::new(move |name: String, args: Value| {
        let state = Arc::clone(&state_clone);
        let mode = mode_clone.clone();
        let bcast = tx_for_tool.clone();
        let cit_buf = Arc::clone(&cit_for_tool);
        let reads = Arc::clone(&read_calls);
        let webs = Arc::clone(&web_calls);
        Box::pin(async move {
            if crate::services::web_search::is_web_search_tool(&name)
                && webs.fetch_add(1, std::sync::atomic::Ordering::SeqCst) >= MAX_WEB_SEARCHES
            {
                return Ok(format!(
                    "No more web searches are available this turn ({} used). Write your answer now from what you already have.",
                    MAX_WEB_SEARCHES
                ));
            }
            if matches!(name.as_str(), "get_section" | "get_judgment")
                && reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst) >= MAX_ORCHESTRATOR_READS
            {
                return Ok(format!(
                    "No more reads are available this turn ({} used). Write your answer now from the findings and text you already have.",
                    MAX_ORCHESTRATOR_READS
                ));
            }
            // Run the tool on its own task: a panic or failure becomes a tool error
            // the model can see, instead of killing the whole chat turn.
            let tool_name = name.clone();
            // (Cancelled with the turn: see `run_isolated`.)
            match run_isolated(async move {
                execute_tool(&state, "", &mode, &name, &args, bcast, cit_buf).await
            })
            .await
            {
                Ok(r) => r,
                Err(e) => {
                    error!("tool {} aborted: {}", tool_name, e);
                    Err(format!("{} failed unexpectedly; continue without it.", tool_name))
                }
            }
        })
    });

    let max = l.model_window as u64;
    let tools_est = deepseek::estimate_tools_tokens(&tools);
    let (sys_est, subagent_est) = deepseek::split_system_prompt_tokens(&system_prompt);
    let summary_est = prior_summary
        .as_ref()
        .map(|s| (s.len() / deepseek::DISPLAY_CHARS_PER_TOKEN) as u64)
        .unwrap_or(0);
    // Breakdown / context / notice events are sent from the task, after the gatekeeper passes.
    let gate_prev: Option<String> = {
        let n = request.messages.len();
        (n >= 2 && request.messages[n - 2].role == "assistant").then(|| request.messages[n - 2].content.clone())
    };

    let mode_log = mode.clone();
    let client = state.deepseek.clone();
    let ctx_max = max;
    let context_cap = l.context_tokens;
    let timeout = Duration::from_secs(l.request_timeout_s);
    let guard_for_task = Arc::clone(&guard);
    let gate_user = last_message.clone();
    let mode_clone2 = mode.clone();
    tracing::Span::current().record("mode", mode.as_str());
    let turn_span = tracing::Span::current();
    let task = tokio::spawn(tracing::Instrument::instrument(async move {
        let mut rec = TurnRecorder::new(&mode_clone2);
        let mut saw_usage = false;
        let tx_run = tx.clone();

        // ── Gatekeeper: screen the message before spending any agent tokens ──
        if config.gatekeeper_enabled {
            let gate = tokio::time::timeout(
                Duration::from_secs(config.gatekeeper_timeout_s.max(1) + 2),
                client.gatekeeper_check(&config, gate_prev.as_deref(), &gate_user),
            )
            .await;
            match gate {
                Ok(Ok((verdict, spent))) => {
                    guard_for_task.record_tokens(spent);
                    info!("gatekeeper verdict={}", verdict.label());
                    if verdict != gatekeeper::Verdict::Allow {
                        rec.outcome = format!("blocked_{}", verdict.label());
                        let _ = tx.send(ChatSseEvent::Token { content: gatekeeper::canned_reply(verdict, &mode_clone2) });
                        let _ = tx.send(ChatSseEvent::Done);
                        return;
                    }
                }
                Ok(Err(e)) => {
                    warn!("gatekeeper failed: {}", e);
                    rec.outcome = "error".into();
                    let _ = tx.send(ChatSseEvent::Error {
                        error: crate::services::llm_errors::message_for(
                            &e,
                            "We couldn't check your message right now. Please try again.",
                        )
                        .into(),
                    });
                    return;
                }
                Err(_) => {
                    warn!("gatekeeper timed out");
                    rec.outcome = "timeout".into();
                    let _ = tx.send(ChatSseEvent::Error {
                        error: "We couldn't check your message right now. Please try again.".into(),
                    });
                    return;
                }
            }
        }

        let _ = tx.send(ChatSseEvent::Breakdown {
            system: sys_est,
            tools: tools_est,
            summary: summary_est,
            subagent: subagent_est,
        });
        let _ = tx.send(ChatSseEvent::ContextUsage {
            used: base_ctx_tokens as u64,
            max: ctx_max,
            percent: ((base_ctx_tokens as u64) * 100 / ctx_max.max(1)).min(100),
        });
        if let Some(message) = notice {
            let _ = tx.send(ChatSseEvent::Notice { message });
        }

        let run = async {
            let mut api_messages = api_messages;
            // Backstop: never exceed the hard input cap.
            if deepseek::estimate_tokens(&api_messages) > context_cap {
                if let Some(message) = trim_to_cap(&mut api_messages, context_cap) {
                    let _ = tx_run.send(ChatSseEvent::Notice { message });
                }
            }
            let stream = client
                .stream_with_tools(&config, api_messages, tools, tool_executor, &mode)
                .await;
            tokio::pin!(stream);
            let mut answer_text = String::new();
            let mut since_scan = 0usize;
            let mut sent_text_citations = std::collections::HashSet::new();
            while let Some(event) = stream.next().await {
                let event = match event {
                    ChatSseEvent::Usage { total_tokens, prompt_tokens, completion_tokens } => {
                        saw_usage = true;
                        rec.prompt_tokens = prompt_tokens;
                        rec.completion_tokens = completion_tokens;
                        guard_for_task.record_tokens(total_tokens);
                        continue; // usage is internal; not sent to the browser
                    }
                    ChatSseEvent::Error { error } => {
                        error!("generation error: {}", error);
                        rec.outcome = "error".into();
                        ChatSseEvent::Error { error: GENERIC_ERROR.into() }
                    }
                    other => other,
                };
                match &event {
                    // Link the Acts the answer names in full even if no search
                    // returned those sections (the model cites from memory). Sent as
                    // the answer grows, not only at the end, so a reply the user
                    // stops halfway keeps the links for what was already written.
                    ChatSseEvent::Token { content } => {
                        answer_text.push_str(content);
                        since_scan += content.len();
                        if since_scan >= CITATION_SCAN_BYTES || content.contains('\n') {
                            since_scan = 0;
                            send_new_text_citations(&tx_run, &answer_text, &mut sent_text_citations, false);
                        }
                    }
                    // The text streamed so far is being replaced or retracted.
                    ChatSseEvent::AnswerReset => {
                        answer_text.clear();
                        since_scan = 0;
                    }
                    ChatSseEvent::Done => {
                        if rec.outcome.is_empty() {
                            rec.outcome = "ok".into();
                        }
                        send_new_text_citations(&tx_run, &answer_text, &mut sent_text_citations, true);
                    }
                    _ => {}
                }
                let _ = tx_run.send(event);
            }
        };
        if tokio::time::timeout(timeout, run).await.is_err() {
            warn!("generation timed out");
            rec.outcome = "timeout".into();
            let _ = tx.send(ChatSseEvent::Error {
                error: "The request took too long and was stopped. Please try a shorter question.".into(),
            });
        }
        if !saw_usage {
            guard_for_task.record_tokens(base_ctx_tokens as u64);
        }
    }, turn_span));

    info!("chat turn started: mode={} msgs={}", mode_log, request.messages.len());

    let abort = AbortOnDrop(task);
    let stream = async_stream::stream! {
        let _permit = permit;
        let _abort = abort;
        loop {
            match rx.recv().await {
                Ok(ev) => {
                    let data = serde_json::to_string(&ev).unwrap_or_default();
                    yield Ok::<Event, Infallible>(Event::default().data(data));
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    };
    let mut resp = Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(10)))
        .into_response();
    resp.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    resp.headers_mut()
        .insert("x-accel-buffering", HeaderValue::from_static("no"));
    resp
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

/// System prompt + (optional) earlier-turn summary + client history, as API messages.
fn build_api_messages(
    system_prompt: &str,
    acts_context: Option<&str>,
    summary: Option<&str>,
    msgs: &[crate::models::schemas::ClientMessage],
    active_tool_names: &Vec<String>,
) -> Vec<Value> {
    let mut out = vec![json!({"role": "system", "content": system_prompt})];
    if let Some(a) = acts_context {
        out.push(json!({"role": "system", "content": a}));
    }
    let mut history: Vec<Value> = Vec::new();
    if let Some(s) = summary.filter(|s| !s.trim().is_empty()) {
        // User-role on purpose: the summary is client-held, so it must never gain system authority.
        history.push(json!({
            "role": "user",
            "content": format!("[Summary of the earlier part of this conversation]\n{s}\n[End of summary. The conversation continues below.]")
        }));
    }
    history.extend(msgs.iter().map(|m| json!({"role": m.role, "content": m.content})));
    out.extend(deepseek::messages_to_api(&history, Some(active_tool_names)));
    out
}

/// Drop the oldest turns until under `cap`; returns a user-facing notice if anything was dropped.
fn trim_to_cap(api_messages: &mut Vec<Value>, cap: usize) -> Option<String> {
    if deepseek::estimate_tokens(api_messages) <= cap {
        return None;
    }
    let before = api_messages.len();
    *api_messages = deepseek::truncate_messages_to_fit(api_messages, cap);
    (api_messages.len() < before).then(|| {
        "Older messages were trimmed to fit the context window. Start a new chat for best results.".to_string()
    })
}

/// Get active tool names for a given mode.
fn get_tool_names(mode: &str) -> Vec<String> {
    match mode {
        "self-help" => vec![
            "classify_issue".into(),
            "legislation_agent".into(),
            "judiciary_agent".into(),
            "askquestion".into(),
        ],
        "judiciary" => vec!["search_judiciary".into(), "askquestion".into()],
        _ => vec!["search_legislation".into(), "askquestion".into()],
    }
}

/// Marker line (leading newline included) for a search hit that is one part of
/// a split section; empty for an unsplit section (`chunk_index` 0 or absent).
/// `chunk_total` is filled in by [`annotate_chunk_totals`] when known.
/// How many sections a search may return: the model's `top_k`, kept within 1..=8.
/// A negative number must not reach a `usize` cast, where it wraps to about 2^64 and asks the
/// vector store (and the remote reranker) for every document it has.
pub(crate) fn search_top_k(args: &Value) -> usize {
    args["top_k"].as_i64().unwrap_or(4).clamp(1, 8) as usize
}

fn part_marker_line(section_id: &str, meta: &Value) -> String {
    let idx = meta.get("chunk_index").and_then(|v| v.as_i64()).unwrap_or(0);
    if idx < 1 {
        return String::new();
    }
    let of_total = meta
        .get("chunk_total")
        .and_then(|v| v.as_u64())
        .map(|t| format!(" of {}", t))
        .unwrap_or_default();
    format!(
        "\n[part {}{} — this is only one part of a longer section; call get_section with section_id \"{}\" to read it in full]",
        idx, of_total, section_id
    )
}

/// Footer for a `get_section` result saying which parts of a split section it
/// holds and how to fetch the rest. Empty for an unsplit section so its output
/// is unchanged.
fn section_parts_footer(section: &crate::services::qdrant_store::ScoredSection) -> String {
    let m = &section.metadata;
    let total = m.get("chunk_total").and_then(|v| v.as_u64()).unwrap_or(1);
    if total <= 1 {
        return String::new();
    }
    let from = m.get("part_from").and_then(|v| v.as_u64()).unwrap_or(1);
    let to = m.get("part_to").and_then(|v| v.as_u64()).unwrap_or(total);
    let tokens = m.get("window_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
    let clamped = m
        .get("part_clamped_from")
        .and_then(|v| v.as_u64())
        .map(|p| {
            format!(
                "[requested part {} is beyond the last part; showing the last window instead]\n",
                p
            )
        })
        .unwrap_or_default();
    let complete = m.get("complete").and_then(|v| v.as_bool()).unwrap_or(false);
    let body = if complete {
        format!("[complete section, assembled from {} parts]", total)
    } else if to >= total {
        format!(
            "[parts {}-{} of {} shown ({} tokens) — this is the end of the section]",
            from, to, total, tokens
        )
    } else {
        format!(
            "[parts {}-{} of {} shown ({} tokens) — the section CONTINUES: call get_section again with the same source_file and section_id and part={} to read the next parts]",
            from,
            to,
            total,
            tokens,
            to + 1
        )
    };
    format!("\n\n{}{}", clamped, body)
}

/// Render a `get_section` result: the section text plus the parts footer.
fn format_section_result(section: crate::services::qdrant_store::ScoredSection) -> String {
    let footer = section_parts_footer(&section);
    format!("{}{}", format_search_results(&[section], false), footer)
}

/// Fill `chunk_total` into the metadata of hits that are one part of a split
/// section, so the part marker can say "part K of M". One cheap exact count per
/// chunked hit; unsplit hits and judiciary hits are untouched.
async fn annotate_chunk_totals(
    state: &Arc<AppState>,
    act_coll: &str,
    sl_coll: &str,
    results: &mut [crate::services::qdrant_store::ScoredSection],
) {
    for s in results.iter_mut() {
        let idx = s.metadata.get("chunk_index").and_then(|v| v.as_i64()).unwrap_or(0);
        if idx < 1 {
            continue;
        }
        let doc_type = s.metadata.get("doc_type").and_then(|v| v.as_str()).unwrap_or("");
        let source = s
            .metadata
            .get("source_file")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if source.is_empty() {
            continue;
        }
        let coll = if doc_type == "subsidiary_legislation" { sl_coll } else { act_coll };
        if let Some(n) = state.qdrant.count_section_parts(coll, &source, &s.section_id).await
            && let Some(obj) = s.metadata.as_object_mut()
        {
            obj.insert("chunk_total".into(), serde_json::json!(n));
        }
    }
}

/// Format search results with deterministic ordering and integer percent scores.
/// Sort by section_id so that identical Qdrant hits always produce byte-identical
/// tool result strings, enabling cross-session DeepSeek cache prefix reuse.
fn format_search_results(
    results: &[crate::services::qdrant_store::ScoredSection],
    is_judiciary: bool,
) -> String {
    let mut sorted: Vec<&crate::services::qdrant_store::ScoredSection> = results.iter().collect();
    sorted.sort_by(|a, b| a.section_id.cmp(&b.section_id));

    let parts: Vec<String> = sorted
        .iter()
        .map(|s| {
            // Integer percent avoids float rounding drift (e.g. 79% vs 80%)
            // that would produce different strings for the same result.
            let score_pct = format!("{}%", (s.score * 100.0) as u32);
            let meta = &s.metadata;
            let header = if is_judiciary {
                let citation = meta
                    .get("neutral_citation")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let case = meta.get("case_name").and_then(|v| v.as_str()).unwrap_or("");
                let topics = meta
                    .get("topic_indexes")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let mut h = vec![s.section_id.as_str()];
                if !citation.is_empty() {
                    h.push(citation);
                }
                if !case.is_empty() {
                    h.push(case);
                }
                if !topics.is_empty() {
                    h.push(topics);
                }
                let score_s = format!("relevance {}", score_pct);
                h.push(&score_s);
                h.join(" | ")
            } else {
                let part = meta.get("part").and_then(|v| v.as_str()).unwrap_or("");
                let division = meta.get("division").and_then(|v| v.as_str()).unwrap_or("");
                let doc_type = meta.get("doc_type").and_then(|v| v.as_str()).unwrap_or("");
                let source = meta
                    .get("source_file")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.trim_end_matches(".pdf"))
                    .unwrap_or("");
                let parent = meta
                    .get("parent_act_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                // For SL: show source_file (the SL document name) in header,
                // not act_name (which is the parent Act).
                // For Acts: show act_name as before.
                let display_name = if doc_type == "subsidiary_legislation" && !source.is_empty() {
                    source
                } else {
                    meta.get("act_name")
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                        .unwrap_or(if !source.is_empty() { source } else { parent })
                };
                let mut h = vec![s.section_id.as_str()];
                if !part.is_empty() {
                    h.push(part);
                }
                if !division.is_empty() {
                    h.push(division);
                }
                if !display_name.is_empty() {
                    h.push(display_name);
                }
                let score_s = format!("relevance {}", score_pct);
                h.push(&score_s);
                h.join(" | ")
            };
            let doc_type = meta.get("doc_type").and_then(|v| v.as_str()).unwrap_or("");
            let parent = meta
                .get("parent_act_name")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let sso_url = meta.get("sso_url").and_then(|v| v.as_str()).unwrap_or("");
            let sso_number = meta
                .get("sso_number")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let sso_line = match (sso_url.is_empty(), sso_number.is_empty()) {
                (true, true) => String::new(),
                (false, true) => format!("\nSSO: {}", sso_url),
                (false, false) => format!("\nSSO: {} ({})", sso_url, sso_number),
                (true, false) => format!("\nSSO number: {}", sso_number),
            };
            // A split section/schedule is stored as one point per part, all sharing
            // the base section_number, so the header alone cannot say whether this
            // hit is the whole section or one fragment. chunk_index is 0 for an
            // unsplit section and N for part N of a split one. The marker is a
            // separate line so the `[sN | Name | relevance X%]` header grammar the
            // sub-agent prompts parse is untouched; unsplit hits are unchanged.
            let part_note = if is_judiciary {
                String::new()
            } else {
                part_marker_line(&s.section_id, meta)
            };
            if doc_type == "subsidiary_legislation" && !parent.is_empty() {
                format!(
                    "[{}]{}\nParent Act: {}{}\n{}",
                    header, part_note, parent, sso_line, s.text,
                )
            } else {
                format!("[{}]{}{}\n{}", header, part_note, sso_line, s.text)
            }
        })
        .collect();
    parts.join("\n\n---\n\n")
}

/// Trim a tool-result string to fit within the configured RAG context budget.
/// Mirrors Python's `_apply_context_budget`: ~4 chars/token, cuts at section
/// boundary ("---") when possible, else at sentence boundary.
fn apply_context_budget(result: String, budget_tokens: i64) -> String {
    if budget_tokens <= 0 {
        return result;
    }
    let max_chars = (budget_tokens * 4) as usize;
    if result.len() <= max_chars {
        return result;
    }

    // Byte offsets must land on char boundaries: statutes and judgments are full
    // of multi-byte characters (—, ’, §).
    let floor = |mut i: usize| {
        while i > 0 && !result.is_char_boundary(i) {
            i -= 1;
        }
        i
    };
    let max_chars = floor(max_chars);
    let truncated = &result[..max_chars];
    let third = floor(max_chars / 3);
    let half = floor(max_chars / 2);
    // Prefer cutting at a "---" section separator in the upper 2/3
    let cut = if let Some(pos) = truncated[third..].rfind("\n\n---\n\n") {
        third + pos
    } else if let Some(pos) = truncated[half..].rfind(". ") {
        half + pos + 1
    } else {
        max_chars
    };
    format!(
        "{}\n\n[... remaining sections trimmed to fit context budget]",
        &result[..cut]
    )
}

/// New answer text (bytes) after which the answer is scanned again for Acts named in
/// full. Each scan looks for every indexed title, so it is throttled.
const CITATION_SCAN_BYTES: usize = 300;

/// Send the citations `sso_links::citations_from_text` finds in `answer` that were not
/// sent before (`sent` holds the urls already sent).
///
/// While the answer is still streaming (`finished == false`) its last word may be half
/// a reference ("s 1" on its way to "s 19(5)"), so scanning stops before it.
fn send_new_text_citations(
    tx: &tokio::sync::broadcast::Sender<ChatSseEvent>,
    answer: &str,
    sent: &mut std::collections::HashSet<String>,
    finished: bool,
) {
    let answer = if finished || answer.ends_with(char::is_whitespace) {
        answer
    } else {
        answer.rfind(char::is_whitespace).map_or("", |i| &answer[..i])
    };
    let fresh: Vec<LegislationCitation> = sso_links::citations_from_text(answer)
        .into_iter()
        .filter(|c| sent.insert(c.url.clone()))
        .collect();
    if !fresh.is_empty() {
        let _ = tx.send(ChatSseEvent::LegislationCitations { citations: fresh });
    }
}

/// Extract SSO citation links from legislation search results.
fn extract_citations(
    results: &[crate::services::qdrant_store::ScoredSection],
) -> Vec<LegislationCitation> {
    let mut seen = std::collections::HashSet::new();
    let mut citations = Vec::new();
    for s in results {
        let meta = &s.metadata;
        let doc_type = meta.get("doc_type").and_then(|v| v.as_str()).unwrap_or("");
        let is_sl = doc_type == "subsidiary_legislation";
        // Acts are cited by their own title. Subsidiary legislation is cited by
        // its own document name (not the parent Act's), so a "Regulation 19"
        // mention links to the regulations and never to the parent Act's s.19.
        let act_name: String = match doc_type {
            "act" => meta
                .get("act_name")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .or_else(|| {
                    meta.get("source_file")
                        .and_then(|v| v.as_str())
                        .map(|f| f.trim_end_matches(".pdf"))
                })
                .unwrap_or("")
                .to_string(),
            "subsidiary_legislation" => meta
                .get("source_file")
                .and_then(|v| v.as_str())
                .map(sso_links::sl_document_name)
                .unwrap_or_default(),
            _ => continue,
        };
        let raw_section = crate::services::qdrant_store::strip_section_s_prefix(&s.section_id);
        // Numbered provisions link to `pr19-` and schedules to `Sc1-` (every part
        // of a schedule shares one link, so the canonical `schedule1` is cited).
        // Appendices and the legislative history have no anchor, so a link built
        // for them would be broken.
        let Some((section, _)) = sso_links::provision_ref(raw_section) else {
            continue;
        };
        let section = section.as_str();
        if act_name.is_empty() {
            continue;
        }
        let key = (act_name.clone(), section.to_string());
        if !seen.insert(key) {
            continue;
        }
        let sso_url = meta
            .get("sso_url")
            .and_then(|v| v.as_str())
            .filter(|u| !u.is_empty());
        let url = match sso_url {
            Some(base) => Some(sso_links::section_url_from_sso_base(base, section))
                .filter(|u| !u.is_empty()),
            // Acts without a stored URL fall back to the act-code index. There is
            // no such index for subsidiary legislation, and falling back to the
            // parent Act would link to the wrong document.
            None if !is_sl => sso_links::act_section_url(&act_name, section),
            None => None,
        };
        if let Some(url) = url {
            citations.push(LegislationCitation {
                label: if is_sl {
                    format!("{} {}", act_name, section)
                } else {
                    format!("s.{}", section)
                },
                act_name,
                section: section.to_string(),
                doc_type: doc_type.to_string(),
                url,
            });
        }
    }
    citations
}

/// Execute any tool a sub-agent might call (search, get_section),
/// broadcasting SSO citations to the frontend via the shared channels.
///
/// `collection_override`: when set, forces `search_legislation` and
/// `get_section` to search only the specified collection instead of
/// the default both-collections merge.  The legislation_research
/// sub-agent passes the acts collection, the legislation_sl sub-agent
/// passes the SL collection.
///
/// `retrieved_sections`: when provided, each `ScoredSection` returned by
/// search or get_section is accumulated here so the caller can later
/// build a tool result from the raw Qdrant data instead of relying on
/// the sub-agent LLM to reproduce it.
/// Web searches (both engines together) the orchestrator may run per turn: each one is a
/// billed API call.
pub(crate) const MAX_WEB_SEARCHES: usize = 4;

/// Direct `get_section` / `get_judgment` reads the orchestrator may make per turn.
/// Each returns at most ORCHESTRATOR_READ_WINDOW_TOKENS tokens.
pub(crate) const MAX_ORCHESTRATOR_READS: usize = 10;

/// Window for a read: `single_part: true` forces exactly one part (a window of
/// 0 still returns the one part that starts it).
fn read_window(args: &Value, default: usize) -> usize {
    if args["single_part"].as_bool().unwrap_or(false) { 0 } else { default }
}

pub(crate) async fn execute_sub_agent_tool(
    state: &Arc<AppState>,
    name: &str,
    args: &Value,
    broadcast_tx: &tokio::sync::broadcast::Sender<ChatSseEvent>,
    pending_citations: &Arc<tokio::sync::Mutex<Vec<Vec<LegislationCitation>>>>,
    collection_override: Option<&str>,
    retrieved_sections: Option<
        &Arc<tokio::sync::Mutex<Vec<crate::services::qdrant_store::ScoredSection>>>,
    >,
) -> Result<String, String> {
    match name {
        "search_legislation" | "search_judiciary" => {
            let (text, citations, raw_sections) = execute_search_tool_with_citations_and_sections(
                state,
                name,
                args,
                "legislation",
                collection_override,
            )
            .await?;
            if !citations.is_empty() {
                pending_citations.lock().await.push(citations.clone());
                let _ = broadcast_tx.send(ChatSseEvent::LegislationCitations { citations });
            }
            if let Some(acc) = retrieved_sections {
                let mut guard = acc.lock().await;
                for s in raw_sections {
                    merge_retrieved_section(&mut guard, s);
                }
            }
            Ok(text)
        }
        "get_section" => {
            let source_file = args["source_file"].as_str().unwrap_or("");
            let section_id = args["section_id"].as_str().unwrap_or("");
            let part = args["part"].as_u64().map(|p| p as usize);
            if source_file.is_empty() || section_id.is_empty() {
                return Ok("Both source_file and section_id are required.".into());
            }
            let win = read_window(args, crate::services::qdrant_store::GET_SECTION_WINDOW_TOKENS);
            let config = state.config.read().await;
            let collections: Vec<String> = if let Some(coll) = collection_override {
                vec![coll.to_string()]
            } else {
                vec![
                    config.qdrant_act_collection.clone(),
                    config.qdrant_sl_collection.clone(),
                ]
            };
            drop(config);
            let mut result = None;
            for coll in &collections {
                if let Ok(Some(section)) = state
                    .qdrant
                    .get_section_windowed(coll, source_file, section_id, part, win)
                    .await
                {
                    result = Some(section);
                    break;
                }
            }
            match result {
                Some(section) => {
                    let citations = extract_citations(std::slice::from_ref(&section));
                    if !citations.is_empty() {
                        pending_citations.lock().await.push(citations.clone());
                        let _ = broadcast_tx.send(ChatSseEvent::LegislationCitations { citations });
                    }
                    if let Some(acc) = retrieved_sections {
                        let mut guard = acc.lock().await;
                        // A get_section result replaces any search fragment of the
                        // same section, and adjacent paged windows are joined.
                        merge_retrieved_section(&mut guard, section.clone());
                    }
                    Ok(format_section_result(section))
                }
                None => Ok(format!(
                    "Section {} not found in '{}'.",
                    section_id, source_file
                )),
            }
        }
        "get_judgment" => {
            let case = args["case"].as_str().unwrap_or("");
            let part = args["part"].as_u64().map(|p| p as usize);
            if case.is_empty() {
                return Ok("The case parameter is required.".into());
            }
            let coll = match collection_override {
                Some(c) => c.to_string(),
                None => state.config.read().await.qdrant_judiciary_collection.clone(),
            };
            let win = read_window(args, crate::services::qdrant_store::GET_SECTION_WINDOW_TOKENS);
            match state.qdrant.get_judgment_windowed(&coll, case, part, win).await {
                Ok(Some(section)) => Ok(format_judgment_result(&section)),
                Ok(None) => Ok(format!("Judgment '{}' not found.", case)),
                Err(e) => Err(e.to_string()),
            }
        }
        _ => Err(format!("Unknown sub-agent tool: {}", name)),
    }
}

fn meta_str<'a>(m: &'a Value, k: &str) -> &'a str {
    m.get(k).and_then(|v| v.as_str()).unwrap_or("")
}

/// Heading for a judgment: case name, neutral citation, date and eLitigation link.
fn judgment_heading(meta: &Value) -> String {
    let case = meta_str(meta, "case_name");
    let cite = meta_str(meta, "neutral_citation");
    let mut h = format!("### {} {}", case, cite).trim_end().to_string();
    let date = meta_str(meta, "decision_date");
    if !date.is_empty() {
        h.push_str(&format!("\nDecision date: {}", date));
    }
    let url = meta_str(meta, "detail_url");
    if !url.is_empty() {
        h.push_str(&format!("\nSource: {}", url));
    }
    h
}

/// Render a `get_judgment` result: heading, the chunk text (each chunk marked
/// with its id) and a footer saying which parts it holds.
fn format_judgment_result(section: &crate::services::qdrant_store::ScoredSection) -> String {
    let m = &section.metadata;
    let total = m.get("chunk_total").and_then(|v| v.as_u64()).unwrap_or(1);
    let from = m.get("part_from").and_then(|v| v.as_u64()).unwrap_or(1);
    let to = m.get("part_to").and_then(|v| v.as_u64()).unwrap_or(total);
    let tokens = m.get("window_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
    let complete = m.get("complete").and_then(|v| v.as_bool()).unwrap_or(false);
    let clamped = m
        .get("part_clamped_from")
        .and_then(|v| v.as_u64())
        .map(|p| format!("[requested part {} is beyond the last part; showing the last window instead]\n", p))
        .unwrap_or_default();
    let footer = if complete {
        format!("[complete judgment, assembled from {} parts]", total)
    } else if to >= total {
        format!("[parts {}-{} of {} shown ({} tokens) — this is the end of the judgment]", from, to, total, tokens)
    } else {
        format!(
            "[parts {}-{} of {} shown ({} tokens) — the judgment CONTINUES: call get_judgment again with the same case and part={} to read the next parts]",
            from, to, total, tokens, to + 1
        )
    };
    format!(
        "{}\n(Do not repeat the party names in your answer; cite by neutral citation and link only.)\n\n{}\n\n{}{}",
        judgment_heading(m), section.text, clamped, footer
    )
}

/// Turn the judiciary sub-agent's JSON references into findings carrying the
/// exact judgment chunk text from Qdrant (the model never reproduces it).
pub(crate) async fn build_judgment_findings_result(
    sub_agent_output: &str,
    retrieved: &[crate::services::qdrant_store::ScoredSection],
    state: &Arc<AppState>,
    config: &AppConfig,
) -> Result<String, String> {
    #[derive(serde::Deserialize)]
    struct JudgmentRef {
        citation: Option<String>,
        chunk_id: Option<String>,
        relevance: Option<String>,
    }
    let mut refs: Vec<JudgmentRef> = match parse_json_refs(sub_agent_output) {
        Some(r) => r,
        None if sub_agent_output.trim() == "[]" => Vec::new(),
        None => {
            warn!("Judiciary sub-agent did not emit valid JSON references ({} chars)", sub_agent_output.len());
            return Ok(sub_agent_output.to_string());
        }
    };
    if refs.is_empty() {
        return Ok("No relevant judgments found.".to_string());
    }
    refs.truncate(MAX_CITE_REFS);

    // Group passages by case, keeping the order of first appearance.
    let mut cases: Vec<(String, String, Vec<String>)> = Vec::new(); // (key, heading, passages)
    let mut seen = std::collections::HashSet::new();
    let mut missing: Vec<String> = Vec::new();
    for r in &refs {
        let cid = r.chunk_id.as_deref().unwrap_or("").trim();
        if cid.is_empty() || !seen.insert(cid.to_string()) {
            continue;
        }
        // `_meta` points are headnote summaries, never quotable text.
        if crate::services::qdrant_store::judgment_chunk_number(cid).is_none() {
            warn!("judiciary cite-by-ref: skipping non-body reference '{}'", cid);
            continue;
        }
        let section = match retrieved.iter().find(|s| s.section_id == cid) {
            Some(s) => Some(s.clone()),
            None => state
                .qdrant
                .get_judgment_chunk(&config.qdrant_judiciary_collection, cid)
                .await
                .ok()
                .flatten(),
        };
        let Some(section) = section else {
            warn!("judiciary cite-by-ref: chunk not found anywhere: '{}' (possible hallucination)", cid);
            missing.push(format!(
                "### {} [NOT FOUND]\nRelevance: {}\n\n[Chunk not found in database — reference may be inaccurate]",
                cid,
                r.relevance.as_deref().unwrap_or("")
            ));
            continue;
        };
        let topics = meta_str(&section.metadata, "topic_indexes");
        let body = crate::services::qdrant_store::strip_judgment_prefix(&section.text, topics);
        let passage = format!(
            "**[{}]** Relevance: {}\n\n{}",
            cid,
            r.relevance.as_deref().unwrap_or(""),
            body
        );
        let key = {
            let c = meta_str(&section.metadata, "neutral_citation");
            if c.is_empty() { meta_str(&section.metadata, "source_file").to_string() } else { c.to_string() }
        };
        match cases.iter_mut().find(|c| c.0 == key) {
            Some(c) => c.2.push(passage),
            None => cases.push((key, judgment_heading(&section.metadata), vec![passage])),
        }
        let _ = &r.citation;
    }

    let n_passages: usize = cases.iter().map(|c| c.2.len()).sum();
    let mut parts: Vec<String> = cases
        .into_iter()
        .map(|(_, heading, passages)| format!("{}\n\n{}", heading, passages.join("\n\n")))
        .collect();
    let n_cases = parts.len();
    parts.extend(missing);
    if parts.is_empty() {
        return Ok("No relevant judgments found.".to_string());
    }
    let result = format!(
        "## Findings ({} judgment passages from {} cases)\n\nNOTE FOR THE FINAL ANSWER: the party names in the headings below must NOT appear in your answer. Cite each case only as its neutral citation plus link, e.g. \"[2023] SGHC 990 (link)\", never \"X v Y [2023] SGHC 990\".\n\n{}",
        n_passages,
        n_cases,
        parts.join("\n\n---\n\n")
    );
    Ok(apply_context_budget(result, config.rag_context_budget))
}

/// Normalize a name for fuzzy comparison: lowercase, collapse whitespace,
/// normalize all apostrophe-like characters to ASCII `'`, strip `.pdf`/`.md`.
fn normalize_name_for_match(s: &str) -> String {
    s.trim_end_matches(".pdf")
        .trim_end_matches(".md")
        .chars()
        .map(|c| match c {
            '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{0060}' | '\u{00B4}' => '\'',
            '\u{201C}' | '\u{201D}' | '\u{201E}' => '"',
            _ => c,
        })
        .collect::<String>()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Check if two act/document names refer to the same thing.
fn names_match(a: &str, b: &str) -> bool {
    if a.is_empty() || b.is_empty() {
        return false;
    }
    let na = normalize_name_for_match(a);
    let nb = normalize_name_for_match(b);
    na == nb || na.contains(&nb) || nb.contains(&na)
}

/// Normalize a section_id from sub-agent output for matching.
///
/// Numbered sections are stored as `s19` / `s2D` and compared upper-cased with the
/// `s` removed. Schedules and appendices (`schedule3`, `legislative_history`) are
/// stored verbatim, so they are left as given (stripping their leading `s` would
/// give `chedule3`, and upper-casing would no longer match the stored id).
fn normalize_section_id(sid: &str) -> String {
    let sid = sid.trim();
    let stripped = sid
        .strip_prefix("Section ")
        .or_else(|| sid.strip_prefix("section "))
        .or_else(|| sid.strip_prefix("Rule "))
        .or_else(|| sid.strip_prefix("rule "))
        .unwrap_or(sid)
        .trim();
    let stripped = stripped.strip_prefix('S').map_or(stripped, |rest| {
        if rest.chars().next().is_some_and(|c| c.is_ascii_digit()) {
            rest
        } else {
            stripped
        }
    });
    let stripped = crate::services::qdrant_store::strip_section_s_prefix(stripped);
    if stripped.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        stripped.to_uppercase()
    } else {
        stripped.to_string()
    }
}

/// Parse a sub-agent's JSON reference array. Tolerates ```json fences and
/// surrounding prose. If the array was cut off by the output-token cap, the
/// complete objects before the cut are kept instead of discarding everything.
/// `None` when no reference could be read at all.
fn parse_json_refs<T: serde::de::DeserializeOwned>(output: &str) -> Option<Vec<T>> {
    let trimmed = output.trim();
    let start = trimmed.find('[')?;
    if let Some(end) = trimmed.rfind(']')
        && end > start
        && let Ok(v) = serde_json::from_str::<Vec<T>>(&trimmed[start..=end])
    {
        return Some(v);
    }
    // Salvage: walk the text and parse each balanced top-level {...} object.
    let (mut depth, mut obj_start, mut in_str, mut esc) = (0usize, None, false, false);
    let mut out = Vec::new();
    for (i, c) in trimmed[start + 1..].char_indices() {
        let i = start + 1 + i;
        if in_str {
            if esc {
                esc = false;
            } else if c == '\\' {
                esc = true;
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        match c {
            '"' => in_str = true,
            '{' => {
                if depth == 0 {
                    obj_start = Some(i);
                }
                depth += 1;
            }
            '}' if depth > 0 => {
                depth -= 1;
                if depth == 0
                    && let Some(st) = obj_start.take()
                    && let Ok(v) = serde_json::from_str::<T>(&trimmed[st..=i])
                {
                    out.push(v);
                }
            }
            _ => {}
        }
    }
    if out.is_empty() { None } else { Some(out) }
}

/// Names a retrieved section can legitimately be cited by. Subsidiary
/// legislation is cited by its own document name only: its `act_name` is the
/// PARENT Act, and matching on it would pull another SL's same-numbered rule.
fn citable_names(s: &crate::services::qdrant_store::ScoredSection) -> Vec<String> {
    let meta = |k: &str| {
        s.metadata
            .get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    if meta("doc_type") == "subsidiary_legislation" {
        vec![meta("source_file")]
    } else {
        vec![meta("act_name"), meta("source_file")]
    }
}

/// Find the retrieved section a reference points at: an exact (normalised)
/// name match wins; a looser substring match is accepted only if it is the
/// single candidate, never by picking the first of several.
fn find_retrieved_match<'a>(
    retrieved: &'a [crate::services::qdrant_store::ScoredSection],
    act: &str,
    normalized_sid: &str,
) -> Option<&'a crate::services::qdrant_store::ScoredSection> {
    let want = normalize_name_for_match(act);
    let same_sid: Vec<&crate::services::qdrant_store::ScoredSection> = retrieved
        .iter()
        .filter(|s| {
            crate::services::qdrant_store::strip_section_s_prefix(&s.section_id)
                .eq_ignore_ascii_case(normalized_sid)
        })
        .collect();
    let exact: Vec<_> = same_sid
        .iter()
        .copied()
        .filter(|s| citable_names(s).iter().any(|n| !n.is_empty() && normalize_name_for_match(n) == want))
        .collect();
    if let Some(first) = exact.first() {
        return Some(first);
    }
    let loose: Vec<_> = same_sid
        .iter()
        .copied()
        .filter(|s| citable_names(s).iter().any(|n| names_match(n, act)))
        .collect();
    if loose.len() == 1 { Some(loose[0]) } else { None }
}

/// Most references one cite step will resolve. The sub-agent is asked for a handful; this only
/// bounds the Qdrant lookups when the output is unreasonably long (or the model is not ours).
pub(crate) const MAX_CITE_REFS: usize = 60;

/// Parse the sub-agent's JSON reference output and merge with raw Qdrant
/// sections to produce a tool result containing genuine statutory text.
///
/// If JSON parsing fails, falls back to the raw sub-agent output (legacy
/// verbatim behavior) so the orchestrator still gets useful content.
pub(crate) async fn build_cite_by_reference_result(
    sub_agent_output: &str,
    retrieved_sections: &[crate::services::qdrant_store::ScoredSection],
    state: &Arc<AppState>,
    config: &AppConfig,
) -> Result<String, String> {
    #[derive(serde::Deserialize)]
    struct SectionRef {
        #[serde(alias = "document_name")]
        act_name: Option<String>,
        section_id: Option<String>,
        relevance: Option<String>,
    }

    let mut refs: Vec<SectionRef> = match parse_json_refs(sub_agent_output) {
        Some(r) => r,
        None => {
            warn!(
                "Sub-agent did not emit valid JSON references, using raw output ({} chars)",
                sub_agent_output.len()
            );
            return Ok(sub_agent_output.to_string());
        }
    };

    if refs.is_empty() {
        return Ok("No relevant provisions found.".to_string());
    }
    refs.truncate(MAX_CITE_REFS);

    info!(
        "cite-by-ref: {} JSON refs, {} accumulated sections",
        refs.len(),
        retrieved_sections.len()
    );

    let mut parts: Vec<String> = Vec::new();
    let mut unmatched: Vec<&SectionRef> = Vec::new();

    for r in &refs {
        let act = r.act_name.as_deref().unwrap_or("");
        let sid = r.section_id.as_deref().unwrap_or("");
        if act.is_empty() || sid.is_empty() {
            continue;
        }

        let normalized_sid = normalize_section_id(sid);

        let matched = find_retrieved_match(retrieved_sections, act, &normalized_sid);

        if let Some(section) = matched {
            // A search hit on a split section is just one part of it. Re-fetch
            // the section so the orchestrator never receives a fragment as the
            // "exact statutory text".
            let upgraded = if is_chunk_fragment(section) {
                let src = section
                    .metadata
                    .get("source_file")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .unwrap_or(act);
                let coll = if section.metadata.get("doc_type").and_then(|v| v.as_str())
                    == Some("subsidiary_legislation")
                {
                    &config.qdrant_sl_collection
                } else {
                    &config.qdrant_act_collection
                };
                state
                    .qdrant
                    .get_section(coll, src, &section.section_id, None)
                    .await
                    .ok()
                    .flatten()
            } else {
                None
            };
            match upgraded {
                Some(full) => parts.push(format_matched_section(&full, act, r.relevance.as_deref())),
                None => parts.push(format_matched_section(section, act, r.relevance.as_deref())),
            }
        } else {
            // Log which sections ARE available from this act for debugging
            let available: Vec<String> = retrieved_sections
                .iter()
                .filter(|s| {
                    let s_act = s
                        .metadata
                        .get("act_name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let s_src = s
                        .metadata
                        .get("source_file")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    names_match(s_act, act) || names_match(s_src, act)
                })
                .map(|s| s.section_id.clone())
                .collect();
            if available.is_empty() {
                info!(
                    "cite-by-ref: no accumulator match for '{}' s{} (act not in accumulator at all)",
                    act, normalized_sid
                );
            } else {
                info!(
                    "cite-by-ref: act '{}' found in accumulator with sections {:?}, but not s{}",
                    act, available, normalized_sid
                );
            }
            unmatched.push(r);
        }
    }

    // Fallback: try get_section for references not matched in accumulated results.
    // Try multiple name variants (apostrophe normalization) since Qdrant `matches`
    // does exact keyword comparison and Unicode vs ASCII apostrophes differ.
    for r in &unmatched {
        let act = r.act_name.as_deref().unwrap_or("");
        let sid = r.section_id.as_deref().unwrap_or("");
        let normalized_sid = normalize_section_id(sid);

        // Build name variants: original, with ASCII apostrophe, with Unicode right quote
        let mut name_variants = vec![act.to_string()];
        let ascii_variant = act.replace(['\u{2019}', '\u{2018}'], "'");
        if ascii_variant != act {
            name_variants.push(ascii_variant);
        }
        let unicode_variant = act.replace('\'', "\u{2019}");
        if unicode_variant != act {
            name_variants.push(unicode_variant);
        }

        let act_coll = &config.qdrant_act_collection;
        let sl_coll = &config.qdrant_sl_collection;
        let mut found = None;
        'name_loop: for name in &name_variants {
            for coll in [act_coll, sl_coll] {
                if let Ok(Some(section)) =
                    state.qdrant.get_section(coll, name, &normalized_sid, None).await
                {
                    found = Some(section);
                    break 'name_loop;
                }
            }
        }
        if let Some(section) = found {
            parts.push(format_matched_section(
                &section,
                act,
                r.relevance.as_deref(),
            ));
        } else {
            warn!(
                "cite-by-ref: section not found anywhere: '{}' s{} (possible hallucination)",
                act, normalized_sid
            );
            let relevance = r.relevance.as_deref().unwrap_or("");
            let mut entry = format!(
                "### {}, Section {} [NOT FOUND]\nRelevance: {}",
                act, normalized_sid, relevance
            );
            entry.push_str("\n\n[Section not found in database — reference may be inaccurate]");
            parts.push(entry);
        }
    }

    if parts.is_empty() {
        return Ok("No relevant provisions found.".to_string());
    }

    let result = format!(
        "## Findings ({} relevant provisions)\n\n{}",
        parts.len(),
        parts.join("\n\n---\n\n")
    );

    Ok(apply_context_budget(result, config.rag_context_budget))
}

fn retrieved_key(s: &crate::services::qdrant_store::ScoredSection) -> String {
    format!("{}|{}", section_source_key(s), s.section_id)
}

/// True for a search hit that is one part of a split section: it carries a
/// `chunk_index >= 1` but was not produced by `get_section` (which sets `part_from`).
fn is_chunk_fragment(s: &crate::services::qdrant_store::ScoredSection) -> bool {
    s.metadata.get("part_from").is_none()
        && s.metadata.get("chunk_index").and_then(|v| v.as_i64()).unwrap_or(0) >= 1
}

/// Add a retrieved section to the sub-agent accumulator.
///
/// The accumulator is keyed on source + section id, and the text kept there is
/// what the orchestrator finally receives as "exact statutory text". A search
/// hit is only one part of a split section, so it must never displace the
/// (full or paged) text returned by `get_section`:
/// - nothing stored yet: store it;
/// - stored search hit, new `get_section` result: replace;
/// - stored and new are both `get_section` windows and the new one starts right
///   after the stored one: join them;
/// - anything else (including a later search hit): keep what is stored.
pub(crate) fn merge_retrieved_section(
    acc: &mut Vec<crate::services::qdrant_store::ScoredSection>,
    s: crate::services::qdrant_store::ScoredSection,
) {
    let key = retrieved_key(&s);
    let Some(pos) = acc.iter().position(|e| retrieved_key(e) == key) else {
        acc.push(s);
        return;
    };
    let new_paged = s.metadata.get("part_from").is_some();
    let old_paged = acc[pos].metadata.get("part_from").is_some();
    match (old_paged, new_paged) {
        (false, true) => acc[pos] = s,
        (true, true) => {
            let num = |m: &Value, k: &str| m.get(k).and_then(|v| v.as_u64());
            let (old_to, new_from) = (num(&acc[pos].metadata, "part_to"), num(&s.metadata, "part_from"));
            if let (Some(old_to), Some(new_from)) = (old_to, new_from)
                && new_from == old_to + 1
            {
                let new_to = num(&s.metadata, "part_to").unwrap_or(new_from);
                let total = num(&s.metadata, "chunk_total").unwrap_or(new_to);
                let old_from = num(&acc[pos].metadata, "part_from").unwrap_or(1);
                let tokens = num(&acc[pos].metadata, "window_tokens").unwrap_or(0)
                    + num(&s.metadata, "window_tokens").unwrap_or(0);
                acc[pos].text.push_str("\n\n");
                acc[pos].text.push_str(&s.text);
                if let Some(obj) = acc[pos].metadata.as_object_mut() {
                    obj.insert("part_to".into(), serde_json::json!(new_to));
                    obj.insert("window_tokens".into(), serde_json::json!(tokens));
                    obj.insert("complete".into(), serde_json::json!(old_from == 1 && new_to >= total));
                }
            }
        }
        _ => {}
    }
}

/// Format a matched section into the tool-result entry.
fn format_matched_section(
    section: &crate::services::qdrant_store::ScoredSection,
    fallback_act: &str,
    relevance: Option<&str>,
) -> String {
    let doc_type = section
        .metadata
        .get("doc_type")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let source = section
        .metadata
        .get("source_file")
        .and_then(|v| v.as_str())
        .map(|f| f.trim_end_matches(".pdf"))
        .unwrap_or("");
    // For SL: use source_file (the SL document name), not act_name (parent Act)
    let display_name = if doc_type == "subsidiary_legislation" && !source.is_empty() {
        source
    } else {
        section
            .metadata
            .get("act_name")
            .and_then(|v| v.as_str())
            .filter(|v| !v.is_empty())
            .unwrap_or(if !source.is_empty() {
                source
            } else {
                fallback_act
            })
    };
    let display_sid = crate::services::qdrant_store::strip_section_s_prefix(&section.section_id);
    let mut entry = format!("### {}, Section {}", display_name, display_sid);
    if let Some(rel) = relevance
        && !rel.is_empty()
    {
        entry.push_str(&format!("\nRelevance: {}", rel));
    }
    entry.push_str(&format!("\n\n{}", section.text));
    // Tell the orchestrator when this entry is only part of a long section.
    entry.push_str(&section_parts_footer(section));
    entry
}

/// Stable key for deduplicating sections: prefer source_file for SL entries,
/// otherwise act_name.
fn section_source_key(s: &crate::services::qdrant_store::ScoredSection) -> String {
    let doc_type = s
        .metadata
        .get("doc_type")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let source = s
        .metadata
        .get("source_file")
        .and_then(|v| v.as_str())
        .map(|f| f.trim_end_matches(".pdf"))
        .unwrap_or("");
    if doc_type == "subsidiary_legislation" && !source.is_empty() {
        return source.to_string();
    }
    s.metadata
        .get("act_name")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .unwrap_or(if !source.is_empty() { source } else { "" })
        .to_string()
}

/// Execute a search tool (Send-safe, no async recursion).
/// Returns the formatted text result for the LLM.
pub(crate) async fn execute_search_tool(
    state: &Arc<AppState>,
    name: &str,
    args: &Value,
    _mode: &str,
) -> Result<String, String> {
    let (text, _citations) =
        execute_search_tool_with_citations(state, name, args, _mode, None).await?;
    Ok(text)
}

/// Execute a search tool, return (text, citations, raw_sections).
/// Same as `execute_search_tool_with_citations` but also returns raw
/// `ScoredSection` objects for the cite-by-reference accumulator.
async fn execute_search_tool_with_citations_and_sections(
    state: &Arc<AppState>,
    name: &str,
    args: &Value,
    _mode: &str,
    collection_override: Option<&str>,
) -> Result<
    (
        String,
        Vec<LegislationCitation>,
        Vec<crate::services::qdrant_store::ScoredSection>,
    ),
    String,
> {
    use sha2::{Digest, Sha256};

    let query = args["query"].as_str().unwrap_or("");
    let top_k = search_top_k(args);
    let config = state.config.read().await;
    let is_legislation = name == "search_legislation";
    let scope = args
        .get("act_name")
        .or_else(|| args.get("case_name"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let reranker_enabled = config.reranker_enabled;
    let rag_context_budget = config.rag_context_budget;

    let cache_key = {
        let mut h = Sha256::new();
        h.update(name.as_bytes());
        h.update(b"\x00");
        h.update(query.as_bytes());
        h.update(b"\x00");
        h.update(scope.as_bytes());
        h.update(b"\x00");
        h.update(top_k.to_string().as_bytes());
        h.update(b"\x00");
        h.update(if reranker_enabled { b"1" } else { b"0" });
        format!("{:x}", h.finalize())
    };

    if !is_legislation && let Some(cached) = state.qdrant.search_result_cache.get(&cache_key).await
    {
        return Ok((cached, Vec::new(), Vec::new()));
    }

    let act_name = if scope.is_empty() { None } else { Some(scope) };

    let results = if let Some(coll) = collection_override {
        state
            .qdrant
            .search_sections(coll, query, top_k, act_name, None, &config)
            .await
            .map_err(|e| e.to_string())?
    } else if is_legislation {
        let act_coll = config.qdrant_act_collection.clone();
        let sl_coll = config.qdrant_sl_collection.clone();
        let (act_res, sl_res) = tokio::join!(
            state
                .qdrant
                .search_sections(&act_coll, query, top_k, act_name, None, &config),
            state
                .qdrant
                .search_sections(&sl_coll, query, top_k, act_name, None, &config)
        );
        let mut merged = act_res.map_err(|e| e.to_string())?;
        merged.extend(sl_res.map_err(|e| e.to_string())?);
        merged.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        merged.truncate(top_k);
        merged
    } else {
        let collection = config.qdrant_judiciary_collection.clone();
        state
            .qdrant
            .search_sections(&collection, query, top_k, act_name, None, &config)
            .await
            .map_err(|e| e.to_string())?
    };

    if results.is_empty() {
        Ok((
            "No relevant sections found for this query.".into(),
            Vec::new(),
            Vec::new(),
        ))
    } else {
        let citations = if is_legislation {
            extract_citations(&results)
        } else {
            Vec::new()
        };
        let mut results = results;
        if is_legislation {
            annotate_chunk_totals(
                state,
                &config.qdrant_act_collection,
                &config.qdrant_sl_collection,
                &mut results,
            )
            .await;
        }
        let raw = format_search_results(&results, name == "search_judiciary");
        let text = apply_context_budget(raw, rag_context_budget);
        if !is_legislation {
            state
                .qdrant
                .search_result_cache
                .insert(cache_key, text.clone())
                .await;
        }
        Ok((text, citations, results))
    }
}

/// Execute a search tool and also return SSO citations for legislation searches.
/// `collection_override`: if set, search only this collection instead of the
/// default dual-collection merge for legislation.
async fn execute_search_tool_with_citations(
    state: &Arc<AppState>,
    name: &str,
    args: &Value,
    _mode: &str,
    collection_override: Option<&str>,
) -> Result<(String, Vec<LegislationCitation>), String> {
    use sha2::{Digest, Sha256};

    let query = args["query"].as_str().unwrap_or("");
    let top_k = search_top_k(args);
    let config = state.config.read().await;
    let is_legislation = name == "search_legislation";
    let scope = args
        .get("act_name")
        .or_else(|| args.get("case_name"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let reranker_enabled = config.reranker_enabled;
    let rag_context_budget = config.rag_context_budget;

    let cache_key = {
        let mut h = Sha256::new();
        h.update(name.as_bytes());
        h.update(b"\x00");
        h.update(query.as_bytes());
        h.update(b"\x00");
        h.update(scope.as_bytes());
        h.update(b"\x00");
        h.update(top_k.to_string().as_bytes());
        h.update(b"\x00");
        h.update(if reranker_enabled { b"1" } else { b"0" });
        format!("{:x}", h.finalize())
    };

    if !is_legislation && let Some(cached) = state.qdrant.search_result_cache.get(&cache_key).await
    {
        return Ok((cached, Vec::new()));
    }

    let act_name = if scope.is_empty() { None } else { Some(scope) };

    let results = if let Some(coll) = collection_override {
        state
            .qdrant
            .search_sections(coll, query, top_k, act_name, None, &config)
            .await
            .map_err(|e| e.to_string())?
    } else if is_legislation {
        let act_coll = config.qdrant_act_collection.clone();
        let sl_coll = config.qdrant_sl_collection.clone();
        let (act_res, sl_res) = tokio::join!(
            state
                .qdrant
                .search_sections(&act_coll, query, top_k, act_name, None, &config),
            state
                .qdrant
                .search_sections(&sl_coll, query, top_k, act_name, None, &config)
        );
        let mut merged = act_res.map_err(|e| e.to_string())?;
        merged.extend(sl_res.map_err(|e| e.to_string())?);
        merged.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        merged.truncate(top_k);
        merged
    } else {
        let collection = config.qdrant_judiciary_collection.clone();
        state
            .qdrant
            .search_sections(&collection, query, top_k, act_name, None, &config)
            .await
            .map_err(|e| e.to_string())?
    };

    if results.is_empty() {
        Ok((
            "No relevant sections found for this query.".into(),
            Vec::new(),
        ))
    } else {
        let citations = if is_legislation {
            extract_citations(&results)
        } else {
            Vec::new()
        };
        let mut results = results;
        if is_legislation {
            annotate_chunk_totals(
                state,
                &config.qdrant_act_collection,
                &config.qdrant_sl_collection,
                &mut results,
            )
            .await;
        }
        let raw = format_search_results(&results, name == "search_judiciary");
        let text = apply_context_budget(raw, rag_context_budget);
        if !is_legislation {
            state
                .qdrant
                .search_result_cache
                .insert(cache_key, text.clone())
                .await;
        }
        Ok((text, citations))
    }
}

/// Message shown on a failed research search and handed to the model.
fn tool_failure_message(error: &str) -> String {
    if is_db_timeout(error) {
        db_timeout_tool_message()
    } else {
        "[ERROR] This search is unavailable right now.".to_string()
    }
}

/// Wrap a sub-agent's tool executor so each of its own searches is streamed
/// to the client as part of the sub-agent transcript.
fn wrap_sub_tool(
    inner: ToolExecutorFn,
    bcast: &tokio::sync::broadcast::Sender<ChatSseEvent>,
    task_id: Option<&str>,
) -> ToolExecutorFn {
    let Some(task_id) = task_id.map(String::from) else {
        return inner;
    };
    let bcast = bcast.clone();
    let counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    Arc::new(move |n: String, a: Value| {
        let inner = Arc::clone(&inner);
        let bcast = bcast.clone();
        let task_id = task_id.clone();
        let id = format!(
            "s{}",
            counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        Box::pin(async move {
            let _ = bcast.send(ChatSseEvent::SubagentToolCall {
                task_id: task_id.clone(),
                id: id.clone(),
                name: n.clone(),
                arguments: a.clone(),
            });
            let res = inner(n.clone(), a).await;
            let (result, is_error) = match &res {
                Ok(t) => (t.clone(), t.starts_with("[ERROR]")),
                Err(e) => {
                    warn!("sub-agent tool {} failed: {:#}", n, e);
                    (tool_failure_message(&e.to_string()), true)
                }
            };
            let _ = bcast.send(ChatSseEvent::SubagentToolResult {
                task_id,
                id,
                name: n,
                result,
                is_error,
            });
            res
        })
    })
}

/// Execute a tool call. Research tools run as sub-agents whose lifecycle and
/// inner searches are streamed as `subagent_*` events keyed by the call id.
async fn execute_tool(
    state: &Arc<AppState>,
    session_id: &str,
    mode: &str,
    name: &str,
    args: &Value,
    broadcast_tx: tokio::sync::broadcast::Sender<ChatSseEvent>,
    pending_citations: Arc<tokio::sync::Mutex<Vec<Vec<LegislationCitation>>>>,
) -> Result<String, String> {
    let mut args = args.clone();
    let call_id = args
        .as_object_mut()
        .and_then(|o| o.remove("__call_id"))
        .and_then(|v| v.as_str().map(String::from));
    let (description, subagent_type) = match name {
        "research_legislation" => ("Legislation research", "legislation"),
        "research_subsidiary_legislation" => ("Subsidiary legislation research", "subsidiary-legislation"),
        "legislation_agent" => ("Legislation agent", "legislation"),
        "judiciary_agent" => ("Judiciary agent", "judiciary"),
        "research_judiciary" => ("Judiciary research", "judiciary"),
        _ => ("", ""),
    };
    let Some(task_id) = call_id.filter(|_| !description.is_empty()) else {
        return execute_tool_inner(
            state, session_id, mode, name, &args, broadcast_tx, pending_citations, None,
        )
        .await;
    };
    let _ = broadcast_tx.send(ChatSseEvent::SubagentStart {
        task_id: task_id.clone(),
        tool: name.to_string(),
        description: description.to_string(),
        subagent_type: subagent_type.to_string(),
        prompt: args["prompt"].as_str().unwrap_or("").to_string(),
    });
    // Searches of this research task that wait for the reranker report their queue here.
    let queue_sink: QueueSink = {
        let tx = broadcast_tx.clone();
        let task_id = task_id.clone();
        Arc::new(move |q: QueueInfo| {
            let _ = tx.send(ChatSseEvent::Queue {
                task_id: task_id.clone(),
                waiting: q.waiting,
                eta_s: q.eta_s,
            });
        })
    };
    // Same for a Qdrant call that misses its deadline, and for the next one that succeeds.
    let db_sink: DbSink = {
        let tx = broadcast_tx.clone();
        let task_id = task_id.clone();
        let shown = Arc::new(std::sync::atomic::AtomicBool::new(false));
        Arc::new(move |timeout_s: u64| {
            use std::sync::atomic::Ordering::Relaxed;
            // `0` only clears a notice that was actually shown.
            if timeout_s == 0 && !shown.swap(false, Relaxed) {
                return;
            }
            if timeout_s > 0 {
                shown.store(true, Relaxed);
            }
            let _ = tx.send(ChatSseEvent::DbSlow { task_id: task_id.clone(), timeout_s });
        })
    };
    let res = QUEUE_SINK
        .scope(
            queue_sink,
            DB_SINK.scope(
                db_sink,
                execute_tool_inner(
                    state, session_id, mode, name, &args, broadcast_tx.clone(), pending_citations, Some(&task_id),
                ),
            ),
        )
        .await;
    let (is_error, output) = match &res {
        Ok(t) => (t.starts_with("[ERROR]"), t.clone()),
        Err(e) => (true, tool_failure_message(e)),
    };
    let _ = broadcast_tx.send(ChatSseEvent::SubagentEnd { task_id, is_error, output });
    res
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn execute_tool_inner(
    state: &Arc<AppState>,
    _session_id: &str,
    mode: &str,
    name: &str,
    args: &Value,
    broadcast_tx: tokio::sync::broadcast::Sender<ChatSseEvent>,
    pending_citations: Arc<tokio::sync::Mutex<Vec<Vec<LegislationCitation>>>>,
    task_id: Option<&str>,
) -> Result<String, String> {
    match name {
        "classify_issue" => {
            debug!(
                "classify_issue called: missing_details_len={}",
                args["missing_details"]
                    .as_array()
                    .map(|a| a.len())
                    .unwrap_or(0)
            );
            // Return structured result matching Python (feeds back to LLM for context)
            let categories = args["categories"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_default();
            let summary = args["summary"].as_str().unwrap_or("");
            let missing: Vec<&str> = args["missing_details"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
                .unwrap_or_default();
            let mut parts = vec![format!("Classification: {}", categories)];
            if !summary.is_empty() {
                parts.push(format!("Summary: {}", summary));
            }
            if !missing.is_empty() {
                parts.push(format!("Still needed: {}", missing.join("; ")));
            }
            Ok(parts.join("\n"))
        }
        "get_section" => {
            let source_file = args["source_file"].as_str().unwrap_or("");
            let section_id = args["section_id"].as_str().unwrap_or("");
            let part = args["part"].as_u64().map(|p| p as usize);
            if source_file.is_empty() || section_id.is_empty() {
                return Ok("Both source_file and section_id are required.".into());
            }
            let config = state.config.read().await;
            let act_coll = config.qdrant_act_collection.clone();
            let sl_coll = config.qdrant_sl_collection.clone();
            drop(config);
            let win = read_window(args, crate::services::qdrant_store::ORCHESTRATOR_READ_WINDOW_TOKENS);
            let result = match state
                .qdrant
                .get_section_windowed(&act_coll, source_file, section_id, part, win)
                .await
            {
                Ok(Some(section)) => Some(section),
                _ => state
                    .qdrant
                    .get_section_windowed(&sl_coll, source_file, section_id, part, win)
                    .await
                    .ok()
                    .flatten(),
            };
            match result {
                Some(section) => {
                    let citations = extract_citations(std::slice::from_ref(&section));
                    if !citations.is_empty() {
                        pending_citations.lock().await.push(citations.clone());
                        let _ = broadcast_tx.send(ChatSseEvent::LegislationCitations { citations });
                    }
                    Ok(format_section_result(section))
                }
                None => Ok(format!(
                    "Section {} not found in '{}'.",
                    section_id, source_file
                )),
            }
        }
        "get_judgment" => {
            let case = args["case"].as_str().unwrap_or("");
            let part = args["part"].as_u64().map(|p| p as usize);
            if case.is_empty() {
                return Ok("The case parameter is required.".into());
            }
            let coll = state.config.read().await.qdrant_judiciary_collection.clone();
            let win = read_window(args, crate::services::qdrant_store::ORCHESTRATOR_READ_WINDOW_TOKENS);
            match state.qdrant.get_judgment_windowed(&coll, case, part, win).await {
                Ok(Some(section)) => Ok(format_judgment_result(&section)),
                Ok(None) => Ok(format!("Judgment '{}' not found.", case)),
                Err(e) => Err(e.to_string()),
            }
        }
        crate::services::web_search::TOOL_TAVILY => {
            let key = state.config.read().await.tavily_api_key.expose().to_string();
            crate::services::web_search::search_tavily(&key, args).await
        }
        crate::services::web_search::TOOL_DEEPSEEK => {
            let (base, key) = {
                let c = state.config.read().await;
                (c.deepseek_base_url.clone(), c.deepseek_api_key.expose().to_string())
            };
            crate::services::web_search::search_deepseek(&base, &key, args).await
        }
        "search_legislation" | "search_judiciary" => {
            let (text, citations) =
                execute_search_tool_with_citations(state, name, args, mode, None).await?;
            if !citations.is_empty() {
                pending_citations.lock().await.push(citations.clone());
                let _ = broadcast_tx.send(ChatSseEvent::LegislationCitations { citations });
            }
            Ok(text)
        }
        "research_legislation" => {
            let prompt = args["prompt"].as_str().unwrap_or("");
            let tool_name = name.to_string();
            let config = state.config.read().await.clone();
            let act_coll = config.qdrant_act_collection.clone();

            let retrieved: Arc<
                tokio::sync::Mutex<Vec<crate::services::qdrant_store::ScoredSection>>,
            > = Arc::new(tokio::sync::Mutex::new(Vec::new()));
            let retrieved_for_tool = Arc::clone(&retrieved);

            let state_clone = Arc::clone(state);
            let bcast_clone = broadcast_tx.clone();
            let cit_clone = Arc::clone(&pending_citations);
            let sub_tool: ToolExecutorFn = Arc::new(
                move |n: String,
                      a: Value|
                      -> std::pin::Pin<
                    Box<dyn std::future::Future<Output = Result<String, String>> + Send>,
                > {
                    let s = Arc::clone(&state_clone);
                    let b = bcast_clone.clone();
                    let c = Arc::clone(&cit_clone);
                    let coll = act_coll.clone();
                    let acc = Arc::clone(&retrieved_for_tool);
                    Box::pin(async move {
                        execute_sub_agent_tool(&s, &n, &a, &b, &c, Some(&coll), Some(&acc)).await
                    })
                },
            );

            let sub_tool = wrap_sub_tool(sub_tool, &broadcast_tx, task_id);
            let (prog_tx, mut prog_rx) = tokio::sync::mpsc::channel::<(usize, &'static str)>(32);
            let bcast = broadcast_tx.clone();
            let tool_name_clone = tool_name.clone();
            tokio::spawn(async move {
                while let Some((searches, phase)) = prog_rx.recv().await {
                    let _ = bcast.send(ChatSseEvent::ToolProgress {
                        name: tool_name_clone.clone(),
                        searches: searches as u32,
                        phase: phase.to_string(),
                    });
                }
            });

            let sub_agent_output = state
                .deepseek
                .run_sub_agent(
                    &config,
                    prompt,
                    "legislation_research",
                    sub_tool,
                    Some(prog_tx),
                )
                .await?;

            let sections = retrieved.lock().await;
            build_cite_by_reference_result(&sub_agent_output, &sections, state, &config).await
        }
        "research_subsidiary_legislation" => {
            let prompt = args["prompt"].as_str().unwrap_or("");
            let act_names: Vec<String> = args["parent_act_names"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            let full_prompt = if act_names.is_empty() {
                prompt.to_string()
            } else {
                format!(
                    "{}\n\nParent Act(s) to research: {}",
                    prompt,
                    act_names.join(", ")
                )
            };
            let tool_name = name.to_string();
            let config = state.config.read().await.clone();
            let sl_coll = config.qdrant_sl_collection.clone();

            let retrieved: Arc<
                tokio::sync::Mutex<Vec<crate::services::qdrant_store::ScoredSection>>,
            > = Arc::new(tokio::sync::Mutex::new(Vec::new()));
            let retrieved_for_tool = Arc::clone(&retrieved);

            let state_clone = Arc::clone(state);
            let bcast_clone = broadcast_tx.clone();
            let cit_clone = Arc::clone(&pending_citations);
            let sub_tool: ToolExecutorFn = Arc::new(
                move |n: String,
                      a: Value|
                      -> std::pin::Pin<
                    Box<dyn std::future::Future<Output = Result<String, String>> + Send>,
                > {
                    let s = Arc::clone(&state_clone);
                    let b = bcast_clone.clone();
                    let c = Arc::clone(&cit_clone);
                    let coll = sl_coll.clone();
                    let acc = Arc::clone(&retrieved_for_tool);
                    Box::pin(async move {
                        execute_sub_agent_tool(&s, &n, &a, &b, &c, Some(&coll), Some(&acc)).await
                    })
                },
            );

            let sub_tool = wrap_sub_tool(sub_tool, &broadcast_tx, task_id);
            let (prog_tx, mut prog_rx) = tokio::sync::mpsc::channel::<(usize, &'static str)>(32);
            let bcast = broadcast_tx.clone();
            let tool_name_clone = tool_name.clone();
            tokio::spawn(async move {
                while let Some((searches, phase)) = prog_rx.recv().await {
                    let _ = bcast.send(ChatSseEvent::ToolProgress {
                        name: tool_name_clone.clone(),
                        searches: searches as u32,
                        phase: phase.to_string(),
                    });
                }
            });

            let sub_agent_output = state
                .deepseek
                .run_sub_agent(
                    &config,
                    &full_prompt,
                    "legislation_sl",
                    sub_tool,
                    Some(prog_tx),
                )
                .await?;

            let sections = retrieved.lock().await;
            build_cite_by_reference_result(&sub_agent_output, &sections, state, &config).await
        }
        "research_judiciary" => {
            let prompt = args["prompt"].as_str().unwrap_or("");
            let tool_name = name.to_string();
            let config = state.config.read().await.clone();
            let jud_coll = config.qdrant_judiciary_collection.clone();

            let retrieved: Arc<
                tokio::sync::Mutex<Vec<crate::services::qdrant_store::ScoredSection>>,
            > = Arc::new(tokio::sync::Mutex::new(Vec::new()));
            let retrieved_for_tool = Arc::clone(&retrieved);

            let state_clone = Arc::clone(state);
            let bcast_clone = broadcast_tx.clone();
            let cit_clone = Arc::clone(&pending_citations);
            let sub_tool: ToolExecutorFn = Arc::new(
                move |n: String,
                      a: Value|
                      -> std::pin::Pin<
                    Box<dyn std::future::Future<Output = Result<String, String>> + Send>,
                > {
                    let s = Arc::clone(&state_clone);
                    let b = bcast_clone.clone();
                    let c = Arc::clone(&cit_clone);
                    let coll = jud_coll.clone();
                    let acc = Arc::clone(&retrieved_for_tool);
                    Box::pin(async move {
                        execute_sub_agent_tool(&s, &n, &a, &b, &c, Some(&coll), Some(&acc)).await
                    })
                },
            );

            let sub_tool = wrap_sub_tool(sub_tool, &broadcast_tx, task_id);
            let (prog_tx, mut prog_rx) = tokio::sync::mpsc::channel::<(usize, &'static str)>(32);
            let bcast = broadcast_tx.clone();
            let tool_name_clone = tool_name.clone();
            tokio::spawn(async move {
                while let Some((searches, phase)) = prog_rx.recv().await {
                    let _ = bcast.send(ChatSseEvent::ToolProgress {
                        name: tool_name_clone.clone(),
                        searches: searches as u32,
                        phase: phase.to_string(),
                    });
                }
            });

            let sub_agent_output = state
                .deepseek
                .run_sub_agent(&config, prompt, "judiciary_research", sub_tool, Some(prog_tx))
                .await?;

            let sections = retrieved.lock().await;
            build_judgment_findings_result(&sub_agent_output, &sections, state, &config).await
        }
        "legislation_agent" | "judiciary_agent" => {
            let prompt = args["prompt"].as_str().unwrap_or("");
            let sub_mode = if name == "legislation_agent" {
                "legislation"
            } else {
                "judiciary"
            };
            let tool_name = name.to_string();
            let config = state.config.read().await;

            let state_clone = Arc::clone(state);
            let mode_clone = mode.to_string();
            let is_legislation_agent = name == "legislation_agent";
            let bcast_tool = broadcast_tx.clone();
            let cit_tool = Arc::clone(&pending_citations);
            let sub_tool: ToolExecutorFn = Arc::new(
                move |n: String,
                      a: Value|
                      -> std::pin::Pin<
                    Box<dyn std::future::Future<Output = Result<String, String>> + Send>,
                > {
                    let s = Arc::clone(&state_clone);
                    let m = mode_clone.clone();
                    let b = bcast_tool.clone();
                    let c = Arc::clone(&cit_tool);
                    Box::pin(async move {
                        // The legislation agent also has get_section. execute_search_tool
                        // only knows the search tools and would send get_section to the
                        // judiciary collection, so use the chunk-aware sub-agent executor.
                        if is_legislation_agent {
                            execute_sub_agent_tool(&s, &n, &a, &b, &c, None, None).await
                        } else {
                            execute_search_tool(&s, &n, &a, &m).await
                        }
                    })
                },
            );

            let sub_tool = wrap_sub_tool(sub_tool, &broadcast_tx, task_id);
            let (prog_tx, mut prog_rx) = tokio::sync::mpsc::channel::<(usize, &'static str)>(32);
            let bcast = broadcast_tx.clone();
            let tool_name_clone = tool_name.clone();
            tokio::spawn(async move {
                while let Some((searches, phase)) = prog_rx.recv().await {
                    let _ = bcast.send(ChatSseEvent::ToolProgress {
                        name: tool_name_clone.clone(),
                        searches: searches as u32,
                        phase: phase.to_string(),
                    });
                }
            });

            state
                .deepseek
                .run_sub_agent(&config, prompt, sub_mode, sub_tool, Some(prog_tx))
                .await
        }
        "askquestion" => {
            let questions = args["questions"].clone();
            let count = questions.as_array().map(|a| a.len()).unwrap_or(0);
            if count == 0 {
                return Ok("No questions were provided, so nothing was shown to the user.".into());
            }
            let request_id = uuid::Uuid::new_v4().to_string();
            let _ = broadcast_tx.send(ChatSseEvent::QuestionRequest {
                request_id,
                questions,
                title: args["title"].as_str().map(String::from),
            });
            Ok(format!(
                "Asked the user {count} question(s); they are shown in the UI as an interactive form. \
                 End your turn now with a one-line note and wait for the user's answers."
            ))
        }
        _ => Err(format!("Unknown tool: {}", name)),
    }
}


#[cfg(test)]
mod chunk_tests {
    use super::*;
    use crate::services::qdrant_store::ScoredSection;
    use serde_json::json;

    #[test]
    fn top_k_always_lands_between_one_and_eight() {
        let k = |v: Value| search_top_k(&json!({ "top_k": v }));
        assert_eq!(search_top_k(&json!({})), 4, "default");
        for (given, want) in [(json!(3), 3), (json!(8), 8), (json!(9), 8), (json!(100000), 8), (json!(1), 1), (json!(0), 1)] {
            assert_eq!(k(given.clone()), want, "{given}");
        }
        // Negative values used to wrap to ~2^64 and fetch every document (a 2013-document rerank).
        for neg in [-1i64, -5, i64::MIN] {
            assert_eq!(k(json!(neg)), 1, "{neg}");
        }
        // Not an integer: the default, never a panic or a huge number.
        for odd in [json!("many"), json!(null), json!(2.5), json!([1]), json!(u64::MAX)] {
            assert!((1..=8).contains(&k(odd.clone())), "{odd}");
        }
    }

    fn hit(section_id: &str, chunk_index: i64, text: &str) -> ScoredSection {
        ScoredSection {
            text: text.into(),
            score: 0.85,
            section_id: section_id.into(),
            metadata: json!({
                "doc_type": "act",
                "act_name": "Legal Profession Act 1966",
                "source_file": "Legal Profession Act 1966.md",
                "chunk_index": chunk_index,
            }),
        }
    }

    fn window(
        section_id: &str,
        from: u64,
        to: u64,
        total: u64,
        tokens: u64,
        text: &str,
    ) -> ScoredSection {
        let mut s = hit(section_id, 1, text);
        let m = s.metadata.as_object_mut().unwrap();
        m.insert("chunk_total".into(), json!(total));
        m.insert("part_from".into(), json!(from));
        m.insert("part_to".into(), json!(to));
        m.insert("window_tokens".into(), json!(tokens));
        m.insert("complete".into(), json!(from == 1 && to == total));
        s
    }

    #[test]
    fn unchunked_hit_output_is_unchanged() {
        let out = format_search_results(&[hit("s5", 0, "body")], false);
        assert_eq!(out, "[s5 | Legal Profession Act 1966 | relevance 85%]\nbody");
    }

    #[test]
    fn chunked_hit_is_marked_without_touching_the_header() {
        let out = format_search_results(&[hit("s2D", 2, "body")], false);
        let first = out.lines().next().unwrap();
        assert_eq!(first, "[s2D | Legal Profession Act 1966 | relevance 85%]");
        let header_re = regex::Regex::new(r"^\[s\d+[A-Z]* \| .* \| relevance \d+%\]$").unwrap();
        assert!(header_re.is_match(first));
        assert!(out.contains("[part 2 — this is only one part"), "{out}");
        assert!(out.contains("section_id \"s2D\""));
    }

    #[test]
    fn chunked_hit_reports_total_when_known() {
        let mut h = hit("schedule3", 2, "body");
        h.metadata
            .as_object_mut()
            .unwrap()
            .insert("chunk_total".into(), json!(5));
        let out = format_search_results(&[h], false);
        assert!(out.contains("[part 2 of 5 —"), "{out}");
    }

    #[test]
    fn footer_for_complete_paged_and_last_windows() {
        let complete = window("s2D", 1, 2, 2, 900, "x");
        assert!(section_parts_footer(&complete).contains("[complete section, assembled from 2 parts]"));

        let first = window("schedule1", 1, 7, 42, 19_000, "x");
        let f = section_parts_footer(&first);
        assert!(f.contains("parts 1-7 of 42"), "{f}");
        assert!(f.contains("CONTINUES"));
        assert!(f.contains("part=8"));

        let last = window("schedule1", 36, 42, 42, 12_000, "x");
        assert!(section_parts_footer(&last).contains("end of the section"));

        // unsplit sections carry no footer, so their output is unchanged
        assert_eq!(section_parts_footer(&hit("s5", 0, "x")), "");
    }

    #[test]
    fn full_get_section_replaces_a_search_fragment() {
        let mut acc = vec![hit("s2D", 2, "fragment")];
        merge_retrieved_section(&mut acc, window("s2D", 1, 2, 2, 900, "full text"));
        assert_eq!(acc.len(), 1);
        assert_eq!(acc[0].text, "full text");
        assert!(!is_chunk_fragment(&acc[0]));
    }

    #[test]
    fn search_hit_never_displaces_get_section_text() {
        let mut acc = vec![window("s2D", 1, 2, 2, 900, "full text")];
        merge_retrieved_section(&mut acc, hit("s2D", 1, "fragment"));
        assert_eq!(acc[0].text, "full text");
    }

    #[test]
    fn first_search_fragment_is_a_fragment_and_a_second_is_ignored() {
        let mut acc = Vec::new();
        merge_retrieved_section(&mut acc, hit("s2D", 1, "one"));
        merge_retrieved_section(&mut acc, hit("s2D", 2, "two"));
        assert_eq!(acc.len(), 1);
        assert!(is_chunk_fragment(&acc[0]));
        // an unsplit hit is complete, not a fragment
        assert!(!is_chunk_fragment(&hit("s5", 0, "x")));
    }

    #[test]
    fn adjacent_windows_are_joined() {
        let mut acc = vec![window("schedule1", 1, 7, 10, 19_000, "A")];
        merge_retrieved_section(&mut acc, window("schedule1", 8, 10, 10, 9_000, "B"));
        assert_eq!(acc[0].text, "A\n\nB");
        assert_eq!(acc[0].metadata["part_to"], json!(10));
        assert_eq!(acc[0].metadata["window_tokens"], json!(28_000));
        assert_eq!(acc[0].metadata["complete"], json!(true));
        // a non-adjacent window is not joined
        let mut acc2 = vec![window("schedule1", 1, 3, 10, 100, "A")];
        merge_retrieved_section(&mut acc2, window("schedule1", 6, 8, 10, 100, "C"));
        assert_eq!(acc2[0].text, "A");
    }

    #[test]
    fn normalize_section_id_keeps_schedule_ids() {
        assert_eq!(normalize_section_id("s2d"), "2D");
        assert_eq!(normalize_section_id("S19"), "19");
        assert_eq!(normalize_section_id("Section 13A"), "13A");
        assert_eq!(normalize_section_id("Rule 4"), "4");
        assert_eq!(normalize_section_id("schedule3"), "schedule3");
        assert_eq!(normalize_section_id("legislative_history"), "legislative_history");
    }

    fn with_meta(mut s: ScoredSection, pairs: &[(&str, serde_json::Value)]) -> ScoredSection {
        let m = s.metadata.as_object_mut().unwrap();
        for (k, v) in pairs {
            m.insert((*k).into(), v.clone());
        }
        s
    }

    #[test]
    fn streaming_scan_stops_before_the_last_half_written_word() {
        if !crate::services::sso_links::index_available() {
            eprintln!("skipping: data/sso_act_index.json not present");
            return;
        }
        let (tx, mut rx) = tokio::sync::broadcast::channel::<ChatSseEvent>(8);
        let mut sent = std::collections::HashSet::new();
        // "s 1" may become "s 19(5)": nothing is sent yet.
        send_new_text_citations(&tx, "per Companies Act 1967, s 1", &mut sent, false);
        assert!(rx.try_recv().is_err());
        // once the word is finished it is sent, once.
        send_new_text_citations(&tx, "per Companies Act 1967, s 19(5) ", &mut sent, false);
        match rx.try_recv() {
            Ok(ChatSseEvent::LegislationCitations { citations }) => {
                assert_eq!(citations.len(), 1);
                assert_eq!(citations[0].section, "19");
            }
            other => panic!("expected citations, got {other:?}"),
        }
        send_new_text_citations(&tx, "per Companies Act 1967, s 19(5) and more", &mut sent, true);
        assert!(rx.try_recv().is_err(), "already sent urls are not repeated");
    }

    #[test]
    fn schedules_link_to_their_sc_anchor_and_appendices_get_no_link() {
        let act = |id: &str| {
            with_meta(
                hit(id, 0, "x"),
                &[("sso_url", json!("https://sso.agc.gov.sg/Act/EmA1968"))],
            )
        };
        assert!(extract_citations(&[act("abbreviations"), act("legislative_history")]).is_empty());
        // every part of a schedule is one citation to the schedule's anchor
        let sch = extract_citations(&[act("schedule3"), act("schedule3_part2")]);
        assert_eq!(sch.len(), 1);
        assert_eq!(sch[0].section, "schedule3");
        assert_eq!(sch[0].url, "https://sso.agc.gov.sg/Act/EmA1968?ProvIds=Sc3-");
        let c = extract_citations(&[act("s13")]);
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].section, "13");
        assert_eq!(c[0].url, "https://sso.agc.gov.sg/Act/EmA1968?ProvIds=pr13-");
        assert_eq!(c[0].doc_type, "act");
    }

    fn sl_hit(id: &str, sso_url: Option<&str>) -> ScoredSection {
        let mut s = with_meta(
            hit(id, 0, "x"),
            &[
                ("doc_type", json!("subsidiary_legislation")),
                (
                    "source_file",
                    json!("Public Service (Disciplinary Proceedings) Regulations 2023 [S 23_2023].md"),
                ),
                ("parent_act_name", json!("Constitution of the Republic of Singapore")),
            ],
        );
        if let Some(u) = sso_url {
            s.metadata
                .as_object_mut()
                .unwrap()
                .insert("sso_url".into(), json!(u));
        }
        s
    }

    #[test]
    fn subsidiary_legislation_links_to_its_own_document() {
        let c = extract_citations(&[sl_hit(
            "s19",
            Some("https://sso.agc.gov.sg/SL/CONS1963-S23-2023?DocDate=20260130"),
        )]);
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].act_name, "Public Service (Disciplinary Proceedings) Regulations 2023");
        assert_eq!(c[0].section, "19");
        assert_eq!(c[0].doc_type, "subsidiary_legislation");
        assert_eq!(
            c[0].url,
            "https://sso.agc.gov.sg/SL/CONS1963-S23-2023?DocDate=20260130&ProvIds=pr19-"
        );
    }

    #[test]
    fn subsidiary_legislation_without_a_url_never_links_to_the_parent_act() {
        // Falling back to the parent Act's index would link to the wrong document.
        assert!(extract_citations(&[sl_hit("s19", None)]).is_empty());
    }
}

#[cfg(test)]
mod quote_tests {
    #[test]
    fn acts_list_follows_a_static_system_prompt() {
        let msgs = vec![crate::models::schemas::ClientMessage { role: "user".into(), content: "hi".into() }];
        let ctx = crate::services::prompts::indexed_acts_context(&["Act A".to_string()]);
        let out = super::build_api_messages("SYS", ctx.as_deref(), None, &msgs, &vec![]);
        assert_eq!(out[0]["content"], "SYS");
        assert!(out[1]["content"].as_str().unwrap().contains("Act A"));
        assert_eq!(out[2]["role"], "user");
        let none = super::build_api_messages("SYS", None, None, &msgs, &vec![]);
        assert_eq!(none.len(), 2);
    }

    #[test]
    fn context_budget_never_splits_a_multibyte_char() {
        // 4 chars/token: a budget of 3 tokens = 12 bytes lands inside '—'.
        let text = "ab—".repeat(20);
        for budget in 1..20 {
            let out = super::apply_context_budget(text.clone(), budget);
            assert!(out.contains("ab") || out.is_empty());
        }
    }

    use super::*;
    use crate::services::qdrant_store::ScoredSection;
    use serde_json::json;

    #[derive(serde::Deserialize, Debug)]
    struct R {
        act_name: String,
        section_id: String,
    }

    #[test]
    fn complete_array_parses_even_inside_fences() {
        let out = "```json\n[{\"act_name\":\"A\",\"section_id\":\"1\"}]\n```";
        assert_eq!(parse_json_refs::<R>(out).unwrap().len(), 1);
    }

    #[test]
    fn truncated_array_keeps_the_complete_objects() {
        let out = "[{\"act_name\":\"A\",\"section_id\":\"1\"},{\"act_name\":\"B \\\"x\\\" {\",\"section_id\":\"2\"},{\"act_name\":\"C\",\"sect";
        let v = parse_json_refs::<R>(out).unwrap();
        assert_eq!(v.len(), 2);
        assert_eq!(v[1].act_name, "B \"x\" {");
        assert!(parse_json_refs::<R>("no json here").is_none());
    }

    fn sl(source: &str, parent: &str, sid: &str) -> ScoredSection {
        ScoredSection {
            text: format!("text of {source} {sid}"),
            score: 0.9,
            section_id: sid.into(),
            metadata: json!({
                "doc_type": "subsidiary_legislation",
                "source_file": format!("{source}.md"),
                "act_name": parent,
            }),
        }
    }

    #[test]
    fn sl_reference_by_parent_act_name_does_not_pull_another_sls_rule() {
        let got = vec![sl("Regs A", "Income Tax Act 1947", "s2"), sl("Order B", "Income Tax Act 1947", "s2")];
        assert!(find_retrieved_match(&got, "Income Tax Act 1947", "2").is_none());
        let m = find_retrieved_match(&got, "Order B", "2").unwrap();
        assert!(m.text.contains("Order B"));
    }

    #[test]
    fn exact_name_beats_substring_and_ambiguous_substring_is_rejected() {
        let a = ScoredSection {
            text: "plain".into(),
            score: 1.0,
            section_id: "s5".into(),
            metadata: json!({"doc_type": "act", "act_name": "Companies Act 1967", "source_file": "Companies Act 1967.md"}),
        };
        let b = ScoredSection {
            text: "other".into(),
            score: 1.0,
            section_id: "s5".into(),
            metadata: json!({"doc_type": "act", "act_name": "Companies Act 1967 (Amendment)", "source_file": "x.md"}),
        };
        let got = vec![b, a];
        assert_eq!(find_retrieved_match(&got, "Companies Act 1967", "5").unwrap().text, "plain");
    }

    #[test]
    fn judgment_result_has_heading_chunk_markers_and_continuation_footer() {
        let section = ScoredSection {
            text: "[2019_SGHC_233_chunk1]\nfirst\n\n[2019_SGHC_233_chunk2]\nsecond".into(),
            score: 1.0,
            section_id: "2019_SGHC_233_chunk1".into(),
            metadata: json!({
                "case_name": "A v B", "neutral_citation": "[2019] SGHC 233",
                "decision_date": "30 Sep 2019", "detail_url": "https://www.elitigation.sg/gd/s/2019_SGHC_233",
                "chunk_total": 5, "part_from": 1, "part_to": 2, "window_tokens": 900, "complete": false
            }),
        };
        let out = format_judgment_result(&section);
        assert!(out.starts_with("### A v B [2019] SGHC 233"));
        assert!(out.contains("Source: https://www.elitigation.sg/gd/s/2019_SGHC_233"));
        assert!(out.contains("CONTINUES: call get_judgment again with the same case and part=3"));
    }

    #[test]
    fn max_output_tokens_is_the_4096_cap() {
        assert_eq!(crate::services::deepseek::MAX_OUTPUT_TOKENS, 65536);
        assert_eq!(crate::services::deepseek::SUBAGENT_MAX_OUTPUT_TOKENS, 65536);
        assert_eq!(read_window(&serde_json::json!({"single_part": true}), 8000), 0);
        assert_eq!(read_window(&serde_json::json!({}), 8000), 8000);
    }
}

/// Drop / cancellation tests. Written to run under Miri (`make server-miri`): no
/// sockets and no timers, only a bare current-thread runtime, so Miri can check
/// that cancelled tasks and dropped streams free everything they own.
#[cfg(test)]
mod drop_tests {
    use super::*;
    use crate::limits::{Guard, Limits};
    use std::future::pending;

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(f)
    }

    /// Let the runtime run everything that is currently runnable (including task cancellations).
    async fn settle() {
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
    }

    fn guard() -> Arc<Guard> {
        let mut l = Limits::from_env();
        l.rate_burst = 1e9;
        l.rate_per_min = 1e9;
        l.repeat_max = usize::MAX;
        l.ip_concurrency = usize::MAX;
        l.global_concurrency = usize::MAX;
        Guard::new(l)
    }

    fn peer() -> std::net::IpAddr {
        std::net::IpAddr::from([10, 0, 0, 1])
    }

    /// A task that owns a clone of `sentinel` and never finishes on its own. The
    /// sentinel's strong count is back to 1 exactly when that task's future was dropped.
    fn parked(sentinel: &Arc<()>) -> tokio::task::JoinHandle<()> {
        let held = Arc::clone(sentinel);
        tokio::spawn(async move {
            let _held = held;
            pending::<()>().await
        })
    }

    #[test]
    fn dropping_abort_on_drop_cancels_the_task_and_frees_what_it_owns() {
        block_on(async {
            let sentinel = Arc::new(());
            let guard = AbortOnDrop(parked(&sentinel));
            settle().await;
            assert_eq!(Arc::strong_count(&sentinel), 2, "the task is parked holding its state");
            drop(guard);
            settle().await;
            assert_eq!(Arc::strong_count(&sentinel), 1, "the cancelled task's state leaked");
        });
    }

    #[test]
    fn cancelling_a_task_that_never_ran_still_frees_what_it_owns() {
        block_on(async {
            let sentinel = Arc::new(());
            // Client disconnects before the runtime ever polled the generation task.
            drop(AbortOnDrop(parked(&sentinel)));
            settle().await;
            assert_eq!(Arc::strong_count(&sentinel), 1);
        });
    }

    #[test]
    fn dropping_a_finished_task_guard_is_harmless() {
        block_on(async {
            let guard = AbortOnDrop(tokio::spawn(async { 7 }));
            settle().await;
            assert!(guard.0.is_finished());
            drop(guard);
        });
    }

    /// The same ownership shape as `chat_turn`: the response stream owns the `Permit`
    /// and the `AbortOnDrop` for the generation task.
    fn response_stream(
        permit: crate::limits::Permit,
        task: tokio::task::JoinHandle<()>,
        mut rx: broadcast::Receiver<u8>,
    ) -> impl tokio_stream::Stream<Item = u8> {
        let abort = AbortOnDrop(task);
        async_stream::stream! {
            let _permit = permit;
            let _abort = abort;
            loop {
                match rx.recv().await {
                    Ok(ev) => yield ev,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }

    #[test]
    fn a_response_stream_dropped_before_its_first_poll_releases_the_permit_and_task() {
        block_on(async {
            let (g, sentinel) = (guard(), Arc::new(()));
            let (tx, rx) = broadcast::channel::<u8>(4);
            let stream = response_stream(g.admit(peer(), "q").unwrap(), parked(&sentinel), rx);
            assert_eq!(g.active(), 1);
            drop(stream); // browser closed the tab before reading anything
            settle().await;
            assert_eq!(g.active(), 0, "the concurrency slot leaked");
            assert_eq!(Arc::strong_count(&sentinel), 1, "the generation task leaked");
            assert_eq!(Arc::strong_count(&g), 1);
            drop(tx);
        });
    }

    #[test]
    fn a_response_stream_dropped_mid_flight_releases_the_permit_and_task() {
        block_on(async {
            let (g, sentinel) = (guard(), Arc::new(()));
            let (tx, rx) = broadcast::channel::<u8>(4);
            // Box::pin, not `tokio::pin!`: `drop` below must drop the stream itself, not a borrow of it.
            let mut stream = Box::pin(response_stream(g.admit(peer(), "q").unwrap(), parked(&sentinel), rx));
            tx.send(1).unwrap();
            assert_eq!(stream.next().await, Some(1));
            // Parked in `rx.recv()` with a slot held, when the client goes away.
            assert!(futures::FutureExt::now_or_never(stream.next()).is_none());
            drop(stream);
            settle().await;
            assert_eq!(g.active(), 0);
            assert_eq!(Arc::strong_count(&sentinel), 1);
            assert_eq!(Arc::strong_count(&g), 1);
        });
    }

    #[test]
    fn a_response_stream_that_finishes_normally_releases_the_permit_and_task() {
        block_on(async {
            let (g, sentinel) = (guard(), Arc::new(()));
            let (tx, rx) = broadcast::channel::<u8>(4);
            let stream = response_stream(g.admit(peer(), "q").unwrap(), parked(&sentinel), rx);
            tokio::pin!(stream);
            tx.send(1).unwrap();
            drop(tx); // generation finished: channel closes
            assert_eq!(stream.next().await, Some(1));
            assert_eq!(stream.next().await, None);
            // The stream value is still alive, but its generator already let go.
            settle().await;
            assert_eq!(g.active(), 0);
            assert_eq!(Arc::strong_count(&sentinel), 1);
        });
    }

    #[test]
    fn run_isolated_returns_the_value_and_turns_a_panic_into_an_error() {
        block_on(async {
            assert_eq!(run_isolated(async { 5 }).await.unwrap(), 5);
            let err = run_isolated(async { panic!("tool exploded") }).await.unwrap_err();
            assert!(err.is_panic());
        });
    }

    #[test]
    fn run_isolated_cancels_its_task_when_the_caller_is_dropped() {
        block_on(async {
            let sentinel = Arc::new(());
            let held = Arc::clone(&sentinel);
            // The orchestrator task running a tool call; aborted on client disconnect.
            let turn = tokio::spawn(run_isolated(async move {
                let _held = held;
                pending::<()>().await
            }));
            settle().await;
            assert_eq!(Arc::strong_count(&sentinel), 2, "the tool call is in flight");
            turn.abort();
            settle().await;
            assert_eq!(Arc::strong_count(&sentinel), 1, "the tool task outlived the turn");
        });
    }
}
