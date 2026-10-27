//! Abuse limits for the public, anonymous chat endpoint.
//!
//! Everything here is enforced server-side, per request, because the client
//! owns the conversation history and cannot be trusted. State is in-memory and
//! therefore per-replica (use an edge rate limit for multi-replica deployments).

use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::http::{HeaderMap, StatusCode};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::models::schemas::ChatRequest;

pub const MODES: [&str; 3] = ["legislation", "judiciary", "self-help"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustProxy {
    None,
    Cloudflare,
    Xff,
}

#[derive(Debug, Clone, Serialize)]
pub struct Limits {
    pub body_bytes: usize,
    pub message_chars: usize,
    pub assistant_chars: usize,
    pub max_messages: usize,
    pub context_tokens: usize,
    pub summary_chars: usize,
    pub rate_per_min: f64,
    pub rate_burst: f64,
    pub ip_concurrency: usize,
    pub global_concurrency: usize,
    pub repeat_max: usize,
    pub repeat_window_s: u64,
    pub daily_token_budget: u64,
    pub tool_rounds: i64,
    pub request_timeout_s: u64,
    pub model_window: i64,
    pub final_check: bool,
    pub tool_nudge: bool,
    /// Tool-endpoint limits (`POST /api/tool`). Internal: not exposed by `/api/limits`.
    #[serde(skip)]
    pub tool_rate_per_min: f64,
    #[serde(skip)]
    pub tool_burst: f64,
    #[serde(skip)]
    pub tool_ip_concurrency: usize,
    #[serde(skip)]
    pub tool_global_concurrency: usize,
    /// Per verified session (not per IP): sustained tool calls a minute, burst, and the
    /// most paid web searches one session may run.
    #[serde(skip)]
    pub session_tool_rate_per_min: f64,
    #[serde(skip)]
    pub session_tool_burst: f64,
    #[serde(skip)]
    pub session_web_searches: u32,
    #[serde(skip)]
    pub trust_proxy: TrustProxy,
}

fn env<T: std::str::FromStr>(key: &str, default: T) -> T {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

impl Limits {
    pub fn from_env() -> Self {
        let trust_proxy = match std::env::var("TRUST_PROXY").unwrap_or_default().as_str() {
            "cf" => TrustProxy::Cloudflare,
            "xff" => TrustProxy::Xff,
            _ => TrustProxy::None,
        };
        Self {
            body_bytes: env("LIMIT_BODY_BYTES", 1024 * 1024),
            message_chars: env("LIMIT_MESSAGE_CHARS", 200_000),
            assistant_chars: env("LIMIT_ASSISTANT_CHARS", 16000),
            max_messages: env("LIMIT_MAX_MESSAGES", 200),
            // Hard cap on estimated input tokens (older turns are dropped past this).
            context_tokens: env("LIMIT_CONTEXT_TOKENS", 140_000),
            summary_chars: env("LIMIT_SUMMARY_CHARS", 16_000),
            rate_per_min: env("LIMIT_RATE_PER_MIN", 8.0),
            rate_burst: env("LIMIT_RATE_BURST", 4.0),
            ip_concurrency: env("LIMIT_IP_CONCURRENCY", 1),
            global_concurrency: env("LIMIT_GLOBAL_CONCURRENCY", 50),
            repeat_max: env("LIMIT_REPEAT_MAX", 3),
            repeat_window_s: env("LIMIT_REPEAT_WINDOW_S", 60),
            daily_token_budget: env("LIMIT_DAILY_TOKEN_BUDGET", 5_000_000),
            tool_rounds: env("LIMIT_TOOL_ROUNDS", 10),
            request_timeout_s: env("LIMIT_REQUEST_TIMEOUT_S", 180),
            model_window: env("LIMIT_MODEL_WINDOW", 200_000),
            final_check: env("LIMIT_FINAL_CHECK", 0u8) != 0,
            tool_nudge: env("LIMIT_TOOL_NUDGE", 1u8) != 0,
            // One research turn fans out into many searches and reads, so these are far
            // looser than the chat limits, but still per IP.
            tool_rate_per_min: env("LIMIT_TOOL_RATE_PER_MIN", 240.0),
            tool_burst: env("LIMIT_TOOL_BURST", 60.0),
            tool_ip_concurrency: env("LIMIT_TOOL_IP_CONCURRENCY", 12),
            tool_global_concurrency: env("LIMIT_TOOL_GLOBAL_CONCURRENCY", 500),
            session_tool_rate_per_min: env("LIMIT_SESSION_TOOL_RATE_PER_MIN", 120.0),
            session_tool_burst: env("LIMIT_SESSION_TOOL_BURST", 40.0),
            session_web_searches: env("LIMIT_SESSION_WEB_SEARCHES", 20),
            trust_proxy,
        }
    }
}

/// A rejected request: HTTP status plus a human-readable, non-leaky message.
#[derive(Debug, Clone)]
pub struct Reject {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    pub retry_after: Option<u64>,
}

impl Reject {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self { status, code, message: message.into(), retry_after: None }
    }
    fn retry(mut self, secs: u64) -> Self {
        self.retry_after = Some(secs.max(1));
        self
    }
}

struct Bucket {
    tokens: f64,
    last: Instant,
}

#[derive(Default)]
struct Inner {
    buckets: HashMap<IpAddr, Bucket>,
    active: HashMap<IpAddr, usize>,
    repeats: HashMap<(IpAddr, u64), VecDeque<Instant>>,
    day: i64,
    tokens_used: u64,
}

pub struct Guard {
    pub limits: Limits,
    inner: Mutex<Inner>,
    /// Daily spend of the whole app (all replicas), when Redis is configured.
    shared: std::sync::OnceLock<Arc<crate::shared_budget::SharedBudget>>,
    global_active: AtomicUsize,
    /// Limiter for the stateless tool endpoint (separate from the one-stream-per-IP chat rule).
    pub tools: Arc<ToolGuard>,
}

/// Held for the lifetime of a generation; releases concurrency slots on drop.
pub struct Permit {
    guard: Arc<Guard>,
    ip: IpAddr,
}

impl Drop for Permit {
    fn drop(&mut self) {
        self.guard.global_active.fetch_sub(1, Ordering::SeqCst);
        if let Ok(mut inner) = self.guard.inner.lock()
            && let Some(n) = inner.active.get_mut(&self.ip)
        {
            *n = n.saturating_sub(1);
            if *n == 0 {
                inner.active.remove(&self.ip);
            }
        }
    }
}

/// The budget day rolls over at 06:00 Singapore time (UTC+8), which is 22:00 UTC.
const RESET_SHIFT_S: i64 = 2 * 3600;

/// Budget day number for a Unix timestamp: it changes at 22:00 UTC (06:00 in Singapore).
pub fn day_index(unix_s: i64) -> i64 {
    (unix_s + RESET_SHIFT_S).div_euclid(86_400)
}

/// Seconds from `unix_s` until the budget next resets (always 1..=86400).
pub fn seconds_until_reset(unix_s: i64) -> u64 {
    (86_400 - (unix_s + RESET_SHIFT_S).rem_euclid(86_400)) as u64
}

pub fn today() -> i64 {
    day_index(chrono::Utc::now().timestamp())
}

const MAX_TRACKED: usize = 20_000;

/// The process-wide guard, so code far from the request handlers (sub-agents) can charge the
/// daily budget. Unset in unit tests, where charging is a no-op.
static BUDGET_SINK: std::sync::OnceLock<Arc<Guard>> = std::sync::OnceLock::new();

pub fn register_budget_sink(g: &Arc<Guard>) {
    let _ = BUDGET_SINK.set(Arc::clone(g));
}

/// Charge `n` provider tokens to today's budget.
pub fn charge_budget(n: u64) {
    if let Some(g) = BUDGET_SINK.get() {
        g.record_tokens(n);
    }
}

impl Guard {
    pub fn new(limits: Limits) -> Arc<Self> {
        Arc::new(Self {
            tools: ToolGuard::new(&limits),
            limits,
            inner: Mutex::new(Inner { day: today(), ..Default::default() }),
            shared: std::sync::OnceLock::new(),
            global_active: AtomicUsize::new(0),
        })
    }

    /// Make the daily budget cover every replica by sharing it through Redis.
    pub fn attach_shared_budget(&self, shared: Arc<crate::shared_budget::SharedBudget>) {
        let _ = self.shared.set(shared);
    }

    /// Tokens used today: this replica's own count, or the app-wide total if that is larger.
    fn effective_used(&self, own: u64) -> u64 {
        self.shared.get().map_or(own, |s| own.max(s.used(today())))
    }

    pub fn active(&self) -> usize {
        self.global_active.load(Ordering::SeqCst)
    }

    /// Record real token usage against the daily budget.
    pub fn record_tokens(&self, n: u64) {
        if let Ok(mut inner) = self.inner.lock() {
            roll_day(&mut inner);
            inner.tokens_used = inner.tokens_used.saturating_add(n);
        }
        if let Some(s) = self.shared.get() {
            s.add(today(), n);
        }
    }

    pub fn tokens_used_today(&self) -> u64 {
        let own = self.inner.lock().map(|i| i.tokens_used).unwrap_or(0);
        self.effective_used(own)
    }

    /// Admit a request or explain why not. Order: budget, spam repeat, rate, concurrency.
    pub fn admit(self: &Arc<Self>, ip: IpAddr, message: &str) -> Result<Permit, Reject> {
        let l = &self.limits;
        let mut inner = self.inner.lock().map_err(|_| {
            Reject::new(StatusCode::SERVICE_UNAVAILABLE, "unavailable", "Service is busy. Please try again shortly.")
        })?;
        roll_day(&mut inner);
        let now = Instant::now();

        if self.effective_used(inner.tokens_used) >= l.daily_token_budget {
            return Err(Reject::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "budget_exhausted",
                "The shared service has reached its daily usage limit. It resets at 6:00 am Singapore time. \
                 To keep going now, add your own API key under Settings > Your own API key.",
            )
            .retry(seconds_until_reset(chrono::Utc::now().timestamp()).min(3600)));
        }

        if inner.buckets.len() > MAX_TRACKED {
            inner.buckets.retain(|_, b| now.duration_since(b.last) < Duration::from_secs(600));
            if inner.buckets.len() > MAX_TRACKED && !inner.buckets.contains_key(&ip) {
                // Still over the ceiling after evicting stale entries: an address-rotating
                // client. Fail closed for new addresses instead of growing without bound.
                return Err(Reject::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "busy",
                    "The service is very busy right now. Please try again in a moment.",
                )
                .retry(10));
            }
        }
        if inner.repeats.len() > MAX_TRACKED {
            inner.repeats.clear();
        }

        // Identical-message spam ("hi" x 100).
        let window = Duration::from_secs(l.repeat_window_s);
        let key = (ip, hash_message(message));
        let q = inner.repeats.entry(key).or_default();
        while q.front().is_some_and(|t| now.duration_since(*t) > window) {
            q.pop_front();
        }
        if q.len() >= l.repeat_max {
            let wait = q.front().map(|t| window.saturating_sub(now.duration_since(*t)).as_secs() + 1).unwrap_or(1);
            return Err(Reject::new(
                StatusCode::TOO_MANY_REQUESTS,
                "repeated_message",
                format!("You've sent the same message several times. Please wait {wait}s or say something different."),
            )
            .retry(wait));
        }

        // Token bucket per IP.
        let per_sec = l.rate_per_min / 60.0;
        let b = inner.buckets.entry(ip).or_insert(Bucket { tokens: l.rate_burst, last: now });
        let elapsed = now.duration_since(b.last).as_secs_f64();
        b.tokens = (b.tokens + elapsed * per_sec).min(l.rate_burst);
        b.last = now;
        if b.tokens < 1.0 {
            let wait = ((1.0 - b.tokens) / per_sec).ceil() as u64;
            return Err(Reject::new(
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                format!("You're sending messages too quickly. Please wait {wait}s and try again."),
            )
            .retry(wait));
        }

        // Concurrency (checked before consuming anything further).
        let ip_active = inner.active.get(&ip).copied().unwrap_or(0);
        if ip_active >= l.ip_concurrency {
            return Err(Reject::new(
                StatusCode::TOO_MANY_REQUESTS,
                "too_many_streams",
                "A reply is already being generated. Please wait for it to finish.",
            )
            .retry(5));
        }
        if self.global_active.load(Ordering::SeqCst) >= l.global_concurrency {
            return Err(Reject::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "busy",
                "The service is very busy right now. Please try again in a moment.",
            )
            .retry(10));
        }

        // Commit.
        if let Some(b) = inner.buckets.get_mut(&ip) {
            b.tokens -= 1.0;
        }
        if let Some(q) = inner.repeats.get_mut(&key) {
            q.push_back(now);
        }
        *inner.active.entry(ip).or_insert(0) += 1;
        self.global_active.fetch_add(1, Ordering::SeqCst);
        Ok(Permit { guard: Arc::clone(self), ip })
    }
}

