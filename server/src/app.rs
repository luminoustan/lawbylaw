//! Router construction. The route set is deliberately tiny and asserted by tests.

use std::sync::Arc;
use std::time::Duration;

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{StatusCode, header},
    middleware,
    response::{IntoResponse, Response},
    routing::{any, get, post},
};
use serde_json::json;
use tower_http::{
    compression::CompressionLayer,
    request_id::{MakeRequestUuid, SetRequestIdLayer},
    services::ServeDir,
};

use crate::AppState;
use crate::routers::{agent, chat, compact, health, tools};
use crate::session::{self, SessionGate};
use crate::security_headers::security_headers_middleware;

/// The complete list of API routes. Anything else under `/api` or `/admin` is a 404.
pub const API_ROUTES: [(&str, &str); 10] = [
    ("POST", "/api/chat"),
    ("POST", "/api/compact"),
    ("POST", "/api/links"),
    ("GET", "/api/agent"),
    ("POST", "/api/tool"),
    ("POST", "/api/cite"),
    ("GET", "/api/session"),
    ("POST", "/api/session"),
    ("GET", "/api/limits"),
    ("GET", "/api/health"),
];

async fn limits_handler(State(state): State<Arc<AppState>>) -> Response {
    let mut v = serde_json::to_value(&state.guard.limits).unwrap_or_default();
    // Only expose what users need; not internal capacity or budget numbers.
    if let Some(o) = v.as_object_mut() {
        // Users see the model's full window as "context"; compaction happens before it fills.
        o.insert("context_tokens".into(), json!(state.guard.limits.model_window));
        for k in [
            "global_concurrency", "daily_token_budget", "model_window", "assistant_chars",
            "summary_chars", "final_check", "tool_nudge",
        ] {
            o.remove(k);
        }
    }
    let mut r = Json(v).into_response();
    r.headers_mut().insert(header::CACHE_CONTROL, "public, max-age=60".parse().unwrap());
    r
}

async fn not_found() -> Response {
    (StatusCode::NOT_FOUND, Json(json!({"error": {"code": "not_found", "message": "Not found."}}))).into_response()
}

/// The path as the static file server will see it: percent-decoded, lower-cased, with empty and `.`
/// segments dropped and `..` resolved. Checking the raw string would let `/%61dmin` or `//admin` through.
fn canonical_path(raw: &str) -> String {
    let b = raw.as_bytes();
    let mut dec = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() && b[i + 1].is_ascii_hexdigit() && b[i + 2].is_ascii_hexdigit() {
            dec.push(u8::from_str_radix(&raw[i + 1..i + 3], 16).unwrap());
            i += 3;
        } else {
            dec.push(b[i]);
            i += 1;
        }
    }
    let text = String::from_utf8_lossy(&dec).to_ascii_lowercase().replace('\\', "/");
    let mut out: Vec<&str> = Vec::new();
    for seg in text.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            s => out.push(s),
        }
    }
    format!("/{}", out.join("/"))
}

/// Paths that must never be served by the SPA fallback. Case-insensitive.
fn reserved_static_path(path: &str) -> bool {
    let path = canonical_path(path);
    path == "/api" || path.starts_with("/api/") || path.starts_with("/admin")
}

/// Every API answer is private unless a handler says otherwise (`/api/limits` does): without this a
/// misconfigured proxy could cache one user's tool result and serve it to another.
async fn api_no_store(req: axum::extract::Request, next: middleware::Next) -> Response {
    let api = reserved_static_path(req.uri().path());
    let mut resp = next.run(req).await;
    if api && !resp.headers().contains_key(header::CACHE_CONTROL) {
        resp.headers_mut().insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    }
    resp
}

pub fn build(state: Arc<AppState>, static_dir: Option<String>) -> Router {
    let gate = Arc::new(SessionGate::from_env(state.guard.limits.trust_proxy));
    build_with_gate(state, static_dir, gate)
}

