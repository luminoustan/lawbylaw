//! Application configuration via environment variables.
//!
//! Mirrors the Python `config.py` Settings class exactly.
//! All 39 fields present, env var names preserved for Helm ConfigMap compatibility.

use serde::Deserialize;

/// Nebius Token Factory defaults (the free shared provider).
pub const NEBIUS_BASE_URL: &str = "https://api.tokenfactory.nebius.com/v1";
pub const NEBIUS_MODEL: &str = "deepseek-ai/DeepSeek-V4.1-Flash";

/// Default functions for serde.
fn default_true() -> bool {
    true
}
fn default_gatekeeper_timeout() -> u64 {
    8
}
fn default_debug() -> bool {
    false
}
fn default_deepseek_base_url() -> String {
    "https://api.deepseek.com".into()
}
fn default_deepseek_model() -> String {
    "deepseek-flash".into()
}
fn default_vllm_base_url() -> String {
    "http://localhost:8000".into()
}
fn default_vllm_embed_model() -> String {
    "Qwen/Qwen3-Embedding-0.6B".into()
}
fn default_qdrant_host() -> String {
    "localhost".into()
}
fn default_qdrant_port() -> u16 {
    6334
}
fn default_qdrant_collection() -> String {
    "legislation_2026-05-30".into()
}
fn default_qdrant_act_collection() -> String {
    "act_chunked_2026-05-30".into()
}
fn default_qdrant_sl_collection() -> String {
    "sl_chunked_2026-05-30".into()
}
fn default_qdrant_judiciary_collection() -> String {
    "judiciary_chunked_2026-05-30".into()
}
fn default_qdrant_vector_size() -> u64 {
    1024
}
fn default_rag_score_threshold() -> f64 {
    0.35
}
fn default_rag_max_results() -> i64 {
    10
}
fn default_rag_embed_batch_size() -> i64 {
    10
}
fn default_rag_max_embed_retries() -> i64 {
    3
}
fn default_rag_context_fill_ratio() -> f64 {
    0.8
}
fn default_rag_search_hard_cap() -> i64 {
    50
}
fn default_sub_agent_context_budget() -> i64 {
    160_000
}
fn default_context_window_size() -> i64 {
    1_000_000
}
fn default_deepseek_http_timeout() -> f64 {
    600.0
}
fn default_rag_context_budget() -> i64 {
    48000
}
fn default_reranker_model() -> String {
    "Qwen/Qwen3-Reranker-0.6B".into()
}
fn default_reranker_top_k() -> i64 {
    5
}
fn default_reranker_prefetch_k() -> i64 {
    8
}
fn default_reranker_max_concurrent() -> i64 {
    4
}
fn default_qdrant_timeout_s() -> i64 {
    8
}
fn default_qdrant_pool_size() -> i64 {
    3
}
fn default_embed_cache_maxsize() -> u64 {
    2048
}
fn default_embed_cache_ttl() -> u64 {
    3600
}
fn default_rerank_cache_maxsize() -> u64 {
    4096
}
fn default_rerank_cache_ttl() -> u64 {
    1800
}
fn default_search_result_cache_maxsize() -> u64 {
    512
}
fn default_search_result_cache_ttl() -> u64 {
    1800
}
fn default_temperature() -> f64 {
    0.0
}
fn default_top_p() -> f64 {
    0.9
}
fn default_system_prompt() -> String {
    // The base identity lives with the rest of the prompt sections so every
    // mode shares one source of truth (see `services::prompts::SOUL`).
    crate::services::prompts::SOUL.to_string()
}
fn default_data_dir() -> String {
    "/data".into()
}
fn default_pdf_path() -> String {
    "pdpa-pdf/Personal Data Protection Act 2012.pdf".into()
}
fn default_group_size() -> i64 {
    4
}
fn default_generation_temperatures() -> Vec<f64> {
    vec![0.3, 0.5, 0.7, 0.9]
}
/// A credential that never prints: `Debug` shows `[redacted]`, so logging or `{:?}`-ing the
/// whole config cannot leak it. Read the value through `Deref<Target = str>` / `expose()`.
#[derive(Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct Secret(String);

