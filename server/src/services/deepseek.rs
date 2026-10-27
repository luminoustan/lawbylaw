//! DeepSeek LLM API client -- streaming + tool-call agentic loop.
//!
//! Mirrors Python `app/backend/services/deepseek.py` (1156 lines).
//! All SSE event types, tool definitions, and search loop logic match exactly.

use crate::config::AppConfig;
use crate::metrics;
use crate::models::schemas::SseEvent;
use crate::services::nudge;
use crate::services::prompts;
use crate::services::provider;
use futures::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio::time::timeout;
use tracing::{debug, error, info, warn};

/// Type alias for the async tool-call executor closure.
pub type ToolExecutorFn = Arc<
    dyn Fn(
            String,
            Value,
        )
            -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send>>
        + Send
        + Sync,
>;

/// Output-token cap sent as `max_tokens` on every orchestrator and sub-agent
/// completion. Quoted legal text never has to fit in it: research sub-agents
/// emit only a short JSON list of references and the server attaches the exact
/// text itself (see `build_cite_by_reference_result`).
pub const MAX_OUTPUT_TOKENS: i64 = 65536;
/// Output headroom kept free when sizing the input budget. Replies are far
/// shorter than the request cap, so reserving the full cap would waste context.
pub const OUTPUT_RESERVE_TOKENS: i64 = 8192;
/// Output cap for sub-agent rounds (cite-by-reference JSON, so a larger cap
/// mainly prevents truncated reference lists).
pub const SUBAGENT_MAX_OUTPUT_TOKENS: i64 = 65536;

// Tool Definitions (JSON schemas) -- matching Python deepseek.py

pub fn make_law_search_tool() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": "search_legislation",
            "description": "Search the indexed statute / legislation database for relevant sections. Call this when you need to cite or verify specific legal provisions, obligations, exemptions, or definitions. Do NOT call it for general knowledge questions that don't require specific statutory section references.\n\nIMPORTANT: When the user's question is about a specific Act, ALWAYS set the act_name parameter to restrict results to that Act. This dramatically improves relevance when multiple Acts are indexed.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "A focused search query describing the legal topic, e.g. 'consent obligations for personal data collection' or 'penalties for non-compliance'"},
                    "top_k": {"type": "integer", "description": "Number of sections to retrieve (1–8). Default 4.", "default": 4},
                    "act_name": {"type": "string", "description": "Optional: restrict search to a specific Act by its exact name. Use this when the user's question is about a particular Act. The available act names are listed in the system prompt."},
                },
                "required": ["query"]
            }
        }
    })
}

pub fn make_research_legislation_tool() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": "research_legislation",
            "description": "Spawn a specialist agent to research the main Act provisions relevant to the user's question. The agent searches the indexed statute database and returns synthesised findings. Write a focused research prompt that includes all relevant context — the agent has NO access to the chat history.",
            "parameters": {
                "type": "object",
                "properties": {
                    "prompt": {
                        "type": "string",
                        "description": "A self-contained research question for the legislation agent. Include the legal topic, any specific Acts mentioned, relevant facts, and what you need the agent to find."
                    }
                },
                "required": ["prompt"]
            }
        }
    })
}

pub fn make_research_sl_tool() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": "research_subsidiary_legislation",
            "description": "Spawn a specialist agent to research subsidiary legislation (regulations, orders, rules) related to the user's question. The agent searches the SL collection and returns relevant provisions with exact statutory text. Call this AFTER research_legislation, using the Act names from those findings.",
            "parameters": {
                "type": "object",
                "properties": {
                    "prompt": {
                        "type": "string",
                        "description": "A self-contained research question for the SL agent. Include what specific regulations, exemptions, or implementation details you are looking for."
                    },
                    "parent_act_names": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Exact parent Act names from the research_legislation findings, e.g. ['Tobacco (Control of Advertisements and Sale) Act 1993']."
                    }
                },
                "required": ["prompt", "parent_act_names"]
            }
        }
    })
}

pub fn make_research_judiciary_tool() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": "research_judiciary",
            "description": "Spawn a specialist agent to research Singapore court judgments relevant to the user's question. The agent searches the indexed judgments and returns the relevant passages with the exact judgment text attached, plus each case's neutral citation and eLitigation link. Call this AFTER the legislation agents, and only when the question turns on case law, precedent, judicial interpretation, or typical outcomes. Write a self-contained prompt — the agent has NO access to the chat history.",
            "parameters": {
                "type": "object",
                "properties": {
                    "prompt": {
                        "type": "string",
                        "description": "A self-contained research question for the judiciary agent. Include the legal issue, the relevant provisions found by the legislation agents, and what you need (e.g. how courts interpret a provision, typical outcomes)."
                    }
                },
                "required": ["prompt"]
            }
        }
    })
}

/// The orchestrator reads with a smaller window than the sub-agents, and only a
/// few times per turn (see `MAX_ORCHESTRATOR_READS` in the chat router).
fn orchestrator_read_tool(mut tool: Value) -> Value {
    if let Some(d) = tool["function"]["description"].as_str() {
        let d = d.replace("20,000", "8,000")
            + " Read what you need; avoid re-reading text you already have.";
        tool["function"]["description"] = Value::String(d);
    }
    tool
}

pub fn make_get_judgment_tool() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": "get_judgment",
            "description": "Read the text of a known judgment by its neutral citation, case name or source id. A judgment is stored as many chunks and a search hit is only ONE chunk of it. get_judgment returns the chunks in order (about 20,000 tokens per call); a footer says either `[complete judgment, assembled from N parts]` or `[parts a-b of M shown ... CONTINUES: call get_judgment again with part=b+1]`. Use it to read the paragraphs around a search hit before relying on it. Example: get_judgment({\"case\": \"[2021] SGHC 987\"})",
            "parameters": {
                "type": "object",
                "properties": {
                    "case": {
                        "type": "string",
                        "description": "Neutral citation (e.g. '[2021] SGHC 987'), exact case name, or source id (e.g. '2021_SGHC_987') exactly as shown in a search result header."
                    },
                    "part": {
                        "type": "integer",
                        "description": "Optional 1-based part number to start reading from. Use the part number given in the previous result's footer. Omit to start from the first part.",
                        "minimum": 1
                    },
                    "single_part": {
                        "type": "boolean",
                        "description": "Set true to return ONLY the part given by `part` (one chunk), not the following parts. Use it to read one specific chunk, e.g. the `[part K of M]` a search hit came from."
                    }
                },
                "required": ["case"]
            }
        }
    })
}

pub fn make_get_section_tool() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": "get_section",
            "description": "Retrieve the exact text of a specific section by its number from a known Act or subsidiary legislation document. Use this when you already know the section number and document name — it is instant and deterministic, unlike search_legislation which uses semantic search. Long sections and schedules are stored in several parts. get_section returns the parts in order, up to about 20,000 tokens per call; a footer says either `[complete section, assembled from N parts]` or `[parts a-b of M shown ... CONTINUES: call get_section again with part=b+1]` — in the second case keep calling with the next part until the end. A search hit marked `[part K ...]` is only one part of a longer section: call get_section to read all of it before quoting or citing it. Example: get_section({\"source_file\": \"Employment Act 1968\", \"section_id\": \"15\"})",
            "parameters": {
                "type": "object",
                "properties": {
                    "source_file": {
                        "type": "string",
                        "description": "Exact name of the Act or subsidiary legislation document, e.g. 'Employment Act 1968' or 'Tobacco (Control of Advertisements and Sale) (Prohibited Tobacco Products) Regulations 2014'."
                    },
                    "section_id": {
                        "type": "string",
                        "description": "Section number to retrieve, e.g. '15', '13A', '26D'. Do not include the 's' prefix or 'section' word. For schedules and appendices use the id exactly as shown in the search result header, e.g. 'schedule3' or 'legislative_history'."
                    },
                    "part": {
                        "type": "integer",
                        "description": "Optional 1-based part number to start reading from, for a long section that was returned in parts. Use the part number given in the previous result's footer. Omit to start from the first part.",
                        "minimum": 1
                    },
                    "single_part": {
                        "type": "boolean",
                        "description": "Set true to return ONLY the part given by `part` (one chunk), not the following parts. Use it to read one specific chunk, e.g. the `[part K of M]` a search hit came from."
                    }
                },
                "required": ["source_file", "section_id"]
            }
        }
    })
}

pub fn make_judgment_search_tool() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": "search_judiciary",
            "description": "Search the indexed judiciary judgments database for relevant case law. Call this when you need to find, cite, or verify court judgments, case summaries, or judicial reasoning.\n\nResults include topic indexes (e.g. [Insolvency Law — Winding up]) and neutral citations (e.g. [2022] SGHC 988).\n\nIMPORTANT: When the user's question is about a specific case, set the case_name parameter to restrict results to that case.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "A focused search query describing the legal issue, e.g. 'winding up standing contingent creditor' or 'duty of care in negligence'"},
                    "top_k": {"type": "integer", "description": "Number of chunks to retrieve (1–8). Default 4.", "default": 4},
                    "case_name": {"type": "string", "description": "Optional: restrict search to a specific case by name or neutral citation, e.g. 'Re ABC HOLDINGS PTE LTD'."}
                },
                "required": ["query"]
            }
        }
    })
}

pub fn make_classify_issue_tool() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": "classify_issue",
            "description": "Classify the user's legal issue into one or more categories. Call this FIRST when the user describes a new problem so you can direct them to the right court, process, and resources.\n\nCategory guidance:\n- civil: disputes between private parties — contracts, tenancy, debt, defamation, negligence, small claims, neighbour disputes.\n- criminal: serious offences prosecuted by the State — theft, assault, cheating, drug offences, sexual offences. Only use this when someone may face arrest or prosecution.\n- family: marriage, divorce, custody, maintenance, adoption, family violence.\n- regulatory: breaches of regulations enforced by government agencies — smoking in prohibited places, littering, noise complaints, building violations, workplace safety. These are typically reported to the relevant agency (NEA, HDB, MOM) rather than the police.\n\nAfter classifying, explain the classification to the user. The missing_details questions will be shown to the user as an interactive form — do NOT repeat them in your text.",
            "parameters": {
                "type": "object",
                "properties": {
                    "categories": {
                        "type": "array",
                        "items": {"type": "string", "enum": ["civil", "criminal", "family", "regulatory"]},
                        "description": "One or more categories that apply to this issue. E.g. a harassment case could be both civil and criminal. A neighbour smoking complaint is regulatory (not criminal)."
                    },
                    "summary": {"type": "string", "description": "A brief one-sentence summary of the user's issue as you understand it so far."},
                    "missing_details": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "List of short, self-contained follow-up questions you still need the user to answer. Each item must be a clear question suitable as a form label, e.g. 'How much is the total debt owed?', 'What is your relationship to the other party?'. These will be shown to the user as an interactive form — do NOT repeat them in your text response."
                    }
                },
                "required": ["categories", "summary"]
            }
        }
    })
}

pub fn make_legislation_agent_tool() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": "legislation_agent",
            "description": "Spawn a specialist legislation agent that searches the indexed statute database (Acts, subsidiary legislation) and returns a synthesised answer. Write a focused research prompt that includes all relevant context from the conversation — the agent has NO access to the chat history.\n\nUse this when the user's issue involves statutory provisions, obligations, penalties, or definitions.",
            "parameters": {
                "type": "object",
                "properties": {
                    "prompt": {"type": "string", "description": "A self-contained research question for the legislation specialist. Include the legal topic, any specific Acts mentioned, relevant facts (amounts, dates, parties), and what you need the agent to find."}
                },
                "required": ["prompt"]
            }
        }
    })
}

pub fn make_judiciary_agent_tool() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": "judiciary_agent",
            "description": "Spawn a specialist judiciary agent that searches the indexed court judgments database and returns a synthesised answer. Write a focused research prompt that includes all relevant context from the conversation — the agent has NO access to the chat history.\n\nUse this when the user's issue could benefit from case law, judicial reasoning, or precedent.",
            "parameters": {
                "type": "object",
                "properties": {
                    "prompt": {"type": "string", "description": "A self-contained research question for the judiciary specialist. Include the legal issue, relevant facts, and what you need the agent to find (e.g. precedent, typical outcomes, judicial reasoning)."}
                },
                "required": ["prompt"]
            }
        }
    })
}

pub fn make_ask_question_tool() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": "askquestion",
            "description": "Ask the user one or more clarifying questions when a specific fact you genuinely need is missing (e.g. an amount, a date, or a party relationship). The questions are shown to the user as an interactive form. Use this sparingly — prefer acting on what the user has already given you. After calling it, end your turn and wait for the answers; do NOT repeat the questions in your text.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Optional short heading for the question form, e.g. 'A few details to proceed'."},
                    "questions": {
                        "type": "array",
                        "description": "One or more questions to ask the user.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "string", "description": "Stable identifier for this question, e.g. 'amount'."},
                                "prompt": {"type": "string", "description": "The question text shown to the user."},
                                "options": {
                                    "type": "array",
                                    "description": "Suggested answers shown as selectable options. May be empty for a free-text question.",
                                    "items": {
                                        "type": "object",
                                        "properties": {
                                            "id": {"type": "string", "description": "Stable identifier for this option."},
                                            "label": {"type": "string", "description": "Label shown to the user."}
                                        },
                                        "required": ["label"]
                                    }
                                },
                                "allow_multiple": {"type": "boolean", "description": "Whether the user may select more than one option."}
                            },
                            "required": ["id", "prompt", "options"]
                        }
                    }
                },
                "required": ["questions"]
            }
        }
    })
}

