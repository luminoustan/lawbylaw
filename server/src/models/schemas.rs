//! Wire types for the stateless chat API.

use serde::{Deserialize, Serialize};

/// One chat message supplied by the client. Only `user` / `assistant` roles are accepted.
#[derive(Debug, Clone, Deserialize)]
pub struct ClientMessage {
    pub role: String,
    pub content: String,
}

/// Inbound chat request (`POST /api/chat`). The client owns the history.
#[derive(Debug, Clone, Deserialize)]
pub struct ChatRequest {
    pub messages: Vec<ClientMessage>,
    #[serde(default)]
    pub mode: Option<String>,
    /// Summary of earlier turns written by `/compact` (client-held).
    #[serde(default)]
    pub summary: Option<String>,
}

/// Inbound `POST /api/compact`: the older part of a chat to summarise, and the summary already in force.
#[derive(Debug, Clone, Deserialize)]
pub struct CompactRequest {
    pub history: Vec<ClientMessage>,
    #[serde(default)]
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
}

/// SSE event types sent to the frontend during streaming chat.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum SseEvent {
    #[serde(rename = "session")]
    Session { session_id: String },
    #[serde(rename = "token")]
    Token { content: String },
    #[serde(rename = "tool_call")]
    ToolCall {
        name: String,
        arguments: serde_json::Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    #[serde(rename = "tool_progress")]
    ToolProgress {
        name: String,
        searches: u32,
        phase: String,
    },
    #[serde(rename = "tool_result")]
    ToolResult {
        name: String,
        result: serde_json::Value,
        /// Id of the `tool_call` this answers; lets clients pair parallel calls
        /// of the same tool.
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    #[serde(rename = "heartbeat")]
    Heartbeat,
    #[serde(rename = "done")]
    Done,
    #[serde(rename = "error")]
    Error { error: String },
    #[serde(rename = "context_usage")]
    ContextUsage { used: u64, max: u64, percent: u64 },
    #[serde(rename = "usage")]
    Usage {
        prompt_tokens: u64,
        completion_tokens: u64,
        total_tokens: u64,
    },
    #[serde(rename = "legislation_citations")]
    LegislationCitations { citations: Vec<LegislationCitation> },
    /// A research sub-agent's search is waiting for the reranker (the GPU is the shared
    /// bottleneck). `waiting` is how many searches are queued, `eta_s` a rough wait in
    /// seconds. `waiting: 0` clears the notice. `task_id` is the research tool-call id.
    #[serde(rename = "queue")]
    Queue { task_id: String, waiting: usize, eta_s: u64 },
    /// A research search hit the database deadline (`timeout_s` seconds) because Qdrant is
    /// busy; the model may retry. `timeout_s: 0` clears the notice once a search succeeds.
    #[serde(rename = "db_slow")]
    DbSlow { task_id: String, timeout_s: u64 },
    /// Informational notice (e.g. older turns were trimmed to fit the context budget).
    #[serde(rename = "notice")]
    Notice { message: String },
    /// Earlier turns were summarised. The client stores `summary` and sends it back
    /// instead of the turns it replaced, keeping all but the last `kept` messages out.
    /// Retract the answer text streamed so far in the current reply (the most
    /// recent text part): the model is replacing it with a corrected answer, or
    /// the text was narration that preceded a tool call.
    #[serde(rename = "answer_reset")]
    AnswerReset,
    /// The model is composing (or verifying) its answer; the UI shows "Synthesizing".
    #[serde(rename = "phase")]
    Phase { phase: String },
    /// Estimated split of the prompt, so the context ring can break it down.
    /// `system` excludes the sub-agent guidance block, which is reported
    /// separately as `subagent` (mirrors the reference agent's `context-sizes`).
    #[serde(rename = "breakdown")]
    Breakdown {
        system: u64,
        tools: u64,
        summary: u64,
        subagent: u64,
    },
    /// A research sub-agent started. `task_id` is the outer tool-call id.
    #[serde(rename = "subagent_start")]
    SubagentStart {
        task_id: String,
        tool: String,
        description: String,
        subagent_type: String,
        prompt: String,
    },
    /// The sub-agent issued one of its own searches.
    #[serde(rename = "subagent_tool_call")]
    SubagentToolCall {
        task_id: String,
        id: String,
        name: String,
        arguments: serde_json::Value,
    },
    #[serde(rename = "subagent_tool_result")]
    SubagentToolResult {
        task_id: String,
        id: String,
        name: String,
        result: String,
        is_error: bool,
    },
    #[serde(rename = "subagent_end")]
    SubagentEnd {
        task_id: String,
        is_error: bool,
        output: String,
    },
    /// The model asked the user a clarifying question via the `askquestion`
    /// tool. The client renders `questions` as an interactive form and replies
    /// in a later turn. `requestId` is camelCase to match the web client's
    /// `QuestionRequestMsg` (adapted from a reference agent).
    #[serde(rename = "questionRequest")]
    QuestionRequest {
        #[serde(rename = "requestId")]
        request_id: String,
        questions: serde_json::Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
    },
}

/// A single SSO citation for a legislation section.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LegislationCitation {
    pub act_name: String,
    pub section: String,
    pub label: String,
    pub url: String,
    /// `act` or `subsidiary_legislation`; lets the client prefer the right kind
    /// when a section number is shared ("Section 13" vs "Regulation 13").
    #[serde(default)]
    pub doc_type: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn question_request_serialises_with_camelcase_request_id() {
        let ev = SseEvent::QuestionRequest {
            request_id: "req-1".into(),
            questions: serde_json::json!([{"id": "a", "prompt": "p", "options": []}]),
            title: Some("A few details".into()),
        };
        let s = serde_json::to_string(&ev).unwrap();
        assert!(s.contains("\"type\":\"questionRequest\""), "{s}");
        assert!(s.contains("\"requestId\":\"req-1\""), "{s}");
        assert!(s.contains("\"title\":\"A few details\""), "{s}");
        assert!(s.contains("\"questions\":[{\"id\":\"a\""), "{s}");
    }

    #[test]
    fn question_request_omits_absent_title() {
        let ev = SseEvent::QuestionRequest {
            request_id: "r".into(),
            questions: serde_json::json!([]),
            title: None,
        };
        assert!(!serde_json::to_string(&ev).unwrap().contains("title"));
    }
}
