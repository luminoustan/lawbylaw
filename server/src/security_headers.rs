//! Security response headers middleware.
//!
//! Mirrors Python `app/backend/security_headers.py` (79 lines).
//! Adds six standard security headers to every HTTP response:
//!   Content-Security-Policy, X-Content-Type-Options, X-Frame-Options,
//!   Strict-Transport-Security (non-localhost only), Referrer-Policy,
//!   Permissions-Policy.

use axum::{
    extract::Request,
    http::{HeaderMap, HeaderValue},
    middleware::Next,
    response::Response,
};

/// Where a browser may send requests besides this site: the two LLM providers a user can choose
/// to bring their own key for (`web/src/agent/providers.ts`), and Tavily, where a user's own search
/// key goes (`web/src/agent/tavily.ts`). Origins only, fixed at build time: there is no setting
/// that widens this, so a page that has been tampered with still cannot send a saved key anywhere
/// else. Tests below keep this list equal to what the web client calls.
const CSP: &str = concat!(
    "default-src 'self'; ",
    // Cloudflare Turnstile loads its script from, and renders its widget in a frame of, this
    // origin only (nothing else is allowed to script or frame).
    "script-src 'self' https://challenges.cloudflare.com; ",
    "frame-src https://challenges.cloudflare.com; ",
    "style-src 'self' 'unsafe-inline'; ",
    "img-src 'self' data:; ",
    "font-src 'self'; ",
    "connect-src 'self' https://api.deepseek.com https://api.tokenfactory.nebius.com https://api.tavily.com; ",
    "object-src 'none'; ",
    "base-uri 'none'; ",
    "form-action 'self'; ",
    "frame-ancestors 'none'"
);

const HSTS: &str = "max-age=31536000; includeSubDomains";

const LOCALHOST_HOSTS: [&str; 4] = ["localhost:8000", "127.0.0.1:8000", "localhost", "127.0.0.1"];


/// Axum middleware that adds security headers to every response.
pub async fn security_headers_middleware(req: Request, next: Next) -> Response {
    let host = req
        .headers()
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let is_localhost = LOCALHOST_HOSTS.contains(&host);

    let mut response = next.run(req).await;
    let headers = response.headers_mut();

    set_if_absent(headers, "content-security-policy", CSP);
    set_if_absent(headers, "x-content-type-options", "nosniff");
    set_if_absent(headers, "x-frame-options", "DENY");
    set_if_absent(headers, "referrer-policy", "no-referrer");
    set_if_absent(
        headers,
        "permissions-policy",
        "camera=(), microphone=(), geolocation=()",
    );

    // HSTS only for non-localhost hosts.
    set_if_absent(headers, "cross-origin-opener-policy", "same-origin");
    set_if_absent(headers, "cross-origin-resource-policy", "same-origin");

    if !is_localhost {
        set_if_absent(headers, "strict-transport-security", HSTS);
    }

    response
}

fn set_if_absent(headers: &mut HeaderMap, key: &str, value: &str) {
    if !headers.contains_key(key)
        && let Ok(v) = HeaderValue::from_str(value)
    {
        headers.insert(
            axum::http::HeaderName::from_bytes(key.as_bytes()).unwrap(),
            v,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::CSP;

    fn directive(name: &str) -> Vec<&'static str> {
        CSP.split("; ")
            .find_map(|d| d.strip_prefix(name).map(|rest| rest.split_whitespace().collect()))
            .unwrap_or_default()
    }

    #[test]
    fn connect_src_allows_only_this_site_the_two_providers_and_tavily() {
        assert_eq!(
            directive("connect-src "),
            ["'self'", "https://api.deepseek.com", "https://api.tokenfactory.nebius.com", "https://api.tavily.com"]
        );
    }

    /// The origins of every `baseUrl` in the web client's provider presets.
    fn client_provider_origins() -> Vec<String> {
        include_str!("../../web/src/agent/providers.ts")
            .lines()
            .filter_map(|l| l.trim().strip_prefix("baseUrl:"))
            .filter(|v| v.trim().starts_with('"')) // the preset values, not the interface field
            .map(|v| {
                let url = v.trim().trim_end_matches(',').trim_matches('"');
                let after_scheme = url.find("://").expect("provider baseUrl has a scheme") + 3;
                let end = url[after_scheme..].find('/').map_or(url.len(), |i| after_scheme + i);
                url[..end].to_string()
            })
            .collect()
    }

    /// The origin of `TAVILY_URL` in the web client.
    fn client_tavily_origin() -> &'static str {
        let line = include_str!("../../web/src/agent/tavily.ts")
            .lines()
            .find_map(|l| l.strip_prefix("export const TAVILY_URL = "))
            .expect("tavily.ts defines TAVILY_URL");
        let url = line.trim().trim_matches('"');
        let after_scheme = url.find("://").expect("TAVILY_URL has a scheme") + 3;
        let end = url[after_scheme..].find('/').map_or(url.len(), |i| after_scheme + i);
        &url[..end]
    }

    #[test]
    fn csp_allows_the_tavily_origin_the_client_calls() {
        assert!(directive("connect-src ").contains(&client_tavily_origin()));
        assert!(client_tavily_origin().starts_with("https://"));
    }

    #[test]
    fn csp_allows_exactly_the_providers_the_client_offers() {
        let providers = client_provider_origins();
        assert_eq!(providers.len(), 2, "expected two provider presets, found {providers:?}");
        let mut allowed = directive("connect-src ");
        allowed.retain(|s| *s != "'self'" && *s != client_tavily_origin());
        let mut expected: Vec<&str> = providers.iter().map(String::as_str).collect();
        allowed.sort();
        expected.sort();
        assert_eq!(allowed, expected);
        assert!(providers.iter().all(|p| p.starts_with("https://")));
    }

    #[test]
    fn everything_else_stays_locked_down() {
        assert_eq!(directive("default-src "), ["'self'"]);
        assert_eq!(directive("script-src "), ["'self'", "https://challenges.cloudflare.com"]);
        assert_eq!(directive("frame-src "), ["https://challenges.cloudflare.com"]);
        assert_eq!(directive("object-src "), ["'none'"]);
        assert_eq!(directive("frame-ancestors "), ["'none'"]);
        assert_eq!(directive("form-action "), ["'self'"]);
    }
}