impl Secret {
    pub fn new(v: impl Into<String>) -> Self {
        Secret(v.into())
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::ops::Deref for Secret {
    type Target = str;
    fn deref(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(if self.0.is_empty() { "\"\" (unset)" } else { "[redacted]" })
    }
}

#[derive(Debug, Deserialize, Clone)]
pub struct AppConfig {
    /// Append a verification reminder to each round of tool results.
    #[serde(default = "default_true")]
    pub tool_nudge: bool,
    /// Hold the first final answer back and ask the model to verify it once.
    #[serde(default = "default_true")]
    pub finalization_check: bool,
    /// Screen each user message with a small gatekeeper LLM call before the main agent.
    #[serde(default = "default_true")]
    pub gatekeeper_enabled: bool,
    /// Gatekeeper model; empty means use `deepseek_model`.
    #[serde(default)]
    pub gatekeeper_model: String,
    #[serde(default = "default_gatekeeper_timeout")]
    pub gatekeeper_timeout_s: u64,

    // ── App ──
    #[serde(default = "default_debug")]
    pub debug: bool,

    // ── DeepSeek API ──
    #[serde(default, alias = "DEEPSEEK_API_KEY")]
    pub deepseek_api_key: Secret,
    #[serde(default = "default_deepseek_base_url")]
    pub deepseek_base_url: String,
    #[serde(default = "default_deepseek_model")]
    pub deepseek_model: String,

    // ── Nebius Token Factory (the free shared provider) ──
    /// `NEBIUS_API_KEY`. When set it wins: the server then uses only the `NEBIUS_*` values and
    /// ignores `DEEPSEEK_*`, so a DeepSeek key is never sent to Nebius. See `resolve_provider`.
    #[serde(default, alias = "NEBIUS_API_KEY")]
    pub nebius_api_key: Secret,
    #[serde(default)]
    pub nebius_base_url: Option<String>,
    #[serde(default)]
    pub nebius_model: Option<String>,

    // ── Web search (optional) ──
    /// Tavily Search API key (`TAVILY_API_KEY`). Without it the Tavily tool is not offered
    /// to the model; DeepSeek search keeps working with `DEEPSEEK_API_KEY`.
    #[serde(default, alias = "TAVILY_API_KEY")]
    pub tavily_api_key: Secret,

    // ── vLLM ──
    #[serde(default = "default_vllm_base_url")]
    pub vllm_base_url: String,
    #[serde(default = "default_vllm_embed_model")]
    pub vllm_embed_model: String,

    // ── Qdrant ──
    #[serde(default = "default_qdrant_host")]
    pub qdrant_host: String,
    #[serde(default = "default_qdrant_port")]
    pub qdrant_port: u16,
    /// Legacy combined legislation collection — kept for RAG panel / admin compatibility.
    #[serde(default = "default_qdrant_collection")]
    pub qdrant_collection: String,
    /// Acts-only collection (e.g. act_chunked_2026-05-30).
    #[serde(default = "default_qdrant_act_collection")]
    pub qdrant_act_collection: String,
    /// Subsidiary-legislation-only collection (e.g. sl_chunked_2026-05-30).
    #[serde(default = "default_qdrant_sl_collection")]
    pub qdrant_sl_collection: String,
    #[serde(default = "default_qdrant_judiciary_collection")]
    pub qdrant_judiciary_collection: String,
    #[serde(default = "default_qdrant_vector_size")]
    pub qdrant_vector_size: u64,

    // ── RAG search / ingest tuning ──
    #[serde(default = "default_rag_score_threshold")]
    pub rag_score_threshold: f64,
    #[serde(default = "default_rag_max_results")]
    pub rag_max_results: i64,
    #[serde(default = "default_rag_embed_batch_size")]
    pub rag_embed_batch_size: i64,
    #[serde(default = "default_rag_max_embed_retries")]
    pub rag_max_embed_retries: i64,

    // ── Agentic search caps ──
    #[serde(default = "default_rag_context_fill_ratio")]
    pub rag_context_fill_ratio: f64,
    #[serde(default = "default_rag_search_hard_cap")]
    pub rag_search_hard_cap: i64,
    #[serde(default = "default_sub_agent_context_budget")]
    pub sub_agent_context_budget: i64,

    // ── Context window management ──
    #[serde(default = "default_context_window_size")]
    pub context_window_size: i64,

    // ── DeepSeek HTTP timeouts ──
    #[serde(default = "default_deepseek_http_timeout")]
    pub deepseek_http_timeout: f64,

    // ── Context budget ──
    #[serde(default = "default_rag_context_budget")]
    pub rag_context_budget: i64,

    // ── Reranker ──
    #[serde(default = "default_true")]
    pub reranker_enabled: bool,
    #[serde(default = "default_reranker_model")]
    pub reranker_model: String,
    #[serde(default = "default_reranker_top_k")]
    pub reranker_top_k: i64,
    #[serde(default = "default_reranker_prefetch_k")]
    pub reranker_prefetch_k: i64,
    #[serde(default = "default_reranker_max_concurrent")]
    pub reranker_max_concurrent: i64,

    /// Hard deadline for one Qdrant search/read, retries included. Past it the user is told the
    /// database is busy instead of waiting.
    #[serde(default = "default_qdrant_timeout_s")]
    pub qdrant_timeout_s: i64,
    /// gRPC channels to Qdrant, used round-robin (the client's own default is 3).
    #[serde(default = "default_qdrant_pool_size")]
    pub qdrant_pool_size: i64,

    // ── Embedding / reranker caching ──
    #[serde(default = "default_embed_cache_maxsize")]
    pub embed_cache_maxsize: u64,
    #[serde(default = "default_embed_cache_ttl")]
    pub embed_cache_ttl: u64,
    #[serde(default = "default_rerank_cache_maxsize")]
    pub rerank_cache_maxsize: u64,
    #[serde(default = "default_rerank_cache_ttl")]
    pub rerank_cache_ttl: u64,

    // ── Search-result caching ──
    // Cache fully-formatted tool-result strings so identical Qdrant queries
    // always produce byte-identical content, enabling DeepSeek prefix cache reuse.
    #[serde(default = "default_search_result_cache_maxsize")]
    pub search_result_cache_maxsize: u64,
    #[serde(default = "default_search_result_cache_ttl")]
    pub search_result_cache_ttl: u64,

    // ── Sampling ──
    // One temperature/nucleus per turn, matching the reference agent's Agent mode
    // (temperature 0, top_p 0.9). A single deterministic setting keeps tool-call
    // arguments byte-stable across sessions (DeepSeek prefix-cache reuse) and the
    // final answer equally deterministic. Sub-agents run at temperature 0, no top_p.
    #[serde(default = "default_temperature")]
    pub temperature: f64,
    #[serde(default = "default_top_p")]
    pub top_p: f64,

    // ── System prompt ──
    #[serde(default = "default_system_prompt")]
    pub system_prompt: String,

    // ── Data paths ──
    #[serde(default = "default_data_dir")]
    pub data_dir: String,
    #[serde(default = "default_pdf_path")]
    pub default_pdf_path: String,

    // ── Generation ──
    #[serde(default = "default_group_size")]
    pub group_size: i64,
    #[serde(default = "default_generation_temperatures")]
    pub generation_temperatures: Vec<f64>,
}

impl AppConfig {
    /// Load configuration from environment variables (with .env fallback).
    pub fn from_env() -> Result<Self, envy::Error> {
        // Load .env file if present (ignore errors).
        let _ = dotenvy::dotenv();

        let mut config: Self = envy::from_env()?;
        config.resolve_provider();

        // SSRF protection: validate base URLs.
        config.validate_urls()?;

        Ok(config)
    }

    /// Pick the free shared provider. The key decides: `NEBIUS_API_KEY` set -> Nebius with
    /// `NEBIUS_*`; else `DEEPSEEK_API_KEY` set -> legacy DeepSeek with `DEEPSEEK_*`; neither ->
    /// Nebius defaults with an empty key. The result lands in the `deepseek_*` fields the client uses.
    pub fn resolve_provider(&mut self) {
        let legacy = self.nebius_api_key.is_empty() && !self.deepseek_api_key.is_empty();
        if legacy {
            return;
        }
        if !self.nebius_api_key.is_empty() {
            self.deepseek_api_key = self.nebius_api_key.clone();
        }
        self.deepseek_base_url = self
            .nebius_base_url
            .clone()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| NEBIUS_BASE_URL.into());
        self.deepseek_model = self
            .nebius_model
            .clone()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| NEBIUS_MODEL.into());
    }

