//! Request observability: one span + access-log line per request, HTTP metrics by route
//! *template* (bounded cardinality), rejection counts and distinct-client tracking.
//!
//! Logs carry `request_id` (set by `SetRequestIdLayer`) and a short salted client hash, never
//! the address or any message content.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Instant;

use axum::{
    extract::{ConnectInfo, MatchedPath, Request, State},
    middleware::Next,
    response::Response,
};
use tracing::{Instrument, debug, info, info_span};

use crate::AppState;
use crate::clients::{self, Kind};
use crate::limits;
use crate::metrics::{HTTP_LATENCY_SECONDS, HTTP_REQUESTS_TOTAL, REJECTIONS_TOTAL};

/// Attached to a response built by `chat::error_response`, so the limiter/validation code that
/// refused the request is counted without parsing bodies.
#[derive(Clone, Copy)]
pub struct RejectCode(pub &'static str);

/// Which tracked endpoint a route template is, if any.
fn client_kind(route: &str) -> Option<Kind> {
    match route {
        "/api/chat" | "/api/compact" => Some(Kind::Chat),
        "/api/tool" | "/api/cite" | "/api/links" => Some(Kind::Tool),
        _ => None,
    }
}

pub async fn observe(State(state): State<Arc<AppState>>, req: Request, next: Next) -> Response {
    let start = Instant::now();
    let method = req.method().as_str().to_string();
    let route = req.extensions().get::<MatchedPath>().map_or("other", |m| m.as_str()).to_string();
    let request_id = req
        .headers()
        .get("x-request-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("-")
        .to_string();
    let peer = req
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|c| c.0)
        .unwrap_or_else(|| SocketAddr::from(([0, 0, 0, 0], 0)));
    let ip = limits::client_ip(req.headers(), peer, state.guard.limits.trust_proxy);
    let tracker = clients::tracker();
    let client = tracker.log_id(ip);
    if let Some(kind) = client_kind(&route) {
        tracker.record(ip, kind);
    }

    let span = info_span!("req", %request_id, %client, route = %route, mode = tracing::field::Empty);
    let resp = next.run(req).instrument(span.clone()).await;

    let status = resp.status().as_u16();
    let secs = start.elapsed().as_secs_f64();
    HTTP_REQUESTS_TOTAL.with_label_values(&[&method, &route, &status.to_string()]).inc();
    HTTP_LATENCY_SECONDS.with_label_values(&[&method, &route]).observe(secs);
    let rejection = resp.extensions().get::<RejectCode>().map(|c| c.0);
    if let Some(code) = rejection {
        REJECTIONS_TOTAL.with_label_values(&[&route, code]).inc();
    }

    let quiet = route == "/api/health" || route == "other";
    let _enter = span.enter();
    if quiet {
        debug!(%method, status, latency_ms = (secs * 1000.0) as u64, "request");
    } else {
        info!(%method, status, latency_ms = (secs * 1000.0) as u64, rejected = rejection.unwrap_or(""), "request");
    }
    resp
}
