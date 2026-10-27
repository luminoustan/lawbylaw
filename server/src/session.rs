//! Cloudflare Turnstile session gate.
//!
//! A visitor solves Turnstile once; `POST /api/session` verifies the widget token with
//! Cloudflare and returns a short-lived, HMAC-signed session token. The expensive routes
//! (chat, compact, tool, cite, links, agent) require that token in `x-lbl-session` when
//! `TURNSTILE_ENFORCE=true`. The token is stateless (expiry plus MAC), so it verifies on
//! every replica, and it is sent as a header: no cookies, nothing stored server-side.
//!
//! Env: `TURNSTILE_ENFORCE`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, `SESSION_HMAC_KEY`
//! (must be identical on every replica; a random per-process key is used, with a warning, if
//! unset), `SESSION_TTL_S` (default 1800), `TURNSTILE_VERIFY_URL` (tests/evals only).

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::{
    Extension, Json,
    extract::{ConnectInfo, Request, State},
    http::{HeaderMap, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::limits::{self, TrustProxy};

pub const SESSION_HEADER: &str = "x-lbl-session";

/// The verified session a request belongs to. Present only when the gate is enforcing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionId(pub String);
const DEFAULT_VERIFY_URL: &str = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/// Routes that cost money or GPU time. Everything else (health, limits, static, session) is open.
const PROTECTED: [&str; 6] =
    ["/api/chat", "/api/compact", "/api/tool", "/api/cite", "/api/links", "/api/agent"];
const SESSION_MAX_PER_MIN: usize = 10;
const MAX_TRACKED_IPS: usize = 20_000;

pub struct SessionGate {
    enforce: bool,
    site_key: String,
    secret_key: String,
    verify_url: String,
    key: [u8; 32],
    ttl: u64,
    trust_proxy: TrustProxy,
    http: reqwest::Client,
    attempts: Mutex<HashMap<IpAddr, (Instant, usize)>>,
}

fn env_s(k: &str) -> String {
    std::env::var(k).unwrap_or_default().trim().to_string()
}

impl SessionGate {
    pub fn from_env(trust_proxy: TrustProxy) -> Self {
        let enforce = std::env::var("TURNSTILE_ENFORCE").is_ok_and(|v| matches!(v.trim(), "1" | "true" | "TRUE" | "True"));
        let mut key = [0u8; 32];
        let configured = env_s("SESSION_HMAC_KEY");
        if configured.is_empty() {
            if enforce {
                tracing::warn!("SESSION_HMAC_KEY is not set: using a per-process key, sessions will not work across replicas");
            }
            key[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
            key[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        } else {
            key.copy_from_slice(&Sha256::digest(configured.as_bytes()));
        }
        let verify_url = match env_s("TURNSTILE_VERIFY_URL") {
            u if u.is_empty() => DEFAULT_VERIFY_URL.to_string(),
            u => u,
        };
        let g = Self {
            enforce,
            site_key: env_s("TURNSTILE_SITE_KEY"),
            secret_key: env_s("TURNSTILE_SECRET_KEY"),
            verify_url,
            key,
            ttl: std::env::var("SESSION_TTL_S").ok().and_then(|v| v.parse().ok()).unwrap_or(1800),
            trust_proxy,
            http: reqwest::Client::builder().timeout(Duration::from_secs(8)).build().unwrap_or_default(),
            attempts: Mutex::new(HashMap::new()),
        };
        if g.enforce && (g.site_key.is_empty() || g.secret_key.is_empty()) {
            tracing::error!("TURNSTILE_ENFORCE is on but TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY are missing: every session request will fail");
        }
        g
    }

    /// `exp.id.mac`, where id is a random per-session value and
    /// mac = HMAC-SHA256(key, "lbl-session|exp|id|ip") in hex. The id lets per-session limits
    /// tell two visitors behind one IP apart. The address is signed in but not sent, so a token
    /// copied to another network does not verify there: one Turnstile solve is one network.
    pub fn issue(&self, now_unix: u64, ip: IpAddr) -> (String, u64) {
        let exp = now_unix + self.ttl;
        let id = uuid::Uuid::new_v4().simple().to_string();
        let mac = hex(&hmac_sha256(&self.key, format!("lbl-session|{exp}|{id}|{}", ip_bind(ip)).as_bytes()));
        (format!("{exp}.{id}.{mac}"), exp)
    }

    /// The session id inside a valid, unexpired token.
    pub fn verify(&self, token: &str, now_unix: u64, ip: IpAddr) -> Option<String> {
        let mut parts = token.split('.');
        let (exp, id, mac) = (parts.next()?, parts.next()?, parts.next()?);
        if parts.next().is_some() || id.is_empty() || id.len() > 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let exp_n = exp.parse::<u64>().ok()?;
        if exp_n < now_unix || exp_n > now_unix + self.ttl {
            return None;
        }
        let want = hex(&hmac_sha256(&self.key, format!("lbl-session|{exp}|{id}|{}", ip_bind(ip)).as_bytes()));
        ct_eq(want.as_bytes(), mac.as_bytes()).then(|| id.to_string())
    }

    pub fn check(&self, token: &str, now_unix: u64, ip: IpAddr) -> bool {
        self.verify(token, now_unix, ip).is_some()
    }

    /// Test-only: an enforcing gate with a fixed key.
    #[cfg(test)]
    pub fn enforcing_for_tests() -> Self {
        Self {
            enforce: true,
            site_key: "site".into(),
            secret_key: "secret".into(),
            verify_url: DEFAULT_VERIFY_URL.into(),
            key: [7u8; 32],
            ttl: 1800,
            trust_proxy: TrustProxy::None,
            http: reqwest::Client::new(),
            attempts: Mutex::new(HashMap::new()),
        }
    }

    fn allow_attempt(&self, ip: IpAddr) -> bool {
        let Ok(mut m) = self.attempts.lock() else { return false };
        let now = Instant::now();
        if m.len() > MAX_TRACKED_IPS {
            m.retain(|_, (t, _)| now.duration_since(*t) < Duration::from_secs(60));
            if m.len() > MAX_TRACKED_IPS && !m.contains_key(&ip) {
                return false;
            }
        }
        let e = m.entry(ip).or_insert((now, 0));
        if now.duration_since(e.0) >= Duration::from_secs(60) {
            *e = (now, 0);
        }
        e.1 += 1;
        e.1 <= SESSION_MAX_PER_MIN
    }
}

/// What a session is tied to: the address for IPv4, the /64 for IPv6 (a device rotates inside its
/// /64 with privacy addresses, so the full address would sign people out every few hours).
fn ip_bind(ip: IpAddr) -> String {
    match ip.to_canonical() {
        IpAddr::V4(v4) => v4.to_string(),
        IpAddr::V6(v6) => {
            let o = v6.octets();
            hex(&o[..8])
        }
    }
}

fn now_unix() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// HMAC-SHA256 (RFC 2104); `key` is already 32 bytes, so it is zero-padded to the 64-byte block.
fn hmac_sha256(key: &[u8; 32], msg: &[u8]) -> [u8; 32] {
    let mut ipad = [0x36u8; 64];
    let mut opad = [0x5cu8; 64];
    for i in 0..32 {
        ipad[i] ^= key[i];
        opad[i] ^= key[i];
    }
    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(msg);
    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner.finalize());
    outer.finalize().into()
}

fn deny(status: StatusCode, code: &'static str, message: &str) -> Response {
    let mut r = (status, Json(json!({"error": {"code": code, "message": message}}))).into_response();
    r.extensions_mut().insert(crate::obs::RejectCode(code));
    r
}

fn peer_of(req_ext: Option<&ConnectInfo<SocketAddr>>) -> SocketAddr {
    req_ext.map(|c| c.0).unwrap_or_else(|| SocketAddr::from(([0, 0, 0, 0], 0)))
}

/// Middleware: with `TRUST_PROXY=cf`, API routes must arrive through Cloudflare; with
/// Turnstile enforced, the expensive routes must carry a valid session token.
pub async fn require_session(State(gate): State<Arc<SessionGate>>, req: Request, next: Next) -> Response {
    let path = req.uri().path().to_string();
    let path = path.as_str();
    let guarded = PROTECTED.contains(&path) || path == "/api/session";
    if !guarded {
        return next.run(req).await;
    }
    if !limits::proxy_header_ok(req.headers(), gate.trust_proxy) {
        return deny(StatusCode::BAD_REQUEST, "bad_origin", "This request did not come through the expected proxy.");
    }
    let mut req = req;
    if gate.enforce && PROTECTED.contains(&path) {
        let ip = limits::client_ip(req.headers(), peer_of(req.extensions().get::<ConnectInfo<SocketAddr>>()), gate.trust_proxy);
        let id = req
            .headers()
            .get(SESSION_HEADER)
            .and_then(|v| v.to_str().ok())
            .and_then(|t| gate.verify(t, now_unix(), ip));
        let Some(id) = id else {
            return deny(StatusCode::FORBIDDEN, "session_required", "Please complete the verification and try again.");
        };
        req.extensions_mut().insert(SessionId(id));
    }
    next.run(req).await
}

/// `GET /api/session`: what the browser needs to decide whether to show the widget.
pub async fn config(Extension(gate): Extension<Arc<SessionGate>>) -> Response {
    let mut r = Json(json!({
        "enforce": gate.enforce,
        "site_key": if gate.enforce { gate.site_key.as_str() } else { "" },
        "ttl_s": gate.ttl,
    }))
    .into_response();
    r.headers_mut().insert(axum::http::header::CACHE_CONTROL, "no-store".parse().unwrap());
    r
}

#[derive(Deserialize)]
pub struct ExchangeBody {
    token: String,
}

#[derive(Deserialize)]
struct Verdict {
    success: bool,
}

/// `POST /api/session` `{token}`: verify the Turnstile token and issue a session token.
pub async fn exchange(
    Extension(gate): Extension<Arc<SessionGate>>,
    connect: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    Json(body): Json<ExchangeBody>,
) -> Response {
    let ip = limits::client_ip(&headers, peer_of(connect.as_ref().map(|e| &e.0)), gate.trust_proxy);
    if !gate.allow_attempt(ip) {
        let mut r = deny(StatusCode::TOO_MANY_REQUESTS, "rate_limited", "Too many verification attempts. Please wait a minute.");
        r.headers_mut().insert(axum::http::header::RETRY_AFTER, "30".parse().unwrap());
        return r;
    }
    if !gate.enforce {
        // Nothing to verify: hand out a token anyway so a client built for the gate keeps working.
        let (t, exp) = gate.issue(now_unix(), ip);
        return Json(json!({"session": t, "expires_at": exp})).into_response();
    }
    if body.token.is_empty() || body.token.len() > 4096 {
        return deny(StatusCode::BAD_REQUEST, "invalid_token", "Verification failed. Please reload the page.");
    }
    let resp = gate
        .http
        .post(&gate.verify_url)
        .form(&[("secret", gate.secret_key.as_str()), ("response", body.token.as_str()), ("remoteip", &ip.to_string())])
        .send()
        .await;
    let verdict = match resp {
        Ok(r) if r.status().is_success() => r.json::<Verdict>().await.ok(),
        _ => {
            tracing::warn!("turnstile siteverify unreachable or failed");
            return deny(StatusCode::BAD_GATEWAY, "verify_unavailable", "Verification is unavailable. Please try again shortly.");
        }
    };
    if !verdict.is_some_and(|v| v.success) {
        return deny(StatusCode::FORBIDDEN, "verification_failed", "Verification failed. Please reload the page and try again.");
    }
    let (t, exp) = gate.issue(now_unix(), ip);
    let mut r = Json(json!({"session": t, "expires_at": exp})).into_response();
    r.headers_mut().insert(axum::http::header::CACHE_CONTROL, "no-store".parse().unwrap());
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    const IP: IpAddr = IpAddr::V4(std::net::Ipv4Addr::new(10, 0, 0, 1));

    fn gate(enforce: bool) -> SessionGate {
        SessionGate {
            enforce,
            site_key: "site".into(),
            secret_key: "secret".into(),
            verify_url: DEFAULT_VERIFY_URL.into(),
            key: [7u8; 32],
            ttl: 1800,
            trust_proxy: TrustProxy::None,
            http: reqwest::Client::new(),
            attempts: Mutex::new(HashMap::new()),
        }
    }

    #[test]
    fn hmac_depends_on_key_and_message() {
        let k = [1u8; 32];
        assert_eq!(hex(&hmac_sha256(&k, b"abc")).len(), 64);
        assert_ne!(hmac_sha256(&k, b"abc"), hmac_sha256(&k, b"abd"));
        assert_ne!(hmac_sha256(&k, b"abc"), hmac_sha256(&[2u8; 32], b"abc"));
        assert_eq!(hmac_sha256(&k, b"abc"), hmac_sha256(&k, b"abc"));
    }

    #[test]
    fn valid_token_passes_until_it_expires() {
        let g = gate(true);
        let (t, exp) = g.issue(1_000, IP);
        assert!(g.check(&t, 1_000, IP));
        assert!(g.check(&t, exp, IP));
        assert!(!g.check(&t, exp + 1, IP), "expired");
    }

    #[test]
    fn forged_or_malformed_tokens_fail() {
        let g = gate(true);
        let (t, _) = g.issue(1_000, IP);
        let (rest, mac) = t.rsplit_once('.').unwrap();
        let (exp, id) = rest.split_once('.').unwrap();
        assert!(!g.check(&format!("{rest}.{}", "0".repeat(mac.len())), 1_000, IP), "wrong mac");
        assert!(!g.check(&format!("{}.{id}.{mac}", exp.parse::<u64>().unwrap() + 1), 1_000, IP), "tampered expiry");
        assert!(!g.check(&format!("{exp}.{}.{mac}", "a".repeat(32)), 1_000, IP), "swapped session id");
        assert!(!g.check(&format!("{t}.extra"), 1_000, IP), "trailing segment");
        assert!(!g.check("", 1_000, IP));
        assert!(!g.check("abc", 1_000, IP));
        assert!(!g.check("x.y", 1_000, IP));
        // A far-future expiry cannot be minted without the key, and is rejected even if signed.
        let far = gate(true);
        let (t2, _) = far.issue(10_000_000, IP);
        assert!(!far.check(&t2, 1_000, IP), "expiry beyond ttl");
        // A token from another key fails.
        let mut other = gate(true);
        other.key = [9u8; 32];
        assert!(!other.check(&t, 1_000, IP));
    }

    #[test]
    fn every_session_gets_its_own_id() {
        let g = gate(true);
        let (a, _) = g.issue(1_000, IP);
        let (b, _) = g.issue(1_000, IP);
        assert_ne!(g.verify(&a, 1_000, IP), g.verify(&b, 1_000, IP));
        assert!(g.verify(&a, 1_000, IP).is_some());
    }

    #[test]
    fn a_token_only_verifies_from_the_network_it_was_issued_to() {
        let g = gate(true);
        let (t, _) = g.issue(1_000, IP);
        assert!(g.check(&t, 1_000, IP));
        assert!(!g.check(&t, 1_000, "10.0.0.2".parse().unwrap()), "another IPv4 address");
        assert!(!g.check(&t, 1_000, "2001:db8::1".parse().unwrap()), "an IPv6 address");
        // IPv4-mapped IPv6 is the same client.
        assert!(g.check(&t, 1_000, "::ffff:10.0.0.1".parse().unwrap()));
    }

    #[test]
    fn ipv6_clients_keep_their_session_inside_one_64() {
        let g = gate(true);
        let a: IpAddr = "2001:db8:1:2::aaaa".parse().unwrap();
        let (t, _) = g.issue(1_000, a);
        assert!(g.check(&t, 1_000, "2001:db8:1:2:1234:5678:9abc:def0".parse().unwrap()), "privacy address rotation");
        assert!(!g.check(&t, 1_000, "2001:db8:1:3::aaaa".parse().unwrap()), "a different /64");
    }

    #[test]
    fn session_attempts_are_rate_limited_per_ip() {
        let g = gate(true);
        let ip: IpAddr = "1.2.3.4".parse().unwrap();
        for _ in 0..SESSION_MAX_PER_MIN {
            assert!(g.allow_attempt(ip));
        }
        assert!(!g.allow_attempt(ip));
        assert!(g.allow_attempt("5.6.7.8".parse().unwrap()));
    }

    async fn status(g: SessionGate, path: &str, header: Option<&str>, cf: bool) -> StatusCode {
        use axum::{Router, body::Body, routing::get};
        use tower::ServiceExt;
        let g = Arc::new(g);
        let app = Router::new()
            .route("/api/chat", get(|| async { "ok" }))
            .route("/api/health", get(|| async { "ok" }))
            .layer(axum::middleware::from_fn_with_state(g, require_session));
        let mut b = Request::builder().uri(path);
        if let Some(h) = header {
            b = b.header(SESSION_HEADER, h);
        }
        if cf {
            b = b.header("cf-connecting-ip", "1.2.3.4");
        }
        app.oneshot(b.body(Body::empty()).unwrap()).await.unwrap().status()
    }

    #[tokio::test]
    async fn enforced_gate_blocks_tokenless_and_forged_requests() {
        assert_eq!(status(gate(true), "/api/chat", None, false).await, StatusCode::FORBIDDEN);
        assert_eq!(status(gate(true), "/api/chat", Some("1.deadbeef"), false).await, StatusCode::FORBIDDEN);
        let g = gate(true);
        let (t, _) = g.issue(now_unix(), IpAddr::from([0, 0, 0, 0])); // the test router has no peer address
        assert_eq!(status(g, "/api/chat", Some(&t), false).await, StatusCode::OK);
        assert_eq!(status(gate(true), "/api/health", None, false).await, StatusCode::OK, "health stays open");
    }

    #[tokio::test]
    async fn unenforced_gate_lets_everything_through() {
        assert_eq!(status(gate(false), "/api/chat", None, false).await, StatusCode::OK);
    }

    #[tokio::test]
    async fn cf_mode_rejects_requests_that_skipped_cloudflare() {
        let mut g = gate(false);
        g.trust_proxy = TrustProxy::Cloudflare;
        assert_eq!(status(g, "/api/chat", None, false).await, StatusCode::BAD_REQUEST);
        let mut g = gate(false);
        g.trust_proxy = TrustProxy::Cloudflare;
        assert_eq!(status(g, "/api/chat", None, true).await, StatusCode::OK);
    }
}
