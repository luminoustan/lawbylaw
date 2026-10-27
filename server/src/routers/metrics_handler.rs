//! Metrics endpoint, served on its own listener (`METRICS_PORT`), never on the API port.
//! GET /metrics

use std::sync::Arc;

use axum::{Router, extract::State, http::StatusCode, routing::get};

use crate::AppState;

/// Refresh the scrape-time gauges, then render the registry.
pub async fn metrics_endpoint(State(state): State<Arc<AppState>>) -> (StatusCode, String) {
    let g = &state.guard;
    crate::metrics::DAILY_TOKENS_USED.set(g.tokens_used_today() as f64);
    crate::metrics::DAILY_TOKEN_BUDGET.set(g.limits.daily_token_budget as f64);
    crate::metrics::ACTIVE_STREAMS.set(g.active() as f64);
    crate::clients::tracker().publish();
    (StatusCode::OK, crate::metrics::render_metrics())
}

/// The metrics-only router. It is deliberately separate from `app::build`.
pub fn router(state: Arc<AppState>) -> Router {
    Router::new().route("/metrics", get(metrics_endpoint)).with_state(state)
}
