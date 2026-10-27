//! The daily token budget, shared by every replica.
//!
//! Each replica counts its own tokens in memory (`limits::Guard`). With `REDIS_URL` set, the
//! replicas also add that spend to one counter in Redis/Valkey and read the total back, so the
//! budget covers the whole app: when it is used up every replica refuses new chats together.
//!
//! Redis is an optimisation of the limit, never a dependency of the service: every call has a
//! short timeout and failures are logged and ignored. If Redis is unreachable the replica falls
//! back to its own count (the budget is then per replica until Redis returns).
//!
//! Key: `lbl:tokens:<days since epoch, UTC>`, expiring after two days.

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::time::Duration;

use redis::aio::ConnectionManager;
use tokio::sync::OnceCell;
use tracing::{debug, info, warn};

const OP_TIMEOUT: Duration = Duration::from_millis(800);
const REFRESH_EVERY: Duration = Duration::from_secs(2);
const KEY_TTL_S: i64 = 2 * 86_400;

pub struct SharedBudget {
    client: Option<redis::Client>,
    conn: OnceCell<ConnectionManager>,
    /// The last total seen in Redis, and the UTC day it belongs to.
    total: AtomicU64,
    day: AtomicI64,
}

fn key(day: i64) -> String {
    format!("lbl:tokens:{day}")
}

impl SharedBudget {
    /// Connect lazily to `url`. Returns `None` for an empty or invalid URL.
    pub fn new(url: &str) -> Option<Arc<Self>> {
        let url = url.trim();
        if url.is_empty() {
            return None;
        }
        match redis::Client::open(url) {
            Ok(c) => Some(Arc::new(Self::with_client(Some(c)))),
            Err(e) => {
                warn!("REDIS_URL is not valid, the daily budget stays per replica: {e}");
                None
            }
        }
    }

    fn with_client(client: Option<redis::Client>) -> Self {
        Self { client, conn: OnceCell::new(), total: AtomicU64::new(0), day: AtomicI64::new(i64::MIN) }
    }

    /// A budget with no Redis behind it, for tests: totals are set with `observe`.
    #[cfg(test)]
    pub fn detached() -> Arc<Self> {
        Arc::new(Self::with_client(None))
    }

    /// What the whole app has used on `day`, as last seen. Zero for a day not seen yet.
    pub fn used(&self, day: i64) -> u64 {
        if self.day.load(Ordering::Acquire) == day { self.total.load(Ordering::Acquire) } else { 0 }
    }

    /// Record a total read from (or returned by) Redis. Totals only grow within a day.
    pub fn observe(&self, day: i64, total: u64) {
        if self.day.swap(day, Ordering::AcqRel) != day {
            self.total.store(total, Ordering::Release);
        } else {
            self.total.fetch_max(total, Ordering::AcqRel);
        }
    }

    async fn connection(&self) -> Option<ConnectionManager> {
        let client = self.client.as_ref()?;
        let conn = self
            .conn
            .get_or_try_init(|| async {
                match tokio::time::timeout(Duration::from_secs(2), ConnectionManager::new(client.clone())).await {
                    Ok(Ok(c)) => {
                        info!("shared daily budget connected");
                        Ok(c)
                    }
                    Ok(Err(e)) => Err(e.to_string()),
                    Err(_) => Err("timed out".to_string()),
                }
            })
            .await;
        match conn {
            Ok(c) => Some(c.clone()),
            Err(e) => {
                debug!("shared budget unavailable: {e}");
                None
            }
        }
    }