pub fn build_with_gate(state: Arc<AppState>, static_dir: Option<String>, gate: Arc<SessionGate>) -> Router {
    let body_limit = state.guard.limits.body_bytes;
    let mut app = Router::new()
        .route("/api/chat", post(chat::chat_turn).layer(DefaultBodyLimit::max(body_limit)))
        .route("/api/compact", post(compact::compact).layer(DefaultBodyLimit::max(body_limit)))
        .route("/api/tool", post(tools::tool_call).layer(DefaultBodyLimit::max(tools::BODY_LIMIT)))
        .route("/api/links", post(tools::links).layer(DefaultBodyLimit::max(tools::BODY_LIMIT)))
        .route("/api/cite", post(tools::cite).layer(DefaultBodyLimit::max(tools::CITE_BODY_LIMIT)))
        .route("/api/agent", get(agent::agent_bundle))
        .route("/api/session", get(session::config).post(session::exchange).layer(DefaultBodyLimit::max(4 * 1024)))
        .route("/api/limits", get(limits_handler))
        .route("/api/health", get(health::health_handler))
        // Any other API or admin path: a hard 404, never the SPA shell.
        .route("/api/{*rest}", get(not_found).post(not_found).put(not_found).delete(not_found).patch(not_found))
        .route("/admin", any(not_found))
        .route("/admin/{*rest}", any(not_found));

    if let Some(dir) = static_dir.filter(|d| std::path::Path::new(d).exists()) {
        let serve = ServeDir::new(&dir).fallback(tower_http::services::ServeFile::new(format!("{dir}/index.html")));
        // Only GET/HEAD may reach the static files, and never for /api* or /admin*
        // (any case, with or without a trailing slash): those are hard 404s.
        app = app.fallback(move |req: axum::extract::Request| {
            let serve = serve.clone();
            async move {
                if reserved_static_path(req.uri().path())
                    || !matches!(*req.method(), axum::http::Method::GET | axum::http::Method::HEAD)
                {
                    return not_found().await;
                }
                match tower::ServiceExt::oneshot(serve, req).await {
                    Ok(r) => r.into_response(),
                    Err(e) => match e {},
                }
            }
        });
    } else {
        app = app.fallback(|| not_found());
    }

    app.layer(DefaultBodyLimit::max(64 * 1024))
        .layer(middleware::from_fn(api_no_store))
        .layer(tower_http::timeout::TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            Duration::from_secs(state.guard.limits.request_timeout_s + 30),
        ))
        .layer(middleware::from_fn_with_state(Arc::clone(&gate), session::require_session))
        .layer(middleware::from_fn_with_state(Arc::clone(&state), crate::obs::observe))
        .layer(axum::Extension(gate))
        .layer(middleware::from_fn(security_headers_middleware))
        .layer(CompressionLayer::new().gzip(true).br(true))
        .layer(SetRequestIdLayer::new(
            axum::http::HeaderName::from_static("x-request-id"),
            MakeRequestUuid,
        ))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::reserved_static_path;

    #[test]
    fn admin_prefix_is_reserved() {
        for path in ["/admin", "/admin/", "/admin/users", "/adminfoo", "/administrator", "/ADMIN"] {
            assert!(reserved_static_path(path), "{}", path);
        }
    }

    #[test]
    fn api_is_reserved_only_at_its_boundary() {
        for path in ["/api", "/api/", "/api/chat", "/API/CHAT"] {
            assert!(reserved_static_path(path), "{}", path);
        }
        assert!(!reserved_static_path("/apifoo"));
        for path in ["/%61dmin", "//admin", "/./admin", "/x/../admin", "/%2e%2e/admin", "/%61pi/chat", "/%2561dmin"] {
            // `/%2561dmin` decodes once to `/%61dmin`, which the file server does not decode again.
            assert_eq!(reserved_static_path(path), path != "/%2561dmin", "{}", path);
        }
        assert!(!reserved_static_path("/"));
    }
}