/// Hard ceiling on tracked client IPs for the tool limiter. A bucket that has refilled to
/// full is identical to no bucket, so those are evicted first without loosening any limit;
/// if an address-rotating client still pushes past the ceiling, *new* addresses are refused
/// (fail closed) rather than letting memory grow without bound.
const TOOL_MAX_TRACKED: usize = 50_000;

/// Most verified sessions tracked at once; past this, unknown sessions are refused.
const SESSION_MAX_TRACKED: usize = 50_000;
/// A session entry idle this long is forgotten (sessions live 30 minutes by default).
const SESSION_IDLE_FORGET: Duration = Duration::from_secs(3600);

struct SessionUse {
    bucket: Bucket,
    web_searches: u32,
}

#[derive(Default)]
struct ToolInner {
    buckets: HashMap<IpAddr, Bucket>,
    active: HashMap<IpAddr, usize>,
}

/// Per-IP token bucket, per-IP and global in-flight caps for `POST /api/tool`.
pub struct ToolGuard {
    rate_per_min: f64,
    burst: f64,
    ip_concurrency: usize,
    global_concurrency: usize,
    max_tracked: usize,
    inner: Mutex<ToolInner>,
    global_active: AtomicUsize,
    session_rate_per_min: f64,
    session_burst: f64,
    session_web_searches: u32,
    sessions: Mutex<HashMap<String, SessionUse>>,
}