    /// Reject non-http(s) URLs with no hostname to prevent SSRF.
    fn validate_urls(&self) -> Result<(), envy::Error> {
        for url in [&self.deepseek_base_url, &self.vllm_base_url] {
            let parsed = url::Url::parse(url)
                .map_err(|e| envy::Error::Custom(format!("Invalid URL '{}': {}", url, e)))?;
            let scheme = parsed.scheme();
            if scheme != "http" && scheme != "https" {
                return Err(envy::Error::Custom(format!(
                    "URL scheme must be http or https, got: {}",
                    scheme
                )));
            }
            if parsed.host().is_none() {
                return Err(envy::Error::Custom(format!(
                    "URL must include a hostname: {}",
                    url
                )));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod secret_tests {
    use super::*;

    const FAKE_DEEPSEEK: &str = "sk-FAKE-deepseek-0123456789abcdef";
    const FAKE_TAVILY: &str = "tvly-FAKE-tavily-0123456789abcdef";

    fn cfg() -> AppConfig {
        envy::from_iter::<_, AppConfig>([
            ("DEEPSEEK_API_KEY".to_string(), FAKE_DEEPSEEK.to_string()),
            ("TAVILY_API_KEY".to_string(), FAKE_TAVILY.to_string()),
        ])
        .expect("config loads from env")
    }

    #[test]
    fn fake_keys_load_and_are_usable() {
        let c = cfg();
        assert_eq!(c.deepseek_api_key.expose(), FAKE_DEEPSEEK);
        assert_eq!(&*c.tavily_api_key, FAKE_TAVILY);
        assert!(!c.deepseek_api_key.is_empty());
    }

    #[test]
    fn debug_output_never_contains_a_key() {
        let c = cfg();
        for rendered in [format!("{c:?}"), format!("{c:#?}"), format!("{:?}", c.deepseek_api_key), format!("{:?}", Some(&c))] {
            assert!(!rendered.contains("FAKE"), "key leaked: {rendered}");
            assert!(!rendered.contains("sk-") && !rendered.contains("tvly-"), "{rendered}");
        }
        assert!(format!("{c:?}").contains("[redacted]"));
    }

    #[test]
    fn unset_key_is_shown_as_unset_not_redacted() {
        let c: AppConfig = envy::from_iter::<_, AppConfig>(Vec::<(String, String)>::new()).unwrap();
        assert!(c.deepseek_api_key.is_empty());
        assert!(format!("{:?}", c.deepseek_api_key).contains("unset"));
    }

    fn resolved(vars: &[(&str, &str)]) -> AppConfig {
        let mut c = envy::from_iter::<_, AppConfig>(vars.iter().map(|(k, v)| (k.to_string(), v.to_string()))).unwrap();
        c.resolve_provider();
        c
    }

    #[test]
    fn nebius_key_selects_nebius_and_ignores_deepseek_values() {
        let c = resolved(&[
            ("NEBIUS_API_KEY", "v1.FAKE-nebius"),
            ("DEEPSEEK_API_KEY", "sk-FAKE"),
            ("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
            ("DEEPSEEK_MODEL", "deepseek-flash"),
        ]);
        assert_eq!(c.deepseek_api_key.expose(), "v1.FAKE-nebius");
        assert_eq!(c.deepseek_base_url, NEBIUS_BASE_URL);
        assert_eq!(c.deepseek_model, NEBIUS_MODEL);
        assert!(!format!("{c:?}").contains("FAKE"));
    }

    #[test]
    fn nebius_overrides_apply() {
        let c = resolved(&[("NEBIUS_API_KEY", "k"), ("NEBIUS_BASE_URL", "http://127.0.0.1:9"), ("NEBIUS_MODEL", "m")]);
        assert_eq!((c.deepseek_base_url.as_str(), c.deepseek_model.as_str()), ("http://127.0.0.1:9", "m"));
    }

    #[test]
    fn legacy_deepseek_key_keeps_deepseek_defaults() {
        let c = resolved(&[("DEEPSEEK_API_KEY", "sk-FAKE")]);
        assert_eq!(c.deepseek_base_url, "https://api.deepseek.com");
        assert_eq!(c.deepseek_model, "deepseek-flash");
    }

    #[test]
    fn no_key_defaults_to_nebius() {
        let c = resolved(&[]);
        assert!(c.deepseek_api_key.is_empty());
        assert_eq!(c.deepseek_base_url, NEBIUS_BASE_URL);
    }
}
