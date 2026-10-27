//! Qwen3 token counting.
//!
//! The vector collections are chunked at ingest by the Qwen3-Embedding-0.6B
//! tokenizer, so the server measures sizes in the same unit. The ~11 MB
//! vocabulary is not vendored: it is loaded at startup from `TOKENIZER_PATH`
//! (default `data/qwen3_tokenizer.json`, Apache-2.0 — `make tokenizer` fetches
//! it). Without the file, counts fall back to a conservative 2 chars/token
//! estimate.

use std::path::PathBuf;
use std::sync::OnceLock;
use tokenizers::Tokenizer;

fn tokenizer_path() -> PathBuf {
    std::env::var_os("TOKENIZER_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("data/qwen3_tokenizer.json"))
}

fn tokenizer() -> Option<&'static Tokenizer> {
    static TOK: OnceLock<Option<Tokenizer>> = OnceLock::new();
    TOK.get_or_init(|| {
        let path = tokenizer_path();
        match Tokenizer::from_file(&path) {
            Ok(t) => Some(t),
            Err(e) => {
                tracing::warn!(
                    path = %path.display(),
                    error = %e,
                    "Qwen3 tokenizer not loaded; counting 2 chars/token"
                );
                None
            }
        }
    })
    .as_ref()
}

/// Number of Qwen3 tokens in `text`, special tokens excluded (mirrors Python's
/// `count_tokens` with `add_special_tokens=False`). If the tokenizer cannot be
/// loaded, falls back to a conservative 2 chars/token estimate so callers still
/// get a bounded result.
pub fn count_tokens(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    match tokenizer().and_then(|t| t.encode(text, false).ok()) {
        Some(enc) => enc.get_ids().len(),
        None => text.len().div_ceil(2),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Expected values recorded from the Python tokenizer
    // (`tokenizers.Tokenizer.from_file(...).encode(s, add_special_tokens=False)`).
    // Skipped when the vocabulary has not been downloaded (`make tokenizer`).
    #[test]
    fn matches_python_tokenizer() {
        if tokenizer().is_none() {
            eprintln!("skipping: data/qwen3_tokenizer.json not present");
            return;
        }
        assert_eq!(count_tokens("Hello world"), 2);
        assert_eq!(
            count_tokens("(b) for the purposes of calculating, under section 28(2), the salary t"),
            19
        );
        assert_eq!(
            count_tokens(
                "Power to enter premises under warrant\n\n2D.—(1) The court may, on the application of the Council, issue a warrant."
            ),
            28
        );
    }

    #[test]
    fn empty_is_zero() {
        assert_eq!(count_tokens(""), 0);
    }
}
