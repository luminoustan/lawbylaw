//! Text normalization for RAG chunks — mirrors Python `text_normalize.py`.

/// Normalize RAG text by collapsing whitespace.
///
/// - Strips leading/trailing whitespace
/// - Collapses horizontal whitespace runs into single spaces
/// - Collapses 3+ newlines into `\n\n`
pub fn normalize_rag_text(text: &str) -> String {
    // Collapse horizontal whitespace
    let mut result = String::with_capacity(text.len());
    let mut last_was_space = false;

    for ch in text.chars() {
        if ch == ' ' || ch == '\t' || ch == '\r' {
            if !last_was_space {
                result.push(' ');
                last_was_space = true;
            }
        } else if ch == '\n' {
            // Track consecutive newlines for vertical collapse.
            result.push('\n');
            last_was_space = false;
        } else {
            result.push(ch);
            last_was_space = false;
        }
    }

    // Collapse 3+ consecutive newlines into "\n\n".
    let mut collapsed = String::with_capacity(result.len());
    let mut newline_count = 0;
    for ch in result.chars() {
        if ch == '\n' {
            newline_count += 1;
            if newline_count <= 2 {
                collapsed.push('\n');
            }
        } else {
            newline_count = 0;
            collapsed.push(ch);
        }
    }

    collapsed.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_collapse_spaces() {
        assert_eq!(normalize_rag_text("hello    world"), "hello world");
    }

    #[test]
    fn test_collapse_newlines() {
        assert_eq!(normalize_rag_text("line1\n\n\n\n\nline2"), "line1\n\nline2");
    }

    #[test]
    fn test_trim() {
        assert_eq!(normalize_rag_text("  \n  hello  \n  "), "hello");
    }
}
