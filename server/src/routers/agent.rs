//! `GET /api/agent?mode=`: everything a browser needs to run the model loop itself.
//!
//! The browser-side agent (bring your own key) must behave exactly like the server-side one,
//! so it does not carry its own copy of the prompts, tool definitions or tuning numbers: it
//! reads them from here. The server stays the single source of truth, and a prompt edit
//! reaches both paths at once. Nothing in the response is secret (the project is open source)
//! and nothing in it depends on the caller.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    Json,
    extract::{ConnectInfo, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::limits::{self, MODES, Reject};
use crate::routers::chat::{MAX_ORCHESTRATOR_READS, MAX_WEB_SEARCHES, error_response};
use crate::services::{deepseek, nudge, prompts, web_search};

#[derive(Deserialize)]
pub struct AgentQuery {
    mode: Option<String>,
}

/// Orchestrator tools that start a sub-agent, and how the browser should run each one:
/// the sub-agent spec to use, the `/api/tool` context for its searches, and the `/api/cite`
/// kind that turns its references into exact text (`null` for the self-help agents, whose
/// answer is used as written).
fn agent_tools(mode: &str) -> Value {
    match mode {
        "legislation" => json!({
            "research_legislation": {"agent": "legislation_research", "context": "research_legislation", "cite": "legislation"},
            "research_subsidiary_legislation": {"agent": "legislation_sl", "context": "research_subsidiary", "cite": "subsidiary_legislation"},
            "research_judiciary": {"agent": "judiciary_research", "context": "research_judiciary", "cite": "judiciary"},
        }),
        "self-help" => json!({
            "legislation_agent": {"agent": "legislation", "context": "agent_legislation", "cite": null},
            "judiciary_agent": {"agent": "judiciary", "context": "agent_judiciary", "cite": null},
        }),
        _ => json!({}),
    }
}

fn subagent_json(config: &crate::config::AppConfig, name: &str) -> Value {
    let spec = deepseek::subagent_spec(config, name);
    json!({
        "system_prompt": spec.system_prompt,
        "tools": spec.tools,
        "final_message": spec.final_message,
    })
}

pub async fn agent_bundle(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<AgentQuery>,
) -> Response {
    let mode = q.mode.unwrap_or_else(|| "legislation".into());
    if !MODES.contains(&mode.as_str()) {
        return error_response(Reject {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_mode",
            message: "Unknown chat mode.".into(),
            retry_after: None,
        });
    }
    // The acts list is a Qdrant read, so this shares the tool limiter.
    let ip = limits::client_ip(&headers, peer, state.guard.limits.trust_proxy);
    let _permit = match state.guard.tools.admit(ip) {
        Ok(p) => p,
        Err(r) => return error_response(r),
    };

    let config = state.config.read().await.clone();
    let l = &state.guard.limits;
    let act_names: Vec<String> = if mode == "legislation" {
        state.qdrant.indexed_act_names(&config.qdrant_act_collection).await.unwrap_or_default()
    } else {
        vec![]
    };

    // Tavily only when the server has a key. The DeepSeek search tool is never offered here:
    // it needs the caller's own provider account and exists on one provider only.
    let tools = web_search::retain_available(
        deepseek::DeepSeekClient::get_tools(&mode),
        !config.tavily_api_key.is_empty(),
        false,
    );

    let subagents: Value = match mode.as_str() {
        "legislation" => json!({
            "legislation_research": subagent_json(&config, "legislation_research"),
            "legislation_sl": subagent_json(&config, "legislation_sl"),
            "judiciary_research": subagent_json(&config, "judiciary_research"),
        }),
        "self-help" => json!({
            "legislation": subagent_json(&config, "legislation"),
            "judiciary": subagent_json(&config, "judiciary"),
        }),
        _ => json!({}),
    };

    let body = json!({
        "mode": mode,
        "system_prompt": deepseek::build_system_prompt(&config, &mode, &[]),
        // A separate message after the system prompt so the prompt itself stays byte-stable.
        "acts_context": prompts::indexed_acts_context(&act_names),
        "tools": tools,
        // Offered by the browser when the visitor has their own Tavily key and the site has none.
        "tavily_tool": web_search::make_tavily_tool(),
        "agent_tools": agent_tools(&mode),
        "subagents": subagents,
        "params": {
            "temperature": config.temperature,
            "top_p": config.top_p,
            "max_output_tokens": deepseek::MAX_OUTPUT_TOKENS,
            "subagent_max_output_tokens": deepseek::SUBAGENT_MAX_OUTPUT_TOKENS,
            "output_reserve_tokens": deepseek::OUTPUT_RESERVE_TOKENS,
            "context_window_size": config.context_window_size,
            "rag_context_fill_ratio": config.rag_context_fill_ratio,
            "rag_context_budget": config.rag_context_budget,
            "sub_agent_context_budget": config.sub_agent_context_budget,
            "rag_search_hard_cap": config.rag_search_hard_cap,
            "finalization_check": config.finalization_check,
            "tool_nudge": config.tool_nudge,
            "max_nudges": nudge::MAX_NUDGES,
            "skip_check_after_tool_steps": nudge::SKIP_AFTER_TOOL_STEPS,
            "revision_min_chars": deepseek::REVISION_MIN_CHARS,
            "max_web_searches": MAX_WEB_SEARCHES,
            "max_orchestrator_reads": MAX_ORCHESTRATOR_READS,
            // The same numbers /api/chat enforces on the server path.
            "context_tokens": l.context_tokens,
            "model_window": l.model_window,
            "message_chars": l.message_chars,
            "max_messages": l.max_messages,
            "request_timeout_s": l.request_timeout_s,
        },
        "texts": {
            "tool_nudge": nudge::DEFAULT_TOOL_NUDGE,
            "finalization_nudge": nudge::FINALIZATION_NUDGE,
            "finalization_ok": nudge::FINALIZATION_OK,
            "forced_final": deepseek::FORCED_FINAL,
            "sub_forced_final": deepseek::SUB_FORCED_FINAL,
            "sub_forced_final_suffix": deepseek::SUB_FORCED_FINAL_SUFFIX,
            // `/compact`: the same three texts `POST /api/compact` uses, so a user's own key summarises
            // exactly as the shared one does.
            "summariser_system": deepseek::SUMMARISER_SYSTEM,
            "summary_instruction": deepseek::SUMMARY_INSTRUCTION,
            "summary_rules": deepseek::SUMMARY_RULES,
            // Lets the client split the system-prompt estimate the way the server does.
            "subagent_definitions": prompts::SUBAGENT_DEFINITIONS,
        },
    });

    let mut r = Json(body).into_response();
    r.headers_mut().insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    r
}

#[cfg(all(test, not(miri)))]
mod tests {
    use super::*;

    #[test]
    fn every_orchestrator_tool_that_starts_a_sub_agent_has_a_spec_in_its_mode() {
        for mode in ["legislation", "self-help"] {
            let tools = agent_tools(mode);
            let config: crate::config::AppConfig = serde_json::from_value(json!({})).unwrap();
            let offered: Vec<String> = deepseek::DeepSeekClient::get_tools(mode)
                .iter()
                .map(|t| t["function"]["name"].as_str().unwrap().to_string())
                .collect();
            for (tool, route) in tools.as_object().unwrap() {
                assert!(offered.contains(tool), "{mode}: {tool} is routed but never offered to the model");
                let agent = route["agent"].as_str().unwrap();
                let spec = deepseek::subagent_spec(&config, agent);
                assert!(!spec.system_prompt.is_empty() && !spec.tools.is_empty(), "{agent}");
            }
            // And the reverse: every offered tool that runs an agent is routed.
            for name in ["research_legislation", "research_subsidiary_legislation", "research_judiciary", "legislation_agent", "judiciary_agent"] {
                if offered.iter().any(|o| o == name) {
                    assert!(tools.get(name).is_some(), "{mode}: {name} is offered but has no route");
                }
            }
        }
        assert!(agent_tools("judiciary").as_object().unwrap().is_empty());
    }

    #[test]
    fn cite_kinds_match_what_the_cite_endpoint_accepts() {
        for mode in ["legislation", "self-help"] {
            for route in agent_tools(mode).as_object().unwrap().values() {
                if let Some(kind) = route["cite"].as_str() {
                    assert!(["legislation", "subsidiary_legislation", "judiciary"].contains(&kind), "{kind}");
                }
            }
        }
    }

    #[test]
    fn forced_final_texts_keep_their_wording_and_placeholder() {
        let main = deepseek::FORCED_FINAL.replace("{n}", "7");
        assert!(main.starts_with("You have now performed 7 searches and retrieved extensive legal context. Please write"), "{main}");
        assert!(main.ends_with("do not paraphrase the law. Do not search again."), "{main}");
        let sub = deepseek::SUB_FORCED_FINAL.replace("{n}", "2");
        assert!(sub.starts_with("You have now performed 2 searches"), "{sub}");
        assert!(sub.contains("Include Act/SL name and section number for each provision. Do not search again."));
        assert_eq!(
            deepseek::SUB_FORCED_FINAL_SUFFIX.replace("{n}", "5"),
            " You performed 5 searches. Do not search again."
        );
        for t in [deepseek::LEGISLATION_REFS_FINAL, deepseek::JUDICIARY_REFS_FINAL] {
            assert!(t.starts_with("Output ONLY a JSON array") && t.ends_with("output []."), "{t}");
            assert!(!t.contains("  "), "stray indentation: {t}");
        }
    }

    #[test]
    fn the_sub_agent_spec_gives_cite_by_reference_agents_their_final_message() {
        let config: crate::config::AppConfig = serde_json::from_value(json!({})).unwrap();
        for m in ["legislation_research", "legislation_sl", "judiciary_research"] {
            assert!(deepseek::subagent_spec(&config, m).final_message.is_some(), "{m}");
        }
        for m in ["legislation", "judiciary"] {
            assert!(deepseek::subagent_spec(&config, m).final_message.is_none(), "{m}");
        }
    }
}
