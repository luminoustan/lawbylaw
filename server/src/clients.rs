//! Distinct-client counting for the "number of users" metric.
//!
//! The app has no accounts, so a "user" is a network client: the address `limits::client_ip`
//! resolves (so `TRUST_PROXY=cf` for a Cloudflare tunnel needs no change here). Addresses are
//! never stored: each is reduced to a keyed hash with a random per-process salt, IPv6 to its /64.
//! Counts are exported as gauges; the hash (6 hex chars) is also the only client id used in logs.
//! The set lives in memory, so a restart starts it empty and replicas cannot be summed.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use crate::metrics::{ACTIVE_CLIENTS, NEW_CLIENTS_TOTAL};

const MAX_TRACKED: usize = 100_000;
const DAY: Duration = Duration::from_secs(86_400);
const WINDOWS: [(&str, Duration); 3] = [
    ("5m", Duration::from_secs(300)),
    ("1h", Duration::from_secs(3_600)),
    ("24h", DAY),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Chat or compact: spends the shared model key.
    Chat,
    /// Tool endpoint: the browser-side (bring your own key) loop.
    Tool,
}

#[derive(Clone, Copy)]
struct Seen {
    any: Instant,
    chat: Option<Instant>,
    tool: Option<Instant>,
}

pub struct ClientTracker {
    salt: [u8; 16],
    seen: Mutex<HashMap<u64, Seen>>,
}

/// Counts per window, in `WINDOWS` order: (any, chat, tool).
pub type Counts = [(usize, usize, usize); 3];

impl Default for ClientTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl ClientTracker {
    pub fn new() -> Self {
        Self { salt: *uuid::Uuid::new_v4().as_bytes(), seen: Mutex::new(HashMap::new()) }
    }

    fn key(&self, ip: IpAddr) -> u64 {
        let mut h = Sha256::new();
        h.update(self.salt);
        match ip {
            IpAddr::V4(v) => h.update(v.octets()),
            IpAddr::V6(v) => match v.to_ipv4_mapped() {
                Some(v4) => h.update(v4.octets()),
                None => h.update(&v.octets()[..8]), // /64
            },
        }
        u64::from_le_bytes(h.finalize()[..8].try_into().unwrap_or([0; 8]))
    }

    /// Short stable id for logs. Not reversible without the salt.
    pub fn log_id(&self, ip: IpAddr) -> String {
        format!("{:012x}", self.key(ip) & 0xffff_ffff_ffff)[..6].to_string()
    }

    pub fn record(&self, ip: IpAddr, kind: Kind) {
        self.record_at(ip, kind, Instant::now());
    }

    fn record_at(&self, ip: IpAddr, kind: Kind, now: Instant) {
        let key = self.key(ip);
        let Ok(mut map) = self.seen.lock() else { return };
        if map.len() >= MAX_TRACKED {
            map.retain(|_, s| now.saturating_duration_since(s.any) < DAY);
            if map.len() >= MAX_TRACKED && !map.contains_key(&key) {
                return; // fail closed: bounded memory beats an exact count
            }
        }
        let fresh = map.get(&key).is_none_or(|s| now.saturating_duration_since(s.any) >= DAY);
        if fresh {
            NEW_CLIENTS_TOTAL.inc();
        }
        let s = map.entry(key).or_insert(Seen { any: now, chat: None, tool: None });
        s.any = now;
        match kind {
            Kind::Chat => s.chat = Some(now),
            Kind::Tool => s.tool = Some(now),
        }
    }

    fn counts_at(&self, now: Instant) -> Counts {
        let mut out = [(0, 0, 0); 3];
        let Ok(map) = self.seen.lock() else { return out };
        let within = |t: Option<Instant>, w: Duration| t.is_some_and(|t| now.saturating_duration_since(t) < w);
        for s in map.values() {
            for (i, (_, w)) in WINDOWS.iter().enumerate() {
                if within(Some(s.any), *w) {
                    out[i].0 += 1;
                }
                if within(s.chat, *w) {
                    out[i].1 += 1;
                }
                if within(s.tool, *w) {
                    out[i].2 += 1;
                }
            }
        }
        out
    }

    /// Write the current counts to the Prometheus gauges (called at scrape time).
    pub fn publish(&self) {
        let now = Instant::now();
        if let Ok(mut map) = self.seen.lock() {
            map.retain(|_, s| now.saturating_duration_since(s.any) < DAY);
        }
        for (i, c) in self.counts_at(now).iter().enumerate() {
            let w = WINDOWS[i].0;
            ACTIVE_CLIENTS.with_label_values(&[w, "any"]).set(c.0 as f64);
            ACTIVE_CLIENTS.with_label_values(&[w, "chat"]).set(c.1 as f64);
            ACTIVE_CLIENTS.with_label_values(&[w, "tool"]).set(c.2 as f64);
        }
    }
}

pub fn tracker() -> &'static ClientTracker {
    static T: OnceLock<ClientTracker> = OnceLock::new();
    T.get_or_init(ClientTracker::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn counts_distinct_clients_per_window_and_kind() {
        let t = ClientTracker::new();
        let t0 = Instant::now();
        t.record_at(ip("10.0.0.1"), Kind::Chat, t0);
        t.record_at(ip("10.0.0.1"), Kind::Chat, t0);
        t.record_at(ip("10.0.0.2"), Kind::Tool, t0);
        let c = t.counts_at(t0);
        assert_eq!(c[0], (2, 1, 1));
        let later = t.counts_at(t0 + Duration::from_secs(600));
        assert_eq!(later[0], (0, 0, 0), "5m window has emptied");
        assert_eq!(later[1], (2, 1, 1), "1h window still holds both");
        assert_eq!(t.counts_at(t0 + Duration::from_secs(2 * 86_400))[2], (0, 0, 0));
    }

    #[test]
    fn ipv6_is_grouped_by_64_and_mapped_v4_equals_v4() {
        let t = ClientTracker::new();
        assert_eq!(t.key(ip("2001:db8:1:2::1")), t.key(ip("2001:db8:1:2:ffff::9")));
        assert_ne!(t.key(ip("2001:db8:1:2::1")), t.key(ip("2001:db8:1:3::1")));
        assert_eq!(t.key(ip("::ffff:10.0.0.9")), t.key(ip("10.0.0.9")));
    }

    #[test]
    fn log_id_is_short_and_not_the_address() {
        let t = ClientTracker::new();
        let id = t.log_id(ip("203.0.113.7"));
        assert_eq!(id.len(), 6);
        assert!(!id.contains("203"));
        assert_eq!(id, t.log_id(ip("203.0.113.7")));
    }
}