// Internal types

#[derive(Debug, Clone, Default)]
struct AccumulatedToolCall {
    id: String,
    name: String,
    arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallMade {
    pub name: String,
    pub arguments: Value,
    pub result: String,
}

// Helper functions

/// Conservative token estimate: ~2 chars per token for dense legal text.
/// Legal citations, section numbers, and statute text are tokenised at ~2 chars/token.
/// Using 3 chars/token previously caused 400 errors because we underestimated context size.
pub fn estimate_tokens(messages: &[Value]) -> usize {
    let mut total_chars: usize = 0;
    for msg in messages {
        if let Some(c) = msg.get("content").and_then(|v| v.as_str()) {
            total_chars += c.len();
        }
        for tc in msg
            .get("tool_calls")
            .and_then(|v| v.as_array())
            .unwrap_or(&vec![])
        {
            if let Some(fn_obj) = tc.get("function") {
                total_chars += fn_obj
                    .get("arguments")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .len();
                total_chars += fn_obj
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .len();
            }
        }
    }
    total_chars / 2
}

/// Characters per token for the *display* rows of the context breakdown.
///
/// The fixed sections (system prompt, tool schemas, sub-agent block) are
/// ordinary prose — Act names, English instructions — which tokenise at about
/// 4 chars/token. [`estimate_tokens`] deliberately uses a denser 2 chars/token
/// because it prices the whole prompt, which is dominated by quoted statutory
/// text; that conservatism is right for budgeting (underestimating causes 400s)
/// but wrong for a display row, where it roughly doubles the figure.
pub const DISPLAY_CHARS_PER_TOKEN: usize = 4;

/// Price the rendered system prompt for the context-breakdown row, matching
/// the reference agent's `estimateSystemPrompt` density. The prompt is serialised
/// as a plain string, so this is the whole price of the `system` message.
pub fn estimate_system_prompt(system_prompt: &str) -> u64 {
    if system_prompt.is_empty() {
        return 0;
    }
    (system_prompt.len() / DISPLAY_CHARS_PER_TOKEN) as u64
}

/// Price the tool-schema part of the request for the breakdown row, matching
/// the reference agent's `estimateToolsTokens` (JSON length at the same density).
pub fn estimate_tools_tokens(tools: &[Value]) -> u64 {
    if tools.is_empty() {
        return 0;
    }
    (serde_json::to_string(tools).map(|s| s.len()).unwrap_or(0) / DISPLAY_CHARS_PER_TOKEN) as u64
}

/// Split the system-prompt estimate into the "system prompt" row and the
/// separate "subagent definitions" row, mirroring the reference agent's
/// `splitSystemPromptTokens`. The block is removed by exact match — not a
/// fixed-length tail slice — so a prompt assembled without it reports a zero
/// subagent row instead of mis-attributing the mode body. The two rows always
/// sum to the full prompt estimate.
pub fn split_system_prompt_tokens(system_prompt: &str) -> (u64, u64) {
    let without = system_prompt.replace(crate::services::prompts::SUBAGENT_DEFINITIONS, "");
    let system_only = estimate_system_prompt(&without);
    (system_only, estimate_system_prompt(system_prompt) - system_only)
}

/// Legacy tool name mapping for backward compatibility.
fn canonical_tool_name(name: &str) -> &str {
    match name {
        "search_law" => "search_legislation",
        "search_judgment" => "search_judiciary",
        other => other,
    }
}

/// Record one billed response's usage (provider, model, mode and call type labelled).
fn record_usage(base_url: &str, model: &str, mode: &str, call_type: &str, u: metrics::Usage) {
    metrics::record_llm_usage(provider::Provider::from_base_url(base_url).label(), model, mode, call_type, u);
}

/// Log the estimated USD cost of a completed turn.
///
/// Pricing (DeepSeek V3/V4):
///   Cache hit  input:  $0.0028 / 1M tokens
///   Cache miss input:  $0.14   / 1M tokens
///   Output:            $0.28   / 1M tokens
fn log_turn_cost(
    total_cache_hit: u64,
    total_cache_miss: u64,
    total_completion: u64,
    search_rounds: usize,
) {
    const PRICE_HIT_PER_M: f64 = 0.0028;
    const PRICE_MISS_PER_M: f64 = 0.14;
    const PRICE_OUTPUT_PER_M: f64 = 0.28;

    let cost_hit = (total_cache_hit as f64 / 1_000_000.0) * PRICE_HIT_PER_M;
    let cost_miss = (total_cache_miss as f64 / 1_000_000.0) * PRICE_MISS_PER_M;
    let cost_output = (total_completion as f64 / 1_000_000.0) * PRICE_OUTPUT_PER_M;
    let cost_total = cost_hit + cost_miss + cost_output;

    info!(
        cache_hit_tokens = total_cache_hit,
        cache_miss_tokens = total_cache_miss,
        output_tokens = total_completion,
        search_rounds,
        cost_cache_hit_usd = format!("{:.6}", cost_hit),
        cost_cache_miss_usd = format!("{:.6}", cost_miss),
        cost_output_usd = format!("{:.6}", cost_output),
        cost_total_usd = format!("{:.6}", cost_total),
        "DeepSeek turn cost"
    );
}

/// Extract cache hit/miss token counts from a DeepSeek `usage` JSON object.
///
/// DeepSeek reports `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` at
/// the top level; the OpenAI-compatible alias
/// `prompt_tokens_details.cached_tokens` (newer) wins when both are present.
/// The miss half is derived as `prompt_tokens - hit` so that
/// `hit + miss == prompt_tokens` holds for every payload shape — including the
/// legacy details-only one that omits the miss field entirely.
fn parse_cache_tokens(usage: &Value) -> (u64, u64) {
    let hit = usage["prompt_tokens_details"]["cached_tokens"]
        .as_u64()
        .or_else(|| usage["prompt_cache_hit_tokens"].as_u64())
        .unwrap_or(0);
    let miss = usage["prompt_tokens"]
        .as_u64()
        .map(|prompt| prompt.saturating_sub(hit))
        .or_else(|| usage["prompt_cache_miss_tokens"].as_u64())
        .unwrap_or(0);
    (hit, miss)
}

/// Apply context budget to tool result text (kept for future use).
#[allow(dead_code)]
fn apply_context_budget(text: &str, budget_tokens: i64) -> String {
    let max_chars = (budget_tokens as usize) * 4;
    if text.len() <= max_chars {
        return text.to_string();
    }
    let mut end = max_chars;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    let cutoff = &text[..end];
    if let Some(last_sep) = cutoff.rfind("\n\n---\n\n") {
        text[..last_sep].to_string()
    } else {
        cutoff.to_string()
    }
}

// Prompt assembly — SOUL, the per-mode orchestrator bodies, the specialist
// sub-agent bodies and the shared output-discipline blocks — lives in
// `services::prompts`, mirroring the reference agent's `buildSystemPrompt`.
// Re-exported here so existing callers (`routers::chat`) and the cache tests
// keep using `deepseek::build_system_prompt`.

pub use crate::services::prompts::build_system_prompt;

// messages_to_api

/// Convert DB message format to DeepSeek API format.
/// Filters cross-mode tool calls when active_tool_names is provided.
pub fn messages_to_api(history: &[Value], active_tool_names: Option<&Vec<String>>) -> Vec<Value> {
    let mut result = Vec::new();
    let active_names: Vec<&str> = active_tool_names
        .map(|names| names.iter().map(|s| s.as_str()).collect())
        .unwrap_or_default();

    for msg in history {
        let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("");

        if role != "assistant" || msg.get("tool_calls").is_none() {
            // Pass through non-assistant or plain assistant messages
            if role == "tool" {
                let tc_id = msg
                    .get("tool_calls")
                    .and_then(|tc| tc.as_array())
                    .and_then(|arr| arr.first())
                    .and_then(|tc| tc.get("id"))
                    .and_then(|id| id.as_str())
                    .unwrap_or("call_0");
                result.push(
                    json!({"role": "tool", "tool_call_id": tc_id, "content": msg["content"]}),
                );
            } else {
                let mut m = json!({"role": role});
                if let Some(c) = msg["content"].as_str()
                    && !c.is_empty()
                {
                    m["content"] = json!(c);
                }
                result.push(m);
            }
            continue;
        }

        // Assistant with tool_calls
        let tool_calls = match msg["tool_calls"].as_array() {
            Some(arr) => arr,
            None => continue, // malformed — skip
        };
        let compatible: Vec<&Value> = if active_names.is_empty() {
            tool_calls.iter().collect()
        } else {
            tool_calls
                .iter()
                .filter(|tc| {
                    let name = tc.get("name").and_then(|n| n.as_str()).unwrap_or("");
                    active_names.contains(&canonical_tool_name(name))
                })
                .collect()
        };

        if compatible.is_empty() {
            // All tool calls filtered out -- emit as plain text
            let mut m = json!({"role": "assistant"});
            if let Some(c) = msg["content"].as_str()
                && !c.is_empty()
            {
                m["content"] = json!(c);
            }
            result.push(m);
        } else {
            // Emit assistant with tool_calls + one tool result per call.
            // Use the persisted real tool_call_id when available so that
            // replayed history byte-matches the original API request,
            // maximising DeepSeek disk cache hits across multi-turn conversations.
            let mut tc_array = Vec::new();
            let mut tc_ids = Vec::new();
            for (i, tc) in compatible.iter().enumerate() {
                // Prefer stored real ID; fall back to synthetic for legacy rows.
                let call_id = tc
                    .get("id")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| format!("call_{}", i));
                let name = tc.get("name").and_then(|n| n.as_str()).unwrap_or("");
                let args = tc.get("arguments").cloned().unwrap_or(json!({}));
                let args_str = if args.is_string() {
                    args.as_str().unwrap_or("{}").to_string()
                } else {
                    serde_json::to_string(&args).unwrap_or_else(|_| "{}".to_string())
                };
                tc_array.push(json!({
                    "id": &call_id,
                    "type": "function",
                    "function": {
                        "name": name,
                        "arguments": args_str
                    }
                }));
                tc_ids.push(call_id);
            }
            let mut assistant_msg = json!({"role": "assistant", "tool_calls": tc_array});
            if let Some(c) = msg["content"].as_str()
                && !c.is_empty()
            {
                assistant_msg["content"] = json!(c);
            }
            result.push(assistant_msg);

            for (i, tc) in compatible.iter().enumerate() {
                let result_text = tc
                    .get("result")
                    .and_then(|r| r.as_str())
                    .unwrap_or("[No result stored]");
                result.push(json!({
                    "role": "tool",
                    "tool_call_id": &tc_ids[i],
                    "content": result_text
                }));
            }
        }
    }
    result
}

// truncate_messages_to_fit

/// Trim messages to fit token budget. Preserves head and tail, drops oldest middle.
pub fn truncate_messages_to_fit(messages: &[Value], max_tokens: usize) -> Vec<Value> {
    if messages.len() <= 5 || estimate_tokens(messages) <= max_tokens {
        return messages.to_vec();
    }

    let head_count = 2.min(messages.len());
    let head: Vec<Value> = messages[..head_count].to_vec();
    let tail_count = 4.min(messages.len() - head_count).max(1);
    let tail_start = messages.len() - tail_count;
    let tail: Vec<Value> = messages[tail_start..].to_vec();
    let mut middle: Vec<Value> = messages[head_count..tail_start].to_vec();

    while !middle.is_empty() {
        let total = estimate_tokens(&head) + estimate_tokens(&middle) + estimate_tokens(&tail);
        if total <= max_tokens {
            break;
        }
        let dropped = middle.remove(0);
        if dropped.get("role").and_then(|r| r.as_str()) == Some("assistant")
            && dropped.get("tool_calls").is_some()
        {
            while !middle.is_empty()
                && middle[0].get("role").and_then(|r| r.as_str()) == Some("tool")
            {
                middle.remove(0);
            }
        }
    }

    let mut result = head;
    result.extend(middle);
    result.extend(tail);

    if estimate_tokens(&result) > max_tokens && result.len() > 2 {
        result = vec![result[0].clone(), result[result.len() - 1].clone()];
    }

    info!(
        "Truncated messages: {} -> {} messages, est. {} tokens (limit {})",
        messages.len(),
        result.len(),
        estimate_tokens(&result),
        max_tokens
    );
    result
}

/// A reply this short cannot be a rewritten answer; it is the `OK` sentinel (or a variant).
pub const REVISION_MIN_CHARS: usize = 16;

/// Settle the draft when the check cannot complete. The draft was already streamed
/// to the user as it was written, so it is only sent again if the screen no longer
/// shows it (a partial revision was retracted).
async fn flush_draft(tx: &mpsc::Sender<SseEvent>, pending: &mut Option<String>, draft_on_screen: bool) {
    if let Some(draft) = pending.take()
        && !draft_on_screen
    {
        tx.send(SseEvent::Token { content: draft }).await.ok();
    }
}

