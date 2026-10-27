//! Per-provider differences between OpenAI-compatible chat endpoints.
//!
//! The app was written against DeepSeek's own API. Nebius serves the same model through a
//! compatible endpoint but differs in ways that matter (found by `evals/provider-probe.mjs`):
//!
//! * DeepSeek's `thinking: {"type": "disabled"}` is accepted by Nebius and **silently ignored**,
//!   so the model keeps reasoning: it burns `max_tokens` and latency on hidden reasoning and can
//!   return an empty reply when the budget is small. Nebius needs `reasoning_effort: "none"`.
//! * Nebius has no DeepSeek Search API (`/v1/tools/search`).
//!
//! The provider is recognised from the configured base URL's host only, never from a free-form
//! string, so a look-alike host cannot select provider-specific behaviour.

use serde_json::{Value, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    DeepSeek,
    Nebius,
    /// Anything else (a local mock, a self-hosted gateway): keep the original DeepSeek-style payload.
    Other,
}

fn host_is(host: &str, domain: &str) -> bool {
    host == domain || host.strip_suffix(domain).is_some_and(|rest| rest.ends_with('.'))
}

impl Provider {
    /// Stable metric label.
    pub fn label(self) -> &'static str {
        match self {
            Provider::DeepSeek => "deepseek",
            Provider::Nebius => "nebius",
            Provider::Other => "other",
        }
    }

    pub fn from_base_url(base_url: &str) -> Self {
        let host = url::Url::parse(base_url)
            .ok()
            .and_then(|u| u.host_str().map(str::to_ascii_lowercase))
            .unwrap_or_default();
        if host_is(&host, "deepseek.com") {
            Provider::DeepSeek
        } else if host_is(&host, "nebius.com") {
            Provider::Nebius
        } else {
            Provider::Other
        }
    }

    /// Whether the provider offers the DeepSeek Search API the `web_search_deepseek` tool calls.
    pub fn has_deepseek_search(self) -> bool {
        self != Provider::Nebius
    }
}

/// Turn the model's hidden reasoning off in a chat-completions payload, using the switch the
/// provider actually honours. The app always wants this: deterministic tool arguments, no
/// reasoning tokens billed, and `max_tokens` spent on the visible answer.
pub fn disable_thinking(payload: &mut Value, base_url: &str) {
    let Some(obj) = payload.as_object_mut() else { return };
    match Provider::from_base_url(base_url) {
        Provider::Nebius => {
            obj.insert("reasoning_effort".into(), json!("none"));
        }
        Provider::DeepSeek | Provider::Other => {
            obj.insert("thinking".into(), json!({"type": "disabled"}));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn providers_are_recognised_by_host() {
        assert_eq!(Provider::from_base_url("https://api.deepseek.com"), Provider::DeepSeek);
        assert_eq!(Provider::from_base_url("https://api.deepseek.com/v1"), Provider::DeepSeek);
        assert_eq!(Provider::from_base_url("https://api.tokenfactory.nebius.com/v1"), Provider::Nebius);
        assert_eq!(Provider::from_base_url("https://API.STUDIO.NEBIUS.COM/v1/"), Provider::Nebius);
        assert_eq!(Provider::from_base_url("http://127.0.0.1:9100"), Provider::Other);
        assert_eq!(Provider::from_base_url("not a url"), Provider::Other);
    }

    #[test]
    fn look_alike_hosts_do_not_select_provider_behaviour() {
        for evil in [
            "https://nebius.com.evil.example/v1",
            "https://evilnebius.com/v1",
            "https://api.deepseek.com.evil.example",
            "https://evildeepseek.com",
            "https://example.com/?x=nebius.com",
            "https://nebius.com@evil.example/v1",
        ] {
            assert_eq!(Provider::from_base_url(evil), Provider::Other, "{evil}");
        }
    }

    #[test]
    fn nebius_gets_reasoning_effort_none_and_no_deepseek_thinking_field() {
        let mut p = json!({"model": "m", "messages": []});
        disable_thinking(&mut p, "https://api.tokenfactory.nebius.com/v1");
        assert_eq!(p["reasoning_effort"], "none");
        assert!(p.get("thinking").is_none(), "Nebius ignores `thinking`; do not send it");
    }

    #[test]
    fn deepseek_and_unknown_hosts_keep_the_thinking_field() {
        for base in ["https://api.deepseek.com", "http://127.0.0.1:9100"] {
            let mut p = json!({"model": "m"});
            disable_thinking(&mut p, base);
            assert_eq!(p["thinking"], json!({"type": "disabled"}), "{base}");
            assert!(p.get("reasoning_effort").is_none(), "{base}");
        }
    }

    #[test]
    fn existing_payload_fields_are_preserved() {
        let mut p = json!({"model": "m", "temperature": 0, "stream": true});
        disable_thinking(&mut p, "https://api.tokenfactory.nebius.com/v1");
        assert_eq!(p["model"], "m");
        assert_eq!(p["stream"], true);
    }

    #[test]
    fn only_nebius_lacks_the_deepseek_search_api() {
        assert!(!Provider::Nebius.has_deepseek_search());
        assert!(Provider::DeepSeek.has_deepseek_search());
        assert!(Provider::Other.has_deepseek_search());
    }
}
