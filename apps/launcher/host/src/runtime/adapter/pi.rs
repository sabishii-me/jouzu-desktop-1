//! pi RPC record/adapter boundary.
//!
//! The session core owns state; this module owns the pi wire vocabulary. Adding
//! a record type or a delta kind starts here rather than in `session.rs`.

use serde_json::Value;

pub const KIND: &str = "pi";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Record {
    Response,
    AgentStart,
    MessageUpdate,
    ToolStart,
    ToolUpdate,
    ToolEnd,
    AgentSettled,
    CustomMessage,
    ExtensionUiRequest,
    ExtensionError,
    Error,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeltaKind {
    Text,
    Thinking,
    Other,
}

pub fn classify(value: &Value) -> Record {
    match value.get("type").and_then(Value::as_str) {
        Some("response") => Record::Response,
        Some("agent_start") => Record::AgentStart,
        Some("message_update") => Record::MessageUpdate,
        Some("tool_execution_start") => Record::ToolStart,
        Some("tool_execution_update") => Record::ToolUpdate,
        Some("tool_execution_end") => Record::ToolEnd,
        Some("agent_settled") => Record::AgentSettled,
        Some("custom_message") => Record::CustomMessage,
        Some("extension_ui_request") => Record::ExtensionUiRequest,
        Some("extension_error") => Record::ExtensionError,
        Some("error") => Record::Error,
        _ => Record::Other,
    }
}

pub fn delta_kind(value: &Value) -> DeltaKind {
    match value
        .get("assistantMessageEvent")
        .and_then(|update| update.get("type"))
        .and_then(Value::as_str)
    {
        Some("text_delta") => DeltaKind::Text,
        Some("thinking_delta") => DeltaKind::Thinking,
        _ => DeltaKind::Other,
    }
}

pub fn delta_text(value: &Value) -> &str {
    value
        .get("assistantMessageEvent")
        .and_then(|update| update.get("delta"))
        .and_then(Value::as_str)
        .unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn classifies_record_and_delta_kinds() {
        assert_eq!(classify(&json!({ "type": "agent_start" })), Record::AgentStart);
        assert_eq!(
            classify(&json!({ "type": "tool_execution_end" })),
            Record::ToolEnd
        );
        assert_eq!(classify(&json!({ "type": "unknown" })), Record::Other);
        assert_eq!(
            delta_kind(&json!({ "assistantMessageEvent": { "type": "thinking_delta", "delta": "x" } })),
            DeltaKind::Thinking
        );
        assert_eq!(
            delta_text(&json!({ "assistantMessageEvent": { "type": "text_delta", "delta": "hi" } })),
            "hi"
        );
    }
}