    /// Add `n` tokens to `day`'s shared counter without blocking the caller.
    pub fn add(self: &Arc<Self>, day: i64, n: u64) {
        if n == 0 || self.client.is_none() {
            return;
        }
        let this = Arc::clone(self);
        // No runtime (plain unit tests) means nothing to spawn on: stay local.
        let Ok(handle) = tokio::runtime::Handle::try_current() else { return };
        handle.spawn(async move {
            let Some(mut conn) = this.connection().await else { return };
            let k = key(day);
            let res = tokio::time::timeout(
                OP_TIMEOUT,
                redis::pipe()
                    .atomic()
                    .cmd("INCRBY").arg(&k).arg(n)
                    .cmd("EXPIRE").arg(&k).arg(KEY_TTL_S).ignore()
                    .query_async::<(u64,)>(&mut conn),
            )
            .await;
            match res {
                Ok(Ok((total,))) => this.observe(day, total),
                Ok(Err(e)) => warn!("shared budget add failed: {e}"),
                Err(_) => warn!("shared budget add timed out"),
            }
        });
    }

    /// Re-read today's total every couple of seconds so spend by other replicas is seen.
    pub fn spawn_refresher(self: &Arc<Self>, today: fn() -> i64) {
        let this = Arc::clone(self);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(REFRESH_EVERY);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                let Some(mut conn) = this.connection().await else { continue };
                let day = today();
                let res = tokio::time::timeout(
                    OP_TIMEOUT,
                    redis::cmd("GET").arg(key(day)).query_async::<Option<u64>>(&mut conn),
                )
                .await;
                match res {
                    Ok(Ok(v)) => this.observe(day, v.unwrap_or(0)),
                    Ok(Err(e)) => debug!("shared budget read failed: {e}"),
                    Err(_) => debug!("shared budget read timed out"),
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_or_bad_url_means_no_shared_budget() {
        assert!(SharedBudget::new("").is_none());
        assert!(SharedBudget::new("   ").is_none());
        assert!(SharedBudget::new("not a url").is_none());
        assert!(SharedBudget::new("redis://127.0.0.1:1").is_some(), "connects lazily, so an unreachable host is fine");
    }

    #[test]
    fn totals_are_per_day_and_never_go_backwards() {
        let b = SharedBudget::detached();
        assert_eq!(b.used(100), 0, "nothing seen yet");
        b.observe(100, 500);
        assert_eq!(b.used(100), 500);
        b.observe(100, 300);
        assert_eq!(b.used(100), 500, "a late, smaller reply cannot lower the total");
        b.observe(100, 900);
        assert_eq!(b.used(100), 900);
        assert_eq!(b.used(101), 0, "a new day starts from zero");
        b.observe(101, 7);
        assert_eq!(b.used(101), 7);
        assert_eq!(b.used(100), 0);
    }

    #[test]
    fn keys_are_per_day() {
        assert_ne!(key(1), key(2));
        assert_eq!(key(20_000), "lbl:tokens:20000");
    }

    #[tokio::test]
    async fn an_unreachable_redis_never_blocks_or_panics() {
        let b = SharedBudget::new("redis://127.0.0.1:1").unwrap();
        b.add(5, 1_000); // fire and forget
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(b.used(5), 0, "nothing is learned from a Redis that is not there");
    }

    /// Two replicas against a real Redis/Valkey: `REDIS_TEST_URL=redis://127.0.0.1:6379 cargo test -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn two_replicas_see_each_others_spend() {
        let url = std::env::var("REDIS_TEST_URL").expect("REDIS_TEST_URL");
        let day = 9_999_000 + (uuid::Uuid::new_v4().as_u128() % 900_000) as i64; // a private key
        let (a, b) = (SharedBudget::new(&url).unwrap(), SharedBudget::new(&url).unwrap());
        a.add(day, 400);
        b.add(day, 250);
        for _ in 0..50 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            if a.used(day) >= 400 && b.used(day) >= 250 {
                break;
            }
        }
        // Each add returns the running total, so the later one sees both.
        assert_eq!(a.used(day).max(b.used(day)), 650);
        let mut conn = a.connection().await.unwrap();
        let ttl: i64 = redis::cmd("TTL").arg(key(day)).query_async(&mut conn).await.unwrap();
        assert!(ttl > 0 && ttl <= KEY_TTL_S, "the key must expire, ttl={ttl}");
        let _: () = redis::cmd("DEL").arg(key(day)).query_async(&mut conn).await.unwrap();
    }
}
