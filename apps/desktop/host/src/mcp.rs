//! The MCP endpoint other agents use to hand work to Desktop.
//!
//! Off until the user turns it on in Settings > Collaboration. It listens on
//! 127.0.0.1 only, on its own port, at one path (`/mcp`), and answers the
//! JSON-RPC subset tools need: initialize, ping, tools/list, tools/call.
//!
//! Each agent has its own token, created by the user and shown once. The host
//! keeps only its SHA-256. Agent tokens and the host's own token are never
//! interchangeable: an agent token opens nothing but `/mcp`, and the host
//! token does not open `/mcp`.
//!
//! The tools are task operations only. Everything that is the user's to
//! decide stays out: approvals and answers, Flow, TextGuard, keys and
//! environment, tool and web-access settings, adding folders, deleting
//! sessions, slash commands.

use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    body::Bytes,
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{
    session::{ApiError, SessionManager},
    tasks::TaskManager,
};

pub const DEFAULT_PORT: u16 = 47615;
const PROTOCOL_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];
/// Client ids the host uses itself; never given to an agent.
const RESERVED_CLIENTS: [&str; 2] = ["desktop", "assistant"];

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentClient {
    pub id: String,
    pub name: String,
    /// SHA-256 of the token, hex. The token itself is never stored.
    token_hash: String,
    #[serde(default = "default_scopes")]
    pub scopes: Vec<String>,
    /// Folders this agent may start tasks in. Empty: every folder the user added.
    #[serde(default)]
    pub workspaces: Vec<String>,
    pub created_at: String,
}

impl AgentClient {
    /// A client the host runs itself (the Assistant): no token, every folder.
    pub(crate) fn builtin(id: &str) -> Self {
        Self {
            id: id.to_string(),
            name: id.to_string(),
            token_hash: String::new(),
            scopes: default_scopes(),
            workspaces: Vec::new(),
            created_at: String::new(),
        }
    }
}

fn default_scopes() -> Vec<String> {
    vec!["tasks".to_string()]
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    #[serde(default)]
    enabled: bool,
    #[serde(default = "default_port")]
    port: u16,
}

fn default_port() -> u16 {
    DEFAULT_PORT
}

impl Default for Settings {
    fn default() -> Self {
        Self { enabled: false, port: DEFAULT_PORT }
    }
}

struct Listener {
    port: u16,
    stop: tokio::sync::oneshot::Sender<()>,
}

pub struct McpServer {
    home: PathBuf,
    version: String,
    tasks: Arc<TaskManager>,
    sessions: Arc<SessionManager>,
    clients: Mutex<Vec<AgentClient>>,
    settings: Mutex<Settings>,
    listener: tokio::sync::Mutex<Option<Listener>>,
    error: Mutex<Option<String>>,
}

fn hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// Equal without telling how much matched.
fn same(left: &str, right: &str) -> bool {
    left.len() == right.len()
        && left
            .bytes()
            .zip(right.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

fn random_hex(bytes: usize) -> String {
    use rand::RngCore;
    let mut buffer = vec![0u8; bytes];
    rand::rngs::OsRng.fill_bytes(&mut buffer);
    hex::encode(buffer)
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), ApiError> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| ApiError::internal(error.to_string()))?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, bytes).map_err(|error| ApiError::internal(error.to_string()))?;
    std::fs::rename(&temp, path).map_err(|error| ApiError::internal(error.to_string()))
}

