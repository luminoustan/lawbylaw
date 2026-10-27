//! Prometheus metrics. Everything is prefixed `lawbylaw_`.
//!
//! Exposed on a separate listener (`METRICS_PORT`, see `routers::metrics_handler`), never on the
//! public API port, so neither the LAN gateway nor a tunnel can reach it.
//!
//! Token accounting rule: spend is recorded where a provider's `usage` object is parsed
//! ([`record_llm_usage`]), so failed, timed-out and aborted turns still count what was billed.

use lazy_static::lazy_static;
use prometheus::{
    CounterVec, Gauge, GaugeVec, HistogramVec, IntCounter, Opts, register_counter_vec, register_gauge,
    register_gauge_vec, register_histogram_vec, register_int_counter,
};
use serde_json::Value;

const SECONDS: &[f64] = &[0.05, 0.1, 0.25, 0.5, 1.0, 2.0, 5.0, 10.0, 30.0, 60.0, 120.0, 300.0, 600.0];
const TURN_TOKENS: &[f64] = &[500.0, 2e3, 5e3, 1e4, 2e4, 5e4, 1e5, 2e5, 5e5, 1e6];

lazy_static! {
    // ── LLM spend ────────────────────────────────────────────────────────────
    /// Provider tokens by kind. `token_type`: prompt_cache_hit | prompt_cache_miss | completion.
    /// `call_type`: gatekeeper | search_round | final_answer | forced_final | sub_agent | compact.
    pub static ref LLM_TOKENS_TOTAL: CounterVec = register_counter_vec!(
        Opts::new("lawbylaw_llm_tokens_total", "Tokens billed by the LLM provider"),
        &["provider", "model", "mode", "call_type", "token_type"]
    ).expect("register lawbylaw_llm_tokens_total");

    pub static ref LLM_REQUESTS_TOTAL: CounterVec = register_counter_vec!(
        Opts::new("lawbylaw_llm_requests_total", "LLM provider requests"),
        &["call_type", "outcome"]
    ).expect("register lawbylaw_llm_requests_total");

    pub static ref LLM_LATENCY_SECONDS: HistogramVec = register_histogram_vec!(
        "lawbylaw_llm_request_duration_seconds",
        "LLM provider request duration",
        &["call_type"],
        SECONDS.to_vec()
    ).expect("register lawbylaw_llm_request_duration_seconds");

    pub static ref GATEKEEPER_VERDICTS_TOTAL: CounterVec = register_counter_vec!(
        Opts::new("lawbylaw_gatekeeper_verdicts_total", "Gatekeeper verdicts on user messages"),
        &["verdict"]
    ).expect("register lawbylaw_gatekeeper_verdicts_total");

    // ── Turns ────────────────────────────────────────────────────────────────
    /// `outcome`: ok | error | timeout | client_abort | blocked_<verdict>.
    pub static ref CHAT_TURNS_TOTAL: CounterVec = register_counter_vec!(
        Opts::new("lawbylaw_chat_turns_total", "Chat turns by outcome"),
        &["mode", "outcome"]
    ).expect("register lawbylaw_chat_turns_total");

    pub static ref CHAT_TURN_SECONDS: HistogramVec = register_histogram_vec!(
        "lawbylaw_chat_turn_duration_seconds",
        "Chat turn duration",
        &["mode"],
        SECONDS.to_vec()
    ).expect("register lawbylaw_chat_turn_duration_seconds");

    pub static ref CHAT_TURN_TOKENS: HistogramVec = register_histogram_vec!(
        "lawbylaw_chat_turn_tokens",
        "Provider tokens (prompt + completion) of the main streamed loop per turn",
        &["mode"],
        TURN_TOKENS.to_vec()
    ).expect("register lawbylaw_chat_turn_tokens");

    pub static ref REJECTIONS_TOTAL: CounterVec = register_counter_vec!(
        Opts::new("lawbylaw_rejections_total", "Requests refused by the limiter or validation"),
        &["endpoint", "code"]
    ).expect("register lawbylaw_rejections_total");

    // ── BYOK / tool endpoint ─────────────────────────────────────────────────
    pub static ref TOOL_CALLS_TOTAL: CounterVec = register_counter_vec!(
        Opts::new("lawbylaw_tool_calls_total", "POST /api/tool calls (browser-side model loop)"),
        &["tool", "context", "outcome"]
    ).expect("register lawbylaw_tool_calls_total");

    pub static ref TOOL_LATENCY_SECONDS: HistogramVec = register_histogram_vec!(
        "lawbylaw_tool_call_duration_seconds",
        "POST /api/tool duration",
        &["tool"],
        SECONDS.to_vec()
    ).expect("register lawbylaw_tool_call_duration_seconds");

    // ── vLLM (RTX 3060) as seen from the app ─────────────────────────────────
    /// `op`: embed | rerank. `outcome`: ok | error.
    pub static ref VLLM_REQUESTS_TOTAL: CounterVec = register_counter_vec!(
        Opts::new("lawbylaw_vllm_requests_total", "Requests the app sent to vLLM"),
        &["op", "outcome"]
    ).expect("register lawbylaw_vllm_requests_total");

    pub static ref VLLM_LATENCY_SECONDS: HistogramVec = register_histogram_vec!(
        "lawbylaw_vllm_request_duration_seconds",
        "vLLM call duration (excluding queue wait)",
        &["op"],
        SECONDS.to_vec()
    ).expect("register lawbylaw_vllm_request_duration_seconds");

    // ── Qdrant ───────────────────────────────────────────────────────────────
    /// `op`: query | scroll | scroll_all | count. `collection`: act | sl | judiciary | other.
    /// `outcome`: ok | error | timeout.
    pub static ref QDRANT_REQUESTS_TOTAL: CounterVec = register_counter_vec!(
        Opts::new("lawbylaw_qdrant_requests_total", "Qdrant calls made by the app"),
        &["op", "collection", "outcome"]
    ).expect("register lawbylaw_qdrant_requests_total");

    pub static ref QDRANT_LATENCY_SECONDS: HistogramVec = register_histogram_vec!(
        "lawbylaw_qdrant_request_duration_seconds",
        "Qdrant call duration as seen by the app (includes client-side waiting)",
        &["op", "collection"],
        SECONDS.to_vec()
    ).expect("register lawbylaw_qdrant_request_duration_seconds");

    pub static ref VLLM_QUEUE_WAIT_SECONDS: HistogramVec = register_histogram_vec!(
        "lawbylaw_vllm_queue_wait_seconds",
        "Time waiting for the app-side GPU semaphore",
        &["op"],
        SECONDS.to_vec()
    ).expect("register lawbylaw_vllm_queue_wait_seconds");

    /// Tokens vLLM reports in its response `usage` (cross-check for `vllm:prompt_tokens_total`).
    pub static ref VLLM_TOKENS_TOTAL: CounterVec = register_counter_vec!(
        Opts::new("lawbylaw_vllm_tokens_total", "Tokens vLLM reported for requests from the app"),
        &["op", "model"]
    ).expect("register lawbylaw_vllm_tokens_total");

    /// `cache`: embed | rerank. A hit means the GPU was not used.
    pub static ref CACHE_LOOKUPS_TOTAL: CounterVec = register_counter_vec!(
        Opts::new("lawbylaw_cache_lookups_total", "App-side embed/rerank cache lookups"),
        &["cache", "result"]
    ).expect("register lawbylaw_cache_lookups_total");

    pub static ref RERANK_FALLBACK_TOTAL: IntCounter = register_int_counter!(
        "lawbylaw_rerank_fallback_total",
        "Reranker failed or filtered everything; vector order was used"
    ).expect("register lawbylaw_rerank_fallback_total");

    // ── HTTP ─────────────────────────────────────────────────────────────────
    pub static ref HTTP_REQUESTS_TOTAL: CounterVec = register_counter_vec!(
        Opts::new("lawbylaw_http_requests_total", "HTTP requests by route template"),
        &["method", "route", "status"]
    ).expect("register lawbylaw_http_requests_total");

    pub static ref HTTP_LATENCY_SECONDS: HistogramVec = register_histogram_vec!(
        "lawbylaw_http_request_duration_seconds",
        "Time until response headers are produced (SSE bodies stream afterwards)",
        &["method", "route"],
        SECONDS.to_vec()
    ).expect("register lawbylaw_http_request_duration_seconds");

    // ── Gauges refreshed at scrape time ──────────────────────────────────────
    pub static ref DAILY_TOKENS_USED: Gauge = register_gauge!(
        "lawbylaw_daily_tokens_used", "Tokens charged to today's budget (the day resets at 06:00 Singapore time)"
    ).expect("register lawbylaw_daily_tokens_used");
    pub static ref DAILY_TOKEN_BUDGET: Gauge = register_gauge!(
        "lawbylaw_daily_token_budget", "Configured daily token budget"
    ).expect("register lawbylaw_daily_token_budget");
    pub static ref ACTIVE_STREAMS: Gauge = register_gauge!(
        "lawbylaw_active_streams", "Chat generations in flight"
    ).expect("register lawbylaw_active_streams");
    pub static ref ACTIVE_CLIENTS: GaugeVec = register_gauge_vec!(
        "lawbylaw_active_clients",
        "Distinct network clients seen in the window (window: 5m|1h|24h, kind: chat|tool|any)",
        &["window", "kind"]
    ).expect("register lawbylaw_active_clients");
    pub static ref NEW_CLIENTS_TOTAL: IntCounter = register_int_counter!(
        "lawbylaw_new_clients_total", "Clients not seen in the previous 24h"
    ).expect("register lawbylaw_new_clients_total");
}

