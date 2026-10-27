//! Tool nudge and finalization check, adapted from a reference agent
//! (`packages/agent/src/backend/agent/{tool-nudge,finalization-check}.ts`) and adapted
//! from "workspace" wording to legal research.
//!
//! * Tool nudge: after each round of tool calls, a short `<system-reminder>` is appended
//!   to the last tool result. It rides on a request that happens anyway and sits at the
//!   tail of history, so the cached prefix is untouched.
//! * Finalization check: when the model ends with a plain answer, the answer is held
//!   back and one verification nudge is sent. The model replies `OK` (draft shown
//!   unchanged), investigates with tools (draft kept) or writes the complete
//!   corrected answer (that reply is shown instead of the draft).

use serde_json::Value;

pub const DEFAULT_TOOL_NUDGE: &str = "Check these results against the user's question: what is still unverified or not yet answered? \
Treat anything you only saw in a search snippet as a claim to confirm against the exact provision or case text, not a fact. \
Keep searching until the question is fully answered, unless your instructions limit the number of searches; write the answer only when you are done.";

pub const FINALIZATION_OK: &str = "OK";
pub const MAX_NUDGES: usize = 1;
/// Skip the check once this many tool steps ran in the turn: the model already investigated.
pub const SKIP_AFTER_TOOL_STEPS: usize = 5;

pub const FINALIZATION_NUDGE: &str = "Check the draft answer above against the user's latest message only. \
A claim about a statute, section, subsidiary legislation or case is verified only if a search result in this turn directly shows it. \
Section numbers, provision text and case names recalled from memory or inferred are not verified: check them with the search tools now. \
General legal principles that need no citation need no search. \
Do not re-open or re-verify earlier turns, even when the latest message is a follow-up; earlier answers are not the subject of this check. \
If nothing needs checking, reply with exactly `OK` and nothing else. \
If something needs correcting, reply with the complete corrected answer to the latest message, not just a list of corrections. \
Do not write a verification checklist.";

/// Wrap the note so the model can tell it apart from the tool's own output.
pub fn format_tool_nudge(message: &str) -> String {
    format!("<system-reminder>\n{message}\n</system-reminder>")
}

/// Append the nudge to the last tool-role message in `messages`. No-op if none.
pub fn attach_tool_nudge(messages: &mut [Value], message: &str) {
    let Some(last) = messages
        .iter_mut()
        .rev()
        .find(|m| m.get("role").and_then(|r| r.as_str()) == Some("tool"))
    else {
        return;
    };
    let cur = last.get("content").and_then(|c| c.as_str()).unwrap_or("").to_string();
    let note = format_tool_nudge(message);
    let content = if cur.is_empty() { note } else { format!("{cur}\n\n{note}") };
    last["content"] = Value::String(content);
}

/// True when the reply is just the OK sentinel (tolerating case, quotes, backticks, a period).
pub fn is_ok_reply(text: &str) -> bool {
    let t = text
        .trim()
        .trim_matches(|c: char| c == '`' || c == '"' || c == '\'' || c == '*' || c == '.' || c.is_whitespace());
    t.eq_ignore_ascii_case(FINALIZATION_OK)
}

/// Hold the first final answer for one verification pass only when this turn
/// actually did research to verify against. A zero-tool turn has nothing new
/// to check and would only invite the model to re-open earlier turns.
pub fn should_check(
    config_enabled: bool,
    nudges_used: usize,
    tool_steps: usize,
    was_pending: bool,
) -> bool {
    was_pending
        || (config_enabled
            && nudges_used < MAX_NUDGES
            && tool_steps >= 1
            && tool_steps < SKIP_AFTER_TOOL_STEPS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ok_reply_variants() {
        for s in ["OK", " ok. ", "`OK`", "\"OK\"", "**OK**"] {
            assert!(is_ok_reply(s), "{s}");
        }
        for s in ["OK, but", "Okay then", "", "The answer is OK"] {
            assert!(!is_ok_reply(s), "{s}");
        }
    }

    #[test]
    fn check_runs_only_after_tool_work_and_only_once() {
        assert!(!should_check(true, 0, 0, false), "zero-tool turn needs no check");
        assert!(should_check(true, 0, 1, false), "one tool step is enough");
        assert!(!should_check(true, 0, SKIP_AFTER_TOOL_STEPS, false));
        assert!(should_check(true, 1, 1, true), "a pending draft must finish its check");
        assert!(!should_check(true, MAX_NUDGES, 1, false));
        assert!(!should_check(false, 0, 1, false));
    }

    #[test]
    fn finalization_nudge_is_scoped_to_the_latest_message() {
        assert!(FINALIZATION_NUDGE.contains("latest message"));
        assert!(FINALIZATION_NUDGE.contains("Do not re-open or re-verify earlier turns"));
        assert!(FINALIZATION_NUDGE.contains("reply with exactly `OK`"));
        assert!(FINALIZATION_NUDGE.contains("complete corrected answer"));
        assert!(FINALIZATION_NUDGE.contains("Do not write a verification checklist"));
    }

    #[test]
    fn nudge_attaches_to_last_tool_result_only() {
        let mut m = vec![
            json!({"role":"tool","tool_call_id":"a","content":"one"}),
            json!({"role":"tool","tool_call_id":"b","content":"two"}),
        ];
        attach_tool_nudge(&mut m, "check");
        assert_eq!(m[0]["content"], "one");
        assert!(m[1]["content"].as_str().unwrap().starts_with("two\n\n<system-reminder>"));
        let mut empty: Vec<Value> = vec![json!({"role":"user","content":"x"})];
        attach_tool_nudge(&mut empty, "check");
        assert_eq!(empty[0]["content"], "x");
    }
}