impl McpServer {
    pub fn new(home: &Path, version: &str, tasks: Arc<TaskManager>, sessions: Arc<SessionManager>) -> Arc<Self> {
        let clients = std::fs::read(home.join("agent-clients.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Vec<AgentClient>>(&bytes).ok())
            .unwrap_or_default();
        let settings = std::fs::read(home.join("mcp-server.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Settings>(&bytes).ok())
            .unwrap_or_default();
        Arc::new(Self {
            home: home.to_path_buf(),
            version: version.to_string(),
            tasks,
            sessions,
            clients: Mutex::new(clients),
            settings: Mutex::new(settings),
            listener: tokio::sync::Mutex::new(None),
            error: Mutex::new(None),
        })
    }

    fn clients_guard(&self) -> std::sync::MutexGuard<'_, Vec<AgentClient>> {
        self.clients.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn settings(&self) -> Settings {
        self.settings.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
    }

    /// The agent a token belongs to.
    pub fn verify(&self, token: &str) -> Option<AgentClient> {
        let presented = hash(token);
        let clients = self.clients_guard();
        let mut found = None;
        for client in clients.iter() {
            if !client.token_hash.is_empty() && same(&client.token_hash, &presented) {
                found = Some(client.clone());
            }
        }
        found
    }

    /// Adds an agent and returns its token. This is the only time it is shown.
    pub fn create_client(&self, name: &str) -> Result<Value, ApiError> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 80 {
            return Err(ApiError::bad_request("Give the agent a name of at most 80 characters"));
        }
        let token = format!("jdmcp_{}", random_hex(32));
        let client = AgentClient {
            id: format!("agent-{}", random_hex(6)),
            name: name.to_string(),
            token_hash: hash(&token),
            scopes: default_scopes(),
            workspaces: Vec::new(),
            created_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        };
        debug_assert!(!RESERVED_CLIENTS.contains(&client.id.as_str()));
        {
            let mut clients = self.clients_guard();
            clients.push(client.clone());
            write_json(&self.home.join("agent-clients.json"), &*clients)?;
        }
        crate::log(&self.home, "info", "mcp.client.created", json!({ "client": client.id }));
        Ok(json!({ "client": client_view(&client), "token": token }))
    }

    pub fn revoke_client(&self, id: &str) -> Result<(), ApiError> {
        let mut clients = self.clients_guard();
        let before = clients.len();
        clients.retain(|client| client.id != id);
        if clients.len() == before {
            return Err(ApiError::new(StatusCode::NOT_FOUND, "client-not-found", "No such agent", false));
        }
        write_json(&self.home.join("agent-clients.json"), &*clients)?;
        crate::log(&self.home, "info", "mcp.client.revoked", json!({ "client": id }));
        Ok(())
    }

    pub async fn snapshot(&self) -> Value {
        let settings = self.settings();
        let serving = self.listener.lock().await.as_ref().map(|listener| listener.port);
        let clients: Vec<Value> = self.clients_guard().iter().map(client_view).collect();
        json!({
            "enabled": settings.enabled,
            "port": settings.port,
            "url": format!("http://127.0.0.1:{}/mcp", settings.port),
            "serving": serving.is_some(),
            "error": self.error.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone(),
            "clients": clients,
        })
    }

    pub async fn update(self: &Arc<Self>, enabled: Option<bool>, port: Option<u16>) -> Result<Value, ApiError> {
        if port.is_some_and(|port| port < 1024) {
            return Err(ApiError::bad_request("Choose a port from 1024 to 65535"));
        }
        {
            let mut settings = self.settings.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(enabled) = enabled {
                settings.enabled = enabled;
            }
            if let Some(port) = port {
                settings.port = port;
            }
            write_json(&self.home.join("mcp-server.json"), &*settings)?;
        }
        self.reconcile().await;
        Ok(self.snapshot().await)
    }

    /// Listens when enabled, on the chosen port; stops otherwise.
    pub async fn reconcile(self: &Arc<Self>) {
        let settings = self.settings();
        let mut listener = self.listener.lock().await;
        let keep = settings.enabled && listener.as_ref().is_some_and(|current| current.port == settings.port);
        if keep {
            return;
        }
        if let Some(current) = listener.take() {
            let _ = current.stop.send(());
            crate::log(&self.home, "info", "mcp.listener.stopped", json!({ "port": current.port }));
        }
        *self.error.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        if !settings.enabled {
            return;
        }
        let address = std::net::SocketAddr::from(([127, 0, 0, 1], settings.port));
        match tokio::net::TcpListener::bind(address).await {
            Ok(tcp) => {
                let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
                let app = router(Arc::clone(self), settings.port);
                let home = self.home.clone();
                tokio::spawn(async move {
                    let result = axum::serve(tcp, app)
                        .with_graceful_shutdown(async move {
                            let _ = stopped.await;
                        })
                        .await;
                    if let Err(error) = result {
                        crate::log(&home, "error", "mcp.listener.failed", json!({ "error": error.to_string() }));
                    }
                });
                crate::log(&self.home, "info", "mcp.listener.started", json!({ "port": settings.port }));
                *listener = Some(Listener { port: settings.port, stop });
            }
            Err(error) => {
                let message = format!("Port {} is not available: {error}", settings.port);
                crate::log(&self.home, "error", "mcp.listener.failed", json!({ "port": settings.port, "error": error.to_string() }));
                *self.error.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(message);
            }
        }
    }
}

fn client_view(client: &AgentClient) -> Value {
    json!({
        "id": client.id,
        "name": client.name,
        "scopes": client.scopes,
        "workspaces": client.workspaces,
        "createdAt": client.created_at,
    })
}

#[derive(Clone)]
struct McpState {
    server: Arc<McpServer>,
    port: u16,
}

pub fn router(server: Arc<McpServer>, port: u16) -> Router {
    Router::new()
        .route("/mcp", post(handle).get(no_stream).delete(no_stream))
        .with_state(McpState { server, port })
}

/// No server-initiated stream: every answer comes with its request.
async fn no_stream() -> Response {
    (StatusCode::METHOD_NOT_ALLOWED, [(header::ALLOW, "POST")]).into_response()
}

fn refuse(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

/// Only this computer's loopback names: a web page elsewhere cannot reach in
/// through a renamed host (DNS rebinding).
fn loopback(headers: &HeaderMap, port: u16) -> bool {
    let allowed = |value: &str| {
        let value = value.to_ascii_lowercase();
        [format!("127.0.0.1:{port}"), format!("localhost:{port}"), format!("[::1]:{port}")]
            .iter()
            .any(|name| value == *name || value == format!("http://{name}"))
    };
    let host_ok = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .is_some_and(allowed);
    let origin_ok = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .is_none_or(allowed);
    host_ok && origin_ok
}

async fn handle(State(state): State<McpState>, headers: HeaderMap, body: Bytes) -> Response {
    if !loopback(&headers, state.port) {
        return refuse(StatusCode::FORBIDDEN, "Unknown Host or Origin");
    }
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .unwrap_or("");
    let Some(client) = (!token.is_empty()).then(|| state.server.verify(token)).flatten() else {
        return (
            StatusCode::UNAUTHORIZED,
            [(header::WWW_AUTHENTICATE, "Bearer")],
            Json(json!({ "error": "Use the agent token from Settings > Collaboration" })),
        )
            .into_response();
    };
    let Ok(message) = serde_json::from_slice::<Value>(&body) else {
        return Json(rpc_error(Value::Null, -32700, "Parse error")).into_response();
    };
    if message.is_array() {
        return Json(rpc_error(Value::Null, -32600, "Batches are not supported")).into_response();
    }
    let Some(method) = message["method"].as_str() else {
        // A response or something else from the client: nothing to answer.
        return StatusCode::ACCEPTED.into_response();
    };
    let Some(id) = message.get("id").cloned() else {
        // A notification (initialized, cancelled): accepted, no answer.
        return StatusCode::ACCEPTED.into_response();
    };
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let answer = match method {
        "initialize" => {
            let asked = params["protocolVersion"].as_str().unwrap_or("");
            let version = PROTOCOL_VERSIONS
                .iter()
                .find(|version| **version == asked)
                .copied()
                .unwrap_or(PROTOCOL_VERSIONS[0]);
            rpc_result(
                id,
                json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": "jouzu-desktop", "version": state.server.version },
                    "instructions": INSTRUCTIONS,
                }),
            )
        }
        "ping" => rpc_result(id, json!({})),
        "tools/list" => rpc_result(id, json!({ "tools": task_tools() })),
        "tools/call" => {
            let name = params["name"].as_str().unwrap_or("").to_string();
            let arguments = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            let result = call_task_tool(&state.server.tasks, &state.server.sessions, &client, &name, &arguments).await;
            rpc_result(id, tool_result(result))
        }
        _ => rpc_error(id, -32601, "Method not found"),
    };
    Json(answer).into_response()
}

fn rpc_result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// A tool's outcome. A refused call is a result the agent reads, not a
/// protocol error.
fn tool_result(result: Result<Value, ApiError>) -> Value {
    match result {
        Ok(value) => json!({
            "content": [{ "type": "text", "text": value.to_string() }],
            "structuredContent": value,
            "isError": false,
        }),
        Err(error) => {
            let value = json!({ "error": { "code": error.code, "message": error.message, "retryable": error.retryable } });
            json!({
                "content": [{ "type": "text", "text": value.to_string() }],
                "structuredContent": value,
                "isError": true,
            })
        }
    }
}

const INSTRUCTIONS: &str = "Jouzu Desktop runs coding tasks for you in folders the user added. \
Each task is a Desktop session the user can open and watch. Calls return at once: start a task, \
then wait on your inbox (wait_inbox) and read a task when it reports. The inbox keeps one entry \
per task, the latest state; acknowledge entries you have handled (ack_inbox). Approvals, \
questions and held messages are the user's to answer in Desktop; a task in waiting_user or held \
waits for them.";

fn string_arg<'a>(arguments: &'a Value, name: &str) -> Result<&'a str, ApiError> {
    arguments[name]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| ApiError::bad_request(format!("{name} is required")))
}