/// Token counts parsed from a provider `usage` object.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Usage {
    pub prompt: u64,
    pub cache_hit: u64,
    pub cache_miss: u64,
    pub completion: u64,
}

impl Usage {
    /// Accepts DeepSeek (`prompt_cache_hit_tokens`) and OpenAI-style
    /// (`prompt_tokens_details.cached_tokens`) shapes. `hit + miss == prompt` always holds.
    pub fn from_json(usage: &Value) -> Self {
        let prompt = usage["prompt_tokens"].as_u64().unwrap_or(0);
        let hit = usage["prompt_tokens_details"]["cached_tokens"]
            .as_u64()
            .or_else(|| usage["prompt_cache_hit_tokens"].as_u64())
            .unwrap_or(0)
            .min(prompt);
        Self {
            prompt,
            cache_hit: hit,
            cache_miss: prompt - hit,
            completion: usage["completion_tokens"].as_u64().unwrap_or(0),
        }
    }

    pub fn total(&self) -> u64 {
        self.prompt + self.completion
    }
}

/// Record one provider response's usage. Call exactly once per billed response.
pub fn record_llm_usage(provider: &str, model: &str, mode: &str, call_type: &str, u: Usage) {
    for (kind, n) in [
        ("prompt_cache_hit", u.cache_hit),
        ("prompt_cache_miss", u.cache_miss),
        ("completion", u.completion),
    ] {
        if n > 0 {
            LLM_TOKENS_TOTAL
                .with_label_values(&[provider, model, mode, call_type, kind])
                .inc_by(n as f64);
        }
    }
}

