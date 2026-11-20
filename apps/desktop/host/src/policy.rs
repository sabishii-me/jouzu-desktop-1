//! Where a future sandbox decides (#197). Nothing is restricted yet: every
//! check allows and is logged, so the places that will decide already exist
//! and no caller has to be split apart later.
//!
//! Two kinds of hook:
//! - `authorize`: may this client do this action in this folder? Called by
//!   every task operation before it touches a session.
//! - `launch_profile`: how is a process started? Called where a runtime
//!   process is spawned; it will add the OS isolation later.

use std::path::Path;

use serde_json::json;

use crate::session::ApiError;

/// What a client asks the host to do on its behalf.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    StartTask,
    SendTask,
    StopTask,
    ReadTask,
    ListTasks,
    ReadInbox,
}

impl Action {
    pub fn as_str(self) -> &'static str {
        match self {
            Action::StartTask => "start_task",
            Action::SendTask => "send_task",
            Action::StopTask => "stop_task",
            Action::ReadTask => "read_task",
            Action::ListTasks => "list_tasks",
            Action::ReadInbox => "read_inbox",
        }
    }
}

/// May `client` do `action` in `workspace`? Allows for now; the decision is
/// logged so the future policy can be checked against real traffic.
pub fn authorize(
    home: &Path,
    client: &str,
    workspace: Option<&str>,
    action: Action,
) -> Result<(), ApiError> {
    crate::log(
        home,
        "debug",
        "policy.authorize",
        json!({ "client": client, "workspace": workspace, "action": action.as_str(), "decision": "allow" }),
    );
    Ok(())
}

/// Why a process is started; the sandbox will give each its own profile.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Launch {
    Runtime,
    Assistant,
}

/// Applies the launch profile for `purpose` to a command before it spawns.
/// No change yet.
pub fn launch_profile(_command: &mut tokio::process::Command, _purpose: Launch) {}
