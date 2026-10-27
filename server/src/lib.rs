//! lawbylaw public legal chatbot — stateless backend.
//!
//! No accounts, no database, no server-side history. Every request carries the
//! full conversation, so every limit is enforced per request (see `limits`).

pub mod app;
pub mod clients;
pub mod config;
pub mod limits;
pub mod metrics;
pub mod models;
pub mod obs;
pub mod routers;
pub mod security_headers;
pub mod session;
pub mod shared_budget;
pub mod services;

use std::sync::Arc;
use tokio::sync::RwLock;

/// Application state shared across all handlers.
pub struct AppState {
    pub config: Arc<RwLock<config::AppConfig>>,
    pub qdrant: services::qdrant_store::QdrantStore,
    pub deepseek: services::deepseek::DeepSeekClient,
    pub guard: Arc<limits::Guard>,
}