/// Held while one tool call runs; releases its in-flight slots on drop.
pub struct ToolPermit {
    guard: Arc<ToolGuard>,
    ip: IpAddr,
}

impl Drop for ToolPermit {
    fn drop(&mut self) {
        self.guard.global_active.fetch_sub(1, Ordering::SeqCst);
        if let Ok(mut inner) = self.guard.inner.lock()
            && let Some(n) = inner.active.get_mut(&self.ip)
        {
            *n = n.saturating_sub(1);
            if *n == 0 {
                inner.active.remove(&self.ip);
            }
        }
    }
}

impl ToolGuard {
    pub fn new(l: &Limits) -> Arc<Self> {
        Arc::new(Self {
            rate_per_min: l.tool_rate_per_min,
            burst: l.tool_burst,
            ip_concurrency: l.tool_ip_concurrency,
            global_concurrency: l.tool_global_concurrency,
            max_tracked: TOOL_MAX_TRACKED,
            inner: Mutex::new(ToolInner::default()),
            global_active: AtomicUsize::new(0),
            session_rate_per_min: l.session_tool_rate_per_min,
            session_burst: l.session_tool_burst,
            session_web_searches: l.session_web_searches,
            sessions: Mutex::new(HashMap::new()),
        })
    }

    /// Admit one tool call for a request that may carry a verified session. The per-IP
    /// limits always apply; with a session id, the session's own rate and its web-search
    /// allowance apply too, so rotating IPs does not buy a verified session more calls.
    pub fn admit_session(self: &Arc<Self>, ip: IpAddr, session: Option<&str>, tool: &str) -> Result<ToolPermit, Reject> {
        let permit = self.admit(ip)?;
        if let Some(id) = session {
            self.charge_session(id, tool)?; // on refusal the permit drops and frees its slots
        }
        Ok(permit)
    }