/// Stream that aborts the upstream generation task when dropped, so a client
/// disconnect stops spending tokens immediately.
struct GuardedStream {
    rx: tokio_stream::wrappers::ReceiverStream<SseEvent>,
    handle: tokio::task::JoinHandle<()>,
}

impl Drop for GuardedStream {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

/// Aborts every task it was given when dropped. `JoinHandle::drop` only *detaches*
/// a task, so when the orchestrator loop is cancelled (client disconnect, request
/// timeout) the tool calls it spawned would otherwise run on, unowned.
#[derive(Default)]
struct AbortAll(Vec<tokio::task::AbortHandle>);

impl Drop for AbortAll {
    fn drop(&mut self) {
        for h in &self.0 {
            h.abort(); // a no-op for a task that already finished
        }
    }
}

impl futures::Stream for GuardedStream {
    type Item = SseEvent;
    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<SseEvent>> {
        std::pin::Pin::new(&mut self.rx).poll_next(cx)
    }
}

#[derive(Clone)]
pub struct DeepSeekClient {
    pub client: Client,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub http_timeout: Duration,
}

/// What the summariser is: it only reports, it must not answer the conversation or add to it.
pub const SUMMARISER_SYSTEM: &str = "You write faithful summaries of conversations between a user and a Singapore legal research assistant. \
You only report what the conversation actually says. You never answer the user's questions, never give legal advice, \
and never add anything that is not in the conversation.";

/// What to summarise for `/compact`, appended after the quoted conversation.
pub const SUMMARY_INSTRUCTION: &str = "Summarise this legal conversation so it can continue from the summary alone. Preserve: the user's situation \
     and goal, section numbers, act names, case citations, key legal facts, dates, amounts, conclusions \
     reached, and any open questions. Do NOT lose specific legal references. Plain prose or short bullets, \
     under 1200 words.";

/// The structure and no-invention rules, after the instruction. Small models fail the free-form instruction in both
/// directions (they invent a situation the user never described, or drop the user's own facts), so the headings are fixed.
pub const SUMMARY_RULES: &str = "Write the summary under exactly these four headings, in this order:\n\
**Situation and goal**: the user's own facts (parties, dates, amounts) and what they want, as they stated them. \
If the user never described a situation of their own, write \"No specific situation described.\"\n\
**Questions and conclusions**: one short bullet per question the user asked, with the conclusion the assistant reached.\n\
**References**: every statute, section number, case citation, date and amount mentioned anywhere in the conversation, copied exactly as written.\n\
**Open questions**: what is still unresolved, or \"None.\"\n\
Use only what appears in the conversation. Do not invent or guess facts, parties, amounts, dates, statutes, section numbers or cases, \
and do not add advice or next steps the assistant did not give. Write in your own words; do not copy passages or whole answers.";

/// Longest summary kept, in characters (matches `LIMIT_SUMMARY_CHARS`).
pub const SUMMARY_MAX_CHARS: usize = 16_000;

/// The conversation as one quoted block, so the model reports on it instead of continuing it.
/// Mirrors `transcript()` in `web/src/agent/compact.ts`, which the browser uses with a user's own key.
pub fn summary_transcript(history: &[crate::models::schemas::ClientMessage], prior: Option<&str>) -> String {
    let lines: Vec<String> = history
        .iter()
        .map(|m| format!("{}: {}", if m.role == "user" { "User" } else { "Assistant" }, m.content))
        .collect();
    let before = match prior.map(str::trim).filter(|p| !p.is_empty()) {
        Some(_) => format!(
            "[Summary of the part of the conversation before this]\n{}\n[End of that summary]\n\n",
            prior.unwrap_or_default()
        ),
        None => String::new(),
    };
    format!("{before}[Conversation to summarise]\n{}\n[End of conversation]", lines.join("\n\n"))
}

/// The two messages `/compact` sends: the summariser's role, then the quoted conversation with the instructions.
pub fn summary_messages(history: &[crate::models::schemas::ClientMessage], prior: Option<&str>) -> Vec<Value> {
    vec![
        json!({"role": "system", "content": SUMMARISER_SYSTEM}),
        json!({"role": "user", "content": format!("{}\n\n{}\n\n{}", summary_transcript(history, prior), SUMMARY_INSTRUCTION, SUMMARY_RULES)}),
    ]
}

/// Sent when the research budget is spent, to force the orchestrator's final answer. `{n}` is the search count.
pub const FORCED_FINAL: &str = "You have now performed {n} searches and retrieved extensive legal context. \
Please write your complete, well-structured answer to the original question \
using all the search results above. When citing statutory provisions, \
quote the exact text from the tool results — do not paraphrase the law. \
Do not search again.";

/// Default forced-final message for a sub-agent that is not cite-by-reference.
pub const SUB_FORCED_FINAL: &str = "You have now performed {n} searches and retrieved extensive legal context. \
Report ALL relevant statutory provisions you found. Reproduce the EXACT \
text of each section verbatim — do not paraphrase or summarize the law. \
Include Act/SL name and section number for each provision. Do not search again.";

/// Appended to a cite-by-reference sub-agent's own forced-final message.
pub const SUB_FORCED_FINAL_SUFFIX: &str = " You performed {n} searches. Do not search again.";

/// Cite-by-reference final message: legislation and subsidiary-legislation research.
pub const LEGISLATION_REFS_FINAL: &str = "Output ONLY a JSON array referencing provisions from your tool \
results above. Each element: {\"act_name\": \"...\", \
\"section_id\": \"...\", \"relevance\": \"one sentence\"}. \
ONLY include sections/rules that appeared in your search_legislation \
or get_section results — do NOT add any from general knowledge. \
Copy act_name and section_id EXACTLY from the tool result headers. \
If no relevant results were found, output [].";

/// Cite-by-reference final message: judiciary research.
pub const JUDICIARY_REFS_FINAL: &str = "Output ONLY a JSON array referencing judgment chunks from your tool \
results above. Each element: {\"citation\": \"[2021] SGHC 987\", \
\"chunk_id\": \"2021_SGHC_987_chunk4\", \"relevance\": \"one sentence\"}. \
ONLY include chunks whose id appeared in your search_judiciary or \
get_judgment results — do NOT add any from general knowledge. Copy \
citation and chunk_id EXACTLY from the result headers. Do not \
reference `_meta` ids. Omit chunks that are only tangentially \
relevant. If no relevant results were found, output [].";

/// What a sub-agent runs with: its system prompt, its tools and, for the cite-by-reference
/// agents, the message that makes it answer with references only.
pub struct SubAgentSpec {
    pub system_prompt: String,
    pub tools: Vec<Value>,
    pub final_message: Option<&'static str>,
}

/// The spec for a sub-agent `mode` (`legislation_research`, `legislation_sl`, `judiciary_research`,
/// or the self-help agents' `legislation` / `judiciary`).
pub fn subagent_spec(config: &AppConfig, mode: &str) -> SubAgentSpec {
    let (tools, system_prompt) = match mode {
        "legislation_research" | "legislation_sl" => (
            vec![make_law_search_tool(), make_get_section_tool()],
            prompts::subagent_prompt(config, mode).expect("sub-agent prompt for a known sub-agent mode"),
        ),
        "judiciary_research" => (
            vec![make_judgment_search_tool(), make_get_judgment_tool()],
            prompts::subagent_prompt(config, mode).expect("sub-agent prompt for a known sub-agent mode"),
        ),
        "legislation" => (
            vec![make_law_search_tool(), make_get_section_tool()],
            build_system_prompt(config, mode, &[]),
        ),
        _ => (vec![make_judgment_search_tool()], build_system_prompt(config, mode, &[])),
    };
    let final_message = match mode {
        "judiciary_research" => Some(JUDICIARY_REFS_FINAL),
        "legislation_research" | "legislation_sl" => Some(LEGISLATION_REFS_FINAL),
        _ => None,
    };
    SubAgentSpec { system_prompt, tools, final_message }
}

impl DeepSeekClient {
    pub fn new(base_url: &str, api_key: &str, model: &str) -> Self {
        // Use a generous default; overridden per-call via config.deepseek_http_timeout
        let timeout_secs = Duration::from_secs(600);
        let client = Client::builder()
            .timeout(timeout_secs)
            .pool_max_idle_per_host(2)
            .build()
            .expect("Failed to build reqwest client");
        Self {
            client,
            base_url: base_url.to_string(),
            api_key: api_key.to_string(),
            model: model.to_string(),
            http_timeout: timeout_secs,
        }
    }

