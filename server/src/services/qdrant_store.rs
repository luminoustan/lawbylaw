//! Qdrant vector store — embedding, hybrid search, reranking, collection management.
//!
//! Mirrors Python `app/backend/services/qdrant_store.py` (1068 lines).
//! Uses Qdrant gRPC client (port 6334) with moka caching.

use anyhow::{Context, Result};
use moka::future::Cache;
use qdrant_client::Qdrant;
use qdrant_client::qdrant::{
    Condition, CreateCollectionBuilder, Distance, Filter, PointId, PointStruct, QueryPointsBuilder,
    ScrollPointsBuilder, VectorParamsBuilder, point_id::PointIdOptions,
};
use reqwest::Client as HttpClient;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::Duration;
use tokio::sync::Semaphore;
use tracing::{debug, info, warn};
use uuid::Uuid;

use crate::config::AppConfig;
use crate::metrics;

/// How many searches are waiting for the reranker and a rough wait, as told to the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QueueInfo {
    pub waiting: usize,
    pub eta_s: u64,
}

/// Where a waiting search reports its queue state. Set per research tool call
/// (see `routers/chat.rs`), so only the request that is really waiting hears about it.
pub type QueueSink = Arc<dyn Fn(QueueInfo) + Send + Sync>;

tokio::task_local! {
    pub static QUEUE_SINK: QueueSink;
}

/// Where a research tool call hears that Qdrant is not answering. Called with the deadline in
/// seconds when a call timed out, and with `0` when a later call went through again.
pub type DbSink = Arc<dyn Fn(u64) + Send + Sync>;

tokio::task_local! {
    pub static DB_SINK: DbSink;
}

/// Prefix of the error text for a Qdrant call that missed its deadline. Tool errors travel as
/// plain strings, so `is_db_timeout` recognises it by this marker.
const DB_TIMEOUT_MARKER: &str = "[db-timeout]";

/// A Qdrant call that did not finish within the configured deadline (retries included).
#[derive(Debug)]
pub struct QdrantTimeout(pub Duration);

impl std::fmt::Display for QdrantTimeout {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{DB_TIMEOUT_MARKER} The legal database did not answer within {}s because it is busy.",
            self.0.as_secs()
        )
    }
}

impl std::error::Error for QdrantTimeout {}

pub fn is_db_timeout(error_text: &str) -> bool {
    error_text.contains(DB_TIMEOUT_MARKER)
}

/// What a research row and the model are told when a search hit the database deadline.
pub fn db_timeout_tool_message() -> String {
    "[ERROR] The legal database is busy and did not answer in time. You may retry this search \
     once; if it fails again, tell the user the database is busy and answer only from what you \
     have already verified."
        .to_string()
}

/// Run one Qdrant call under a hard deadline. The client retries a failed call once on its own,
/// which would double the wait, so the deadline wraps the whole thing. On a miss the task's
/// `DB_SINK` is told; the next success tells it the database is back.
pub(crate) async fn with_deadline<T, E>(
    deadline: Duration,
    fut: impl std::future::Future<Output = std::result::Result<T, E>>,
) -> Result<T>
where
    E: std::error::Error + Send + Sync + 'static,
{
    let sink = DB_SINK.try_with(Arc::clone).ok();
    match tokio::time::timeout(deadline, fut).await {
        Ok(res) => {
            if let (Ok(_), Some(sink)) = (&res, &sink) {
                sink(0);
            }
            res.map_err(anyhow::Error::from)
        }
        Err(_) => {
            if let Some(sink) = &sink {
                sink(deadline.as_secs().max(1));
            }
            Err(QdrantTimeout(deadline).into())
        }
    }
}

/// A search that waits this long for a reranker slot is told it is queued.
/// `tokio::spawn` that keeps the caller's queue sink: task-locals do not cross a spawn, and the
/// research agent runs its model stream and every tool call in spawned tasks.
pub fn spawn_with_queue_sink<F>(fut: F) -> tokio::task::JoinHandle<F::Output>
where
    F: std::future::Future + Send + 'static,
    F::Output: Send + 'static,
{
    let queue = QUEUE_SINK.try_with(|s| s.clone()).ok();
    let db = DB_SINK.try_with(|s| s.clone()).ok();
    match (queue, db) {
        (Some(q), Some(d)) => tokio::spawn(QUEUE_SINK.scope(q, DB_SINK.scope(d, fut))),
        (Some(q), None) => tokio::spawn(QUEUE_SINK.scope(q, fut)),
        (None, Some(d)) => tokio::spawn(DB_SINK.scope(d, fut)),
        (None, None) => tokio::spawn(fut),
    }
}

/// Most chunks one section / judgment read will pull from Qdrant (see `scroll_capped`).
const MAX_SCROLL_POINTS: usize = 1000;
/// Qdrant calls slower than this are logged at WARN.
const SLOW_QDRANT_MS: u128 = 1500;
const QUEUE_NOTICE_AFTER: Duration = Duration::from_millis(1500);
/// While still queued, the estimate is refreshed this often.
const QUEUE_REFRESH: Duration = Duration::from_secs(2);
/// Assumed rerank time before any call has been measured.
const DEFAULT_RERANK_MS: u64 = 600;

/// Searches waiting for a reranker slot, plus a moving average of how long one rerank call takes.
#[derive(Debug, Default)]
pub(crate) struct RerankQueue {
    waiting: AtomicUsize,
    ewma_ms: AtomicU64,
}

impl RerankQueue {
    /// Estimate for a search at the back of the queue: the slots in front must turn over
    /// `ceil(waiting / capacity)` times, then its own call runs.
    pub(crate) fn info(&self, capacity: usize) -> QueueInfo {
        let waiting = self.waiting.load(Ordering::Relaxed);
        let ewma = match self.ewma_ms.load(Ordering::Relaxed) {
            0 => DEFAULT_RERANK_MS,
            ms => ms,
        };
        let rounds = waiting.div_ceil(capacity.max(1)) as u64;
        QueueInfo { waiting, eta_s: (ewma * (rounds + 1)).div_ceil(1000) }
    }

    pub(crate) fn record_call_ms(&self, ms: u64) {
        let old = self.ewma_ms.load(Ordering::Relaxed);
        let new = if old == 0 { ms.max(1) } else { ((old * 7 + ms * 3) / 10).max(1) };
        self.ewma_ms.store(new, Ordering::Relaxed);
    }
}

/// Keeps `waiting` right even when the waiting future is dropped (client hung up).
struct WaitGuard<'a>(&'a AtomicUsize);

impl Drop for WaitGuard<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