    fn charge_session(&self, id: &str, tool: &str) -> Result<(), Reject> {
        let busy = || Reject::new(StatusCode::SERVICE_UNAVAILABLE, "busy", "The service is very busy right now. Please try again in a moment.").retry(10);
        let mut m = self.sessions.lock().map_err(|_| busy())?;
        let now = Instant::now();
        let per_sec = (self.session_rate_per_min / 60.0).max(f64::MIN_POSITIVE);
        if m.len() >= SESSION_MAX_TRACKED && !m.contains_key(id) {
            m.retain(|_, u| now.duration_since(u.bucket.last) < SESSION_IDLE_FORGET);
            if m.len() >= SESSION_MAX_TRACKED {
                return Err(busy());
            }
        }
        let u = m.entry(id.to_string()).or_insert(SessionUse { bucket: Bucket { tokens: self.session_burst, last: now }, web_searches: 0 });
        let tokens = (u.bucket.tokens + now.duration_since(u.bucket.last).as_secs_f64() * per_sec).min(self.session_burst);
        if tokens < 1.0 {
            let wait = ((1.0 - tokens) / per_sec).ceil() as u64;
            return Err(Reject::new(
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                format!("You're searching too quickly. Please wait {wait}s and try again."),
            )
            .retry(wait));
        }
        if tool == "web_search_tavily" {
            if u.web_searches >= self.session_web_searches {
                return Err(Reject::new(
                    StatusCode::TOO_MANY_REQUESTS,
                    "web_search_limit",
                    "This session has used its web searches. Start a new session to search the web again.",
                ));
            }
            u.web_searches += 1;
        }
        u.bucket = Bucket { tokens: tokens - 1.0, last: now };
        Ok(())
    }

    pub fn active(&self) -> usize {
        self.global_active.load(Ordering::SeqCst)
    }

    /// Admit one tool call or explain why not. Nothing is consumed on a refusal.
    pub fn admit(self: &Arc<Self>, ip: IpAddr) -> Result<ToolPermit, Reject> {
        let busy = || Reject::new(StatusCode::SERVICE_UNAVAILABLE, "busy", "The service is very busy right now. Please try again in a moment.").retry(10);
        let mut inner = self.inner.lock().map_err(|_| busy())?;
        let now = Instant::now();
        let per_sec = (self.rate_per_min / 60.0).max(f64::MIN_POSITIVE);

        if inner.buckets.len() >= self.max_tracked {
            let (burst, rate) = (self.burst, per_sec);
            inner.buckets.retain(|_, b| b.tokens + now.duration_since(b.last).as_secs_f64() * rate < burst);
            if inner.buckets.len() >= self.max_tracked && !inner.buckets.contains_key(&ip) {
                return Err(busy());
            }
        }

        // Look at the bucket without committing to it, so a later refusal costs nothing.
        let (tokens, last) = inner.buckets.get(&ip).map_or((self.burst, now), |b| (b.tokens, b.last));
        let tokens = (tokens + now.duration_since(last).as_secs_f64() * per_sec).min(self.burst);
        if tokens < 1.0 {
            let wait = ((1.0 - tokens) / per_sec).ceil() as u64;
            return Err(Reject::new(
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                format!("You're searching too quickly. Please wait {wait}s and try again."),
            )
            .retry(wait));
        }
        if inner.active.get(&ip).copied().unwrap_or(0) >= self.ip_concurrency {
            return Err(Reject::new(StatusCode::TOO_MANY_REQUESTS, "too_many_streams", "Too many searches are already running. Please wait for them to finish.").retry(2));
        }
        if self.global_active.load(Ordering::SeqCst) >= self.global_concurrency {
            // A tool call holds its slot for milliseconds, so the cap clears almost at once. Say 1s
            // (the smallest Retry-After there is), not the 10s that suits the table-full case.
            return Err(Reject::new(StatusCode::SERVICE_UNAVAILABLE, "busy", "The service is very busy right now. Please try again in a moment.").retry(1));
        }

        inner.buckets.insert(ip, Bucket { tokens: tokens - 1.0, last: now });
        *inner.active.entry(ip).or_insert(0) += 1;
        self.global_active.fetch_add(1, Ordering::SeqCst);
        Ok(ToolPermit { guard: Arc::clone(self), ip })
    }

    #[cfg(test)]
    fn tracked(&self) -> usize {
        self.inner.lock().unwrap().buckets.len()
    }
}

fn roll_day(inner: &mut Inner) {
    let d = today();
    if inner.day != d {
        inner.day = d;
        inner.tokens_used = 0;
    }
}

fn hash_message(m: &str) -> u64 {
    let norm: String = m.trim().to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ");
    let digest = Sha256::digest(norm.as_bytes());
    u64::from_le_bytes(digest[..8].try_into().unwrap_or([0; 8]))
}

/// Resolve the client IP. Forwarding headers are honoured only when explicitly trusted.
pub fn client_ip(headers: &HeaderMap, peer: SocketAddr, mode: TrustProxy) -> IpAddr {
    let parsed = match mode {
        TrustProxy::None => None,
        TrustProxy::Cloudflare => headers
            .get("cf-connecting-ip")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse().ok()),
        // The last entry is the one appended by our (trusted) proxy.
        TrustProxy::Xff => headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.rsplit(',').next())
            .and_then(|v| v.trim().parse().ok()),
    };
    normalize_ip(parsed.unwrap_or_else(|| peer.ip()))
}

/// Limits are per *network*, not per address: an IPv6 user owns a whole /64 (2^64 addresses),
/// so keying on the full address would let one client dodge every per-IP limit by rotating.
/// IPv4-mapped IPv6 addresses collapse to their IPv4 form.
pub fn normalize_ip(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V4(_) => ip,
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => {
                let mut o = v6.octets();
                o[8..].fill(0);
                IpAddr::V6(std::net::Ipv6Addr::from(o))
            }
        },
    }
}

/// True when the trusted-proxy header this deployment depends on is present and valid.
/// With `TRUST_PROXY=cf` a request without `CF-Connecting-IP` did not come through Cloudflare.
pub fn proxy_header_ok(headers: &HeaderMap, mode: TrustProxy) -> bool {
    match mode {
        TrustProxy::Cloudflare => headers
            .get("cf-connecting-ip")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.trim().parse::<IpAddr>().is_ok()),
        _ => true,
    }
}