    /// Summarise `history` for `/compact` with the server's own model. Returns (summary, tokens spent).
    /// No tools: the summariser writes text only.
    pub async fn summarize_conversation(
        &self,
        config: &AppConfig,
        history: &[crate::models::schemas::ClientMessage],
        prior: Option<&str>,
    ) -> Result<(String, u64), String> {
        let messages = summary_messages(history, prior);
        let prompt_chars = serde_json::to_string(&messages).map(|s| s.len()).unwrap_or(0);
        let mut payload = json!({
            "model": self.model,
            "messages": messages,
            "temperature": 0.1,
            "max_tokens": 3000,
            "stream": false
        });
        provider::disable_thinking(&mut payload, &self.base_url);
        let client = Self::http_client_with_timeout(config.deepseek_http_timeout.min(90.0) as u64);
        let t_call = Instant::now();
        let resp = client
            .post(format!("{}/chat/completions", self.base_url))
            .header("Authorization", format!("Bearer {}", self.api_key))
            .json(&payload)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status().as_u16()));
        }
        let body: Value = resp.json().await.map_err(|e| e.to_string())?;
        let text = body["choices"][0]["message"]["content"].as_str().unwrap_or("").trim().to_string();
        if text.is_empty() {
            return Err("empty summary".into());
        }
        let text: String = text.chars().take(SUMMARY_MAX_CHARS).collect();
        let spent = body["usage"]["total_tokens"].as_u64().unwrap_or((prompt_chars / 3) as u64);
        record_usage(&self.base_url, &self.model, "compact", "compact", metrics::Usage::from_json(&body["usage"]));
        metrics::record_llm_request("compact", "ok", t_call.elapsed().as_secs_f64());
        Ok((text, spent))
    }

    /// Build a one-shot HTTP client with the configured DeepSeek timeout.
    fn http_client_with_timeout(timeout_secs: u64) -> Client {
        Client::builder()
            .timeout(Duration::from_secs(timeout_secs))
            .pool_max_idle_per_host(2)
            .build()
            .unwrap_or_else(|_| Client::new())
    }

    /// Get tool definitions for a given mode.
    pub fn get_tools(mode: &str) -> Vec<Value> {
        match mode {
            "self-help" => vec![
                make_classify_issue_tool(),
                make_legislation_agent_tool(),
                make_judiciary_agent_tool(),
                crate::services::web_search::make_tavily_tool(),
                crate::services::web_search::make_deepseek_tool(),
                make_ask_question_tool(),
            ],
            "judiciary" => vec![make_judgment_search_tool(), make_ask_question_tool()],
            _ => vec![
                make_research_legislation_tool(),
                make_research_sl_tool(),
                make_research_judiciary_tool(),
                orchestrator_read_tool(make_get_section_tool()),
                orchestrator_read_tool(make_get_judgment_tool()),
                crate::services::web_search::make_tavily_tool(),
                crate::services::web_search::make_deepseek_tool(),
                make_ask_question_tool(),
            ],
        }
    }

    /// Stream DeepSeek completion with agentic tool-call execution loop.
    ///
    /// `on_tool_call`: async closure (name, args) -> Result<String, String>
    /// Returns a stream of SseEvent.
    pub async fn stream_with_tools(
        &self,
        config: &AppConfig,
        messages: Vec<Value>,
        tools: Vec<Value>,
        on_tool_call: ToolExecutorFn,
        mode: &str,
    ) -> impl futures::Stream<Item = SseEvent> {
        let (tx, rx) = mpsc::channel::<SseEvent>(256);
        let tx_clone = tx.clone();

        // Build a per-call client honouring the configured HTTP timeout
        let client = Self::http_client_with_timeout(config.deepseek_http_timeout as u64);
        let base_url = self.base_url.clone();
        let api_key = self.api_key.clone();
        let model = self.model.clone();
        let config_clone = config.clone();
        let mode_owned = mode.to_string();

        let handle = crate::services::qdrant_store::spawn_with_queue_sink(async move {
            if let Err(e) = Self::stream_inner(
                &client,
                &base_url,
                &api_key,
                &model,
                &config_clone,
                messages,
                tools,
                on_tool_call,
                &tx_clone,
                &mode_owned,
            )
            .await
            {
                error!("stream_with_tools inner error: {}", e);
                let _ = tx_clone
                    .send(SseEvent::Error {
                        error: e.to_string(),
                    })
                    .await;
            }
        });

        GuardedStream { rx: tokio_stream::wrappers::ReceiverStream::new(rx), handle }
    }

    /// Inner implementation of the streaming loop.
    #[allow(clippy::too_many_arguments)]
    async fn stream_inner(
        client: &Client,
        base_url: &str,
        api_key: &str,
        model: &str,
        config: &AppConfig,
        messages: Vec<Value>,
        tools: Vec<Value>,
        on_tool_call: ToolExecutorFn,
        tx: &mpsc::Sender<SseEvent>,
        mode: &str,
    ) -> Result<(), anyhow::Error> {
        let url = format!("{}/chat/completions", base_url);
        let max_tokens: i64 = MAX_OUTPUT_TOKENS;
        // One sampling setting for every round, matching the reference agent's Agent
        // mode (temperature 0, top_p 0.9): deterministic tool-call arguments and a
        // deterministic final answer.
        let temperature = config.temperature;
        let top_p = config.top_p;
        let hard_cap = config.rag_search_hard_cap as usize;
        let max_search_tokens = ((config.context_window_size - OUTPUT_RESERVE_TOKENS) as f64
            * config.rag_context_fill_ratio) as usize;
        // Apply a 0.75 safety factor: the 3-chars/token heuristic underestimates by ~25-33%
        // on legal text (dense citations). This prevents HTTP 400 context-exceeded errors.
        let hard_input_limit = ((config.context_window_size - OUTPUT_RESERVE_TOKENS) as f64 * 0.75) as usize;
        let mut working_messages = messages;
        let mut search_count: usize = 0;
        let mut total_prompt_tokens: u64 = 0;
        let mut total_completion_tokens: u64 = 0;
        let mut total_cache_hit_tokens: u64 = 0;
        let mut total_cache_miss_tokens: u64 = 0;
        // Tool nudge + finalization check (adapted from a reference agent).
        let mut last_ctx: u64 = 0; // real size of the latest request (prompt + reply), for the context ring
        let mut nudges_used: usize = 0;
        let mut tool_steps: usize = 0;
        let mut pending_draft: Option<String> = None;
        // The pending draft is already on the user's screen (it streams as written).
        let mut draft_on_screen = false;
        'search_loop: while search_count < hard_cap {
            let current_tokens = estimate_tokens(&working_messages);
            if current_tokens >= max_search_tokens {
                debug!(
                    "Budget reached before API call: {} >= {}",
                    current_tokens, max_search_tokens
                );
                break 'search_loop;
            }

            // Hold the answer back while a verification pass may add corrections.
            // Zero-tool turns are not held: there is nothing researched in this
            // turn to verify, and checking would invite the model to re-open
            // earlier turns.
            let was_pending = pending_draft.is_some();
            let hold = nudge::should_check(
                config.finalization_check,
                nudges_used,
                tool_steps,
                was_pending,
            );
            // The first answer streams live; only the verification reply is buffered
            // (it is usually just `OK` and must not be shown).
            let verifying = was_pending;
            let mut held = String::new();
            let mut live_streamed = false; // text of a round that may turn out to be narration
            let mut revision_streamed = false;
            if hold {
                tx.send(SseEvent::Phase { phase: "synthesizing".into() }).await.ok();
            }

            let t_start = Instant::now();
            let mut payload = json!({
                "model": model,
                "messages": &working_messages,
                "tools": &tools,
                "tool_choice": "auto",
                "temperature": temperature,
                "top_p": top_p,
                "max_tokens": max_tokens,
                "stream": true,
                "stream_options": {"include_usage": true}
            });
            provider::disable_thinking(&mut payload, base_url);

            // Make streaming HTTP request
            let resp = client
                .post(&url)
                .header("Authorization", format!("Bearer {}", api_key))
                .json(&payload)
                .send()
                .await;

            let resp = match resp {
                Ok(r) => r,
                Err(e) => {
                    error!("DeepSeek HTTP request failed: {}", e);
                    metrics::record_llm_request("search_round", "error", t_start.elapsed().as_secs_f64());
                    flush_draft(tx, &mut pending_draft, draft_on_screen).await;
                    tx.send(SseEvent::Error {
                        error: format!("DeepSeek API error: {}", e),
                    })
                    .await
                    .ok();
                    return Ok(());
                }
            };

            let status = resp.status().as_u16();
            if status != 200 {
                metrics::record_llm_request("search_round", "http_error", t_start.elapsed().as_secs_f64());
                if status == 400 {
                    warn!("DeepSeek HTTP 400 -- truncating and forcing final answer");
                    working_messages =
                        truncate_messages_to_fit(&working_messages, max_search_tokens);
                    break 'search_loop;
                }
                flush_draft(tx, &mut pending_draft, draft_on_screen).await;
                tx.send(SseEvent::Error {
                    error: super::llm_errors::user_message(status).to_string(),
                })
                .await
                .ok();
                return Ok(());
            }

            // Parse SSE stream
            let mut stream = resp.bytes_stream();
            let mut buffer = String::new();
            let mut accumulated_tool_calls: HashMap<usize, AccumulatedToolCall> = HashMap::new();
            let mut accumulated_content = String::new();
            let mut round_prompt_tokens: u64 = 0;
            let mut round_completion_tokens: u64 = 0;
            let mut round_cache_hit_tokens: u64 = 0;
            let mut round_cache_miss_tokens: u64 = 0;
            let mut had_tool_calls = false;

            loop {
                let next = tokio::select! {
                    result = timeout(Duration::from_secs(15), stream.next()) => {
                        match result {
                            Ok(Some(item)) => item,
                            Ok(None) => break,
                            Err(_elapsed) => {
                                tx.send(SseEvent::Heartbeat).await.ok();
                                continue;
                            }
                        }
                    }
                };

                let chunk = match next {
                    Ok(bytes) => bytes,
                    Err(_) => break,
                };

                buffer.push_str(&String::from_utf8_lossy(&chunk));
                while let Some(pos) = buffer.find('\n') {
                    let line = buffer[..pos].to_string();
                    buffer.drain(..=pos);

                    let data = match line.strip_prefix("data: ") {
                        Some(d) => d,
                        None => continue,
                    };

                    if data.trim() == "[DONE]" {
                        break;
                    }

                    let parsed: Value = match serde_json::from_str(data) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };

                    // Accumulate usage (including cache hit/miss tokens)
                    if let Some(usage) = parsed.get("usage") {
                        round_prompt_tokens = usage["prompt_tokens"].as_u64().unwrap_or(0);
                        round_completion_tokens = usage["completion_tokens"].as_u64().unwrap_or(0);
                        let (hit, miss) = parse_cache_tokens(usage);
                        round_cache_hit_tokens = hit;
                        round_cache_miss_tokens = miss;
                    }

                    if let Some(choices) = parsed["choices"].as_array() {
                        for choice in choices {
                            let delta = match choice.get("delta") {
                                Some(d) => d,
                                None => continue,
                            };

                            // Stream text tokens
                            if let Some(content) = delta["content"].as_str()
                                && !content.is_empty()
                            {
                                accumulated_content.push_str(content);
                                if !verifying {
                                    live_streamed = true;
                                    tx.send(SseEvent::Token {
                                        content: content.to_string(),
                                    })
                                    .await
                                    .ok();
                                } else if revision_streamed {
                                    tx.send(SseEvent::Token {
                                        content: content.to_string(),
                                    })
                                    .await
                                    .ok();
                                } else {
                                    held.push_str(content);
                                    // Clearly a rewritten answer rather than `OK`: swap it
                                    // in for the draft and stream the rest live.
                                    if held.trim().chars().count() > REVISION_MIN_CHARS && !nudge::is_ok_reply(&held) {
                                        if draft_on_screen {
                                            tx.send(SseEvent::AnswerReset).await.ok();
                                            draft_on_screen = false;
                                        }
                                        revision_streamed = true;
                                        tx.send(SseEvent::Token { content: held.clone() }).await.ok();
                                    }
                                }
                            }

                            // Accumulate tool call fragments
                            if let Some(tc_list) = delta["tool_calls"].as_array() {
                                had_tool_calls = true;
                                for tc in tc_list {
                                    let idx = tc["index"].as_u64().unwrap_or(0) as usize;
                                    let entry =
                                        accumulated_tool_calls.entry(idx).or_insert_with(|| {
                                            AccumulatedToolCall {
                                                id: String::new(),
                                                name: String::new(),
                                                arguments: String::new(),
                                            }
                                        });
                                    if let Some(id) = tc["id"].as_str() {
                                        entry.id = id.to_string();
                                    }
                                    if let Some(fn_obj) = tc.get("function") {
                                        if let Some(n) = fn_obj["name"].as_str() {
                                            entry.name.push_str(n);
                                        }
                                        if let Some(a) = fn_obj["arguments"].as_str() {
                                            entry.arguments.push_str(a);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            } // end SSE read loop

            // Record metrics
            let call_type = if had_tool_calls {
                "search_round"
            } else {
                "final_answer"
            };
            metrics::record_llm_request(call_type, "ok", t_start.elapsed().as_secs_f64());
            record_usage(
                base_url,
                model,
                mode,
                call_type,
                metrics::Usage {
                    prompt: round_prompt_tokens,
                    cache_hit: round_cache_hit_tokens,
                    cache_miss: round_cache_miss_tokens,
                    completion: round_completion_tokens,
                },
            );

            info!(
                call_type,
                prompt_tokens = round_prompt_tokens,
                cache_hit_tokens = round_cache_hit_tokens,
                cache_miss_tokens = round_cache_miss_tokens,
                search_count,
                "DeepSeek round complete"
            );

            total_prompt_tokens += round_prompt_tokens;
            total_completion_tokens += round_completion_tokens;
            total_cache_hit_tokens += round_cache_hit_tokens;
            total_cache_miss_tokens += round_cache_miss_tokens;
            last_ctx = round_prompt_tokens + round_completion_tokens;

            if had_tool_calls {
                // Text emitted alongside a tool call is pre-tool narration ("I'll research
                // this for you."), not the answer. The model still sees its own text in
                // `working_messages`, but the user must not keep it: retract whatever
                // was streamed this round. A pending draft is kept: the model may be
                // investigating during the check and will confirm or revise it afterwards.
                if live_streamed || revision_streamed {
                    tx.send(SseEvent::AnswerReset).await.ok();
                    if revision_streamed {
                        draft_on_screen = false; // the partial revision replaced the draft
                    }
                } else if !held.is_empty() {
                    debug!("dropped pre-tool narration ({} chars)", held.len());
                }
                if pending_draft.is_some() {
                    debug!("finalization check: model investigated, keeping draft for confirmation");
                }
            } else if hold {
                if let Some(draft) = pending_draft.take() {
                    if revision_streamed {
                        debug!("finalization check: revised answer (streamed)");
                    } else if held.trim().is_empty() || nudge::is_ok_reply(&held) {
                        debug!("finalization check: confirmed");
                        if !draft_on_screen {
                            tx.send(SseEvent::Token { content: draft }).await.ok();
                        }
                    } else {
                        debug!("finalization check: revised answer");
                        if draft_on_screen {
                            tx.send(SseEvent::AnswerReset).await.ok();
                        }
                        tx.send(SseEvent::Token { content: held }).await.ok();
                    }
                    draft_on_screen = false;
                } else if !accumulated_content.trim().is_empty() {
                    // First final answer: it has already streamed to the user. Keep it as
                    // the draft and ask for one verification pass behind it.
                    let draft = accumulated_content.clone();
                    working_messages.push(json!({"role": "assistant", "content": &draft}));
                    working_messages.push(json!({"role": "user", "content": nudge::FINALIZATION_NUDGE}));
                    nudges_used += 1;
                    pending_draft = Some(draft);
                    draft_on_screen = true;
                    continue 'search_loop;
                }
            }

            if !had_tool_calls {
                // Model produced text answer -- we're done
                log_turn_cost(
                    total_cache_hit_tokens,
                    total_cache_miss_tokens,
                    total_completion_tokens,
                    search_count,
                );
                let used = total_prompt_tokens + total_completion_tokens;
                let max = config.context_window_size as u64;
                // Emit token split for DB persistence (Gap 2)
                tx.send(SseEvent::Usage {
                    prompt_tokens: total_prompt_tokens,
                    completion_tokens: total_completion_tokens,
                    total_tokens: used,
                })
                .await
                .ok();
                tx.send(SseEvent::ContextUsage {
                    used: last_ctx,
                    max,
                    percent: (last_ctx * 100).checked_div(max).unwrap_or(0),
                })
                .await
                .ok();
                tx.send(SseEvent::Done).await.ok();
                return Ok(());
            }

            // Build assistant message with tool_calls for the API
            let mut tc_for_msg = Vec::new();
            let mut tc_id_list = Vec::new();
            let mut sorted: Vec<(&usize, &AccumulatedToolCall)> =
                accumulated_tool_calls.iter().collect();
            sorted.sort_by_key(|(k, _)| *k);
            for (i, (_k, tc)) in sorted.iter().enumerate() {
                let call_id = if tc.id.is_empty() {
                    format!("call_{}", i)
                } else {
                    tc.id.clone()
                };
                tc_for_msg.push(json!({
                    "id": &call_id,
                    "type": "function",
                    "function": {"name": tc.name, "arguments": tc.arguments}
                }));
                tc_id_list.push(call_id);
            }
            working_messages.push(json!({
                "role": "assistant",
                "content": if accumulated_content.is_empty() { Value::Null } else { json!(accumulated_content) },
                "tool_calls": tc_for_msg
            }));

            // Execute all tool calls concurrently (parallel). Sub-agents each have their
            // own non_streaming_with_tools loop and run independently — this matches Python's
            // asyncio.create_task behaviour. Reranking is fast now (4K doc cap, prefetch_k=8).
            let count = sorted.len();
            let mut tool_results: Vec<(usize, String, Result<String, String>)> = Vec::new();
            type ToolHandles =
                Vec<tokio::task::JoinHandle<(usize, String, Result<String, String>)>>;
            let mut tool_handles: ToolHandles = Vec::new();
            // Owned by this loop iteration: if the loop is cancelled while tools run,
            // dropping it cancels them too.
            let mut tool_abort = AbortAll::default();

            for (i, (_k, tc)) in sorted.iter().enumerate() {
                let name = tc.name.clone();
                let args: Value = serde_json::from_str(&tc.arguments).unwrap_or(json!({}));
                let call_id = tc_id_list[i].clone();
                let tx = tx.clone();
                let on_tc = Arc::clone(&on_tool_call);

                tx.send(SseEvent::ToolCall {
                    name: name.clone(),
                    arguments: args.clone(),
                    id: Some(call_id.clone()),
                })
                .await
                .ok();

                let call_id_for_exec = call_id.clone();
                let handle = crate::services::qdrant_store::spawn_with_queue_sink(async move {
                    tx.send(SseEvent::ToolProgress {
                        name: name.clone(),
                        searches: 1,
                        phase: "searching".to_string(),
                    })
                    .await
                    .ok();

                    // The call id travels with the args so sub-agent tools can key
                    // their transcript to this call; the executor strips it.
                    let mut exec_args = args;
                    if let Some(o) = exec_args.as_object_mut() {
                        o.insert("__call_id".into(), json!(call_id_for_exec));
                    }
                    let result = on_tc(name.clone(), exec_args).await;

                    match &result {
                        Ok(result_text) => {
                            tx.send(SseEvent::ToolResult {
                                name: name.clone(),
                                result: json!(result_text),
                                id: Some(call_id.clone()),
                            })
                            .await
                            .ok();
                        }
                        Err(e) => {
                            // A failed tool is not a failed turn: show it on its card, keep going.
                            warn!("tool {} failed: {}", name, e);
                            tx.send(SseEvent::ToolResult {
                                name: name.clone(),
                                result: json!(if crate::services::qdrant_store::is_db_timeout(&e.to_string()) {
                                    crate::services::qdrant_store::db_timeout_tool_message()
                                } else {
                                    "[ERROR] This search is unavailable right now.".to_string()
                                }),
                                id: Some(call_id.clone()),
                            })
                            .await
                            .ok();
                        }
                    }
                    (i, call_id, result)
                });
                tool_abort.0.push(handle.abort_handle());
                tool_handles.push(handle);
            }

            // Wait for all tool calls to complete, sending heartbeats every 3s.
            let mut pending: Vec<_> = tool_handles.into_iter().collect();
            let mut heartbeat_elapsed = Duration::ZERO;
            while !pending.is_empty() {
                tokio::time::sleep(Duration::from_millis(200)).await;
                heartbeat_elapsed += Duration::from_millis(200);
                if heartbeat_elapsed >= Duration::from_secs(3) {
                    tx.send(SseEvent::Heartbeat).await.ok();
                    heartbeat_elapsed = Duration::ZERO;
                }
                let mut still_pending = Vec::new();
                for h in pending.drain(..) {
                    if h.is_finished() {
                        if let Ok((i, call_id, res)) = h.await {
                            tool_results.push((i, call_id, res));
                        }
                    } else {
                        still_pending.push(h);
                    }
                }
                pending = still_pending;
            }

            search_count += count;
            tool_steps += 1;

            // Check if all tools failed — if so, tell LLM to answer without search
            let all_failed = tool_results.iter().all(|(_, _, r)| r.is_err());
            if all_failed {
                let err_msg = tool_results
                    .first()
                    .and_then(|(_, _, r)| r.as_ref().err())
                    .cloned()
                    .unwrap_or_else(|| "search unavailable".to_string());
                // Feed error results so the API conversation stays valid
                tool_results.sort_by_key(|(i, _, _)| *i);
                for (_, call_id, _) in &tool_results {
                    working_messages.push(json!({
                        "role": "tool",
                        "tool_call_id": call_id,
                        "content": format!("[Search unavailable: {}. Answer from general knowledge, clearly stating you could not verify against the database.]", err_msg)
                    }));
                }
                // Break the search loop — no point retrying if embedding is down
                break 'search_loop;
            }

            // Feed actual tool results back into working_messages so LLM sees the search results.
            // Cap each result at rag_context_budget tokens to prevent single large sub-agent
            // answers from blowing up the orchestrator's context window.
            tool_results.sort_by_key(|(i, _, _)| *i);
            for (_, call_id, res) in &tool_results {
                let raw = match res {
                    Ok(text) => text.clone(),
                    Err(e) => format!("[Search failed: {}]", e),
                };
                // Cap at rag_context_budget tokens (2 chars/token estimate)
                let max_result_chars = (config.rag_context_budget * 2) as usize;
                let content = if raw.len() > max_result_chars {
                    let mut end = max_result_chars;
                    while end > 0 && !raw.is_char_boundary(end) {
                        end -= 1;
                    }
                    format!("{}\n\n[... trimmed to fit context budget]", &raw[..end])
                } else {
                    raw
                };
                working_messages.push(json!({
                    "role": "tool",
                    "tool_call_id": call_id,
                    "content": content
                }));
            }

            if config.tool_nudge {
                nudge::attach_tool_nudge(&mut working_messages, nudge::DEFAULT_TOOL_NUDGE);
            }

            // Post-result budget check
            if estimate_tokens(&working_messages) >= max_search_tokens {
                info!(
                    "Post-result budget reached ({} tokens) -- forcing final answer",
                    estimate_tokens(&working_messages)
                );
                break 'search_loop;
            }
        }

        // A draft that was waiting for its check when the loop ended is still the answer.
        if let Some(draft) = pending_draft.take() {
            if !draft_on_screen {
                tx.send(SseEvent::Token { content: draft }).await.ok();
            }
            let used = total_prompt_tokens + total_completion_tokens;
            let max = config.context_window_size as u64;
            tx.send(SseEvent::Usage {
                prompt_tokens: total_prompt_tokens,
                completion_tokens: total_completion_tokens,
                total_tokens: used,
            })
            .await
            .ok();
            tx.send(SseEvent::ContextUsage { used: last_ctx, max, percent: (last_ctx * 100).checked_div(max).unwrap_or(0) })
                .await
                .ok();
            tx.send(SseEvent::Done).await.ok();
            return Ok(());
        }

        // -- Forced Final Answer ---------------------------------------------------
        tx.send(SseEvent::Phase { phase: "synthesizing".into() }).await.ok();
        working_messages.push(json!({
            "role": "user",
            "content": FORCED_FINAL.replace("{n}", &search_count.to_string())
        }));

        // Truncate to hard_input_limit before forced final. If still too big, truncate harder
        // to keep only system + last user message so we always get some answer.
        if estimate_tokens(&working_messages) >= hard_input_limit {
            working_messages = truncate_messages_to_fit(&working_messages, hard_input_limit);
        }

        let mut final_payload = json!({
            "model": model,
            "messages": &working_messages,
            "temperature": temperature,
            "top_p": top_p,
            "max_tokens": max_tokens,
            "stream": true,
            "stream_options": {"include_usage": true}
        });
        provider::disable_thinking(&mut final_payload, base_url);

        let t_final = Instant::now();
        let resp = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", api_key))
            .json(&final_payload)
            .send()
            .await;

        match resp {
            Ok(resp) => {
                let resp = if resp.status().as_u16() == 400 {
                    // Estimate was still too high — truncate to just system + last user and retry once
                    warn!("Forced-final returned 400 — truncating to minimal context and retrying");
                    let minimal = if working_messages.len() >= 2 {
                        vec![
                            working_messages[0].clone(),
                            working_messages[working_messages.len() - 1].clone(),
                        ]
                    } else {
                        working_messages.clone()
                    };
                    let mut retry_payload = json!({
                        "model": model,
                        "messages": minimal,
                        "temperature": temperature,
                        "top_p": top_p,
                        "max_tokens": max_tokens,
                        "stream": true,
                        "stream_options": {"include_usage": true}
                    });
                    provider::disable_thinking(&mut retry_payload, base_url);
                    let retry_resp = client
                        .post(&url)
                        .header("Authorization", format!("Bearer {}", api_key))
                        .json(&retry_payload)
                        .send()
                        .await;
                    match retry_resp {
                        Ok(r) if r.status().is_success() => r,
                        _ => {
                            tx.send(SseEvent::Error {
                                error: "Context window exceeded — conversation was too long. Please start a new chat session.".into(),
                            }).await.ok();
                            return Ok(());
                        }
                    }
                } else {
                    resp
                };

                let mut stream = resp.bytes_stream();
                let mut buffer = String::new();
                let mut final_prompt_tokens: u64 = 0;
                let mut final_completion_tokens: u64 = 0;
                let mut final_cache_hit_tokens: u64 = 0;
                let mut final_cache_miss_tokens: u64 = 0;

                while let Some(chunk) = stream.next().await {
                    let bytes = match chunk {
                        Ok(b) => b,
                        Err(_) => break,
                    };
                    buffer.push_str(&String::from_utf8_lossy(&bytes));
                    while let Some(pos) = buffer.find('\n') {
                        let line = buffer[..pos].to_string();
                        buffer.drain(..=pos);
                        if let Some(data) = line.strip_prefix("data: ") {
                            if data.trim() == "[DONE]" {
                                break;
                            }
                            if let Ok(chunk) = serde_json::from_str::<Value>(data) {
                                if let Some(usage) = chunk.get("usage") {
                                    final_prompt_tokens =
                                        usage["prompt_tokens"].as_u64().unwrap_or(0);
                                    final_completion_tokens =
                                        usage["completion_tokens"].as_u64().unwrap_or(0);
                                    let (hit, miss) = parse_cache_tokens(usage);
                                    final_cache_hit_tokens = hit;
                                    final_cache_miss_tokens = miss;
                                }
                                if let Some(content) =
                                    chunk["choices"][0]["delta"]["content"].as_str()
                                    && !content.is_empty()
                                {
                                    tx.send(SseEvent::Token {
                                        content: content.to_string(),
                                    })
                                    .await
                                    .ok();
                                }
                            }
                        }
                    }
                }

                metrics::record_llm_request("forced_final", "ok", t_final.elapsed().as_secs_f64());
                record_usage(
                    base_url,
                    model,
                    mode,
                    "forced_final",
                    metrics::Usage {
                        prompt: final_prompt_tokens,
                        cache_hit: final_cache_hit_tokens,
                        cache_miss: final_cache_miss_tokens,
                        completion: final_completion_tokens,
                    },
                );

                info!(
                    call_type = "final_answer",
                    prompt_tokens = final_prompt_tokens,
                    cache_hit_tokens = final_cache_hit_tokens,
                    cache_miss_tokens = final_cache_miss_tokens,
                    search_count,
                    "DeepSeek round complete"
                );

                total_prompt_tokens += final_prompt_tokens;
                total_completion_tokens += final_completion_tokens;
                total_cache_hit_tokens += final_cache_hit_tokens;
                total_cache_miss_tokens += final_cache_miss_tokens;
                last_ctx = final_prompt_tokens + final_completion_tokens;
                log_turn_cost(
                    total_cache_hit_tokens,
                    total_cache_miss_tokens,
                    total_completion_tokens,
                    search_count,
                );
            }
            Err(e) => {
                metrics::record_llm_request("forced_final", "error", t_final.elapsed().as_secs_f64());
                warn!("forced-final failed: {}", e);
                tx.send(SseEvent::Error {
                    error: super::llm_errors::message_for(&e.to_string(), super::llm_errors::GENERIC).to_string(),
                })
                .await
                .ok();
                return Ok(());
            }
        }

        let used = total_prompt_tokens + total_completion_tokens;
        let max = config.context_window_size as u64;
        // Emit Usage on forced-final path too (mirrors Python's always-emit behavior)
        tx.send(SseEvent::Usage {
            prompt_tokens: total_prompt_tokens,
            completion_tokens: total_completion_tokens,
            total_tokens: used,
        })
        .await
        .ok();
        tx.send(SseEvent::ContextUsage {
            used: last_ctx,
            max,
            percent: (last_ctx * 100).checked_div(max).unwrap_or(0),
        })
        .await
        .ok();
        tx.send(SseEvent::Done).await.ok();
        Ok(())
    }

    /// Record a sub-agent response: Prometheus, and the daily budget (which previously ignored
    /// sub-agent spend entirely).
    fn record_sub_agent_usage(&self, sub_mode: &str, body: &Value, seconds: f64) {
        let u = metrics::Usage::from_json(&body["usage"]);
        record_usage(&self.base_url, &self.model, sub_mode, "sub_agent", u);
        metrics::record_llm_request("sub_agent", "ok", seconds);
        crate::limits::charge_budget(u.total());
        debug!(
            sub_mode,
            prompt_tokens = u.prompt,
            cache_hit_tokens = u.cache_hit,
            completion_tokens = u.completion,
            "sub-agent usage"
        );
    }

    /// Non-streaming DeepSeek completion with tool-call loop.
    /// Used by sub-agents. Returns (final_content, tool_calls_made).
    /// on_progress: optional channel to emit (search_count, phase) updates.
    /// forced_final_override: if set, replaces the default "reproduce verbatim"
    /// forced-final message — used by cite-by-reference legislation sub-agents.
    #[allow(clippy::too_many_arguments)]
    pub async fn non_streaming_with_tools(
        &self,
        config: &AppConfig,
        messages: Vec<Value>,
        tools: Vec<Value>,
        on_tool_call: ToolExecutorFn,
        on_progress: Option<tokio::sync::mpsc::Sender<(usize, &'static str)>>,
        max_context_tokens: Option<i64>,
        forced_final_override: Option<&str>,
        sub_mode: &str,
    ) -> Result<(String, Vec<ToolCallMade>), String> {
        let url = format!("{}/chat/completions", self.base_url);
        let max_tokens: i64 = SUBAGENT_MAX_OUTPUT_TOKENS;
        // Sub-agents are deterministic by design — the reference agent's `task` tool runs
        // them at temperature 0 with no top_p — so repeated spawns are stable.
        let temperature: f64 = 0.0;
        let hard_cap = config.rag_search_hard_cap as usize;
        let max_search_tokens = max_context_tokens.map(|b| b as usize).unwrap_or_else(|| {
            ((config.context_window_size - OUTPUT_RESERVE_TOKENS) as f64 * config.rag_context_fill_ratio)
                as usize
        });

        let mut working_messages = messages;
        let mut search_count: usize = 0;
        let mut all_tool_calls: Vec<ToolCallMade> = Vec::new();

        while search_count < hard_cap {
            let current_tokens = estimate_tokens(&working_messages);
            if current_tokens >= max_search_tokens {
                break;
            }

            debug!(
                "non_streaming loop start: search_count={} tokens={} msgs={}",
                search_count,
                current_tokens,
                working_messages.len()
            );

            let mut payload = json!({
                "model": self.model,
                "messages": &working_messages,
                "tools": &tools,
                "tool_choice": "auto",
                "temperature": temperature,
                "max_tokens": max_tokens,
                "stream": false
            });
            provider::disable_thinking(&mut payload, &self.base_url);

            let t_call = Instant::now();
            let resp = self
                .client
                .post(&url)
                .header("Authorization", format!("Bearer {}", self.api_key))
                .json(&payload)
                .send()
                .await
                .inspect_err(|_| metrics::record_llm_request("sub_agent", "error", t_call.elapsed().as_secs_f64()))
                .map_err(|e| format!("DeepSeek API error: {}", e))?;

            let status = resp.status().as_u16();
            debug!(
                "non_streaming API response: http_status={}",
                status
            );

            if status != 200 {
                metrics::record_llm_request("sub_agent", "http_error", t_call.elapsed().as_secs_f64());
                if status == 400 {
                    warn!("non_streaming: DeepSeek HTTP 400 — truncating and forcing final answer");
                    working_messages =
                        truncate_messages_to_fit(&working_messages, max_search_tokens);
                    break;
                }
                return Err(format!("DeepSeek API error: HTTP {}", status));
            }

            let body: Value = resp
                .json()
                .await
                .inspect_err(|_| metrics::record_llm_request("sub_agent", "error", t_call.elapsed().as_secs_f64()))
                .map_err(|e| e.to_string())?;
            self.record_sub_agent_usage(sub_mode, &body, t_call.elapsed().as_secs_f64());
            let choice = &body["choices"][0];
            let message = &choice["message"];
            let finish_reason = choice["finish_reason"].as_str().unwrap_or("unknown");
            let tc_count = message["tool_calls"]
                .as_array()
                .map(|a| a.len())
                .unwrap_or(0);
            debug!(
                "non_streaming finish_reason={} tool_calls={}",
                finish_reason, tc_count
            );

            if finish_reason != "tool_calls" {
                let content = message["content"].as_str().unwrap_or("").to_string();
                debug!(
                    "non_streaming returning text answer len={}",
                    content.len()
                );
                return Ok((content, all_tool_calls));
            }

            // Execute tool calls sequentially
            if let Some(tc_list) = message["tool_calls"].as_array() {
                search_count += tc_list.len();

                // Build assistant message
                working_messages.push(json!({
                    "role": "assistant",
                    "content": message["content"],
                    "tool_calls": tc_list
                }));

                for tc in tc_list {
                    let name = tc["function"]["name"].as_str().unwrap_or("").to_string();
                    let args_str = tc["function"]["arguments"].as_str().unwrap_or("{}");
                    let args: Value = serde_json::from_str(args_str).unwrap_or(json!({}));
                    let tc_id = tc["id"].as_str().unwrap_or("call_0");

                    debug!(
                        "non_streaming calling tool: name={}",
                        name
                    );
                    let result = on_tool_call(name.clone(), args.clone())
                        .await
                        .unwrap_or_else(|e| format!("[ERROR] {} failed: {}", name, e));
                    debug!(
                        "non_streaming tool returned: name={} result_len={}",
                        name,
                        result.len()
                    );

                    all_tool_calls.push(ToolCallMade {
                        name: name.clone(),
                        arguments: args,
                        result: result.clone(),
                    });

                    working_messages.push(json!({
                        "role": "tool",
                        "tool_call_id": tc_id,
                        "content": result
                    }));
                }

                if estimate_tokens(&working_messages) >= max_search_tokens {
                    break;
                }
            }
            // Emit progress after each round (mirrors Python's on_progress(search_count, "searching"))
            if let Some(ref tx) = on_progress {
                let _ = tx.send((search_count, "searching")).await;
            }
        }

        // Emit synthesising phase before forced final (mirrors Python)
        if let Some(ref tx) = on_progress {
            let _ = tx.send((search_count, "synthesising")).await;
        }

        let forced_final_content = if let Some(msg) = forced_final_override {
            format!("{}{}", msg, SUB_FORCED_FINAL_SUFFIX.replace("{n}", &search_count.to_string()))
        } else {
            SUB_FORCED_FINAL.replace("{n}", &search_count.to_string())
        };
        working_messages.push(json!({
            "role": "user",
            "content": forced_final_content
        }));

        // Truncate if over the safe input limit before the final POST (mirrors Python)
        let hard_input_limit = ((config.context_window_size - OUTPUT_RESERVE_TOKENS) as f64 * 0.75) as usize;
        if estimate_tokens(&working_messages) >= hard_input_limit {
            working_messages = truncate_messages_to_fit(&working_messages, hard_input_limit);
        }

        let mut final_payload = json!({
            "model": self.model,
            "messages": &working_messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": false
        });
        provider::disable_thinking(&mut final_payload, &self.base_url);

        let t_call = Instant::now();
        let resp = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .json(&final_payload)
            .send()
            .await
            .inspect_err(|_| metrics::record_llm_request("sub_agent", "error", t_call.elapsed().as_secs_f64()))
            .map_err(|e| format!("DeepSeek API error: {}", e))?;

        let body: Value = resp.json().await.map_err(|e| e.to_string())?;
        self.record_sub_agent_usage(sub_mode, &body, t_call.elapsed().as_secs_f64());
        let content = body["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("")
            .to_string();

        Ok((content, all_tool_calls))
    }

    /// Spawn a specialist agent with mode-specific prompt.
    /// Used by the self-help mode for legislation_agent and judiciary_agent,
    /// and by the legislation orchestrator for research sub-agents.
    pub async fn run_sub_agent(
        &self,
        config: &AppConfig,
        prompt: &str,
        mode: &str,
        on_tool_call: ToolExecutorFn,
        on_progress: Option<tokio::sync::mpsc::Sender<(usize, &'static str)>>,
    ) -> Result<String, String> {
        let SubAgentSpec { tools, system_prompt, final_message: cite_by_ref_final } = subagent_spec(config, mode);

        let messages = vec![
            json!({"role": "system", "content": system_prompt}),
            json!({"role": "user", "content": prompt}),
        ];

        let (content, _tool_calls) = self
            .non_streaming_with_tools(
                config,
                messages,
                tools,
                on_tool_call,
                on_progress,
                Some(config.sub_agent_context_budget),
                cite_by_ref_final,
                mode,
            )
            .await?;

        Ok(if content.is_empty() {
            "The agent could not produce a response.".into()
        } else {
            content
        })
    }
}

// ── Cache-optimisation tests ─────────────────────────────────────────────────
//
// Adapted from a reference agent `scripts/tests/cache-optimization.test.cjs`
// (groups 1-4 and 6). They validate the context-assembly pipeline for
// DeepSeek's prefix KV cache:
//
//   * a cache hit on turn N+1 requires the rendered request to be a
//     BYTE-IDENTICAL prefix of a previously persisted request;
//   * the API reports `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`,
//     with `hit + miss == prompt_tokens`.
//
// Groups 7+ of the upstream suite (session prefix lock, memory, plan mode,
// sub-agent subtraction) are reference-agent-only — lawbylaw is stateless per
// request with no server-side memory — so they are intentionally not ported.
#[cfg(test)]
mod cache_tests {
    use super::*;

    /// Every `AppConfig` field carries a serde default, so an empty object
    /// deserialises to the fully-defaulted config (no env access).
    // ── Answer streaming against a scripted DeepSeek endpoint ───────────────────

    fn sse_body(frames: &[Value]) -> String {
        let mut out: String = frames.iter().map(|f| format!("data: {f}\n\n")).collect();
        out.push_str("data: [DONE]\n\n");
        out
    }

    fn text_chunks(parts: &[&str]) -> Vec<Value> {
        parts.iter().map(|t| json!({"choices": [{"delta": {"content": t}}]})).collect()
    }

    fn tool_call_chunk() -> Vec<Value> {
        vec![json!({"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "c1",
            "function": {"name": "search_legislation", "arguments": "{}"}}]}}]})]
    }

    /// Serve one scripted SSE body per request. The reply for request `gate_at`
    /// (1-based) is withheld until `gate` fires, so a test can prove what the
    /// client received *before* that request was answered.
    async fn mock_deepseek(
        bodies: Vec<String>,
        gate_at: usize,
        gate: Arc<tokio::sync::Notify>,
    ) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            for (n, body) in bodies.into_iter().enumerate() {
                let Ok((mut sock, _)) = listener.accept().await else { return };
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                // read the headers, then the declared body, so the client is not cut off
                loop {
                    let Ok(k) = sock.read(&mut chunk).await else { return };
                    if k == 0 { break }
                    buf.extend_from_slice(&chunk[..k]);
                    if let Some(h) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&buf[..h]).to_lowercase();
                        let len = head
                            .lines()
                            .find_map(|l| l.strip_prefix("content-length:"))
                            .and_then(|v| v.trim().parse::<usize>().ok())
                            .unwrap_or(0);
                        if buf.len() >= h + 4 + len { break }
                    }
                }
                if n + 1 == gate_at {
                    gate.notified().await;
                }
                let head = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    body.len()
                );
                let _ = sock.write_all(head.as_bytes()).await;
                let _ = sock.write_all(body.as_bytes()).await;
                let _ = sock.shutdown().await;
            }
        });
        format!("http://{addr}")
    }

    /// Run the orchestrator against `bodies` and collect every event.
    async fn run_turn(bodies: Vec<String>, gate_at: usize) -> Vec<SseEvent> {
        run_turn_with(bodies, gate_at, true).await
    }

    async fn run_turn_with(bodies: Vec<String>, gate_at: usize, check: bool) -> Vec<SseEvent> {
        use futures::StreamExt;
        let gate = Arc::new(tokio::sync::Notify::new());
        // `gate_at` is the verification request: its reply is withheld until the answer streamed
        let base = mock_deepseek(bodies, gate_at, gate.clone()).await;
        let client = DeepSeekClient::new(&base, "key", "m");
        let mut cfg = default_config();
        cfg.finalization_check = check;
        cfg.tool_nudge = false;
        cfg.rag_search_hard_cap = 10;
        let exec: ToolExecutorFn = Arc::new(|_n, _a| Box::pin(async { Ok("section text".to_string()) }));
        let msgs = vec![json!({"role": "system", "content": "s"}), json!({"role": "user", "content": "q"})];
        let stream = client.stream_with_tools(&cfg, msgs, vec![], exec, "legislation").await;
        tokio::pin!(stream);
        let mut events = Vec::new();
        let mut opened = false;
        let run = async {
            while let Some(ev) = stream.next().await {
                // The gate opens only after answer text reached the consumer: if the
                // answer were held until verification finished, this would deadlock.
                if !opened && matches!(&ev, SseEvent::Token { .. }) {
                    opened = true;
                    gate.notify_one();
                }
                let done = matches!(ev, SseEvent::Done | SseEvent::Error { .. });
                events.push(ev);
                if done { break }
            }
        };
        tokio::time::timeout(Duration::from_secs(10), run)
            .await
            .expect("the answer must stream before the verification reply arrives");
        events
    }

    fn answer_events(events: &[SseEvent]) -> Vec<String> {
        events
            .iter()
            .filter_map(|e| match e {
                SseEvent::Token { content } => Some(content.clone()),
                SseEvent::AnswerReset => Some("<reset>".to_string()),
                _ => None,
            })
            .collect()
    }

    #[tokio::test]
    async fn the_answer_streams_live_and_ok_adds_nothing() {
        let events = run_turn(vec![
            sse_body(&tool_call_chunk()),
            sse_body(&text_chunks(&["The ", "deposit ", "is refundable."])),
            sse_body(&text_chunks(&["OK"])),
        ], 3)
        .await;
        assert_eq!(answer_events(&events), vec!["The ", "deposit ", "is refundable."]);
        assert!(matches!(events.last(), Some(SseEvent::Done)));
    }

    #[tokio::test]
    async fn the_turn_ends_when_the_answer_ends_with_the_check_off() {
        // Only two replies are served: a third request would be refused and surface as an error.
        let mut narrate = text_chunks(&["Let me check."]);
        narrate.extend(tool_call_chunk());
        let events = run_turn_with(
            vec![sse_body(&narrate), sse_body(&text_chunks(&["The ", "answer."]))],
            99,
            false,
        )
        .await;
        assert_eq!(answer_events(&events), vec!["Let me check.", "<reset>", "The ", "answer."]);
        assert!(matches!(events.last(), Some(SseEvent::Done)), "{:?}", events.last().map(|_| "not done"));
        let last_token = events.iter().rposition(|e| matches!(e, SseEvent::Token { .. })).unwrap();
        assert!(
            !events[last_token..].iter().any(|e| matches!(e, SseEvent::Phase { .. } | SseEvent::ToolCall { .. })),
            "nothing may start after the answer"
        );
    }

    #[tokio::test]
    async fn a_rewritten_answer_replaces_the_streamed_draft() {
        let events = run_turn(vec![
            sse_body(&tool_call_chunk()),
            sse_body(&text_chunks(&["Draft ", "answer."])),
            sse_body(&text_chunks(&["Corrected ", "answer: section 5 applies."])),
        ], 3)
        .await;
        let shown = answer_events(&events);
        assert_eq!(&shown[..2], ["Draft ", "answer."]);
        assert_eq!(shown[2], "<reset>");
        assert_eq!(shown[3..].concat(), "Corrected answer: section 5 applies.");
    }

    #[tokio::test]
    async fn text_before_a_tool_call_is_retracted() {
        // Round 1 calls a tool (no text); round 2 narrates then calls a tool again.
        let mut narrate = text_chunks(&["Let me check."]);
        narrate.extend(tool_call_chunk());
        let events = run_turn(vec![
            sse_body(&tool_call_chunk()),
            sse_body(&narrate),
            sse_body(&text_chunks(&["Final answer."])),
            sse_body(&text_chunks(&["OK"])),
        ], 4)
        .await;
        let shown = answer_events(&events);
        assert_eq!(shown, vec!["Let me check.", "<reset>", "Final answer."]);
    }

    fn default_config() -> AppConfig {
        serde_json::from_value(json!({})).expect("AppConfig must deserialize from all-defaults")
    }

    /// A client that disconnects mid-research must stop the tool calls too, not only
    /// the orchestrator loop: `JoinHandle::drop` detaches a task, it does not cancel
    /// it, so a tool task nobody aborts keeps running (and spending tokens) after
    /// the stream is gone.
    #[tokio::test]
    async fn dropping_the_stream_cancels_in_flight_tool_calls() {
        let gate = Arc::new(tokio::sync::Notify::new());
        let base = mock_deepseek(vec![sse_body(&tool_call_chunk())], 99, gate).await;
        let client = DeepSeekClient::new(&base, "key", "m");
        let mut cfg = default_config();
        cfg.tool_nudge = false;
        cfg.rag_search_hard_cap = 10;

        // `sentinel` is only ever cloned into the tool call, so its strong count
        // falls back to 1 exactly when the tool call's future has been dropped.
        let sentinel = Arc::new(());
        let (started_tx, started_rx) = tokio::sync::oneshot::channel::<()>();
        let started = Arc::new(std::sync::Mutex::new(Some(started_tx)));
        let held = Arc::clone(&sentinel);
        let exec: ToolExecutorFn = Arc::new(move |_n, _a| {
            let held = Arc::clone(&held);
            let started = Arc::clone(&started);
            Box::pin(async move {
                let _held = held;
                if let Some(tx) = started.lock().unwrap().take() {
                    let _ = tx.send(());
                }
                std::future::pending::<Result<String, String>>().await
            })
        });

        let msgs = vec![json!({"role": "system", "content": "s"}), json!({"role": "user", "content": "q"})];
        let stream = client.stream_with_tools(&cfg, msgs, vec![], exec, "legislation").await;
        tokio::time::timeout(Duration::from_secs(5), started_rx)
            .await
            .expect("the tool call should start")
            .unwrap();
        assert!(Arc::strong_count(&sentinel) > 1, "the tool call is in flight");

        drop(stream); // client disconnects

        for _ in 0..100 {
            if Arc::strong_count(&sentinel) == 1 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("the tool call kept running after the stream was dropped");
    }

    fn tool_names(tools: &[Value]) -> Vec<String> {
        tools
            .iter()
            .map(|t| {
                t["function"]["name"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string()
            })
            .collect()
    }

    fn as_json(v: &Value) -> String {
        serde_json::to_string(v).unwrap()
    }

    #[test]
    fn sampling_defaults_match_reference_agent() {
        // the reference agent's Agent mode runs at temperature 0 with top_p 0.9.
        let cfg = default_config();
        assert_eq!(cfg.temperature, 0.0);
        assert_eq!(cfg.top_p, 0.9);
    }

    // ── 1. Token-count correctness (parse_cache_tokens) ─────────────────────
    // The DeepSeek API reports prompt_cache_hit_tokens / prompt_cache_miss_tokens
    // at the top level of `usage`; older payloads expose
    // prompt_tokens_details.cached_tokens instead. Both halves of the prompt must
    // be reconstructed so that hit + miss == prompt_tokens and the cache metrics
    // (deepseek_prompt_cache_{hit,miss}_tokens_total) stay correct.

    #[test]
    fn cache_tokens_absent_counts_the_whole_prompt_as_a_miss() {
        // No cache fields → nothing was served from cache, so every prompt token
        // is a miss (matches the reference agent's mapUsage).
        let (hit, miss) =
            parse_cache_tokens(&json!({"prompt_tokens": 5000, "completion_tokens": 200}));
        assert_eq!((hit, miss), (0, 5000));
    }

    #[test]
    fn cache_tokens_hit_plus_miss_equals_prompt_tokens() {
        let (hit, miss) = parse_cache_tokens(&json!({
            "prompt_tokens": 10_000,
            "completion_tokens": 500,
            "prompt_cache_hit_tokens": 8_000,
            "prompt_cache_miss_tokens": 2_000,
        }));
        assert_eq!((hit, miss), (8_000, 2_000));
        assert_eq!(hit + miss, 10_000, "hit + miss must equal prompt_tokens");
    }

    #[test]
    fn cache_tokens_fall_back_to_prompt_tokens_details() {
        let (hit, miss) = parse_cache_tokens(&json!({
            "prompt_tokens": 12_000,
            "completion_tokens": 300,
            "prompt_tokens_details": {"cached_tokens": 9_000},
        }));
        assert_eq!(hit, 9_000, "older payloads nest cached tokens under prompt_tokens_details");
        // The miss half is derived so the invariant holds even though the legacy
        // shape omits prompt_cache_miss_tokens.
        assert_eq!(miss, 3_000);
        assert_eq!(hit + miss, 12_000);
    }

    #[test]
    fn cache_tokens_details_field_wins_over_top_level() {
        let (hit, miss) = parse_cache_tokens(&json!({
            "prompt_tokens": 8_000,
            "prompt_cache_hit_tokens": 3_000,
            "prompt_tokens_details": {"cached_tokens": 5_000},
        }));
        assert_eq!(hit, 5_000, "prompt_tokens_details.cached_tokens takes precedence");
        assert_eq!(miss, 3_000);
    }

    #[test]
    fn cache_tokens_full_hit_and_miss_only() {
        let (hit, miss) = parse_cache_tokens(&json!({
            "prompt_tokens": 15_000,
            "prompt_cache_hit_tokens": 15_000,
            "prompt_cache_miss_tokens": 0,
        }));
        assert_eq!((hit, miss), (15_000, 0), "100% hit: miss is zero");

        let (hit, miss) = parse_cache_tokens(&json!({"prompt_cache_miss_tokens": 5_000}));
        assert_eq!((hit, miss), (0, 5_000), "miss-only payload");
    }

    // ── 2. Wire-format determinism ──────────────────────────────────────────
    // A prefix cache hit requires byte-identical rendering, so nothing in the
    // prompt, the tool schemas, or the message conversion may embed a timestamp,
    // a random id, or an unstable ordering.

    #[test]
    fn system_prompt_is_deterministic_and_mode_specific() {
        let cfg = default_config();
        let acts = vec!["Employment Act 1968".to_string()];
        assert_eq!(
            build_system_prompt(&cfg, "legislation", &acts),
            build_system_prompt(&cfg, "legislation", &acts),
            "same inputs must render an identical system prompt"
        );
        assert_ne!(
            build_system_prompt(&cfg, "legislation", &acts),
            build_system_prompt(&cfg, "judiciary", &[]),
            "mode is part of the prefix"
        );
        assert_ne!(
            build_system_prompt(&cfg, "legislation", &acts),
            build_system_prompt(&cfg, "self-help", &[])
        );
    }

    #[test]
    fn every_prompt_variant_forbids_narration() {
        let cfg = default_config();
        for mode in ["legislation", "judiciary", "self-help"] {
            let p = build_system_prompt(&cfg, mode, &[]);
            assert!(
                p.contains("## Output discipline"),
                "{mode} prompt must carry the output-discipline block"
            );
            assert!(
                p.contains("Do NOT narrate"),
                "{mode} prompt must forbid narration between tool calls"
            );
        }
    }

    #[test]
    fn answering_prompts_standardise_how_provisions_are_cited() {
        let cfg = default_config();
        for mode in ["legislation", "self-help"] {
            let p = build_system_prompt(&cfg, mode, &[]);
            assert!(p.contains("## Citing legislation"), "{mode} prompt must carry the citation format");
        }
        assert!(!build_system_prompt(&cfg, "judiciary", &[]).contains("## Citing legislation"));
    }

    #[test]
    fn web_search_tools_are_offered_and_described_in_the_answering_modes() {
        let cfg = default_config();
        for mode in ["legislation", "self-help"] {
            let names = tool_names(&DeepSeekClient::get_tools(mode));
            let p = build_system_prompt(&cfg, mode, &[]);
            for t in ["web_search_tavily", "web_search_deepseek"] {
                assert!(names.iter().any(|n| n == t), "{t} must be a {mode} tool");
                assert!(p.contains(t), "the {mode} prompt must describe {t}");
            }
            assert!(p.contains("## Web search"));
        }
        let j = tool_names(&DeepSeekClient::get_tools("judiciary"));
        assert!(!j.iter().any(|n| n.starts_with("web_search")));
        // askquestion stays last so the tool list prefix is stable
        assert_eq!(tool_names(&DeepSeekClient::get_tools("legislation")).last().map(String::as_str), Some("askquestion"));
    }

    #[test]
    fn subagent_definitions_are_split_out_of_the_system_prompt_row() {
        let cfg = default_config();
        // Legislation and self-help dispatch to sub-agents, so they carry the
        // block; judiciary searches directly and must report a zero row.
        for mode in ["legislation", "self-help"] {
            let p = build_system_prompt(&cfg, mode, &[]);
            let (system, subagent) = split_system_prompt_tokens(&p);
            assert!(subagent > 0, "{mode} must report a subagent row");
            assert_eq!(
                system + subagent,
                estimate_system_prompt(&p),
                "{mode} rows must sum to the whole prompt"
            );
            assert!(
                system < estimate_system_prompt(&p),
                "{mode} system row must exclude the subagent block"
            );
        }
        let j = build_system_prompt(&cfg, "judiciary", &[]);
        assert_eq!(split_system_prompt_tokens(&j).1, 0);
    }

    #[test]
    fn breakdown_rows_use_the_display_density() {
        // The display rows are priced at 4 chars/token (prose), while
        // `estimate_tokens` stays at 2 chars/token for budgeting. The rows must
        // therefore be *smaller* than the conservative total, not equal to it.
        let cfg = default_config();
        let p = build_system_prompt(&cfg, "legislation", &[]);
        let tools = DeepSeekClient::get_tools("legislation");
        let (system, subagent) = split_system_prompt_tokens(&p);
        let tools_est = estimate_tools_tokens(&tools);

        assert_eq!(system + subagent, estimate_system_prompt(&p));
        assert_eq!(system + subagent, (p.len() / DISPLAY_CHARS_PER_TOKEN) as u64);
        assert!(tools_est > 0);

        // The conservative budget estimate is ~2x the display estimate.
        let msgs = vec![json!({"role": "system", "content": p})];
        let budget = estimate_tokens(&msgs) as u64;
        assert!(
            budget > system + subagent,
            "budget estimate must stay conservative (denser) than the display rows"
        );
    }

    #[test]
    fn display_density_is_four_chars_per_token() {
        assert_eq!(DISPLAY_CHARS_PER_TOKEN, 4);
        assert_eq!(estimate_system_prompt(""), 0);
        assert_eq!(estimate_system_prompt(&"a".repeat(400)), 100);
        assert_eq!(estimate_tools_tokens(&[]), 0);
    }

    #[test]
    fn indexed_acts_change_invalidates_system_prompt() {
        let cfg = default_config();
        let one = build_system_prompt(&cfg, "legislation", &["Act A".to_string()]);
        let two = build_system_prompt(
            &cfg,
            "legislation",
            &["Act A".to_string(), "Act B".to_string()],
        );
        assert_ne!(one, two, "a changed Act index invalidates the cached prefix");
        assert!(one.contains("Act A"));
        assert!(two.contains("Act B"));
        assert!(
            !build_system_prompt(&cfg, "legislation", &[]).contains("## Indexed Acts"),
            "the Indexed Acts block is omitted when there are no acts"
        );
    }

    #[test]
    fn get_tools_is_deterministic_with_stable_fifo_order() {
        for mode in ["legislation", "self-help", "judiciary"] {
            let a = DeepSeekClient::get_tools(mode);
            let b = DeepSeekClient::get_tools(mode);
            assert_eq!(
                serde_json::to_string(&a).unwrap(),
                serde_json::to_string(&b).unwrap(),
                "tool schemas must be byte-identical across calls ({mode})"
            );
        }
        assert_eq!(
            tool_names(&DeepSeekClient::get_tools("self-help")),
            vec![
                "classify_issue",
                "legislation_agent",
                "judiciary_agent",
                "web_search_tavily",
                "web_search_deepseek",
                "askquestion"
            ]
        );
        assert_eq!(
            tool_names(&DeepSeekClient::get_tools("judiciary")),
            vec!["search_judiciary", "askquestion"]
        );
        assert_eq!(
            tool_names(&DeepSeekClient::get_tools("legislation")),
            vec![
                "research_legislation",
                "research_subsidiary_legislation",
                "research_judiciary",
                "get_section",
                "get_judgment",
                "web_search_tavily",
                "web_search_deepseek",
                "askquestion"
            ]
        );
    }

    #[test]
    fn ask_question_tool_is_registered_and_described() {
        for mode in ["legislation", "self-help", "judiciary"] {
            assert!(
                tool_names(&DeepSeekClient::get_tools(mode))
                    .iter()
                    .any(|n| n == "askquestion"),
                "askquestion must be available in {mode} mode"
            );
            assert!(
                build_system_prompt(&default_config(), mode, &[]).contains("askquestion"),
                "the {mode} system prompt must list askquestion"
            );
        }
        let t = make_ask_question_tool();
        assert_eq!(t["function"]["name"], "askquestion");
        assert_eq!(t["function"]["parameters"]["required"][0], "questions");
    }

    #[test]
    fn messages_to_api_is_pure() {
        let h = vec![
            json!({"role": "user", "content": "hi"}),
            json!({"role": "assistant", "content": "hello"}),
        ];
        assert_eq!(
            serde_json::to_string(&messages_to_api(&h, None)).unwrap(),
            serde_json::to_string(&messages_to_api(&h, None)).unwrap()
        );
    }

    // ── 3. Multi-turn prefix chain ──────────────────────────────────────────
    // For the cache to hit, turn N+1's rendered messages must begin with turn N's
    // rendered messages byte-for-byte.

    fn assert_prefix(short: &[Value], long: &[Value]) {
        assert!(
            long.len() > short.len(),
            "the later turn must carry strictly more messages"
        );
        for (i, m) in short.iter().enumerate() {
            assert_eq!(
                as_json(m),
                as_json(&long[i]),
                "message {i} must be byte-identical to preserve the cache prefix"
            );
        }
    }

    #[test]
    fn appended_turn_preserves_prior_messages_as_prefix() {
        let h1 = vec![json!({"role": "user", "content": "Q1"})];
        let h2 = vec![
            json!({"role": "user", "content": "Q1"}),
            json!({"role": "assistant", "content": "A1"}),
            json!({"role": "user", "content": "Q2"}),
        ];
        assert_prefix(&messages_to_api(&h1, None), &messages_to_api(&h2, None));
    }

    #[test]
    fn three_turn_chain_stays_a_prefix() {
        let h1 = vec![json!({"role": "user", "content": "Q1"})];
        let h2 = vec![
            json!({"role": "user", "content": "Q1"}),
            json!({"role": "assistant", "content": "A1"}),
            json!({"role": "user", "content": "Q2"}),
        ];
        let h3 = vec![
            json!({"role": "user", "content": "Q1"}),
            json!({"role": "assistant", "content": "A1"}),
            json!({"role": "user", "content": "Q2"}),
            json!({"role": "assistant", "content": "A2"}),
            json!({"role": "user", "content": "Q3"}),
        ];
        let w1 = messages_to_api(&h1, None);
        let w2 = messages_to_api(&h2, None);
        let w3 = messages_to_api(&h3, None);
        assert_prefix(&w1, &w3);
        assert_prefix(&w2, &w3);
    }

    #[test]
    fn tool_call_and_result_are_replayed_verbatim() {
        let h1 = vec![
            json!({"role": "user", "content": "search"}),
            json!({
                "role": "assistant",
                "content": "Checking.",
                "tool_calls": [{
                    "id": "tc1",
                    "name": "search_legislation",
                    "arguments": {"query": "deposits"},
                    "result": "Section 5 ..."
                }]
            }),
        ];
        let h2 = vec![
            h1[0].clone(),
            h1[1].clone(),
            json!({"role": "assistant", "content": "Found it."}),
            json!({"role": "user", "content": "thanks"}),
        ];
        let w1 = messages_to_api(&h1, None);
        let w2 = messages_to_api(&h2, None);
        assert_prefix(&w1, &w2);

        let asst = w1
            .iter()
            .find(|m| m["role"] == "assistant" && m.get("tool_calls").is_some())
            .expect("assistant tool_calls message");
        assert_eq!(
            asst["tool_calls"][0]["id"], "tc1",
            "the persisted real tool_call_id must survive the round trip"
        );
        let tool_msg = w1.iter().find(|m| m["role"] == "tool").expect("tool result");
        assert_eq!(tool_msg["tool_call_id"], "tc1");
        assert_eq!(tool_msg["content"], "Section 5 ...");
    }

    #[test]
    fn cross_mode_tool_calls_are_filtered() {
        // Switching modes must not replay the other mode's tool calls, which is a
        // deliberate cache invalidation.
        let h = vec![
            json!({"role": "user", "content": "q"}),
            json!({
                "role": "assistant",
                "content": "",
                "tool_calls": [{"id": "tc1", "name": "search_legislation", "arguments": {}, "result": "r"}]
            }),
        ];
        let out = messages_to_api(&h, Some(&vec!["search_judiciary".to_string()]));
        assert_eq!(out.len(), 2);
        assert!(
            out[1].get("tool_calls").is_none(),
            "a filtered-out tool call is emitted as plain assistant text"
        );
    }

    // ── 4. Tool prefix preservation ─────────────────────────────────────────
    // The tools array is part of the cache key: its order and each schema's bytes
    // must be stable, so appending a tool never displaces an existing entry.

    #[test]
    fn distinct_tools_have_distinct_stable_schemas() {
        assert_eq!(as_json(&make_law_search_tool()), as_json(&make_law_search_tool()));
        assert_ne!(
            as_json(&make_law_search_tool()),
            as_json(&make_judgment_search_tool()),
            "different tools must not collide"
        );
    }

    // ── 6. Cache invalidation: truncation ───────────────────────────────────
    // Dropping messages rewrites the prefix, so truncation must only engage over
    // budget and must be deterministic (a stable set of survivors).

    #[test]
    fn truncate_is_identity_under_budget() {
        let msgs: Vec<Value> = (0..12)
            .map(|i| {
                json!({
                    "role": if i % 2 == 0 { "user" } else { "assistant" },
                    "content": "x".repeat(400)
                })
            })
            .collect();
        let same = truncate_messages_to_fit(&msgs, 1_000_000);
        assert_eq!(
            serde_json::to_string(&same).unwrap(),
            serde_json::to_string(&msgs).unwrap(),
            "under budget the prefix is untouched"
        );
    }

    #[test]
    fn truncate_over_budget_keeps_head_and_tail_deterministically() {
        let msgs: Vec<Value> = (0..12)
            .map(|i| {
                json!({
                    "role": if i % 2 == 0 { "user" } else { "assistant" },
                    "content": "x".repeat(400)
                })
            })
            .collect();
        let trimmed = truncate_messages_to_fit(&msgs, 100);
        assert!(trimmed.len() < msgs.len());
        assert_eq!(trimmed[0], msgs[0], "the head is preserved");
        assert_eq!(
            trimmed[trimmed.len() - 1],
            msgs[msgs.len() - 1],
            "the tail is preserved"
        );
        assert_eq!(
            serde_json::to_string(&trimmed).unwrap(),
            serde_json::to_string(&truncate_messages_to_fit(&msgs, 100)).unwrap(),
            "truncation must be deterministic"
        );
    }
}

/// Drop / cancellation tests, runnable under Miri (`make server-miri`): a bare
/// current-thread runtime, no sockets, no timers.
#[cfg(test)]
mod drop_tests {
    use super::*;
    use std::future::pending;

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(f)
    }

    async fn settle() {
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
    }

    /// Owns a clone of `sentinel` (and optionally a channel sender) and never finishes
    /// by itself; the sentinel's count returns to 1 when the future is dropped.
    fn parked(sentinel: &Arc<()>, tx: Option<mpsc::Sender<SseEvent>>) -> tokio::task::JoinHandle<()> {
        let held = Arc::clone(sentinel);
        tokio::spawn(async move {
            let _held = held;
            let _tx = tx;
            pending::<()>().await
        })
    }

    fn guarded(handle: tokio::task::JoinHandle<()>, rx: mpsc::Receiver<SseEvent>) -> GuardedStream {
        GuardedStream { rx: tokio_stream::wrappers::ReceiverStream::new(rx), handle }
    }

    #[test]
    fn dropping_a_guarded_stream_aborts_the_producer_and_closes_the_channel() {
        block_on(async {
            let sentinel = Arc::new(());
            let (tx, rx) = mpsc::channel::<SseEvent>(4);
            let stream = guarded(parked(&sentinel, Some(tx.clone())), rx);
            settle().await;
            assert_eq!(Arc::strong_count(&sentinel), 2, "the producer is running");
            assert!(!tx.is_closed());
            drop(stream); // client disconnects
            settle().await;
            assert_eq!(Arc::strong_count(&sentinel), 1, "the producer task leaked");
            assert!(tx.is_closed(), "the receiver must be dropped with the stream");
        });
    }

    #[test]
    fn a_guarded_stream_dropped_before_its_producer_ran_still_cleans_up() {
        block_on(async {
            let sentinel = Arc::new(());
            let (tx, rx) = mpsc::channel::<SseEvent>(4);
            drop(guarded(parked(&sentinel, Some(tx)), rx));
            settle().await;
            assert_eq!(Arc::strong_count(&sentinel), 1);
        });
    }

    #[test]
    fn a_guarded_stream_forwards_events_in_order_then_ends() {
        block_on(async {
            let (tx, rx) = mpsc::channel::<SseEvent>(4);
            let producer = tokio::spawn(async move {
                tx.send(SseEvent::Token { content: "a".into() }).await.ok();
                tx.send(SseEvent::Done).await.ok();
            });
            let mut stream = guarded(producer, rx);
            assert!(matches!(stream.next().await, Some(SseEvent::Token { content }) if content == "a"));
            assert!(matches!(stream.next().await, Some(SseEvent::Done)));
            assert!(stream.next().await.is_none(), "ends once the producer is gone");
        });
    }

    #[test]
    fn abort_all_cancels_every_task_and_tolerates_finished_ones() {
        block_on(async {
            let sentinel = Arc::new(());
            let mut abort = AbortAll::default();
            let (a, b) = (parked(&sentinel, None), parked(&sentinel, None));
            let done = tokio::spawn(async {});
            for h in [&a, &b, &done] {
                abort.0.push(h.abort_handle());
            }
            settle().await;
            assert_eq!(Arc::strong_count(&sentinel), 3);
            assert!(done.is_finished(), "aborting a finished task must be a no-op");
            drop(abort);
            settle().await;
            assert_eq!(Arc::strong_count(&sentinel), 1, "a tool task outlived its guard");
            assert!(a.await.unwrap_err().is_cancelled());
            assert!(b.await.unwrap_err().is_cancelled());
            assert!(done.await.is_ok());
        });
    }
}