/// Record the outcome and duration of one provider request.
pub fn record_llm_request(call_type: &str, outcome: &str, seconds: f64) {
    LLM_REQUESTS_TOTAL.with_label_values(&[call_type, outcome]).inc();
    LLM_LATENCY_SECONDS.with_label_values(&[call_type]).observe(seconds);
}

/// One Qdrant call. `collection` is the full collection name; only its kind is used as a label
/// (the full names carry a date and would churn the series).
pub fn record_qdrant(op: &str, collection: &str, outcome: &str, seconds: f64) {
    let kind = collection_kind(collection);
    QDRANT_REQUESTS_TOTAL.with_label_values(&[op, kind, outcome]).inc();
    QDRANT_LATENCY_SECONDS.with_label_values(&[op, kind]).observe(seconds);
}

fn collection_kind(collection: &str) -> &'static str {
    if collection.contains("judiciary") {
        "judiciary"
    } else if collection.starts_with("sl") {
        "sl"
    } else if collection.starts_with("act") {
        "act"
    } else {
        "other"
    }
}

/// Render all metrics in Prometheus exposition format.
pub fn render_metrics() -> String {
    use prometheus::Encoder;
    let encoder = prometheus::TextEncoder::new();
    let mut buffer = Vec::new();
    if encoder.encode(&prometheus::gather(), &mut buffer).is_err() {
        return String::new();
    }
    String::from_utf8(buffer).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn qdrant_calls_are_labelled_by_collection_kind_not_dated_name() {
        assert_eq!(collection_kind("judiciary_chunked_2026-05-30"), "judiciary");
        assert_eq!(collection_kind("sl_chunked_2026-05-30"), "sl");
        assert_eq!(collection_kind("act_chunked_2026-05-30"), "act");
        assert_eq!(collection_kind("something_else"), "other");
        let before = QDRANT_REQUESTS_TOTAL.with_label_values(&["scroll", "judiciary", "timeout"]).get();
        record_qdrant("scroll", "judiciary_chunked_2026-05-30", "timeout", 31.0);
        assert!(QDRANT_REQUESTS_TOTAL.with_label_values(&["scroll", "judiciary", "timeout"]).get() >= before + 1.0);
    }

    #[test]
    fn hit_plus_miss_equals_prompt_for_every_payload_shape() {
        let deepseek = Usage::from_json(&json!({"prompt_tokens": 100, "completion_tokens": 7, "prompt_cache_hit_tokens": 60, "prompt_cache_miss_tokens": 40}));
        assert_eq!((deepseek.cache_hit, deepseek.cache_miss, deepseek.completion), (60, 40, 7));
        let openai = Usage::from_json(&json!({"prompt_tokens": 100, "completion_tokens": 1, "prompt_tokens_details": {"cached_tokens": 25}}));
        assert_eq!((openai.cache_hit, openai.cache_miss), (25, 75));
        let bare = Usage::from_json(&json!({"prompt_tokens": 10, "completion_tokens": 2}));
        assert_eq!((bare.cache_hit, bare.cache_miss, bare.total()), (0, 10, 12));
        // A bogus hit count larger than the prompt is clamped.
        let odd = Usage::from_json(&json!({"prompt_tokens": 5, "prompt_cache_hit_tokens": 9}));
        assert_eq!((odd.cache_hit, odd.cache_miss), (5, 0));
    }

    #[test]
    fn usage_is_recorded_per_token_type() {
        let u = Usage { prompt: 30, cache_hit: 10, cache_miss: 20, completion: 5 };
        record_llm_usage("test", "m", "unit", "search_round", u);
        let v = |t: &str| LLM_TOKENS_TOTAL.with_label_values(&["test", "m", "unit", "search_round", t]).get();
        assert_eq!(v("prompt_cache_hit"), 10.0);
        assert_eq!(v("prompt_cache_miss"), 20.0);
        assert_eq!(v("completion"), 5.0);
        assert!(render_metrics().contains("lawbylaw_llm_tokens_total"));
    }
}