/// The task tools, as MCP lists them. The Assistant gets the same ones.
pub(crate) fn task_tools() -> Vec<Value> {
    let task_id = json!({ "type": "string", "description": "The taskId start_task returned." });
    vec![
        json!({
            "name": "list_workspaces",
            "description": "Folders the user added to Desktop. Tasks can run only in these.",
            "inputSchema": { "type": "object", "properties": {} },
        }),
        json!({
            "name": "start_task",
            "description": "Start a task: a new Desktop session in a folder, given its first message. Returns at once with the taskId; progress reaches your inbox.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "workspace": { "type": "string", "description": "A folder path from list_workspaces (or inside one)." },
                    "text": { "type": "string", "description": "What the task should do. Slash commands are not allowed." },
                    "model": {
                        "type": "object",
                        "description": "Optional: run the task on this model (from list_models). Default: the user's default model.",
                        "properties": { "provider": { "type": "string" }, "id": { "type": "string" } },
                        "required": ["provider", "id"],
                    },
                },
                "required": ["workspace", "text"],
            },
        }),
        json!({
            "name": "list_models",
            "description": "The models tasks can run on, as the runtime reports them.",
            "inputSchema": { "type": "object", "properties": {} },
        }),
        json!({
            "name": "send_task",
            "description": "Send a follow-up message to a task. Returns at once.",
            "inputSchema": {
                "type": "object",
                "properties": { "taskId": task_id, "text": { "type": "string" } },
                "required": ["taskId", "text"],
            },
        }),
        json!({
            "name": "stop_task",
            "description": "Stop what a task is doing now. Its conversation stays and can continue with send_task.",
            "inputSchema": { "type": "object", "properties": { "taskId": task_id }, "required": ["taskId"] },
        }),
        json!({
            "name": "get_task",
            "description": "A task's current state: waiting_to_start, starting, running, waiting_user, held, finished, failed, stopped or unloaded (not open now; read_task still works).",
            "inputSchema": { "type": "object", "properties": { "taskId": task_id }, "required": ["taskId"] },
        }),
        json!({
            "name": "list_tasks",
            "description": "Your tasks with their current state.",
            "inputSchema": { "type": "object", "properties": {} },
        }),
        json!({
            "name": "read_task",
            "description": "A task's latest messages, oldest first, each in full. limit is how many messages.",
            "inputSchema": {
                "type": "object",
                "properties": { "taskId": task_id, "limit": { "type": "integer", "minimum": 1, "maximum": 200, "default": 20 } },
                "required": ["taskId"],
            },
        }),
        json!({
            "name": "read_inbox",
            "description": "Task state changes not yet acknowledged, one entry per task (the latest). Pass after = the last seq you saw to get only newer ones.",
            "inputSchema": { "type": "object", "properties": { "after": { "type": "integer", "minimum": 0 } } },
        }),
        json!({
            "name": "wait_inbox",
            "description": "Like read_inbox, but waits until something arrives or the time is up (at most 60 seconds).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "after": { "type": "integer", "minimum": 0 },
                    "timeoutSeconds": { "type": "integer", "minimum": 1, "maximum": 60, "default": 25 },
                },
            },
        }),
        json!({
            "name": "ack_inbox",
            "description": "Remove inbox entries up to and including seq: you have handled them.",
            "inputSchema": { "type": "object", "properties": { "seq": { "type": "integer", "minimum": 0 } }, "required": ["seq"] },
        }),
    ]
}

