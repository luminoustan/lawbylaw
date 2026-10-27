use std::net::SocketAddr;
use std::sync::Arc;

use tracing::{info, warn};

use lawbylaw_server::AppState;
use lawbylaw_server::app;
use lawbylaw_server::config::AppConfig;
use lawbylaw_server::limits::{Guard, Limits};
use lawbylaw_server::routers::health;
use lawbylaw_server::services::{deepseek::DeepSeekClient, qdrant_store::QdrantStore};

/// `LOG_FORMAT=json` (the cluster setting) emits one flat JSON object per event, with the
/// request span's fields (`request_id`, `client`, `route`, `mode`) merged in. Anything else is
/// human-readable text. ANSI colour is only used on a real terminal.
fn init_logging() {
    use std::io::IsTerminal;
    let filter =
        tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into());
    let builder = tracing_subscriber::fmt().with_env_filter(filter);
    if std::env::var("LOG_FORMAT").is_ok_and(|v| v.eq_ignore_ascii_case("json")) {
        builder.json().flatten_event(true).with_current_span(true).with_span_list(false).init();
    } else {
        builder.with_ansi(std::io::stderr().is_terminal() || std::io::stdout().is_terminal()).init();
    }
}

#[tokio::main]
async fn main() -> Result<(), anyhow::Error> {
    init_logging();

    let limits = Limits::from_env();
    let mut cfg = AppConfig::from_env()?;
    // Public-safe overrides: small context window, few tool rounds, small tool results.
    cfg.rag_search_hard_cap = limits.tool_rounds;
    cfg.context_window_size = limits.model_window;
    cfg.tool_nudge = limits.tool_nudge;
    cfg.finalization_check = limits.final_check;
    cfg.rag_context_budget = cfg.rag_context_budget.min(12_000);
    cfg.deepseek_http_timeout = cfg.deepseek_http_timeout.min(limits.request_timeout_s as f64);

    if cfg.deepseek_api_key.is_empty() {
        warn!("NEBIUS_API_KEY (or legacy DEEPSEEK_API_KEY) is not set; chat requests will fail");
    }
    info!("llm={} model={} qdrant={}:{}", cfg.deepseek_base_url, cfg.deepseek_model, cfg.qdrant_host, cfg.qdrant_port);

    let qdrant_url = format!("http://{}:{}", cfg.qdrant_host, cfg.qdrant_port);
    let mut qdrant = QdrantStore::new(&qdrant_url, &cfg).await?;
    qdrant.set_vllm_url(&cfg.vllm_base_url);
    let deepseek = DeepSeekClient::new(&cfg.deepseek_base_url, &cfg.deepseek_api_key, &cfg.deepseek_model);

    let guard = Guard::new(limits);
    lawbylaw_server::limits::register_budget_sink(&guard);
    // One daily budget for the whole app: replicas add their spend to a shared Redis counter.
    if let Some(shared) = lawbylaw_server::shared_budget::SharedBudget::new(&std::env::var("REDIS_URL").unwrap_or_default()) {
        shared.spawn_refresher(lawbylaw_server::limits::today);
        guard.attach_shared_budget(shared);
        tracing::info!("daily token budget is shared across replicas through Redis");
    } else {
        tracing::info!("daily token budget is per replica (REDIS_URL not set)");
    }
    let state = Arc::new(AppState {
        config: Arc::new(tokio::sync::RwLock::new(cfg)),
        qdrant,
        deepseek,
        guard,
    });

    let static_dir = std::env::var("STATIC_DIR").ok().or(Some("/app/static".into()));
    // Metrics get their own listener: it is not in the Service, the VirtualService or any tunnel.
    let metrics_port: u16 = std::env::var("METRICS_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(9102);
    let metrics_router = lawbylaw_server::routers::metrics_handler::router(Arc::clone(&state));
    let metrics_listener = tokio::net::TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], metrics_port))).await?;
    info!("Metrics on {}", metrics_listener.local_addr()?);
    tokio::spawn(async move {
        if let Err(e) = axum::serve(metrics_listener, metrics_router).await {
            warn!("metrics listener stopped: {e}");
        }
    });

    let router = app::build(state, static_dir);
    let addr = SocketAddr::from(([0, 0, 0, 0], std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8000)));
    info!("Listening on {}", addr);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            health::DRAINING.store(true, std::sync::atomic::Ordering::Relaxed);
        })
        .await?;
    Ok(())
}
