//! Health and readiness check endpoint.
//!
//! Returns 503 while the pod is draining (SIGTERM received) so Kubernetes
//! stops routing new traffic before the process exits.
//! Mirrors Python `main.py` lines 162-185.

use crate::models::schemas::HealthResponse;
use axum::{Json, http::StatusCode};
use std::sync::atomic::AtomicBool;

/// Global drain flag — set to true when SIGTERM is received.
pub static DRAINING: AtomicBool = AtomicBool::new(false);

/// Health check endpoint.
/// GET /api/health
pub async fn health_handler() -> (StatusCode, Json<HealthResponse>) {
    // Public and unauthenticated: status only. No version, model, counts or load.
    let draining = DRAINING.load(std::sync::atomic::Ordering::Relaxed);
    if draining {
        (StatusCode::SERVICE_UNAVAILABLE, Json(HealthResponse { status: "draining" }))
    } else {
        (StatusCode::OK, Json(HealthResponse { status: "ok" }))
    }
}