/// Validate the shape and size of a chat request. Returns the normalized mode.
pub fn validate(req: &ChatRequest, l: &Limits) -> Result<String, Reject> {
    let bad = |code, msg: String| Reject::new(StatusCode::BAD_REQUEST, code, msg);
    let big = |code, msg: String| Reject::new(StatusCode::PAYLOAD_TOO_LARGE, code, msg);

    let mode = req.mode.clone().unwrap_or_else(|| "legislation".into());
    if !MODES.contains(&mode.as_str()) {
        return Err(bad("invalid_mode", "Unknown chat mode.".into()));
    }
    if req.messages.is_empty() {
        return Err(bad("empty", "Please enter a message.".into()));
    }
    if req.messages.len() > l.max_messages {
        return Err(big(
            "too_many_messages",
            format!("This conversation is too long (over {} messages). Please start a new chat.", l.max_messages),
        ));
    }
    if let Some(s) = &req.summary {
        if s.contains('\0') {
            return Err(bad("invalid_content", "Message contains invalid characters.".into()));
        }
        if s.chars().count() > l.summary_chars {
            return Err(big("summary_too_long", "The saved conversation summary is too long. Please start a new chat.".into()));
        }
    }
    for m in &req.messages {
        if m.role != "user" && m.role != "assistant" {
            return Err(bad("invalid_role", "Invalid message role.".into()));
        }
        if m.content.contains('\0') {
            return Err(bad("invalid_content", "Message contains invalid characters.".into()));
        }
        let max = if m.role == "user" { l.message_chars } else { l.assistant_chars };
        let n = m.content.chars().count();
        if n > max {
            return Err(big(
                "message_too_long",
                format!("Message is too long ({n} characters). The limit is {max} characters."),
            ));
        }
    }
    let last = &req.messages[req.messages.len() - 1];
    if last.role != "user" || last.content.trim().is_empty() {
        return Err(bad("empty", "Please enter a message.".into()));
    }
    Ok(mode)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::schemas::ClientMessage;

    fn lim() -> Limits {
        let mut l = Limits::from_env();
        l.rate_burst = 3.0;
        l.rate_per_min = 0.6;
        l.repeat_max = 100;
        l.ip_concurrency = 100;
        l
    }
    fn ip(n: u8) -> IpAddr {
        IpAddr::from([10, 0, 0, n])
    }

    #[test]
    fn spam_is_rate_limited() {
        let g = Guard::new(lim());
        let mut ok = 0;
        for i in 0..50 {
            if g.admit(ip(1), &format!("m{i}")).map(|p| drop(p)).is_ok() {
                ok += 1;
            }
        }
        assert_eq!(ok, 3);
        assert!(g.admit(ip(2), "other").is_ok(), "other IPs unaffected");
    }

    #[test]
    fn identical_repeats_cool_down() {
        let mut l = lim();
        l.rate_burst = 50.0;
        l.repeat_max = 3;
        let g = Guard::new(l);
        let mut codes = vec![];
        for _ in 0..6 {
            match g.admit(ip(1), "Hi") {
                Ok(p) => drop(p),
                Err(r) => codes.push(r.code),
            }
        }
        assert_eq!(codes, vec!["repeated_message"; 3]);
    }

    #[test]
    fn concurrency_slot_released_on_drop() {
        let mut l = lim();
        l.rate_burst = 50.0;
        l.ip_concurrency = 1;
        let g = Guard::new(l);
        let p = g.admit(ip(1), "a").unwrap();
        assert_eq!(g.admit(ip(1), "b").err().unwrap().code, "too_many_streams");
        drop(p);
        assert!(g.admit(ip(1), "c").is_ok());
    }

    #[test]
    fn budget_breaker() {
        let mut l = lim();
        l.daily_token_budget = 100;
        let g = Guard::new(l);
        g.record_tokens(100);
        assert_eq!(g.admit(ip(1), "a").err().unwrap().code, "budget_exhausted");
    }

    #[test]
    fn spoofed_xff_ignored_by_default() {
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-for", "1.2.3.4".parse().unwrap());
        let peer: SocketAddr = "9.9.9.9:1".parse().unwrap();
        assert_eq!(client_ip(&h, peer, TrustProxy::None), peer.ip());
        assert_eq!(client_ip(&h, peer, TrustProxy::Xff).to_string(), "1.2.3.4");
    }

    fn req(role: &str, content: &str) -> ChatRequest {
        ChatRequest { messages: vec![ClientMessage { role: role.into(), content: content.into() }], mode: None, summary: None }
    }

    #[test]
    fn a_message_may_be_200k_characters() {
        let l = Limits::from_env();
        assert_eq!(l.message_chars, 200_000);
        assert!(validate(&req("user", &"a".repeat(200_000)), &l).is_ok());
        assert_eq!(validate(&req("user", &"a".repeat(200_001)), &l).err().unwrap().code, "message_too_long");
        // The default body cap leaves room for such a message even when every character is 4 bytes of UTF-8.
        assert!(l.body_bytes >= 200_000 * 4);
    }

    #[test]
    fn validation_rules() {
        let l = Limits::from_env();
        assert!(validate(&req("user", "hello"), &l).is_ok());
        assert_eq!(validate(&req("system", "x"), &l).err().unwrap().code, "invalid_role");
        assert_eq!(validate(&req("user", &"a".repeat(l.message_chars + 1)), &l).err().unwrap().status, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(validate(&req("user", "a\0b"), &l).err().unwrap().code, "invalid_content");
        assert_eq!(validate(&req("user", "   "), &l).err().unwrap().code, "empty");
        let many = ChatRequest {
            messages: (0..l.max_messages + 1).map(|_| ClientMessage { role: "user".into(), content: "x".into() }).collect(),
            mode: None,
            summary: None,
        };
        assert_eq!(validate(&many, &l).err().unwrap().code, "too_many_messages");
    }

    // ── Drop / ownership tests ──────────────────────────────────────────────
    //
    // These are written to run under Miri as well as plain `cargo test`
    // (`make server-miri`). They check that a `Permit` gives back *everything*
    // it took (global counter, per-IP entry, the `Arc<Guard>` it holds) on every
    // exit path, and give Miri's data-race / leak / use-after-free detection
    // something real to chew on.

    /// Limits that never reject on rate, repeat or concurrency, so a test only
    /// exercises slot accounting.
    fn open() -> Limits {
        let mut l = lim();
        l.rate_burst = 1e9;
        l.rate_per_min = 1e9;
        l.repeat_max = usize::MAX;
        l.ip_concurrency = usize::MAX;
        l.global_concurrency = usize::MAX;
        l
    }

    /// Nothing is held: counters are zero, the per-IP map is empty and no
    /// `Permit` (each holds an `Arc<Guard>`) is still alive.
    fn assert_fully_released(g: &Arc<Guard>) {
        assert_eq!(g.active(), 0, "global slot leaked");
        assert!(g.inner.lock().unwrap().active.is_empty(), "per-IP entry leaked");
        assert_eq!(Arc::strong_count(g), 1, "a Permit (or its Arc<Guard>) leaked");
    }

    #[test]
    fn drop_releases_every_slot_and_the_guard_arc() {
        let g = Guard::new(open());
        let a = g.admit(ip(1), "a").unwrap();
        let b = g.admit(ip(1), "b").unwrap();
        let c = g.admit(ip(2), "c").unwrap();
        assert_eq!(g.active(), 3);
        assert_eq!(Arc::strong_count(&g), 4, "each Permit holds the Guard alive");
        drop(b);
        assert_eq!(g.active(), 2);
        assert_eq!(g.inner.lock().unwrap().active[&ip(1)], 1);
        drop((a, c));
        assert_fully_released(&g);
    }

    #[test]
    fn rejected_admissions_hold_nothing() {
        let mut l = open();
        l.ip_concurrency = 1;
        let g = Guard::new(l);
        let p = g.admit(ip(1), "a").unwrap();
        for i in 0..5 {
            assert!(g.admit(ip(1), &format!("x{i}")).is_err());
        }
        // Only the one real permit exists: rejections must not leak slots or Arcs.
        assert_eq!(g.active(), 1);
        assert_eq!(Arc::strong_count(&g), 2);
        drop(p);
        assert_fully_released(&g);
    }

    #[test]
    fn permit_released_when_the_holder_panics() {
        let g = Guard::new(open());
        let held = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _p = g.admit(ip(1), "a").unwrap();
            panic!("handler blew up mid-stream");
        }));
        assert!(held.is_err());
        assert_fully_released(&g);
    }

    #[test]
    fn permit_can_be_dropped_on_another_thread() {
        let g = Guard::new(open());
        let p = g.admit(ip(1), "a").unwrap();
        std::thread::spawn(move || drop(p)).join().unwrap();
        assert_fully_released(&g);
    }

    #[test]
    fn dropping_with_a_poisoned_lock_does_not_panic_or_leak_the_global_slot() {
        let g = Guard::new(open());
        let p = g.admit(ip(1), "a").unwrap();
        // Poison the mutex the way a panicking request thread would.
        let g2 = Arc::clone(&g);
        let _ = std::thread::spawn(move || {
            let _held = g2.inner.lock().unwrap();
            panic!("poison");
        })
        .join();
        assert!(g.inner.lock().is_err(), "setup: lock should be poisoned");
        // A panic inside Drop while already unwinding would abort the process.
        drop(p);
        assert_eq!(g.active(), 0, "the global slot is an atomic and must still be released");
        // Every later request gets a clean 503 rather than a panic.
        assert_eq!(g.admit(ip(1), "b").err().unwrap().status, StatusCode::SERVICE_UNAVAILABLE);
    }

    #[test]
    fn concurrent_admit_and_drop_ends_with_nothing_held() {
        let (threads, rounds) = if cfg!(miri) { (3, 4) } else { (8, 500) };
        let g = Guard::new(open());
        let handles: Vec<_> = (0..threads)
            .map(|t| {
                let g = Arc::clone(&g);
                std::thread::spawn(move || {
                    for r in 0..rounds {
                        // Half the threads share one IP so the per-IP counter is contended.
                        let who = ip(if t % 2 == 0 { 1 } else { t as u8 + 10 });
                        let p = g.admit(who, &format!("{t}-{r}")).unwrap();
                        assert!(g.active() >= 1);
                        // Hand the permit to another thread half the time.
                        if r % 2 == 0 {
                            std::thread::spawn(move || drop(p)).join().unwrap();
                        } else {
                            drop(p);
                        }
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        assert_fully_released(&g);
    }

    #[test]
    fn global_cap_is_never_exceeded_under_contention() {
        let mut l = open();
        l.global_concurrency = 2;
        let (threads, rounds) = if cfg!(miri) { (3, 4) } else { (8, 200) };
        let g = Guard::new(l);
        let handles: Vec<_> = (0..threads)
            .map(|t| {
                let g = Arc::clone(&g);
                std::thread::spawn(move || {
                    for r in 0..rounds {
                        if let Ok(p) = g.admit(ip(t as u8 + 1), &format!("{t}-{r}")) {
                            // `admit` holds the lock across the check and the commit, so the cap holds.
                            assert!(g.active() <= 2, "cap exceeded: {}", g.active());
                            drop(p);
                        }
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        assert_fully_released(&g);
    }

    /// Address-rotating clients cannot grow `buckets` without bound: past the ceiling new
    /// addresses are refused (fail closed).
    #[test]
    fn tracked_ips_stay_bounded() {
        let g = Guard::new(open());
        for n in 0..(MAX_TRACKED as u32 + 500) {
            let who = IpAddr::from(n.to_be_bytes());
            let _ = g.admit(who, "hi");
        }
        let tracked = g.inner.lock().unwrap().buckets.len();
        assert!(tracked <= MAX_TRACKED + 1, "{tracked} buckets tracked");
    }

    #[test]
    fn ipv6_is_limited_per_slash_64() {
        let a: IpAddr = "2001:db8:1:2:aaaa:bbbb:cccc:dddd".parse().unwrap();
        let b: IpAddr = "2001:db8:1:2:1111:2222:3333:4444".parse().unwrap();
        let c: IpAddr = "2001:db8:1:3::1".parse().unwrap();
        assert_eq!(normalize_ip(a), normalize_ip(b));
        assert_ne!(normalize_ip(a), normalize_ip(c));
        let mapped: IpAddr = "::ffff:1.2.3.4".parse().unwrap();
        assert_eq!(normalize_ip(mapped), "1.2.3.4".parse::<IpAddr>().unwrap());
    }

    #[test]
    fn cf_mode_requires_the_header() {
        let mut h = HeaderMap::new();
        assert!(!proxy_header_ok(&h, TrustProxy::Cloudflare));
        h.insert("cf-connecting-ip", "1.2.3.4".parse().unwrap());
        assert!(proxy_header_ok(&h, TrustProxy::Cloudflare));
        assert!(proxy_header_ok(&HeaderMap::new(), TrustProxy::None));
    }

    // ---- tool endpoint limiter ----

    fn tool_limits(burst: f64, per_ip: usize, global: usize) -> Limits {
        let mut l = lim();
        l.tool_rate_per_min = 60.0; // one token a second
        l.tool_burst = burst;
        l.tool_ip_concurrency = per_ip;
        l.tool_global_concurrency = global;
        l
    }

    fn assert_tools_released(g: &Arc<ToolGuard>) {
        assert_eq!(g.active(), 0, "global slot leaked");
        assert!(g.inner.lock().unwrap().active.is_empty(), "per-IP entry leaked");
        assert_eq!(Arc::strong_count(g), 1, "a ToolPermit leaked");
    }

    #[test]
    fn tool_bursts_then_rate_limits_per_ip() {
        let g = ToolGuard::new(&tool_limits(3.0, 100, 100));
        for _ in 0..3 {
            drop(g.admit(ip(1)).unwrap());
        }
        let r = g.admit(ip(1)).err().expect("fourth call in the burst window is refused");
        assert_eq!((r.status, r.code), (StatusCode::TOO_MANY_REQUESTS, "rate_limited"));
        assert!(r.retry_after.unwrap() >= 1);
        assert!(g.admit(ip(2)).is_ok(), "other IPs are unaffected");
        assert_tools_released(&g);
    }

    #[test]
    fn tool_tokens_refill_over_time() {
        let g = ToolGuard::new(&tool_limits(2.0, 100, 100));
        drop(g.admit(ip(1)).unwrap());
        drop(g.admit(ip(1)).unwrap());
        assert!(g.admit(ip(1)).is_err());
        // Pretend 5s passed: at one token a second the bucket is full again.
        let back = Instant::now().checked_sub(std::time::Duration::from_secs(5)).unwrap();
        g.inner.lock().unwrap().buckets.get_mut(&ip(1)).unwrap().last = back;
        drop(g.admit(ip(1)).unwrap());
        drop(g.admit(ip(1)).unwrap());
        assert!(g.admit(ip(1)).is_err(), "refill is capped at the burst size");
    }

    #[test]
    fn tool_concurrency_caps_hold_and_a_refusal_costs_nothing() {
        let g = ToolGuard::new(&tool_limits(100.0, 2, 3));
        let a = g.admit(ip(1)).unwrap();
        let b = g.admit(ip(1)).unwrap();
        let r = g.admit(ip(1)).err().expect("per-IP cap");
        assert_eq!(r.code, "too_many_streams");
        let tokens = g.inner.lock().unwrap().buckets[&ip(1)].tokens;
        assert!(g.admit(ip(1)).is_err());
        assert!(g.inner.lock().unwrap().buckets[&ip(1)].tokens >= tokens, "a refused call spent a token");
        let c = g.admit(ip(2)).unwrap();
        let r = g.admit(ip(3)).err().expect("global cap");
        assert_eq!(r.code, "busy");
        assert_eq!(r.retry_after, Some(1), "a slot frees in milliseconds, so do not make clients wait 10s");
        drop(a);
        let d = g.admit(ip(3)).expect("a freed slot is reusable");
        drop((b, c, d));
        assert_tools_released(&g);
    }

    #[test]
    fn tool_permit_released_when_the_holder_panics() {
        let g = ToolGuard::new(&tool_limits(100.0, 2, 2));
        let g2 = Arc::clone(&g);
        let r = std::thread::spawn(move || {
            let _p = g2.admit(ip(1)).unwrap();
            panic!("tool blew up");
        })
        .join();
        assert!(r.is_err());
        assert_tools_released(&g);
    }

    #[test]
    fn tool_tracking_is_bounded_without_loosening_any_limit() {
        let mut g = ToolGuard::new(&tool_limits(5.0, 100, 100));
        Arc::get_mut(&mut g).unwrap().max_tracked = 8;
        for n in 1..=8u8 {
            drop(g.admit(ip(n)).unwrap());
        }
        assert_eq!(g.tracked(), 8);
        // Every tracked client is still mid-bucket, so none can be forgotten: new addresses
        // are refused, and the ones we know keep their own limits.
        assert_eq!(g.admit(ip(99)).err().expect("full").code, "busy");
        assert_eq!(g.tracked(), 8);
        for _ in 0..4 {
            drop(g.admit(ip(1)).unwrap());
        }
        assert!(g.admit(ip(1)).is_err(), "a known client cannot reset itself by the table being full");
        // Once buckets have refilled they are indistinguishable from no bucket and are dropped.
        let back = Instant::now().checked_sub(std::time::Duration::from_secs(600)).unwrap();
        for b in g.inner.lock().unwrap().buckets.values_mut() {
            b.last = back;
        }
        drop(g.admit(ip(99)).expect("room again after eviction"));
        assert!(g.tracked() <= 8);
        assert_tools_released(&g);
    }

    #[test]
    fn tool_caps_are_never_exceeded_under_contention() {
        let (threads, rounds) = if cfg!(miri) { (3, 4) } else { (8, 200) };
        let g = ToolGuard::new(&tool_limits(1e9, 100, 2));
        let handles: Vec<_> = (0..threads)
            .map(|t| {
                let g = Arc::clone(&g);
                std::thread::spawn(move || {
                    for _ in 0..rounds {
                        if let Ok(p) = g.admit(ip(t as u8 + 1)) {
                            assert!(g.active() <= 2, "cap exceeded: {}", g.active());
                            drop(p);
                        }
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        assert_tools_released(&g);
    }

    #[test]
    fn the_guard_owns_a_tool_limiter_and_dropping_the_guard_drops_it() {
        let g = Guard::new(open());
        let tools = Arc::clone(&g.tools);
        assert_eq!(Arc::strong_count(&tools), 2);
        drop(g);
        assert_eq!(Arc::strong_count(&tools), 1);
    }

    // ---- budget shared across replicas ----

    #[test]
    fn the_budget_covers_the_whole_app_not_one_replica() {
        let mut l = lim();
        l.daily_token_budget = 1_000;
        let g = Guard::new(l);
        let shared = crate::shared_budget::SharedBudget::detached();
        g.attach_shared_budget(Arc::clone(&shared));
        g.record_tokens(100); // this replica has barely used anything
        assert!(g.admit(ip(1), "hello").is_ok());
        // Another replica reports a day total over the budget: this one refuses too.
        shared.observe(today(), 1_000);
        let e = g.admit(ip(2), "hello again").err().expect("app-wide budget is spent");
        assert_eq!(e.code, "budget_exhausted");
        assert_eq!(g.tokens_used_today(), 1_000, "the dashboard shows the app-wide figure");
    }

    #[test]
    fn without_a_shared_budget_each_replica_counts_alone() {
        let mut l = lim();
        l.daily_token_budget = 1_000;
        let g = Guard::new(l);
        g.record_tokens(999);
        assert!(g.admit(ip(1), "a").is_ok());
        g.record_tokens(1);
        assert_eq!(g.admit(ip(1), "b").err().unwrap().code, "budget_exhausted");
    }

    #[test]
    fn a_stale_shared_total_from_yesterday_does_not_block_today() {
        let mut l = lim();
        l.daily_token_budget = 1_000;
        let g = Guard::new(l);
        let shared = crate::shared_budget::SharedBudget::detached();
        g.attach_shared_budget(Arc::clone(&shared));
        shared.observe(today() - 1, 5_000);
        assert!(g.admit(ip(1), "morning").is_ok());
        assert_eq!(g.tokens_used_today(), 0);
    }

    #[test]
    fn the_larger_of_own_and_shared_counts_wins() {
        let mut l = lim();
        l.daily_token_budget = 1_000;
        let g = Guard::new(l);
        let shared = crate::shared_budget::SharedBudget::detached();
        g.attach_shared_budget(Arc::clone(&shared));
        shared.observe(today(), 200); // Redis is behind (down, or not yet read back)
        g.record_tokens(1_000); // but this replica alone has used it all
        assert_eq!(g.admit(ip(1), "x").err().unwrap().code, "budget_exhausted");
    }


    #[test]
    fn the_budget_day_rolls_over_at_6am_singapore_time() {
        use chrono::TimeZone;
        let utc = |h, m, sec| chrono::Utc.with_ymd_and_hms(2026, 10, 23, h, m, sec).unwrap().timestamp();
        // 05:59:59 in Singapore is 21:59:59 UTC the day before: still the old budget day.
        let before = day_index(utc(21, 59, 59) - 86_400);
        let at = day_index(utc(22, 0, 0) - 86_400);
        assert_eq!(at, before + 1, "06:00:00 Singapore starts a new day");
        // From 06:00 to 05:59:59 the next morning it is one day.
        assert_eq!(day_index(utc(22, 0, 0) - 86_400), day_index(utc(21, 59, 59)));
        // Midnight in Singapore (16:00 UTC) is not a boundary.
        assert_eq!(day_index(utc(15, 59, 59)), day_index(utc(16, 0, 0)));
        // Midnight UTC is not a boundary either.
        assert_eq!(day_index(utc(23, 59, 59)), day_index(utc(0, 0, 0) + 86_400));
        assert_eq!(seconds_until_reset(utc(21, 59, 59)), 1);
        assert_eq!(seconds_until_reset(utc(22, 0, 0)), 86_400);
        assert_eq!(seconds_until_reset(utc(10, 0, 0)), 12 * 3600);
    }

    #[test]
    fn the_limit_message_points_users_to_their_own_key() {
        let mut l = lim();
        l.daily_token_budget = 1;
        let g = Guard::new(l);
        g.record_tokens(5);
        let e = g.admit(ip(1), "hi").err().unwrap();
        assert_eq!(e.code, "budget_exhausted");
        assert!(e.message.contains("6:00 am Singapore time"), "{}", e.message);
        assert!(e.message.contains("own API key"), "{}", e.message);
        assert!(e.retry_after.is_some_and(|s| (1..=3600).contains(&s)));
    }

}