/// Take a slot from `sem`. A short wait is silent; past `notice_after` the task-local
/// `QUEUE_SINK` (if any) is told how many are queued, refreshed every `refresh`, and told
/// `waiting: 0` once the slot is obtained so the client can clear its notice.
pub(crate) async fn acquire_with_queue_notice<'a>(
    sem: &'a Semaphore,
    queue: &RerankQueue,
    capacity: usize,
    notice_after: Duration,
    refresh: Duration,
) -> Result<tokio::sync::SemaphorePermit<'a>> {
    queue.waiting.fetch_add(1, Ordering::Relaxed);
    let _guard = WaitGuard(&queue.waiting);
    if let Ok(permit) = tokio::time::timeout(notice_after, sem.acquire()).await {
        return Ok(permit?);
    }
    let sink = QUEUE_SINK.try_with(Arc::clone).ok();
    let acquire = sem.acquire();
    tokio::pin!(acquire);
    let mut tick = tokio::time::interval(refresh);
    let mut announced = false;
    loop {
        tokio::select! {
            permit = &mut acquire => {
                if announced {
                    if let Some(sink) = &sink {
                        sink(QueueInfo { waiting: 0, eta_s: 0 });
                    }
                }
                return Ok(permit?);
            }
            _ = tick.tick() => {
                if let Some(sink) = &sink {
                    sink(queue.info(capacity));
                    announced = true;
                }
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScoredSection {
    pub text: String,
    pub score: f64,
    pub section_id: String,
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct UpsertProgress {
    pub sections_processed: usize,
    pub sections_embedded: usize,
    pub sections_upserted: usize,
    pub phase: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedSection {
    pub section_id: String,
    pub text: String,
    pub heading: Option<String>,
    pub part: Option<String>,
    pub division: Option<String>,
    pub act_name: String,
    pub doc_type: String,
    pub source_notes: Option<String>,
}

#[derive(Clone)]
pub struct QdrantStore {
    pub client: Qdrant,
    embed_client: HttpClient,
    vllm_url: String,
    embed_model: String,
    embed_cache: Cache<String, Vec<f32>>,
    rerank_cache: Cache<String, Vec<ScoredSection>>,
    /// Cache of fully-formatted tool-result strings, keyed by SHA-256 of
    /// (collection, tool_name, query, scope, top_k, reranker_enabled).
    /// Ensures byte-identical content for repeated identical searches,
    /// enabling DeepSeek disk-cache prefix reuse across sessions.
    pub search_result_cache: Cache<String, String>,
    embed_semaphore: Arc<Semaphore>,
    rerank_semaphore: Arc<Semaphore>,
    rerank_capacity: usize,
    rerank_queue: Arc<RerankQueue>,
    /// Hard deadline for one Qdrant search / read (see `with_deadline`).
    qdrant_timeout: Duration,
    /// Acts list cache: populated by indexed_act_names(), TTL-refreshed to
    /// avoid busting the DeepSeek prompt prefix cache on every request.
    acts_cache: Cache<String, Vec<String>>,
    /// Distinct `parent_act_name` values from SL points, keyed by collection.
    /// Used by list_subsidiary_legislation fuzzy fallback to avoid a full
    /// collection scroll — matching is done in-memory against this small list
    /// (~336 entries), then a single exact-filter Qdrant query retrieves the SL docs.
    sl_parents_cache: Cache<String, Vec<String>>,
    /// Auto-derived abbreviation map: UPPERCASE initialism → canonical parent_act_name.
    /// Built from unambiguous initialisms of all SL parent names (e.g. "CPC" →
    /// "Criminal Procedure Code 2010").  Keyed by collection, same TTL as sl_parents_cache.
    sl_abbrev_cache: Cache<String, std::collections::HashMap<String, String>>,
}

/// `ok` / `timeout` / `error` label for a Qdrant call's result.
fn outcome_of<T>(r: &Result<T>) -> &'static str {
    match r {
        Ok(_) => "ok",
        Err(e) if e.downcast_ref::<QdrantTimeout>().is_some() => "timeout",
        Err(_) => "error",
    }
}

fn cache_lookup(cache: &str, hit: bool) {
    metrics::CACHE_LOOKUPS_TOTAL.with_label_values(&[cache, if hit { "hit" } else { "miss" }]).inc();
}

/// One call that reached vLLM (and so the GPU). `usage` is the response's `usage` object; vLLM
/// reports prompt/total tokens for embeddings and (in recent versions) rerank.
fn record_vllm(op: &str, model: &str, outcome: &str, secs: f64, usage: Option<&Value>) {
    metrics::VLLM_REQUESTS_TOTAL.with_label_values(&[op, outcome]).inc();
    metrics::VLLM_LATENCY_SECONDS.with_label_values(&[op]).observe(secs);
    if let Some(n) = usage.and_then(|u| u["total_tokens"].as_u64().or_else(|| u["prompt_tokens"].as_u64())) {
        metrics::VLLM_TOKENS_TOTAL.with_label_values(&[op, model]).inc_by(n as f64);
    }
}

impl QdrantStore {
    pub async fn new(qdrant_url: &str, config: &AppConfig) -> Result<Self> {
        let qdrant_timeout = Duration::from_secs(config.qdrant_timeout_s.max(1) as u64);
        let mut qdrant_config = qdrant_client::config::QdrantConfig::from_url(qdrant_url);
        // The per-attempt client timeout sits above our deadline so `with_deadline` is the
        // one that decides, and the user-visible notice is always sent.
        qdrant_config.set_timeout(qdrant_timeout + Duration::from_secs(2));
        qdrant_config.set_connect_timeout(Duration::from_secs(3));
        qdrant_config.set_pool_size(config.qdrant_pool_size.max(1) as usize);
        let client = Qdrant::new(qdrant_config.skip_compatibility_check())
            .context("Failed to build Qdrant client")?;
        let embed_client = HttpClient::builder()
            .timeout(Duration::from_secs(300))
            .pool_max_idle_per_host(2)
            .build()?;
        let embed_cache = Cache::builder()
            .max_capacity(config.embed_cache_maxsize)
            .time_to_live(Duration::from_secs(config.embed_cache_ttl))
            .build();
        let rerank_cache = Cache::builder()
            .max_capacity(config.rerank_cache_maxsize)
            .time_to_live(Duration::from_secs(config.rerank_cache_ttl))
            .build();
        let search_result_cache = Cache::builder()
            .max_capacity(config.search_result_cache_maxsize)
            .time_to_live(Duration::from_secs(config.search_result_cache_ttl))
            .build();
        // Acts list is stable between ingests; cache it for 1 hour to prevent
        // system-prompt churn from busting the DeepSeek prefix cache.
        let acts_cache = Cache::builder()
            .max_capacity(8)
            .time_to_live(Duration::from_secs(3600))
            .build();
        let sl_parents_cache = Cache::builder()
            .max_capacity(8)
            .time_to_live(Duration::from_secs(3600))
            .build();
        let sl_abbrev_cache = Cache::builder()
            .max_capacity(8)
            .time_to_live(Duration::from_secs(3600))
            .build();
        Ok(Self {
            client,
            embed_client,
            vllm_url: config.vllm_base_url.clone(),
            embed_model: config.vllm_embed_model.clone(),
            embed_cache,
            rerank_cache,
            search_result_cache,
            embed_semaphore: Arc::new(Semaphore::new(1)),
            rerank_semaphore: Arc::new(Semaphore::new(config.reranker_max_concurrent as usize)),
            rerank_capacity: config.reranker_max_concurrent as usize,
            rerank_queue: Arc::new(RerankQueue::default()),
            qdrant_timeout,
            acts_cache,
            sl_parents_cache,
            sl_abbrev_cache,
        })
    }

    pub fn set_vllm_url(&mut self, url: &str) {
        self.vllm_url = url.to_string();
    }

    /// Truncate text for embedding: max 30_000 chars (~7,500 tokens), sentence-aware.
    /// Matches the embed model's 8,192-token maxModelLen with headroom.
    /// p95 of law_sections is ~1,511 tokens; query strings are <100 tokens.
    fn truncate_for_embed(text: &str) -> &str {
        const MAX_EMBED_CHARS: usize = 30_000;
        if text.len() <= MAX_EMBED_CHARS {
            return text;
        }
        let truncated = &text[..MAX_EMBED_CHARS];
        // Snap back to last ". " boundary if one exists in the second half
        if let Some(pos) = truncated[MAX_EMBED_CHARS / 2..].rfind(". ") {
            let abs = MAX_EMBED_CHARS / 2 + pos + 1;
            if abs < text.len() {
                return &text[..abs];
            }
        }
        truncated
    }

    /// Embed text using vLLM /v1/embeddings.
    /// Cache key includes model name (mirrors Python _embed_cache_key).
    pub async fn embed_text(&self, text: &str) -> Result<Vec<f32>> {
        let model = &self.embed_model;
        let truncated = Self::truncate_for_embed(text);
        let cache_key = {
            let mut hasher = Sha256::new();
            hasher.update(model.as_bytes());
            hasher.update(b"\x00");
            hasher.update(truncated.as_bytes());
            format!("{:x}", hasher.finalize())
        };
        if let Some(cached) = self.embed_cache.get(&cache_key).await {
            cache_lookup("embed", true);
            return Ok(cached);
        }
        let t_embed_wait = std::time::Instant::now();
        let _permit = self.embed_semaphore.acquire().await?;
        metrics::VLLM_QUEUE_WAIT_SECONDS.with_label_values(&["embed"]).observe(t_embed_wait.elapsed().as_secs_f64());
        // Double-check cache after acquiring semaphore (another task may have populated it)
        if let Some(cached) = self.embed_cache.get(&cache_key).await {
            cache_lookup("embed", true);
            return Ok(cached);
        }
        cache_lookup("embed", false);
        let t_embed_call = std::time::Instant::now();
        let payload = serde_json::json!({
            "model": model,
            "input": truncated,
        });
        let url = format!("{}/v1/embeddings", self.vllm_url);
        let resp = self.embed_client.post(&url).json(&payload).send().await;
        let resp = match resp {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                record_vllm("embed", model, "error", t_embed_call.elapsed().as_secs_f64(), None);
                anyhow::bail!("vLLM embeddings HTTP {}", r.status());
            }
            Err(e) => {
                record_vllm("embed", model, "error", t_embed_call.elapsed().as_secs_f64(), None);
                return Err(anyhow::Error::new(e).context("Failed to call vLLM embeddings"));
            }
        };
        let body: Value = resp.json().await?;
        record_vllm("embed", model, "ok", t_embed_call.elapsed().as_secs_f64(), Some(&body["usage"]));
        let embedding: Vec<f32> = body["data"][0]["embedding"]
            .as_array()
            .context("Missing embedding data")?
            .iter()
            .filter_map(|v| v.as_f64().map(|f| f as f32))
            .collect();
        self.embed_cache.insert(cache_key, embedding.clone()).await;
        debug!(
            wait_ms = t_embed_wait.elapsed().as_millis() as u64,
            call_ms = t_embed_call.elapsed().as_millis() as u64,
            "embed_text done"
        );
        Ok(embedding)
    }

    /// Batch embed multiple texts. Falls back to individual on failure.
    pub async fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(vec![]);
        }
        let url = format!("{}/v1/embeddings", self.vllm_url);
        let truncated: Vec<&str> = texts.iter().map(|t| Self::truncate_for_embed(t)).collect();
        let payload = serde_json::json!({
            "model": &self.embed_model,
            "input": truncated,
        });
        let t_batch = std::time::Instant::now();
        let resp = self
            .embed_client
            .post(&url)
            .json(&payload)
            .timeout(Duration::from_secs(300))
            .send()
            .await;
        match resp {
            Ok(r) if r.status().is_success() => {
                let body: Value = r.json().await?;
                record_vllm("embed", &self.embed_model, "ok", t_batch.elapsed().as_secs_f64(), Some(&body["usage"]));
                Ok(body["data"]
                    .as_array()
                    .unwrap_or(&vec![])
                    .iter()
                    .map(|item| {
                        item["embedding"]
                            .as_array()
                            .unwrap_or(&vec![])
                            .iter()
                            .filter_map(|v| v.as_f64().map(|f| f as f32))
                            .collect()
                    })
                    .collect())
            }
            _ => {
                record_vllm("embed", &self.embed_model, "error", t_batch.elapsed().as_secs_f64(), None);
                warn!("Batch embedding failed — falling back to individual");
                let mut results = Vec::new();
                for text in texts {
                    results.push(self.embed_text(text).await?);
                }
                Ok(results)
            }
        }
    }

    /// Hybrid search: exact section-id lookup + semantic search.
    /// `act_name` scopes results to a single Act (resolved to `source_file` filter).
    /// `source_file` scopes results to a specific document (e.g. "Foo Regulations 2019.pdf").
    pub async fn search_sections(
        &self,
        collection: &str,
        query: &str,
        top_k: usize,
        act_name: Option<&str>,
        source_file: Option<&str>,
        config: &AppConfig,
    ) -> Result<Vec<ScoredSection>> {
        let mut results = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        // Scope by source_file and/or act_name (new collections have `act_name`).
        // Match both .pdf and .md source_file variants so lookups succeed
        // regardless of which extension was stored by the ingest step.
        let is_judiciary = collection == config.qdrant_judiciary_collection;
        let scope_filter = if is_judiciary {
            // Judgments carry case_name / neutral_citation / source_file, not act_name.
            source_file
                .or(act_name)
                .filter(|s| !s.trim().is_empty())
                .map(judiciary_scope_filter)
        } else {
            let mut conditions: Vec<Condition> = Vec::new();
            if let Some(sf) = source_file {
                conditions.push(Condition::from(act_name_filter(sf, false)));
            } else if let Some(a) = act_name {
                conditions.push(Condition::from(act_name_filter(a, true)));
            }
            if conditions.is_empty() {
                None
            } else {
                Some(Filter::must(conditions))
            }
        };

        // Phase 1: exact section lookup (section_number or legacy section_id, "s" prefix).
        // Not for judgments: they have no section numbers (their `section_id` is
        // `<case>_chunkN`), so the filter can never match, and neither field is indexed on that
        // collection, so the scroll reads all ~180k on-disk payloads. That is 2-3 s with a warm
        // page cache and 25 s to over a minute with a cold one.
        let section_nums = if is_judiciary { Vec::new() } else { extract_section_ids(query) };
        if !section_nums.is_empty() {
            let mut conditions = section_id_conditions(&section_nums);
            let section_filter = if conditions.len() == 1 {
                Filter::must(vec![conditions.remove(0)])
            } else {
                Filter::should(conditions)
            };
            let exact_filter = match &scope_filter {
                Some(act_f) => Filter::must([
                    Condition::from(act_f.clone()),
                    Condition::from(section_filter),
                ]),
                None => section_filter,
            };
            let t_scroll = std::time::Instant::now();
            let exact = with_deadline(
                self.qdrant_timeout,
                self.client.scroll(
                    ScrollPointsBuilder::new(collection)
                        .filter(exact_filter)
                        .limit((section_nums.len() + 5) as u32)
                        .with_payload(true),
                ),
            )
            .await;
            let s_ms = t_scroll.elapsed().as_millis();
            metrics::record_qdrant("scroll", collection, outcome_of(&exact), t_scroll.elapsed().as_secs_f64());
            match &exact {
                Ok(r) if s_ms >= SLOW_QDRANT_MS => {
                    warn!("[qdrant] exact-section scroll {collection} slow: hits={} ms={s_ms}", r.result.len())
                }
                Ok(r) => info!("[qdrant] exact-section scroll {collection} hits={} ms={s_ms}", r.result.len()),
                Err(e) => warn!("[qdrant] exact-section scroll {collection} FAILED after ms={s_ms}: {e:#}"),
            }
            if let Ok(resp) = exact {
                for point in resp.result {
                    let p = &point.payload;
                    let text = p
                        .get("text")
                        .and_then(|v| v.as_str())
                        .cloned()
                        .unwrap_or_default();
                    if text.is_empty() {
                        continue;
                    }
                    let mut section_id = payload_section_id(p);
                    if section_id.is_empty() {
                        section_id = point
                            .id
                            .as_ref()
                            .and_then(|id| id.point_id_options.as_ref())
                            .and_then(|o| match o {
                                PointIdOptions::Uuid(u) => Some(u.to_string()),
                                _ => None,
                            })
                            .unwrap_or_default();
                    }
                    let mut metadata = serde_json::to_value(p).unwrap_or_default();
                    if let Some(obj) = metadata.as_object_mut() {
                        strip_section_payload_keys(obj);
                    }
                    seen.insert(section_id.clone());
                    results.push(ScoredSection {
                        text,
                        score: 1.0,
                        section_id,
                        metadata,
                    });
                }
            }
        }

        // Phase 2: semantic search (optionally scoped to act_name)
        let query_vec = self.embed_text(query).await?;
        let mut semantic_builder = QueryPointsBuilder::new(collection)
            .query(query_vec)
            .limit((config.reranker_prefetch_k as u64).max(top_k as u64))
            .with_payload(true)
            .score_threshold(config.rag_score_threshold as f32);
        if let Some(ref f) = scope_filter {
            semantic_builder = semantic_builder.filter(f.clone());
        }
        let t_query = std::time::Instant::now();
        let semantic = with_deadline(self.qdrant_timeout, self.client.query(semantic_builder)).await;
        let q_ms = t_query.elapsed().as_millis();
        metrics::record_qdrant("query", collection, outcome_of(&semantic), t_query.elapsed().as_secs_f64());
        match &semantic {
            Ok(r) if q_ms >= SLOW_QDRANT_MS => warn!(
                "[qdrant] query {collection} slow: hits={} scoped={} ms={q_ms}",
                r.result.len(),
                scope_filter.is_some()
            ),
            Ok(r) => info!("[qdrant] query {collection} hits={} scoped={} ms={q_ms}", r.result.len(), scope_filter.is_some()),
            Err(e) => warn!("[qdrant] query {collection} FAILED after ms={q_ms}: {e:#}"),
        }
        let semantic = semantic.context("Semantic search failed")?;

        for point in semantic.result {
            let point_uuid = point
                .id
                .and_then(|id| id.point_id_options)
                .and_then(|o| match o {
                    PointIdOptions::Uuid(u) => Some(u),
                    _ => None,
                })
                .map(|u| u.to_string())
                .unwrap_or_default();
            if seen.contains(&point_uuid) {
                continue;
            }
            seen.insert(point_uuid.clone());
            let p = &point.payload;
            let text = p
                .get("text")
                .and_then(|v| v.as_str())
                .cloned()
                .unwrap_or_default();
            if !text.is_empty() {
                let section_id = payload_section_id(p);
                let section_id = if section_id.is_empty() {
                    point_uuid
                } else {
                    section_id
                };
                let mut metadata = serde_json::to_value(p).unwrap_or_default();
                if let Some(obj) = metadata.as_object_mut() {
                    strip_section_payload_keys(obj);
                }
                results.push(ScoredSection {
                    text,
                    score: point.score as f64,
                    section_id,
                    metadata,
                });
            }
        }

        // Rerank if enabled
        if config.reranker_enabled && results.len() > config.reranker_top_k as usize {
            results = self.rerank_sections(query, results, config).await?;
        }
        results.truncate(config.reranker_top_k as usize);
        Ok(results)
    }

    /// Rerank sections via vLLM /v1/rerank (Cohere-compatible).
    pub async fn rerank_sections(
        &self,
        query: &str,
        sections: Vec<ScoredSection>,
        config: &AppConfig,
    ) -> Result<Vec<ScoredSection>> {
        if sections.len() <= 1 {
            return Ok(sections);
        }
        let cache_key = rerank_cache_key(query, &sections);
        if let Some(cached) = self.rerank_cache.get(&cache_key).await {
            cache_lookup("rerank", true);
            return Ok(cached);
        }
        cache_lookup("rerank", false);
        let _t_wait = std::time::Instant::now();
        let _permit = acquire_with_queue_notice(
            &self.rerank_semaphore,
            &self.rerank_queue,
            self.rerank_capacity,
            QUEUE_NOTICE_AFTER,
            QUEUE_REFRESH,
        )
        .await?;
        let t_wait_ms = _t_wait.elapsed().as_millis();
        metrics::VLLM_QUEUE_WAIT_SECONDS.with_label_values(&["rerank"]).observe(_t_wait.elapsed().as_secs_f64());
        let t_rerank = std::time::Instant::now();
        // Per-doc cap: 4,000 chars (~1,000 tokens) is enough for relevance scoring.
        // Qwen3-Reranker-0.6B has 32K token window but scoring 20×80K chars took 40-75s.
        // At 4K chars: same relevance quality, ~10-20x faster per call.
        // Use floor_char_boundary to avoid slicing mid-UTF-8 codepoint.
        const MAX_DOC_CHARS: usize = 4_000;
        let k = config.reranker_top_k as usize;
        let doc_strings: Vec<String> = sections
            .iter()
            .map(|s| {
                let t = s.text.as_str();
                if t.len() > MAX_DOC_CHARS {
                    // Walk back to a valid char boundary
                    let mut end = MAX_DOC_CHARS;
                    while end > 0 && !t.is_char_boundary(end) {
                        end -= 1;
                    }
                    t[..end].to_string()
                } else {
                    t.to_string()
                }
            })
            .collect();
        let docs: Vec<&str> = doc_strings.iter().map(|s| s.as_str()).collect();
        let n_docs = docs.len();
        let url = format!("{}/v1/rerank", self.vllm_url);
        // top_n = len(documents) so we get scores for ALL docs, then filter by min score (mirrors Python)
        let result = self
            .embed_client
            .post(&url)
            .json(&serde_json::json!({
                "model": config.reranker_model, "query": query,
                "documents": docs, "top_n": n_docs
            }))
            .timeout(Duration::from_secs(300))
            .send()
            .await;
        // Feeds the wait estimate shown to queued users (successful calls only).
        if matches!(&result, Ok(r) if r.status().is_success()) {
            self.rerank_queue.record_call_ms(t_rerank.elapsed().as_millis() as u64);
        }

        let rerank_secs = t_rerank.elapsed().as_secs_f64();
        let resp = match result {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                record_vllm("rerank", &config.reranker_model, "error", rerank_secs, None);
                metrics::RERANK_FALLBACK_TOTAL.inc();
                warn!(
                    "Reranker returned HTTP {} — falling back to semantic ranking",
                    r.status()
                );
                let mut fallback = sections;
                fallback.truncate(k);
                return Ok(fallback);
            }
            Err(e) => {
                record_vllm("rerank", &config.reranker_model, "error", rerank_secs, None);
                metrics::RERANK_FALLBACK_TOTAL.inc();
                warn!(
                    "Reranker request failed: {} — falling back to semantic ranking",
                    e
                );
                let mut fallback = sections;
                fallback.truncate(k);
                return Ok(fallback);
            }
        };

        let body: Value = match resp.json::<Value>().await {
            Ok(v) => {
                record_vllm("rerank", &config.reranker_model, "ok", rerank_secs, Some(&v["usage"]));
                v
            }
            Err(e) => {
                metrics::RERANK_FALLBACK_TOTAL.inc();
                warn!("Reranker JSON parse failed: {} — falling back", e);
                let mut fallback = sections;
                fallback.truncate(k);
                return Ok(fallback);
            }
        };

        const RERANKER_MIN_SCORE: f64 = 0.3;
        let empty = vec![];
        let mut scored: Vec<(usize, f64)> = body["results"]
            .as_array()
            .unwrap_or(&empty)
            .iter()
            .filter_map(|r| {
                let idx = r["index"].as_u64()? as usize;
                let score = r["relevance_score"].as_f64()?;
                if idx < sections.len() {
                    Some((idx, score))
                } else {
                    None
                }
            })
            .collect();
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        let mut reranked: Vec<ScoredSection> = scored
            .iter()
            .filter(|(_, score)| *score >= RERANKER_MIN_SCORE)
            .map(|(idx, score)| {
                let mut s = sections[*idx].clone();
                s.score = *score;
                s
            })
            .collect();

        // Fallback: if min-score filter removed everything, return top-k by semantic score (mirrors Python)
        if reranked.is_empty() {
            metrics::RERANK_FALLBACK_TOTAL.inc();
            warn!(
                "Reranker filtered all sections (min_score={}) — falling back to top {} by vector score",
                RERANKER_MIN_SCORE, k
            );
            let mut fallback = sections;
            fallback.truncate(k);
            return Ok(fallback);
        }

        reranked.truncate(k);
        self.rerank_cache.insert(cache_key, reranked.clone()).await;
        debug!(
            n_docs,
            wait_ms = t_wait_ms as u64,
            rerank_ms = t_rerank.elapsed().as_millis() as u64,
            results = reranked.len(),
            "rerank done"
        );
        Ok(reranked)
    }

    /// Stream-upsert: embed + buffer + upsert.
    pub async fn upsert_sections_stream(
        &self,
        collection: &str,
        sections: &[ParsedSection],
    ) -> Result<()> {
        let batch_size = 10usize;
        let mut buffer: Vec<PointStruct> = Vec::with_capacity(batch_size);
        for (i, sec) in sections.iter().enumerate() {
            let text = normalize_rag_text(&sec.text);
            let embedding = self.embed_text(&text).await?;
            let point_id = Uuid::new_v5(&Uuid::nil(), sec.section_id.as_bytes());
            let mut payload_map = std::collections::HashMap::new();
            payload_map.insert("text".into(), serde_json::Value::String(text));
            payload_map.insert(
                "section_id".into(),
                serde_json::Value::String(sec.section_id.clone()),
            );
            let point = PointStruct::new(point_id.to_string(), embedding, payload_map);
            buffer.push(point);
            if buffer.len() >= batch_size || i == sections.len() - 1 {
                let batch = std::mem::take(&mut buffer);
                self.client
                    .upsert_points(
                        qdrant_client::qdrant::UpsertPointsBuilder::new(collection, batch)
                            .wait(true),
                    )
                    .await?;
            }
        }
        Ok(())
    }

    /// Ensure collection exists; recreate on vector size mismatch.
    pub async fn ensure_collection(&self, name: &str, vector_size: u64) -> Result<()> {
        if !self.client.collection_exists(name).await.unwrap_or(false) {
            info!(
                "Creating collection: {} (vector_size={})",
                name, vector_size
            );
            self.client
                .create_collection(
                    CreateCollectionBuilder::new(name)
                        .vectors_config(VectorParamsBuilder::new(vector_size, Distance::Cosine)),
                )
                .await?;
            return Ok(());
        }
        Ok(())
    }

    pub async fn delete_collection(&self, name: &str) -> Result<()> {
        self.client.delete_collection(name).await.ok();
        Ok(())
    }

    pub async fn collection_count(&self, name: &str) -> Result<u64> {
        Ok(self
            .client
            .count(qdrant_client::qdrant::CountPoints {
                collection_name: name.to_string(),
                ..Default::default()
            })
            .await
            .map(|r| r.result.unwrap_or_default().count)
            .unwrap_or(0))
    }

    /// Return all distinct act names indexed in a collection.
    /// Results are cached for 1 hour so the legislation system prompt is stable
    /// between requests, preserving the DeepSeek prefix cache across users.
    pub async fn indexed_act_names(&self, collection: &str) -> Result<Vec<String>> {
        if let Some(cached) = self.acts_cache.get(collection).await {
            return Ok(cached);
        }
        let mut names = Vec::new();
        if let Ok(resp) = self
            .client
            .scroll(
                ScrollPointsBuilder::new(collection)
                    .with_payload(true)
                    .limit(10000),
            )
            .await
        {
            for p in resp.result {
                let payload = &p.payload;
                if let Some(act) = payload.get("act_name").and_then(|v| v.as_str()) {
                    let s = act.to_string();
                    if !s.is_empty() && !names.contains(&s) {
                        names.push(s);
                    }
                }
            }
        }
        names.sort();
        self.acts_cache
            .insert(collection.to_string(), names.clone())
            .await;
        Ok(names)
    }

    /// Return all distinct subsidiary legislation document names under a parent Act.
    ///
    /// Phase 0 — abbreviation expansion: if the query looks like an initialism
    ///   (all-uppercase, 2-6 chars, optional trailing year), expand it using the
    ///   auto-derived abbreviation map before any matching.  "CPC" → "Criminal
    ///   Procedure Code 2010", "MDA" → "Misuse of Drugs Act 1973", etc.
    ///
    /// Phase 1 — exact filter: Qdrant `matches` filter on `parent_act_name`.  Fast path
    ///   when the LLM passes the stored name verbatim (e.g. "Criminal Procedure Code 2010").
    ///
    /// Phase 2 — in-memory fuzzy match: fetches (and caches for 1 h) the ~336 distinct
    ///   `parent_act_name` values from Qdrant in a single small scroll, normalises both
    ///   sides with `normalize_act_name`, picks the best match, then issues one exact
    ///   Qdrant query for that matched name.  Total latency: one cheap cached list lookup
    ///   + one indexed Qdrant filter — no full-collection scan.
    pub async fn list_subsidiary_legislation(
        &self,
        collection: &str,
        parent_act_name: &str,
    ) -> Result<Vec<String>> {
        // ── Phase 0: abbreviation expansion ──────────────────────────────────────
        // Detect all-caps initialisms like "CPC", "MDA 1973", "PDPA".
        // Strip a trailing year from the query for lookup, then re-use the expanded name.
        let abbrev_re = regex::Regex::new(r"^([A-Z]{2,6})(?:\s+\d{4})?$").unwrap();
        let query = if let Some(caps) = abbrev_re.captures(parent_act_name.trim()) {
            let initialism = &caps[1];
            let abbrev_map = self.sl_abbrev_map(collection).await;
            if let Some(expanded) = abbrev_map.get(initialism) {
                info!(
                    "list_subsidiary_legislation: expanded abbreviation '{}' → '{}'",
                    parent_act_name, expanded
                );
                expanded.clone()
            } else {
                parent_act_name.to_string()
            }
        } else {
            parent_act_name.to_string()
        };

        // ── Phase 1: exact match ──────────────────────────────────────────────────
        let mut names = self.fetch_sl_names_for_parent(collection, &query).await;
        if !names.is_empty() {
            names.sort();
            return Ok(names);
        }

        // ── Phase 2: in-memory fuzzy match against cached parent name list ────────
        info!(
            "list_subsidiary_legislation: exact match for '{}' returned 0 results, trying fuzzy fallback",
            query
        );
        let query_norm = normalize_act_name(&query);
        let all_parents = self.sl_parent_names(collection).await;

        // Content-token-all matching: ALL non-stopword query tokens must appear
        // in the candidate.  This avoids "Penal Code" matching "Criminal Procedure
        // Code" (shares only "code", but "penal" is absent).
        // Quotes are normalised (\u{2019} right-single-quote → ') before tokenising
        // so "Women's Charter" matches the stored "Women\u{2019}s Charter 1961".
        static STOPWORDS: &[&str] = &["act", "the", "of", "and", "for", "in", "on"];
        let query_norm_ascii = query_norm.replace('\u{2019}', "'");
        let all_tokens: Vec<&str> = query_norm_ascii.split_whitespace().collect();
        let content_tokens: Vec<&str> = all_tokens
            .iter()
            .copied()
            .filter(|t| !STOPWORDS.contains(t))
            .collect();
        let effective_tokens = if content_tokens.is_empty() {
            all_tokens.as_slice()
        } else {
            content_tokens.as_slice()
        };
        let best = all_parents
            .iter()
            .filter_map(|stored| {
                let norm = normalize_act_name(stored).replace('\u{2019}', "'");
                // All content tokens must be present in the candidate
                let content_hits = effective_tokens
                    .iter()
                    .filter(|&&t| norm.contains(t))
                    .count();
                if content_hits < effective_tokens.len() {
                    return None;
                }
                // Guard: reject if one name is a proper substring of the other.
                // e.g. "sale of goods act" ⊂ "sale of goods (united nations convention) act"
                // This prevents "Sale of Goods Act 1979" matching its UN Convention
                // variant, which shares all the same content tokens.
                if norm.contains(query_norm.as_str()) || query_norm.contains(norm.as_str()) {
                    return None;
                }
                // Tie-break: prefer the candidate whose normalised name is closest
                // in length to the query (avoids over-broad matches like "Act" alone).
                let length_diff = (norm.len() as isize - query_norm.len() as isize).unsigned_abs();
                Some((content_hits, usize::MAX - length_diff, stored.as_str()))
            })
            .max_by_key(|&(hits, tiebreak, _)| (hits, tiebreak));

        if let Some((_, _, matched_name)) = best {
            info!(
                "list_subsidiary_legislation: fuzzy matched '{}' → '{}'",
                query, matched_name
            );
            names = self
                .fetch_sl_names_for_parent(collection, matched_name)
                .await;
        }
        names.sort();
        Ok(names)
    }

    /// Fetch distinct SL `source_file` names for an exact `parent_act_name` value.
    async fn fetch_sl_names_for_parent(
        &self,
        collection: &str,
        parent_act_name: &str,
    ) -> Vec<String> {
        let filter = Filter::must([
            keyword_match("parent_act_name", parent_act_name.to_string()),
            keyword_match("doc_type", "subsidiary_legislation".to_string()),
        ]);
        let mut names: Vec<String> = Vec::new();
        let mut offset: Option<PointId> = None;
        loop {
            let mut builder = ScrollPointsBuilder::new(collection)
                .filter(filter.clone())
                .with_payload(true)
                .limit(1000);
            if let Some(o) = offset {
                builder = builder.offset(o);
            }
            match self.client.scroll(builder).await {
                Ok(resp) => {
                    for p in &resp.result {
                        if let Some(sf) = p.payload.get("source_file").and_then(|v| v.as_str()) {
                            let name = sf.trim_end_matches(".pdf").to_string();
                            if !name.is_empty() && !names.contains(&name) {
                                names.push(name);
                            }
                        }
                    }
                    offset = resp.next_page_offset;
                    if offset.is_none() || resp.result.is_empty() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        names
    }

    /// Return (and cache) the distinct `parent_act_name` values from all SL points.
    /// Also populates the abbreviation cache as a side-effect.
    /// A single paginated scroll collects ~336 unique strings; cached for 1 h.
    async fn sl_parent_names(&self, collection: &str) -> Vec<String> {
        if let Some(cached) = self.sl_parents_cache.get(collection).await {
            return cached;
        }
        let sl_filter = Filter::must([keyword_match(
            "doc_type",
            "subsidiary_legislation".to_string(),
        )]);
        let mut seen = std::collections::HashSet::new();
        let mut offset: Option<PointId> = None;
        loop {
            let mut builder = ScrollPointsBuilder::new(collection)
                .filter(sl_filter.clone())
                .with_payload(true)
                .limit(1000);
            if let Some(o) = offset {
                builder = builder.offset(o);
            }
            match self.client.scroll(builder).await {
                Ok(resp) => {
                    for p in &resp.result {
                        if let Some(pan) = p
                            .payload
                            .get("parent_act_name")
                            .and_then(|v| v.as_str())
                            .filter(|pan| !pan.is_empty())
                        {
                            seen.insert(pan.to_string());
                        }
                    }
                    offset = resp.next_page_offset;
                    if offset.is_none() || resp.result.is_empty() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let mut names: Vec<String> = seen.into_iter().collect();
        names.sort();
        // Build and cache the abbreviation map alongside the names list.
        let abbrev_map = build_abbrev_map(&names);
        self.sl_abbrev_cache
            .insert(collection.to_string(), abbrev_map)
            .await;
        self.sl_parents_cache
            .insert(collection.to_string(), names.clone())
            .await;
        names
    }

    /// Return (and cache) the initialism → canonical-name abbreviation map.
    /// Triggers sl_parent_names if the cache is cold (they share the same scroll).
    async fn sl_abbrev_map(&self, collection: &str) -> std::collections::HashMap<String, String> {
        if let Some(cached) = self.sl_abbrev_cache.get(collection).await {
            return cached;
        }
        // Warm the parents cache, which also populates the abbrev cache.
        self.sl_parent_names(collection).await;
        self.sl_abbrev_cache
            .get(collection)
            .await
            .unwrap_or_default()
    }

    /// Retrieve a specific section by exact section_id and source_file.
    /// No embedding or reranking — pure Qdrant filter scroll.
    ///
    /// Oversized sections/schedules are stored as several chunks. All chunks are
    /// fetched (paginated), ordered by `chunk_index`, and returned as a window of
    /// whole parts of at most [`GET_SECTION_WINDOW_TOKENS`] Qwen3 tokens starting
    /// at `part` (1-based, default 1). The returned metadata carries
    /// `chunk_total`, `part_from`, `part_to`, `window_tokens` and `complete`.
    pub async fn get_section(
        &self,
        collection: &str,
        source_file: &str,
        section_id: &str,
        part: Option<usize>,
    ) -> Result<Option<ScoredSection>> {
        self.get_section_windowed(collection, source_file, section_id, part, GET_SECTION_WINDOW_TOKENS)
            .await
    }

    /// [`Self::get_section`] with an explicit window size (in Qwen3 tokens).
    /// A single part larger than the window is still returned whole.
    pub async fn get_section_windowed(
        &self,
        collection: &str,
        source_file: &str,
        section_id: &str,
        part: Option<usize>,
        window_tokens_max: usize,
    ) -> Result<Option<ScoredSection>> {
        // Accept the source_file with or without extension; match all variants
        // plus the bare act_name field to handle both .pdf and .md payloads.
        let stem = source_file.trim_end_matches(".pdf").trim_end_matches(".md");
        // Stored names use the typographic apostrophe (Women’s Charter); models
        // type a straight one, so try both spellings.
        let source_filter = act_name_filter(stem, true);
        let section_filter = Filter::should(
            section_id_candidates(section_id)
                .into_iter()
                .flat_map(|c| {
                    [
                        keyword_match("section_number", c.clone()),
                        keyword_match("section_id", c),
                    ]
                })
                .collect::<Vec<_>>(),
        );
        let filter = Filter::must([
            Condition::from(source_filter),
            Condition::from(section_filter),
        ]);

        // Scroll every page: schedules can have well over 100 chunks, and a
        // single capped scroll would silently drop the rest.
        let mut points = self
            .scroll_all(collection, &filter, true)
            .await
            .context("get_section scroll failed")?;

        // Schedules are ingested as a header point plus separate sub-parts
        // (`schedule2` + `schedule2_parta`, `schedule2_table1`, `schedule3_part1`…).
        // Reading `schedule2` must return the whole schedule, so gather the
        // `<id>_*` siblings and order them after the header.
        let mut rank: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        if is_schedule_like_id(section_id) {
            let lister = Filter::must([Condition::from(act_name_filter(stem, true))]);
            let all = self.scroll_all(collection, &lister, false).await.unwrap_or_default();
            let prefixes: Vec<String> = section_id_candidates(section_id)
                .iter()
                .map(|c| format!("{}_", c.to_lowercase()))
                .collect();
            let mut siblings: Vec<String> = all
                .iter()
                .map(|pt| payload_section_id(&pt.payload))
                .filter(|id| {
                    let l = id.to_lowercase();
                    prefixes.iter().any(|pre| l.starts_with(pre))
                })
                .collect();
            siblings.sort();
            siblings.dedup();
            for (i, id) in siblings.iter().enumerate() {
                rank.insert(id.clone(), i + 1);
                let f = Filter::must([
                    Condition::from(act_name_filter(stem, true)),
                    keyword_match("section_number", id.clone()),
                ]);
                points.extend(
                    self.scroll_all(collection, &f, true)
                        .await
                        .context("get_section sibling scroll failed")?,
                );
            }
        }
        if points.is_empty() {
            return Ok(None);
        }

        // Oversized sections are split at ingest into token-bounded chunks
        // that all share the same section_number; chunk_index is 0 for an
        // unsplit section and 1..N for the parts of a split one.
        points.sort_by_key(|pt| {
            (
                rank.get(&payload_section_id(&pt.payload)).copied().unwrap_or(0),
                pt.payload
                    .get("chunk_index")
                    .and_then(|v| v.as_integer())
                    .unwrap_or(0),
            )
        });
        // Drop empty-text points, keeping the payload for metadata.
        let points: Vec<_> = points
            .into_iter()
            .filter(|pt| {
                pt.payload
                    .get("text")
                    .and_then(|v| v.as_str())
                    .is_some_and(|t| !t.is_empty())
            })
            .collect();
        if points.is_empty() {
            return Ok(None);
        }

        let total = points.len();
        let requested = part.unwrap_or(1).max(1);
        let start = requested.min(total) - 1;
        let texts: Vec<String> = points[start..]
            .iter()
            .filter_map(|pt| pt.payload.get("text").and_then(|v| v.as_str()).map(|t| t.to_string()))
            .collect();
        // Token counting walks real tokenizer merges; keep it off the async workers.
        let (take, window_tokens) = tokio::task::spawn_blocking(move || {
            plan_window(
                &texts,
                window_tokens_max,
                crate::services::tokenizer::count_tokens,
            )
        })
        .await
        .context("get_section token counting failed")?;
        let end = start + take;

        let text = points[start..end]
            .iter()
            .filter_map(|pt| pt.payload.get("text").and_then(|v| v.as_str()))
            .map(|t| t.as_str())
            .collect::<Vec<_>>()
            .join("\n\n");

        let p = &points[start].payload;
        let section_id = payload_section_id(p);
        let mut metadata = serde_json::to_value(p).unwrap_or_default();
        if let Some(obj) = metadata.as_object_mut() {
            strip_section_payload_keys(obj);
            obj.insert("chunk_total".into(), serde_json::json!(total));
            obj.insert("part_from".into(), serde_json::json!(start + 1));
            obj.insert("part_to".into(), serde_json::json!(end));
            obj.insert("window_tokens".into(), serde_json::json!(window_tokens));
            obj.insert("complete".into(), serde_json::json!(start == 0 && end == total));
            if requested > total {
                obj.insert("part_clamped_from".into(), serde_json::json!(requested));
            }
        }
        Ok(Some(ScoredSection {
            text,
            score: 1.0,
            section_id,
            metadata,
        }))
    }

    /// Scroll every page of `filter`. `full_payload=false` fetches only the
    /// section ids (cheap listing).
    async fn scroll_all(
        &self,
        collection: &str,
        filter: &Filter,
        full_payload: bool,
    ) -> Result<Vec<qdrant_client::qdrant::RetrievedPoint>> {
        self.scroll_capped(collection, filter, full_payload, 256, "scroll_all").await
    }

    /// Scroll pages of `filter` into one list, with timing and a hard size cap.
    ///
    /// A tool call only ever shows the model a window of at most
    /// [`GET_SECTION_WINDOW_TOKENS`] tokens, so pulling more than
    /// [`MAX_SCROLL_POINTS`] chunks (one response was 18 MB) is pure transfer cost
    /// through two sidecars. Hitting the cap is logged, never silent.
    async fn scroll_capped(
        &self,
        collection: &str,
        filter: &Filter,
        full_payload: bool,
        page_size: u32,
        label: &str,
    ) -> Result<Vec<qdrant_client::qdrant::RetrievedPoint>> {
        let t0 = std::time::Instant::now();
        let mut points: Vec<qdrant_client::qdrant::RetrievedPoint> = Vec::new();
        let mut offset: Option<PointId> = None;
        let mut pages = 0u32;
        let mut truncated = false;
        let outcome: Result<()> = async {
            loop {
                let mut builder = ScrollPointsBuilder::new(collection)
                    .filter(filter.clone())
                    .limit(page_size);
                builder = if full_payload {
                    builder.with_payload(true)
                } else {
                    builder.with_payload(qdrant_client::qdrant::with_payload_selector::SelectorOptions::Include(
                        qdrant_client::qdrant::PayloadIncludeSelector {
                            fields: vec!["section_number".into(), "section_id".into()],
                        },
                    ))
                };
                if let Some(o) = offset.take() {
                    builder = builder.offset(o);
                }
                let resp = with_deadline(self.qdrant_timeout, self.client.scroll(builder)).await?;
                pages += 1;
                let empty = resp.result.is_empty();
                points.extend(resp.result);
                offset = resp.next_page_offset;
                if offset.is_none() || empty {
                    break;
                }
                if points.len() >= MAX_SCROLL_POINTS {
                    truncated = true;
                    break;
                }
            }
            Ok(())
        }
        .await;
        let ms = t0.elapsed().as_millis();
        metrics::record_qdrant("scroll_all", collection, outcome_of(&outcome), t0.elapsed().as_secs_f64());
        let text_kb: usize = points
            .iter()
            .filter_map(|pt| pt.payload.get("text").and_then(|v| v.as_str()).map(|t| t.len()))
            .sum::<usize>()
            / 1024;
        match &outcome {
            Ok(()) if truncated => warn!(
                "[qdrant] {label} {collection} TRUNCATED at {} points (pages={pages} text_kb={text_kb} ms={ms})",
                points.len()
            ),
            Ok(()) if ms >= SLOW_QDRANT_MS => warn!(
                "[qdrant] {label} {collection} slow: points={} pages={pages} text_kb={text_kb} ms={ms}",
                points.len()
            ),
            Ok(()) => info!(
                "[qdrant] {label} {collection} points={} pages={pages} text_kb={text_kb} ms={ms}",
                points.len()
            ),
            Err(e) => warn!("[qdrant] {label} {collection} FAILED after ms={ms} pages={pages}: {e:#}"),
        }
        outcome?;
        Ok(points)
    }

    /// Number of chunks stored for a section (1 for an unsplit section), used to
    /// tell the model how many parts a search hit belongs to.
    pub async fn count_section_parts(
        &self,
        collection: &str,
        source_file: &str,
        section_number: &str,
    ) -> Option<u64> {
        let source_filter = act_name_filter(source_file, true);
        let filter = Filter::must([
            Condition::from(source_filter),
            keyword_match("section_number", section_number.to_string()),
        ]);
        let resp = self
            .client
            .count(qdrant_client::qdrant::CountPointsBuilder::new(collection).filter(filter).exact(true))
            .await
            .ok()?;
        resp.result.map(|r| r.count)
    }

    /// Read a judgment by neutral citation, case name or source stem.
    ///
    /// The judgment's body chunks (`<stem>_chunkN`, ordered by N; the `_meta`
    /// headnote point is not judgment text and is skipped) are returned as a
    /// window of whole chunks of at most [`GET_SECTION_WINDOW_TOKENS`] Qwen3
    /// tokens, starting at `part` (1-based). The ingest prefix (topic headnotes
    /// and the `Legislation:` line) repeated on every chunk is removed.
    /// Metadata carries `chunk_total`, `part_from`, `part_to`, `window_tokens`
    /// and `complete`, like [`Self::get_section`].
    pub async fn get_judgment(
        &self,
        collection: &str,
        case: &str,
        part: Option<usize>,
    ) -> Result<Option<ScoredSection>> {
        self.get_judgment_windowed(collection, case, part, GET_SECTION_WINDOW_TOKENS)
            .await
    }

    /// [`Self::get_judgment`] with an explicit window size (in Qwen3 tokens).
    pub async fn get_judgment_windowed(
        &self,
        collection: &str,
        case: &str,
        part: Option<usize>,
        window_tokens_max: usize,
    ) -> Result<Option<ScoredSection>> {
        let filter = judiciary_scope_filter(case);
        let points = self
            .scroll_capped(collection, &filter, true, 128, "get_judgment")
            .await
            .context("get_judgment scroll failed")?;
        // A case-name scope could in principle match several judgments; keep the
        // one whose source_file sorts first so the result is deterministic.
        let mut chunks: Vec<(String, u64, String, QdrantPayload)> = Vec::new();
        for pt in points {
            let sid = payload_section_id(&pt.payload);
            let Some(n) = judgment_chunk_number(&sid) else { continue };
            let text = pt
                .payload
                .get("text")
                .and_then(|v| v.as_str())
                .map(|t| t.to_string())
                .unwrap_or_default();
            if text.is_empty() {
                continue;
            }
            let src = pt
                .payload
                .get("source_file")
                .and_then(|v| v.as_str())
                .map(|t| t.to_string())
                .unwrap_or_default();
            chunks.push((src, n, text, pt.payload));
        }
        let Some(first_src) = chunks.iter().map(|c| c.0.clone()).min() else {
            return Ok(None);
        };
        chunks.retain(|c| c.0 == first_src);
        chunks.sort_by_key(|c| c.1);

        let total = chunks.len();
        let requested = part.unwrap_or(1).max(1);
        let start = requested.min(total) - 1;
        let texts: Vec<String> = chunks[start..]
            .iter()
            .map(|c| {
                let topics = c.3.get("topic_indexes").and_then(|v| v.as_str()).map(|s| s.as_str()).unwrap_or("");
                strip_judgment_prefix(&c.2, topics)
            })
            .collect();
        let planned = texts.clone();
        let (take, window_tokens) = tokio::task::spawn_blocking(move || {
            plan_window(&planned, window_tokens_max, crate::services::tokenizer::count_tokens)
        })
        .await
        .context("get_judgment token counting failed")?;
        let end = start + take;
        // Mark each chunk with its id so the model can cite the exact chunk.
        let text = chunks[start..end]
            .iter()
            .zip(texts.iter())
            .map(|(c, t)| format!("[{}]\n{}", payload_section_id(&c.3), t))
            .collect::<Vec<_>>()
            .join("\n\n");

        let p = &chunks[start].3;
        let mut metadata = serde_json::to_value(p).unwrap_or_default();
        if let Some(obj) = metadata.as_object_mut() {
            strip_section_payload_keys(obj);
            obj.insert("chunk_total".into(), serde_json::json!(total));
            obj.insert("part_from".into(), serde_json::json!(start + 1));
            obj.insert("part_to".into(), serde_json::json!(end));
            obj.insert("window_tokens".into(), serde_json::json!(window_tokens));
            obj.insert("complete".into(), serde_json::json!(start == 0 && end == total));
            if requested > total {
                obj.insert("part_clamped_from".into(), serde_json::json!(requested));
            }
        }
        Ok(Some(ScoredSection {
            text,
            score: 1.0,
            section_id: payload_section_id(p),
            metadata,
        }))
    }

    /// Fetch one judgment chunk by its id (`2019_SGHC_233_chunk4`), prefix removed.
    pub async fn get_judgment_chunk(
        &self,
        collection: &str,
        chunk_id: &str,
    ) -> Result<Option<ScoredSection>> {
        let Some(stem) = chunk_id.rsplit_once("_chunk").map(|(s, _)| s) else {
            return Ok(None);
        };
        let filter = Filter::must([
            Condition::from(judiciary_scope_filter(stem)),
            keyword_match("section_id", chunk_id.to_string()),
        ]);
        let resp = self
            .client
            .scroll(
                ScrollPointsBuilder::new(collection)
                    .filter(filter)
                    .limit(2)
                    .with_payload(true),
            )
            .await
            .context("get_judgment_chunk scroll failed")?;
        let Some(pt) = resp.result.into_iter().next() else {
            return Ok(None);
        };
        let text = pt
            .payload
            .get("text")
            .and_then(|v| v.as_str())
            .map(|t| t.to_string())
            .unwrap_or_default();
        if text.is_empty() {
            return Ok(None);
        }
        let topics = pt.payload.get("topic_indexes").and_then(|v| v.as_str()).map(|s| s.as_str()).unwrap_or("");
        let text = strip_judgment_prefix(&text, topics);
        let mut metadata = serde_json::to_value(&pt.payload).unwrap_or_default();
        if let Some(obj) = metadata.as_object_mut() {
            strip_section_payload_keys(obj);
        }
        Ok(Some(ScoredSection {
            text,
            score: 1.0,
            section_id: payload_section_id(&pt.payload),
            metadata,
        }))
    }

    /// Invalidate the acts-list cache for a collection.
    /// Call this after a legislation ingest so the next request rebuilds the prompt.
    pub async fn invalidate_acts_cache(&self, collection: &str) {
        self.acts_cache.invalidate(collection).await;
    }

    /// Delete points by filename filter (stub).
    pub async fn delete_by_filename(&self, _collection: &str, _filename: &str) -> Result<()> {
        Ok(())
    }
}

/// Build an uppercase-initialism → canonical-name map from a list of Act names.
///
/// Two initialisms are generated per name so we match both the "with-Act" and
/// "without-Act" conventions lawyers use:
///   - "Misuse of Drugs Act 1973"  → stopwords={"the","of","and",…} → "MDA"
///   - same name, also excluding "act"                              → "MD"
///
/// Only unambiguous initialisms (mapping to exactly one name) are kept.
fn build_abbrev_map(names: &[String]) -> std::collections::HashMap<String, String> {
    // Two stopword sets: one that keeps "act" (→ includes A), one that drops it
    static SW_NO_ACT: &[&str] = &["the", "of", "and", "for", "in", "on", "to", "a"];
    static SW_WITH_ACT: &[&str] = &["act", "the", "of", "and", "for", "in", "on", "to", "a"];
    let mut raw: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    for name in names {
        let norm = normalize_act_name(name);
        for stopwords in [SW_NO_ACT, SW_WITH_ACT] {
            let initialism: String = norm
                .split_whitespace()
                .filter(|w| !stopwords.contains(w) && w.len() > 1)
                .map(|w| w.chars().next().unwrap().to_ascii_uppercase())
                .collect();
            if initialism.len() >= 2 {
                raw.entry(initialism).or_default().push(name.clone());
            }
        }
    }
    // Keep only unambiguous mappings (deduplicate same-name entries first)
    raw.into_iter()
        .filter_map(|(k, v)| {
            let mut unique: Vec<String> = v;
            unique.dedup();
            if unique.len() == 1 {
                Some((k, unique.remove(0)))
            } else {
                None
            }
        })
        .collect()
}

/// Normalize an Act name for fuzzy matching: strip "(Cap. NNN)" / "(Cap NNN)"
/// suffixes (with or without period), trailing year, leading "The ", and lowercase.
fn normalize_act_name(name: &str) -> String {
    let s = name.trim();
    // Match both "Cap." and "Cap" (LLM sometimes omits the period)
    let cap_re = regex::Regex::new(r"\s*\(Cap\.?\s*\d+\w*\)").unwrap();
    let s = cap_re.replace_all(s, "");
    let year_re = regex::Regex::new(r"\s+\d{4}$").unwrap();
    let s = year_re.replace(&s, "");
    let s = s.trim();
    let s = s
        .strip_prefix("The ")
        .or_else(|| s.strip_prefix("the "))
        .unwrap_or(s);
    s.to_lowercase()
}

/// Body-chunk number of a judgment point id (`2019_SGHC_233_chunk4` -> 4).
/// `_meta` headnote points and anything else return `None`.
pub fn judgment_chunk_number(section_id: &str) -> Option<u64> {
    section_id.rsplit_once("_chunk")?.1.parse().ok()
}

/// Source stem and neutral citation for a citation such as `[2019] SGHC 233`
/// (`2019_SGHC_233`, `[2019] SGHC 233`). `None` if `s` is not a citation.
pub fn parse_neutral_citation(s: &str) -> Option<(String, String)> {
    let re = regex::Regex::new(r"^\[?(\d{4})\]?[\s_]*([A-Za-z()]+)[\s_]+(\d+)$").ok()?;
    let c = re.captures(s.trim())?;
    let (y, court, n) = (&c[1], c[2].to_uppercase(), &c[3]);
    Some((format!("{y}_{court}_{n}"), format!("[{y}] {court} {n}")))
}

/// Filter selecting one judgment from what the model typed: a neutral
/// citation, a source stem, or a case name.
pub fn judiciary_scope_filter(scope: &str) -> Filter {
    let scope = scope.trim();
    let stem = scope.trim_end_matches(".pdf").trim_end_matches(".md");
    let mut conds = vec![
        keyword_match("case_name", scope.to_string()),
        keyword_match("neutral_citation", scope.to_string()),
        keyword_match("source_file", scope.to_string()),
        keyword_match("source_file", format!("{stem}.pdf")),
    ];
    if let Some((src, cite)) = parse_neutral_citation(stem) {
        conds.push(keyword_match("source_file", format!("{src}.pdf")));
        conds.push(keyword_match("neutral_citation", cite));
    }
    Filter::should(conds)
}

/// Remove the text ingest prepends to every judgment chunk (the topic headnote
/// lines and the `Legislation:` line). It is retrieval context, not part of
/// the judgment, so it must not appear inside a quote.
pub fn strip_judgment_prefix(text: &str, topic_indexes: &str) -> String {
    let norm = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    let topics: Vec<String> = topic_indexes.split("; ").map(norm).filter(|t| !t.is_empty()).collect();
    let mut lines = text.lines().peekable();
    let mut consumed_any = false;
    while let Some(l) = lines.peek() {
        let n = norm(l);
        if !n.is_empty() && topics.iter().any(|t| *t == n) {
            lines.next();
            consumed_any = true;
        } else {
            break;
        }
    }
    if !consumed_any {
        return text.to_string();
    }
    while lines.peek().is_some_and(|l| l.trim().is_empty()) {
        lines.next();
    }
    if lines.peek().is_some_and(|l| l.trim_start().starts_with("Legislation:")) {
        lines.next();
        while lines.peek().is_some_and(|l| l.trim().is_empty()) {
            lines.next();
        }
    }
    lines.collect::<Vec<_>>().join("\n")
}

/// Cache key for a rerank call. It must identify the exact candidate set, not
/// just the query: the same query is run against the Act, SL and judiciary
/// collections, and a key without the candidates returned another
/// collection's sections.
pub fn rerank_cache_key(query: &str, sections: &[ScoredSection]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(query.as_bytes());
    for s in sections {
        h.update(b"\x00");
        h.update(s.section_id.as_bytes());
        h.update(b"\x01");
        let src = s
            .metadata
            .get("source_file")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        h.update(src.as_bytes());
        h.update(b"\x01");
        h.update(s.text.as_bytes());
    }
    format!("rerank:{:x}", h.finalize())
}

type QdrantPayload = std::collections::HashMap<String, qdrant_client::qdrant::Value>;

/// Maximum Qwen3 tokens of section text returned by one `get_section` call.
/// Exact (keyword) match on `field`.
///
/// Do not use `Condition::matches(field, String)` for these fields: qdrant-client turns any
/// string containing whitespace ("Employment Act 1968", "[2007] SGCA 53") into a full-text
/// match. The payload fields are keyword-indexed only, so Qdrant then scans every point in
/// the collection (0.8 s on `act`, 1.4 s on `sl`, timeouts on `judiciary`) and matches on
/// tokens rather than the exact value.
fn keyword_match(field: &str, value: impl Into<String>) -> Condition {
    Condition::matches(field.to_string(), qdrant_client::qdrant::r#match::MatchValue::Keyword(value.into()))
}

/// Match an Act/SL by file or name: `.pdf`/`.md` stems (and `act_name` when
/// `with_act_name`), under both apostrophe spellings.
pub fn act_name_filter(name: &str, with_act_name: bool) -> Filter {
    let stem = name.trim_end_matches(".pdf").trim_end_matches(".md");
    let mut conds = Vec::new();
    for v in apostrophe_variants(stem) {
        conds.push(keyword_match("source_file", format!("{}.pdf", v)));
        conds.push(keyword_match("source_file", format!("{}.md", v)));
        if with_act_name {
            conds.push(keyword_match("act_name", v));
        }
    }
    Filter::should(conds)
}

/// `name` plus its straight/typographic apostrophe counterpart (deduplicated).
pub fn apostrophe_variants(name: &str) -> Vec<String> {
    let straight = name.replace(['\u{2019}', '\u{2018}'], "'");
    let curly = straight.replace('\'', "\u{2019}");
    let mut out = vec![name.to_string()];
    for v in [straight, curly] {
        if !out.contains(&v) {
            out.push(v);
        }
    }
    out
}

pub const GET_SECTION_WINDOW_TOKENS: usize = 20_000;
/// Window for reads made directly by the orchestrator, whose context also holds
/// every sub-agent's findings.
pub const ORCHESTRATOR_READ_WINDOW_TOKENS: usize = 8_000;

/// Choose how many whole parts (starting at index 0 of `texts`) fit in `cap`
/// tokens. Always takes at least one part, so a single oversized chunk is still
/// returned instead of stalling. Returns `(parts_taken, tokens_in_window)`.
/// Counting stops as soon as the next part would overflow.
pub fn plan_window(texts: &[String], cap: usize, count: impl Fn(&str) -> usize) -> (usize, usize) {
    let mut total = 0usize;
    let mut taken = 0usize;
    for t in texts {
        let n = count(t);
        if taken > 0 && total + n > cap {
            break;
        }
        total += n;
        taken += 1;
    }
    (taken, total)
}

/// Candidate `section_number` values for an id the model supplied. Ids are
/// stored as `s19` for numbered sections but verbatim for schedules and
/// appendices (`schedule3`, `legislative_history`), and the model may drop or
/// keep the `s`, so try the id as given and with an `s` prefix.
pub fn section_id_candidates(section_id: &str) -> Vec<String> {
    let id = section_id.trim();
    let mut out = vec![id.to_string()];
    let prefixed = format!("s{}", id);
    if !out.contains(&prefixed) {
        out.push(prefixed);
    }
    out
}

/// Strip a leading `s` only when it is the numbered-section prefix (`s19`,
/// `s2D`), i.e. followed by a digit. `schedule3` and `legislative_history` are
/// returned unchanged.
pub fn strip_section_s_prefix(id: &str) -> &str {
    match id.strip_prefix('s') {
        Some(rest) if rest.chars().next().is_some_and(|c| c.is_ascii_digit()) => rest,
        _ => id,
    }
}

/// Read section identifier from payload (`section_number` preferred, else `section_id`).
/// Ids that are not numbered sections (`s15`, `15A`): schedules, appendices,
/// tables. Only these can have `<id>_part…` sibling points.
pub fn is_schedule_like_id(id: &str) -> bool {
    let id = id.trim();
    let mut chars = id.chars();
    match chars.next() {
        None => false,
        Some(c) if c.is_ascii_digit() => false,
        Some('s') | Some('S') => !chars.next().is_some_and(|c| c.is_ascii_digit()),
        Some(_) => true,
    }
}

pub fn payload_section_id(p: &QdrantPayload) -> String {
    for key in ["section_number", "section_id"] {
        if let Some(s) = p
            .get(key)
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            return s.to_string();
        }
    }
    String::new()
}

fn strip_section_payload_keys(obj: &mut serde_json::Map<String, serde_json::Value>) {
    obj.remove("text");
    obj.remove("section_number");
    obj.remove("section_id");
}

/// Qdrant conditions: each section matches `section_number` OR legacy `section_id`.
fn section_id_conditions(section_nums: &[String]) -> Vec<Condition> {
    section_nums
        .iter()
        .map(|n| {
            let sid = format!("s{}", n);
            Condition::from(Filter::should([
                keyword_match("section_number", sid.clone()),
                keyword_match("section_id", sid),
            ]))
        })
        .collect()
}

/// Deterministic UUID v5 (namespace: nil UUID).
pub fn point_uuid(section_id: &str) -> Uuid {
    Uuid::new_v5(&Uuid::nil(), section_id.as_bytes())
}

/// Extract bare section numbers from query text (matches Python `_extract_section_ids`).
/// Returns values like `["4", "48H"]` for payload field `section_number`.
pub fn extract_section_ids(text: &str) -> Vec<String> {
    use std::collections::HashSet;
    let anchor_re = regex::Regex::new(r"(?i)sections?\s+").unwrap();
    let sec_id_re = regex::Regex::new(r"(?i)^(\d+[A-Za-z]*)").unwrap();
    let sep_re = regex::Regex::new(r"(?i)\s*(?:,\s*|\s+and\s+|\s+&\s+|\s+or\s+)").unwrap();
    let s_shorthand = regex::Regex::new(r"(?i)(?:^|\s)s(\d+[A-Za-z]*)\b").unwrap();

    let mut seen = HashSet::new();
    let mut result = Vec::new();
    let mut add = |raw: &str| {
        if raw.is_empty() {
            return;
        }
        let norm = if raw.chars().last().is_some_and(|c| c.is_ascii_alphabetic()) {
            raw.to_uppercase()
        } else {
            raw.to_string()
        };
        if seen.insert(norm.clone()) {
            result.push(norm);
        }
    };

    for anchor in anchor_re.find_iter(text) {
        let mut pos = anchor.end();
        while pos < text.len() {
            let Some(m) = sec_id_re.captures(&text[pos..]) else {
                break;
            };
            add(&m[1]);
            pos += m.get(0).unwrap().end();
            if let Some(sep) = sep_re.captures(&text[pos..]) {
                pos += sep.get(0).unwrap().end();
            } else {
                break;
            }
        }
    }
    for cap in s_shorthand.captures_iter(text) {
        add(&cap[1]);
    }
    result
}

/// Normalize RAG text.
pub fn normalize_rag_text(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut last_ws = false;
    let mut nl: usize = 0;
    for ch in text.chars() {
        match ch {
            ' ' | '\t' | '\r' => {
                if !last_ws {
                    result.push(' ');
                    last_ws = true;
                }
                nl = 0;
            }
            '\n' => {
                nl += 1;
                if nl <= 2 {
                    result.push('\n');
                }
                last_ws = false;
            }
            _ => {
                result.push(ch);
                last_ws = false;
                nl = 0;
            }
        }
    }
    result.trim().to_string()
}

#[cfg(test)]
mod tests {
    // Exact-match filters must stay keyword matches (see `keyword_match`).
    mod keyword_filter_tests {
        use super::super::*;
        use qdrant_client::qdrant::condition::ConditionOneOf;
        use qdrant_client::qdrant::r#match::MatchValue;

        fn match_values(f: &Filter) -> Vec<MatchValue> {
            let mut out = Vec::new();
            for c in f.should.iter().chain(f.must.iter()).chain(f.must_not.iter()) {
                match &c.condition_one_of {
                    Some(ConditionOneOf::Field(fc)) => {
                        if let Some(v) = fc.r#match.as_ref().and_then(|m| m.match_value.clone()) {
                            out.push(v);
                        }
                    }
                    Some(ConditionOneOf::Filter(inner)) => out.extend(match_values(inner)),
                    _ => {}
                }
            }
            out
        }

        fn assert_all_keyword(f: &Filter) {
            let vals = match_values(f);
            assert!(!vals.is_empty());
            for v in vals {
                assert!(matches!(v, MatchValue::Keyword(_)), "expected a keyword match, got {v:?}");
            }
        }

        #[test]
        fn act_names_with_spaces_are_keyword_matches() {
            assert_all_keyword(&act_name_filter("Employment Act 1968", true));
            assert_all_keyword(&act_name_filter("Women\u{2019}s Charter 1961.pdf", true));
        }

        #[test]
        fn case_scopes_with_spaces_are_keyword_matches() {
            assert_all_keyword(&judiciary_scope_filter("[2007] SGCA 53"));
            assert_all_keyword(&judiciary_scope_filter("Lek Gwee Noi v Humming Flowers & Gifts Pte Ltd"));
        }

        #[test]
        fn the_client_default_really_is_the_trap() {
            // Documents why `keyword_match` exists: a plain String with a space is a text match.
            let c = Condition::matches("act_name", "Employment Act 1968".to_string());
            let Some(ConditionOneOf::Field(fc)) = c.condition_one_of else { panic!() };
            assert!(matches!(fc.r#match.unwrap().match_value, Some(MatchValue::Text(_))));
        }
    }

    // ── Qdrant deadline ──
    mod deadline_tests {
        use super::super::*;
        use std::sync::Mutex;

        #[derive(Debug)]
        struct Boom;
        impl std::fmt::Display for Boom {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "boom")
            }
        }
        impl std::error::Error for Boom {}

        fn recording_db_sink() -> (DbSink, Arc<Mutex<Vec<u64>>>) {
            let seen = Arc::new(Mutex::new(Vec::new()));
            let s2 = Arc::clone(&seen);
            (Arc::new(move |s| s2.lock().unwrap().push(s)), seen)
        }

        #[tokio::test]
        async fn a_slow_call_fails_at_the_deadline_and_says_so() {
            let (sink, seen) = recording_db_sink();
            let started = std::time::Instant::now();
            let err = DB_SINK
                .scope(sink, async {
                    with_deadline(Duration::from_millis(50), async {
                        tokio::time::sleep(Duration::from_secs(5)).await;
                        Ok::<_, Boom>(1)
                    })
                    .await
                })
                .await
                .unwrap_err();
            assert!(started.elapsed() < Duration::from_secs(2), "did not stop at the deadline");
            assert!(err.downcast_ref::<QdrantTimeout>().is_some());
            assert!(is_db_timeout(&format!("{err:#}")));
            assert!(is_db_timeout(&format!("{:#}", err.context("Semantic search failed"))));
            assert_eq!(*seen.lock().unwrap(), vec![1]); // 50 ms rounds up to 1 s
        }

        #[tokio::test]
        async fn success_clears_and_other_errors_are_not_timeouts() {
            let (sink, seen) = recording_db_sink();
            DB_SINK
                .scope(sink, async {
                    let v = with_deadline(Duration::from_secs(1), async { Ok::<_, Boom>(7) }).await.unwrap();
                    assert_eq!(v, 7);
                    let e = with_deadline(Duration::from_secs(1), async { Err::<(), _>(Boom) }).await.unwrap_err();
                    assert!(!is_db_timeout(&format!("{e:#}")));
                })
                .await;
            // Only the success reports; a plain error says nothing about the database being slow.
            assert_eq!(*seen.lock().unwrap(), vec![0]);
        }

        #[tokio::test]
        async fn works_without_a_sink() {
            let r = with_deadline(Duration::from_millis(20), std::future::pending::<Result<(), Boom>>()).await;
            assert!(r.is_err());
        }

        #[tokio::test]
        async fn the_db_sink_survives_a_spawn() {
            let (sink, _) = recording_db_sink();
            let inside = DB_SINK
                .scope(sink, async {
                    spawn_with_queue_sink(async { DB_SINK.try_with(|_| ()).is_ok() }).await.unwrap()
                })
                .await;
            assert!(inside, "spawned task lost the db sink");
        }
    }

    // ── Rerank queue notices ──
    mod queue_tests {
        use super::super::*;
        use std::sync::Mutex;

        fn recording_sink() -> (QueueSink, Arc<Mutex<Vec<QueueInfo>>>) {
            let seen = Arc::new(Mutex::new(Vec::new()));
            let s2 = Arc::clone(&seen);
            (Arc::new(move |q| s2.lock().unwrap().push(q)), seen)
        }

        #[test]
        fn eta_scales_with_queue_length_and_capacity() {
            let q = RerankQueue::default();
            q.waiting.store(0, Ordering::Relaxed);
            assert_eq!(q.info(4), QueueInfo { waiting: 0, eta_s: 1 }); // default 600 ms, rounded up
            q.record_call_ms(1000);
            q.waiting.store(9, Ordering::Relaxed); // 3 turnovers of 4 slots, then its own call
            assert_eq!(q.info(4), QueueInfo { waiting: 9, eta_s: 4 });
            q.waiting.store(4, Ordering::Relaxed);
            assert_eq!(q.info(4).eta_s, 2);
        }

        #[test]
        fn average_follows_recent_calls() {
            let q = RerankQueue::default();
            q.record_call_ms(1000);
            for _ in 0..30 {
                q.record_call_ms(200);
            }
            assert!(q.ewma_ms.load(Ordering::Relaxed) < 260);
        }

        #[tokio::test]
        async fn the_sink_survives_a_spawn() {
            let (sink, _seen) = recording_sink();
            let inside = QUEUE_SINK
                .scope(sink, async {
                    spawn_with_queue_sink(async { QUEUE_SINK.try_with(|_| ()).is_ok() }).await.unwrap()
                })
                .await;
            assert!(inside, "spawned task lost the queue sink");
            // And outside any scope it still just spawns.
            assert!(!spawn_with_queue_sink(async { QUEUE_SINK.try_with(|_| ()).is_ok() }).await.unwrap());
        }

        #[tokio::test]
        async fn a_free_slot_is_silent() {
            let sem = Semaphore::new(1);
            let q = RerankQueue::default();
            let (sink, seen) = recording_sink();
            let permit = QUEUE_SINK
                .scope(sink, acquire_with_queue_notice(&sem, &q, 1, Duration::from_millis(50), Duration::from_millis(20)))
                .await
                .unwrap();
            drop(permit);
            assert!(seen.lock().unwrap().is_empty());
            assert_eq!(q.waiting.load(Ordering::Relaxed), 0);
        }

        #[tokio::test]
        async fn a_long_wait_is_announced_then_cleared() {
            let sem = Arc::new(Semaphore::new(1));
            let q = Arc::new(RerankQueue::default());
            let held = sem.acquire().await.unwrap();
            let (sink, seen) = recording_sink();
            let (sem2, q2) = (Arc::clone(&sem), Arc::clone(&q));
            let waiter = tokio::spawn(QUEUE_SINK.scope(sink, async move {
                let _p = acquire_with_queue_notice(&sem2, &q2, 1, Duration::from_millis(30), Duration::from_millis(30))
                    .await
                    .unwrap();
            }));
            tokio::time::sleep(Duration::from_millis(150)).await;
            assert_eq!(q.waiting.load(Ordering::Relaxed), 1);
            drop(held);
            waiter.await.unwrap();
            let seen = seen.lock().unwrap();
            assert!(seen.len() >= 2, "expected announcements and a clear, got {seen:?}");
            assert!(seen[..seen.len() - 1].iter().all(|i| i.waiting == 1));
            assert_eq!(*seen.last().unwrap(), QueueInfo { waiting: 0, eta_s: 0 });
            assert_eq!(q.waiting.load(Ordering::Relaxed), 0);
        }

        #[tokio::test]
        async fn dropping_a_waiter_frees_its_place() {
            let sem = Arc::new(Semaphore::new(1));
            let q = Arc::new(RerankQueue::default());
            let _held = sem.acquire().await.unwrap();
            let (sem2, q2) = (Arc::clone(&sem), Arc::clone(&q));
            let waiter = tokio::spawn(async move {
                let _ = acquire_with_queue_notice(&sem2, &q2, 1, Duration::from_millis(30), Duration::from_millis(30)).await;
            });
            tokio::time::sleep(Duration::from_millis(80)).await;
            assert_eq!(q.waiting.load(Ordering::Relaxed), 1);
            waiter.abort();
            let _ = waiter.await;
            assert_eq!(q.waiting.load(Ordering::Relaxed), 0);
        }
    }

    #[test]
    fn apostrophe_variants_cover_both_spellings() {
        let v = super::apostrophe_variants("Women's Charter 1961");
        assert!(v.contains(&"Women's Charter 1961".to_string()));
        assert!(v.contains(&"Women\u{2019}s Charter 1961".to_string()));
        let v = super::apostrophe_variants("Women\u{2019}s Charter 1961");
        assert!(v.contains(&"Women's Charter 1961".to_string()));
        assert_eq!(super::apostrophe_variants("Civil Law Act 1909").len(), 1);
    }

    use super::*;
    use qdrant_client::qdrant::Value;
    use qdrant_client::qdrant::value::Kind;

    fn str_val(s: &str) -> Value {
        Value {
            kind: Some(Kind::StringValue(s.to_string())),
        }
    }

    fn payload(entries: &[(&str, &str)]) -> QdrantPayload {
        entries
            .iter()
            .map(|(k, v)| (k.to_string(), str_val(v)))
            .collect()
    }

    fn scored(id: &str, src: &str, text: &str) -> ScoredSection {
        ScoredSection {
            text: text.into(),
            score: 0.9,
            section_id: id.into(),
            metadata: serde_json::json!({"source_file": src}),
        }
    }

    #[test]
    fn rerank_key_depends_on_candidates_not_just_query() {
        let acts = vec![scored("s1", "A.md", "act text")];
        let sl = vec![scored("s1", "B.md", "sl text")];
        assert_ne!(rerank_cache_key("same query", &acts), rerank_cache_key("same query", &sl));
        assert_eq!(rerank_cache_key("q", &acts), rerank_cache_key("q", &acts));
        // Multi-byte query longer than 80 bytes must not panic.
        let _ = rerank_cache_key(&"é".repeat(100), &acts);
    }

    #[test]
    fn judgment_chunk_numbers() {
        assert_eq!(judgment_chunk_number("2019_SGHC_233_chunk4"), Some(4));
        assert_eq!(judgment_chunk_number("2019_SGHC_233_chunk0"), Some(0));
        assert_eq!(judgment_chunk_number("2019_SGHC_233_meta"), None);
    }

    #[test]
    fn neutral_citation_parsing() {
        assert_eq!(
            parse_neutral_citation("[2019] SGHC 233"),
            Some(("2019_SGHC_233".into(), "[2019] SGHC 233".into()))
        );
        assert_eq!(
            parse_neutral_citation("2019_sghc_233.pdf".trim_end_matches(".pdf")),
            Some(("2019_SGHC_233".into(), "[2019] SGHC 233".into()))
        );
        assert_eq!(parse_neutral_citation("Anita Damu v Public Prosecutor"), None);
    }

    #[test]
    fn judgment_prefix_is_stripped_but_body_untouched() {
        let topics = "[Evidence — Expert]; [Criminal Procedure]";
        let text = "[Evidence — Expert]\n[Criminal Procedure]\n\nLegislation: Evidence Act\n\n2 The question of relevance.\n\n[2019] SGHC 5 is cited.";
        assert_eq!(
            strip_judgment_prefix(text, topics),
            "2 The question of relevance.\n\n[2019] SGHC 5 is cited."
        );
        // No topic prefix: returned unchanged (a body line starting with '[' is not eaten).
        let body = "[2019] SGHC 5 is cited.\n\nMore.";
        assert_eq!(strip_judgment_prefix(body, topics), body);
    }

    #[test]
    fn schedule_like_ids() {
        for id in ["schedule2", "legislative_history", "comparative_table", "Schedule3"] {
            assert!(is_schedule_like_id(id), "{id}");
        }
        for id in ["15", "s15", "13A", "s2D", ""] {
            assert!(!is_schedule_like_id(id), "{id}");
        }
    }

    #[test]
    fn payload_section_id_prefers_section_number() {
        let p = payload(&[("section_number", "s8"), ("section_id", "s9")]);
        assert_eq!(payload_section_id(&p), "s8");
    }

    #[test]
    fn payload_section_id_falls_back_to_section_id() {
        let p = payload(&[("section_id", "s13A")]);
        assert_eq!(payload_section_id(&p), "s13A");
    }

    #[test]
    fn payload_serialises_to_plain_json_including_integers() {
        let mut p = payload(&[("doc_type", "act")]);
        p.insert(
            "chunk_index".into(),
            Value {
                kind: Some(Kind::IntegerValue(3)),
            },
        );
        let j = serde_json::to_value(&p).unwrap();
        assert_eq!(j.get("doc_type").and_then(|v| v.as_str()), Some("act"));
        assert_eq!(j.get("chunk_index").and_then(|v| v.as_i64()), Some(3));
        assert_eq!(p.get("chunk_index").and_then(|v| v.as_integer()), Some(3));
    }

    fn texts(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("part{i}")).collect()
    }

    #[test]
    fn plan_window_takes_whole_parts_up_to_cap() {
        // every part costs 10 tokens; cap 35 fits 3 parts
        let (taken, tokens) = plan_window(&texts(10), 35, |_| 10);
        assert_eq!((taken, tokens), (3, 30));
    }

    #[test]
    fn plan_window_returns_everything_when_it_fits() {
        assert_eq!(plan_window(&texts(4), 100, |_| 10), (4, 40));
    }

    #[test]
    fn plan_window_always_takes_one_oversized_part() {
        assert_eq!(plan_window(&texts(3), 5, |_| 50), (1, 50));
    }

    #[test]
    fn plan_window_covers_more_than_128_parts_in_windows() {
        let all = texts(166);
        let mut start = 0;
        let mut seen = 0;
        while start < all.len() {
            let (taken, tokens) = plan_window(&all[start..], 20_000, |_| 1_000);
            assert!(tokens <= 20_000);
            seen += taken;
            start += taken;
        }
        assert_eq!(seen, 166);
    }

    #[test]
    fn section_id_candidates_cover_schedules_and_numbers() {
        assert_eq!(section_id_candidates("2D"), vec!["2D", "s2D"]);
        assert_eq!(section_id_candidates("s2D"), vec!["s2D", "ss2D"]);
        assert_eq!(section_id_candidates("schedule3"), vec!["schedule3", "sschedule3"]);
        assert_eq!(
            section_id_candidates("legislative_history"),
            vec!["legislative_history", "slegislative_history"]
        );
        // a model that stripped the leading s off a schedule id still resolves
        assert!(section_id_candidates("chedule3").contains(&"schedule3".to_string()));
    }

    #[test]
    fn strip_s_prefix_only_for_numbered_sections() {
        assert_eq!(strip_section_s_prefix("s19"), "19");
        assert_eq!(strip_section_s_prefix("s2D"), "2D");
        assert_eq!(strip_section_s_prefix("schedule3"), "schedule3");
        assert_eq!(strip_section_s_prefix("legislative_history"), "legislative_history");
        assert_eq!(strip_section_s_prefix("19"), "19");
    }

    // ── Live checks against a real Qdrant (ignored by default) ──────────────
    // Run with: cargo test live_ -- --ignored --nocapture
    // QDRANT_LIVE_URL defaults to http://localhost:6334.

    async fn live_store() -> (QdrantStore, String, String) {
        let cfg: AppConfig = serde_json::from_value(serde_json::json!({})).unwrap();
        let url = std::env::var("QDRANT_LIVE_URL").unwrap_or_else(|_| "http://localhost:6334".into());
        let store = QdrantStore::new(&url, &cfg).await.expect("qdrant client");
        (store, cfg.qdrant_act_collection.clone(), cfg.qdrant_sl_collection.clone())
    }

    /// Page through a section with `part=` until the end; returns (parts_seen, windows).
    async fn read_all_parts(
        store: &QdrantStore,
        coll: &str,
        source: &str,
        id: &str,
    ) -> (usize, usize) {
        let mut next = 1usize;
        let (mut seen, mut windows) = (0usize, 0usize);
        loop {
            let s = store
                .get_section(coll, source, id, Some(next))
                .await
                .unwrap()
                .expect("section exists");
            let m = &s.metadata;
            let (from, to, total, tokens) = (
                m["part_from"].as_u64().unwrap() as usize,
                m["part_to"].as_u64().unwrap() as usize,
                m["chunk_total"].as_u64().unwrap() as usize,
                m["window_tokens"].as_u64().unwrap() as usize,
            );
            assert_eq!(from, next, "window must start where requested");
            assert!(to - from + 1 == 1 || tokens <= GET_SECTION_WINDOW_TOKENS, "{id}: {tokens} tokens");
            println!("{id}: parts {from}-{to} of {total}, {tokens} tokens");
            seen += to - from + 1;
            windows += 1;
            if to >= total {
                return (seen, windows);
            }
            next = to + 1;
        }
    }

    #[tokio::test]
    #[ignore = "needs a local Qdrant"]
    async fn live_small_split_sections_come_back_whole() {
        let (store, act, _) = live_store().await;
        let s = store
            .get_section(&act, "Legal Profession Act 1966", "2D", None)
            .await
            .unwrap()
            .expect("s2D");
        assert_eq!(s.metadata["chunk_total"], 2);
        assert_eq!(s.metadata["complete"], true);
        assert!(s.text.contains("2D.—(1)"), "first part present");
        assert!(s.text.contains("(13) Any document"), "second part present");

        let sched = store
            .get_section(&act, "Employment Act 1968", "schedule3", None)
            .await
            .unwrap()
            .expect("schedule3 resolves with its id verbatim");
        assert_eq!(sched.metadata["chunk_total"], 2);
        assert_eq!(sched.metadata["complete"], true);
        // the model may also strip the leading s
        assert!(
            store
                .get_section(&act, "Employment Act 1968", "chedule3", None)
                .await
                .unwrap()
                .is_some()
        );
        assert_eq!(
            store.count_section_parts(&act, "Employment Act 1968.md", "schedule3").await,
            Some(2)
        );
    }

    #[tokio::test]
    #[ignore = "needs a local Qdrant"]
    async fn live_appendix_ids_are_not_prefixed_with_s() {
        let (store, act, _) = live_store().await;
        let s = store
            .get_section(&act, "Public Utilities Act 2001", "legislative_history", None)
            .await
            .unwrap();
        assert!(s.is_some(), "legislative_history must resolve");
    }

    #[tokio::test]
    #[ignore = "needs a local Qdrant"]
    async fn live_large_sections_are_paged_without_loss() {
        let (store, act, sl) = live_store().await;
        let (seen, windows) =
            read_all_parts(&store, &act, "Criminal Procedure Code 2010", "schedule1").await;
        assert_eq!(seen, 42);
        assert!(windows > 1, "42 parts must not fit in one 20k-token window");

        // 166 parts: more than the old single 128-point scroll could return.
        let (seen, _) = read_all_parts(
            &store,
            &sl,
            "Strategic Goods (Control) Order 2025 [S 660_2025]",
            "schedule_part2",
        )
        .await;
        assert_eq!(seen, 166);
    }
}