/// Folders this agent may use: the user's, narrowed by the agent's own list.
fn agent_workspaces(sessions: &SessionManager, client: &AgentClient) -> Vec<Value> {
    sessions
        .workspaces()
        .into_iter()
        .filter(|value| {
            client.workspaces.is_empty()
                || value["path"].as_str().is_some_and(|path| {
                    let path = Path::new(path);
                    client.workspaces.iter().any(|root| path.starts_with(root))
                })
        })
        .map(|value| {
            let name = value["path"]
                .as_str()
                .and_then(|path| Path::new(path).file_name())
                .map(|name| name.to_string_lossy().into_owned());
            json!({ "path": value["path"], "name": name })
        })
        .collect()
}

/// Runs one task tool for `client`. Unknown names are refused.
pub(crate) async fn call_task_tool(
    tasks: &Arc<TaskManager>,
    sessions: &SessionManager,
    client: &AgentClient,
    name: &str,
    arguments: &Value,
) -> Result<Value, ApiError> {
    if !client.scopes.iter().any(|scope| scope == "tasks") {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "scope-missing", "This agent may not run tasks", false));
    }
    let id = client.id.as_str();
    match name {
        "list_workspaces" => Ok(json!({ "workspaces": agent_workspaces(sessions, client) })),
        "start_task" => {
            let workspace = string_arg(arguments, "workspace")?;
            if !client.workspaces.is_empty() {
                let candidate = Path::new(workspace).canonicalize().unwrap_or_default();
                let inside = client
                    .workspaces
                    .iter()
                    .filter_map(|root| Path::new(root).canonicalize().ok())
                    .any(|root| candidate.starts_with(root));
                if !inside {
                    return Err(ApiError::new(
                        StatusCode::FORBIDDEN,
                        "workspace-not-allowed",
                        "This agent may not use that folder",
                        false,
                    ));
                }
            }
            let model = arguments.get("model").filter(|model| !model.is_null()).cloned();
            tasks.start_with(id, workspace, string_arg(arguments, "text")?, model)
        }
        "list_models" => {
            let answer = sessions.runtime_models().await.unwrap_or_else(|| {
                Err(ApiError::unavailable("The runtime has not listed its models yet. Try again shortly."))
            })?;
            let models: Vec<Value> = answer["models"]
                .as_array()
                .map(|models| {
                    models
                        .iter()
                        .map(|model| json!({
                            "provider": model["provider"],
                            "id": model["id"],
                            "name": model["name"],
                            "reasoning": model["reasoning"],
                            "contextWindow": model["contextWindow"],
                        }))
                        .collect()
                })
                .unwrap_or_default();
            Ok(json!({ "models": models }))
        }
        "send_task" => tasks.send(id, string_arg(arguments, "taskId")?, string_arg(arguments, "text")?),
        "stop_task" => tasks.stop(id, string_arg(arguments, "taskId")?),
        "get_task" => tasks.get(id, string_arg(arguments, "taskId")?),
        "list_tasks" => tasks.list(id),
        "read_task" => {
            let limit = arguments["limit"].as_u64().unwrap_or(20) as usize;
            tasks.read(id, string_arg(arguments, "taskId")?, limit)
        }
        "read_inbox" => tasks.inbox(id, arguments["after"].as_u64().unwrap_or(0)),
        "wait_inbox" => {
            let seconds = arguments["timeoutSeconds"].as_u64().unwrap_or(25).clamp(1, 60);
            tasks
                .wait(id, arguments["after"].as_u64().unwrap_or(0), Duration::from_secs(seconds))
                .await
        }
        "ack_inbox" => {
            let seq = arguments["seq"]
                .as_u64()
                .ok_or_else(|| ApiError::bad_request("seq is required"))?;
            tasks.ack(id, seq)
        }
        _ => Err(ApiError::new(StatusCode::NOT_FOUND, "unknown-tool", format!("No tool named {name}"), false)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::RuntimeSpec;
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    const PORT: u16 = 47999;

    fn setup() -> (Arc<McpServer>, tempfile::TempDir, tempfile::TempDir) {
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-runtime.mjs");
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let sessions = Arc::new(SessionManager::new(
            Some(RuntimeSpec::node_script(&fixture)),
            home.path().to_path_buf(),
            home.path().join("data"),
            None,
            50,
            None,
        ));
        sessions.add_workspaces(&[workspace.path().to_string_lossy().into_owned()]).unwrap();
        let tasks = TaskManager::new(sessions.clone(), 4);
        (McpServer::new(home.path(), "9.9.9", tasks, sessions), home, workspace)
    }

    async fn rpc(server: &Arc<McpServer>, token: &str, body: Value) -> (StatusCode, Value) {
        let request = Request::builder()
            .method("POST")
            .uri("/mcp")
            .header(header::HOST, format!("127.0.0.1:{PORT}"))
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        let response = router(server.clone(), PORT).oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    async fn call(server: &Arc<McpServer>, token: &str, name: &str, arguments: Value) -> Value {
        let (status, body) = rpc(
            server,
            token,
            json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": { "name": name, "arguments": arguments } }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body["result"].clone()
    }

    #[tokio::test]
    async fn an_agent_starts_a_task_and_hears_it_finish() {
        let (server, home, workspace) = setup();
        let created = server.create_client("Claude Code").unwrap();
        let token = created["token"].as_str().unwrap().to_string();
        // Only the hash is kept.
        let stored = std::fs::read_to_string(home.path().join("agent-clients.json")).unwrap();
        assert!(!stored.contains(&token));

        let (_, init) = rpc(&server, &token, json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-03-26" } })).await;
        assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(init["result"]["serverInfo"]["version"], "9.9.9");
        let (status, _) = rpc(&server, &token, json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await;
        assert_eq!(status, StatusCode::ACCEPTED);

        let (_, listed) = rpc(&server, &token, json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).await;
        let names: Vec<&str> = listed["result"]["tools"].as_array().unwrap().iter().filter_map(|tool| tool["name"].as_str()).collect();
        assert!(names.contains(&"start_task") && names.contains(&"wait_inbox"));
        // Nothing that is the user's to decide.
        for name in &names {
            assert!(!name.contains("approv") && !name.contains("answer") && !name.contains("flow") && !name.contains("textguard"));
        }

        let folders = call(&server, &token, "list_workspaces", json!({})).await;
        let ours = workspace.path().canonicalize().unwrap();
        assert!(
            folders["structuredContent"]["workspaces"].as_array().unwrap().iter().any(|folder| {
                folder["path"].as_str().and_then(|path| Path::new(path).canonicalize().ok()).as_deref() == Some(ours.as_path())
            }),
            "{folders}"
        );

        let started = call(&server, &token, "start_task", json!({ "workspace": workspace.path(), "text": "hello" })).await;
        assert_eq!(started["isError"], false, "{started}");
        let task_id = started["structuredContent"]["taskId"].as_str().unwrap().to_string();
        let mut finished = false;
        let mut after = 0;
        for _ in 0..10 {
            let waited = call(&server, &token, "wait_inbox", json!({ "after": after, "timeoutSeconds": 5 })).await;
            let entries = waited["structuredContent"]["entries"].as_array().unwrap().clone();
            if let Some(last) = entries.last() {
                after = last["seq"].as_u64().unwrap();
            }
            if entries.iter().any(|entry| entry["taskId"] == task_id.as_str() && entry["state"] == "finished") {
                finished = true;
                break;
            }
        }
        assert!(finished);
        let read = call(&server, &token, "read_task", json!({ "taskId": task_id })).await;
        assert!(!read["structuredContent"]["messages"].as_array().unwrap().is_empty());
        let acked = call(&server, &token, "ack_inbox", json!({ "seq": after })).await;
        assert_eq!(acked["structuredContent"]["left"], 0);
    }

    #[tokio::test]
    async fn refused_calls_are_results_the_agent_can_read() {
        let (server, _home, workspace) = setup();
        let token = server.create_client("agent").unwrap()["token"].as_str().unwrap().to_string();
        let slash = call(&server, &token, "start_task", json!({ "workspace": workspace.path(), "text": "/textguard off" })).await;
        assert_eq!(slash["isError"], true);
        assert_eq!(slash["structuredContent"]["error"]["code"], "command-not-allowed");
        let unknown = call(&server, &token, "approve", json!({})).await;
        assert_eq!(unknown["isError"], true);
        let (_, missing) = rpc(&server, &token, json!({ "jsonrpc": "2.0", "id": 3, "method": "resources/list" })).await;
        assert_eq!(missing["error"]["code"], -32601);
    }

    #[tokio::test]
    async fn only_a_live_agent_token_opens_mcp() {
        let (server, _home, _workspace) = setup();
        let (status, _) = rpc(&server, "not-a-token", json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" })).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let created = server.create_client("agent").unwrap();
        let token = created["token"].as_str().unwrap().to_string();
        let (status, _) = rpc(&server, &token, json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" })).await;
        assert_eq!(status, StatusCode::OK);
        server.revoke_client(created["client"]["id"].as_str().unwrap()).unwrap();
        let (status, _) = rpc(&server, &token, json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" })).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn a_foreign_origin_or_host_is_refused() {
        let (server, _home, _workspace) = setup();
        let token = server.create_client("agent").unwrap()["token"].as_str().unwrap().to_string();
        for (host, origin) in [("evil.example:47999", None), ("127.0.0.1:47999", Some("http://evil.example"))] {
            let mut request = Request::builder()
                .method("POST")
                .uri("/mcp")
                .header(header::HOST, host)
                .header(header::AUTHORIZATION, format!("Bearer {token}"));
            if let Some(origin) = origin {
                request = request.header(header::ORIGIN, origin);
            }
            let request = request.body(Body::from(json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }).to_string())).unwrap();
            let response = router(server.clone(), PORT).oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
        }
    }

    #[tokio::test]
    async fn the_switch_starts_and_stops_the_listener() {
        let (server, _home, _workspace) = setup();
        let probe = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        let snapshot = server.update(Some(true), Some(port)).await.unwrap();
        assert_eq!(snapshot["serving"], true, "{snapshot}");
        assert!(tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok());
        let snapshot = server.update(Some(false), None).await.unwrap();
        assert_eq!(snapshot["serving"], false);
    }
}
