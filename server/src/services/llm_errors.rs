//! What the visitor is told when the model provider answers with an error.
//!
//! Follows the provider's documented error codes (DeepSeek: 400, 401, 402, 422, 429, 500, 503).
//! The text says what happened and what to do, but never carries the provider's body, the
//! key, or any internals. Codes the provider does not document get the generic message.

/// Fallback when there is no (documented) status code to go on.
pub const GENERIC: &str = "The assistant hit a problem reaching its language model. Please try again in a moment.";

/// Visitor-facing message for an HTTP status returned by the model provider.
pub fn user_message(status: u16) -> &'static str {
    match status {
        400 | 422 => "The request couldn't be processed by the language model. Please rephrase your question, or start a new chat if this one is very long.",
        401 => "The service can't sign in to its language model right now. This is a problem on our side, not yours. Please try again later.",
        402 => "The service has run out of language-model credit, so it can't answer right now. Please try again later.",
        429 => "The language model is receiving too many requests. Please wait a few seconds and try again.",
        500 => "The language model had an internal error. Please wait a moment and try again.",
        503 => "The language model is overloaded right now. Please wait a moment and try again.",
        _ => GENERIC,
    }
}

/// Pull `HTTP <code>` out of an internal error string such as `HTTP 402` or
/// `DeepSeek API error: HTTP 503`.
pub fn status_in(err: &str) -> Option<u16> {
    let rest = &err[err.find("HTTP ")? + 5..];
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok().filter(|s| (400..600).contains(s))
}

/// Visitor-facing message for an internal error string, or `fallback` if it names no status.
pub fn message_for<'a>(err: &str, fallback: &'a str) -> &'a str {
    match status_in(err) {
        Some(s) => user_message(s),
        None => fallback,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_documented_code_has_its_own_message() {
        let codes = [400, 401, 402, 422, 429, 500, 503];
        let msgs: Vec<_> = codes.iter().map(|c| user_message(*c)).collect();
        assert!(msgs.iter().all(|m| *m != GENERIC));
        assert_eq!(user_message(400), user_message(422));
        for (i, a) in msgs.iter().enumerate() {
            for (j, b) in msgs.iter().enumerate() {
                if i < j && !(codes[i] == 400 && codes[j] == 422) {
                    assert_ne!(a, b, "{} and {} share a message", codes[i], codes[j]);
                }
            }
        }
        assert!(user_message(402).contains("credit"));
        assert!(user_message(429).contains("too many"));
    }

    #[test]
    fn undocumented_codes_are_generic() {
        assert_eq!(user_message(418), GENERIC);
        assert_eq!(user_message(502), GENERIC);
    }

    #[test]
    fn finds_the_status_in_internal_errors() {
        assert_eq!(status_in("HTTP 402"), Some(402));
        assert_eq!(status_in("DeepSeek API error: HTTP 503"), Some(503));
        assert_eq!(status_in("DeepSeek API error: connection reset"), None);
        assert_eq!(status_in("HTTP 200"), None);
        assert_eq!(message_for("HTTP 402", "x"), user_message(402));
        assert_eq!(message_for("timed out", "fallback"), "fallback");
    }

    #[test]
    fn messages_never_leak_internals() {
        for c in [400, 401, 402, 422, 429, 500, 503, 0] {
            let m = user_message(c).to_lowercase();
            for bad in ["api key", "bearer", "deepseek", "http ", "sk-"] {
                assert!(!m.contains(bad), "{c}: {m}");
            }
        }
    }
}
