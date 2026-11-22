//! Connectors: outside services as event sources, and actions graph steps
//! can take there.
//!
//! A connector turns what happens outside into events for triggers (the
//! same events whether it polls or, later, receives a webhook), and offers
//! actions a run's `connector` step calls. It is built in for now and shaped
//! like the plugin kind reserved for it: an id, settings the user owns, a
//! status, events out, actions in. Moving it into a plugin later changes
//! neither triggers nor graphs.
//!
//! GitHub is the first. It polls the repositories the user lists, as often as
//! the user set, with the token from the environment variable the user names
//! (Settings > Environment), sending conditional requests (ETag) so a quiet
//! repository costs no rate limit. The first look at a repository only notes
//! where it is: what happened before is not an event.
//!
//! Writes (a comment, a pull request) go out only from a run step that comes
//! right after a checkpoint the user approved, and never with a local path
//! in them.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::http::StatusCode;
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Notify;

use crate::{
    session::{ApiError, SessionManager},
    triggers::{Event, Triggers},
};

pub const GITHUB: &str = "github";
const GITHUB_API: &str = "https://api.github.com";
/// The most items GitHub returns in one page.
const PAGE: &str = "100";

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubSettings {
    #[serde(default)]
    pub enabled: bool,
    /// "owner/name" each.
    #[serde(default)]
    pub repos: Vec<String>,
    /// How often to look. Nothing is polled until the user sets it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub every_seconds: Option<u64>,
    /// The environment variable that holds the token. None: no token
    /// (public repositories only, at GitHub's lower limit).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_variable: Option<String>,
    /// Another API address (GitHub Enterprise, tests).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_url: Option<String>,
}

/// Where the connector is in each repository: what it has seen.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepoState {
    #[serde(default)]
    etags: HashMap<String, String>,
    #[serde(default)]
    last_issue_event: Option<u64>,
    #[serde(default)]
    last_number: Option<u64>,
    #[serde(default)]
    last_release: Option<u64>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    #[serde(skip_serializing_if = "Option::is_none")]
    last_poll_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_error: Option<String>,
    events: u64,
}

pub struct Connectors {
    home: PathBuf,
    sessions: Arc<SessionManager>,
    triggers: Arc<Triggers>,
    client: reqwest::Client,
    settings: Mutex<GitHubSettings>,
    state: Mutex<HashMap<String, RepoState>>,
    status: Mutex<Status>,
    changed: Notify,
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), ApiError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| ApiError::internal(error.to_string()))?;
    }
    let temp = path.with_extension("tmp");
    std::fs::write(&temp, serde_json::to_vec_pretty(value).unwrap_or_default())
        .and_then(|_| std::fs::rename(&temp, path))
        .map_err(|error| ApiError::internal(error.to_string()))
}

fn valid_repo(repo: &str) -> bool {
    let mut parts = repo.split('/');
    let ok = |part: Option<&str>| {
        part.is_some_and(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)))
    };
    ok(parts.next()) && ok(parts.next()) && parts.next().is_none()
}

impl Connectors {
    pub fn new(home: &Path, sessions: Arc<SessionManager>, triggers: Arc<Triggers>) -> Arc<Self> {
        let dir = home.join("connectors");
        let settings = std::fs::read(dir.join("github.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        let state = std::fs::read(dir.join("github-state.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Arc::new(Self {
            home: home.to_path_buf(),
            sessions,
            triggers,
            client: reqwest::Client::builder().user_agent("jouzu-desktop").build().unwrap_or_default(),
            settings: Mutex::new(settings),
            state: Mutex::new(state),
            status: Mutex::new(Status::default()),
            changed: Notify::new(),
        })
    }

    fn dir(&self) -> PathBuf {
        self.home.join("connectors")
    }

    fn settings(&self) -> GitHubSettings {
        lock(&self.settings).clone()
    }

    /// The token, read when needed from the user's environment settings
    /// (or the host's own environment), never stored here.
    fn token(&self, settings: &GitHubSettings) -> Option<String> {
        let name = settings.token_variable.as_deref()?;
        crate::environment::enabled(self.sessions.runtime_home())
            .ok()
            .and_then(|entries| entries.into_iter().find(|(key, _)| key == name).map(|(_, value)| value))
            .or_else(|| std::env::var(name).ok())
            .filter(|value| !value.is_empty())
    }

    pub fn snapshot(&self) -> Value {
        let settings = self.settings();
        let status = lock(&self.status).clone();
        json!({
            "connectors": [{
                "id": GITHUB,
                "name": "GitHub",
                "settings": settings,
                "tokenFound": self.token(&settings).is_some(),
                "status": status,
                "events": ["github.issue.opened", "github.pr.opened", "github.issue.labeled", "github.issue.closed", "github.issue.reopened", "github.release.published"],
                "actions": ["read_issue", "comment", "open_pr", "open_issues"],
            }]
        })
    }

    /// The user's settings. Only the user: the host token reaches this.
    pub fn update(&self, settings: GitHubSettings) -> Result<Value, ApiError> {
        if let Some(bad) = settings.repos.iter().find(|repo| !valid_repo(repo)) {
            return Err(ApiError::bad_request(format!("{bad} is not owner/name")));
        }
        if settings.every_seconds == Some(0) {
            return Err(ApiError::bad_request("everySeconds must be at least 1"));
        }
        if settings.enabled && settings.every_seconds.is_none() {
            return Err(ApiError::bad_request("Set how often to look (everySeconds) to turn it on"));
        }
        write_json(&self.dir().join("github.json"), &settings)?;
        *lock(&self.settings) = settings;
        self.sessions.publish_control("connectors.changed", json!({ "id": GITHUB }));
        self.changed.notify_one();
        Ok(self.snapshot())
    }

    pub fn launch(self: &Arc<Self>) {
        let connectors = Arc::clone(self);
        tokio::spawn(async move { connectors.poll_loop().await });
    }

    async fn poll_loop(self: Arc<Self>) {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let settings = self.settings();
            let every = settings.every_seconds.filter(|_| settings.enabled && !settings.repos.is_empty());
            if every.is_some() {
                self.poll().await;
            }
            match every {
                Some(seconds) => {
                    tokio::select! {
                        _ = changed => {}
                        _ = tokio::time::sleep(Duration::from_secs(seconds)) => {}
                    }
                }
                None => changed.await,
            }
        }
    }

    fn base(settings: &GitHubSettings) -> String {
        settings.api_url.clone().unwrap_or_else(|| GITHUB_API.into()).trim_end_matches('/').to_string()
    }

    fn request(&self, settings: &GitHubSettings, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let mut request = self
            .client
            .request(method, format!("{}{path}", Self::base(settings)))
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28");
        if let Some(token) = self.token(settings) {
            request = request.bearer_auth(token);
        }
        request
    }

    /// GET with the ETag from last time. None: nothing changed.
    async fn get_changed(&self, settings: &GitHubSettings, repo: &str, key: &str, path: &str) -> Result<Option<Vec<Value>>, String> {
        let etag = lock(&self.state).get(repo).and_then(|state| state.etags.get(key).cloned());
        let mut request = self.request(settings, reqwest::Method::GET, path);
        if let Some(etag) = etag {
            request = request.header("If-None-Match", etag);
        }
        let response = request.send().await.map_err(|error| format!("GitHub did not answer: {error}"))?;
        if response.status() == reqwest::StatusCode::NOT_MODIFIED {
            return Ok(None);
        }
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(format!("GitHub answered {status} for {path}: {}", body.chars().take(300).collect::<String>()));
        }
        let etag = response.headers().get("etag").and_then(|value| value.to_str().ok()).map(str::to_string);
        let items: Vec<Value> = response.json().await.map_err(|error| format!("GitHub sent something unreadable: {error}"))?;
        if let Some(etag) = etag {
            lock(&self.state).entry(repo.to_string()).or_default().etags.insert(key.to_string(), etag);
        }
        Ok(Some(items))
    }

    /// One look at every repository; new happenings become events.
    pub async fn poll(&self) {
        let settings = self.settings();
        let mut events = Vec::new();
        let mut error = None;
        for repo in &settings.repos {
            match self.poll_repo(&settings, repo).await {
                Ok(mut found) => events.append(&mut found),
                Err(message) => error = Some(message),
            }
        }
        let _ = write_json(&self.dir().join("github-state.json"), &*lock(&self.state));
        {
            let mut status = lock(&self.status);
            status.last_poll_at = Some(now_iso());
            status.last_error = error.clone();
            status.events += events.len() as u64;
        }
        if let Some(message) = &error {
            crate::log(self.sessions.home(), "warn", "connector.github.poll", json!({ "error": message }));
        }
        self.sessions.publish_control("connectors.changed", json!({ "id": GITHUB }));
        for event in events {
            self.triggers.emit(event).await;
        }
    }

    async fn poll_repo(&self, settings: &GitHubSettings, repo: &str) -> Result<Vec<Event>, String> {
        let mut events = Vec::new();
        let at = now_iso();
        let event = |id: String, kind: &str, fields: Value| Event { id, kind: kind.into(), at: at.clone(), fields };

        // New issues and pull requests, newest first.
        if let Some(items) = self
            .get_changed(settings, repo, "issues", &format!("/repos/{repo}/issues?state=all&sort=created&direction=desc&per_page={PAGE}"))
            .await?
        {
            let last = lock(&self.state).get(repo).and_then(|state| state.last_number);
            let newest = items.iter().filter_map(|item| item["number"].as_u64()).max();
            if let Some(last) = last {
                for item in items.iter().rev().filter(|item| item["number"].as_u64().is_some_and(|number| number > last)) {
                    let pull = item.get("pull_request").is_some();
                    let number = item["number"].as_u64().unwrap_or_default();
                    events.push(event(
                        format!("github:{repo}:{number}:opened"),
                        if pull { "github.pr.opened" } else { "github.issue.opened" },
                        json!({
                            "repo": repo,
                            "number": number,
                            "title": item["title"],
                            "author": item["user"]["login"],
                            "labels": item["labels"].as_array().map(|labels| labels.iter().filter_map(|label| label["name"].as_str()).collect::<Vec<_>>()),
                            "url": item["html_url"],
                        }),
                    ));
                }
            }
            if let Some(newest) = newest {
                let mut state = lock(&self.state);
                let entry = state.entry(repo.to_string()).or_default();
                entry.last_number = Some(entry.last_number.map_or(newest, |last| last.max(newest)));
            }
        }

        // Labels, closes and reopens.
        if let Some(items) = self.get_changed(settings, repo, "issue-events", &format!("/repos/{repo}/issues/events?per_page={PAGE}")).await? {
            let last = lock(&self.state).get(repo).and_then(|state| state.last_issue_event);
            let newest = items.iter().filter_map(|item| item["id"].as_u64()).max();
            if let Some(last) = last {
                for item in items.iter().rev().filter(|item| item["id"].as_u64().is_some_and(|id| id > last)) {
                    let kind = match item["event"].as_str() {
                        Some("labeled") => "github.issue.labeled",
                        Some("closed") => "github.issue.closed",
                        Some("reopened") => "github.issue.reopened",
                        _ => continue,
                    };
                    events.push(event(
                        format!("github:{repo}:event:{}", item["id"]),
                        kind,
                        json!({
                            "repo": repo,
                            "number": item["issue"]["number"],
                            "title": item["issue"]["title"],
                            "label": item["label"]["name"],
                            "actor": item["actor"]["login"],
                            "pullRequest": item["issue"].get("pull_request").is_some(),
                            "url": item["issue"]["html_url"],
                        }),
                    ));
                }
            }
            if let Some(newest) = newest {
                let mut state = lock(&self.state);
                let entry = state.entry(repo.to_string()).or_default();
                entry.last_issue_event = Some(entry.last_issue_event.map_or(newest, |last| last.max(newest)));
            }
        }

        // Releases, drafts aside.
        if let Some(items) = self.get_changed(settings, repo, "releases", &format!("/repos/{repo}/releases?per_page={PAGE}")).await? {
            let last = lock(&self.state).get(repo).and_then(|state| state.last_release);
            let published: Vec<&Value> = items.iter().filter(|item| item["draft"] != true).collect();
            let newest = published.iter().filter_map(|item| item["id"].as_u64()).max();
            if let Some(last) = last {
                for item in published.iter().rev().filter(|item| item["id"].as_u64().is_some_and(|id| id > last)) {
                    events.push(event(
                        format!("github:{repo}:release:{}", item["id"]),
                        "github.release.published",
                        json!({
                            "repo": repo,
                            "tag": item["tag_name"],
                            "name": item["name"],
                            "prerelease": item["prerelease"],
                            "url": item["html_url"],
                        }),
                    ));
                }
            }
            // The first look notes where the repository is (0: none yet).
            let mut state = lock(&self.state);
            let entry = state.entry(repo.to_string()).or_default();
            entry.last_release = Some(entry.last_release.unwrap_or(0).max(newest.unwrap_or(0)));
        }
        // A repository with no issues yet still counts as looked at.
        {
            let mut state = lock(&self.state);
            let entry = state.entry(repo.to_string()).or_default();
            entry.last_number.get_or_insert(0);
            entry.last_issue_event.get_or_insert(0);
        }
        Ok(events)
    }

    /// Refuses text that would put something local in public: the user's
    /// home folder or the host's data folder.
    fn scan(&self, text: &str) -> Result<(), String> {
        let mut local: Vec<String> = vec![self.home.to_string_lossy().into_owned()];
        if let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
            local.push(home.to_string_lossy().into_owned());
        }
        let lower = text.to_lowercase().replace('\\', "/");
        for path in local.iter().filter(|path| path.len() > 3) {
            if lower.contains(&path.to_lowercase().replace('\\', "/")) {
                return Err("The text contains a local path; it is not sent".into());
            }
        }
        Ok(())
    }

    /// A run step's action. `may_write` is the engine's word that the step
    /// comes right after a checkpoint the user approved.
    pub async fn act(&self, connector: &str, action: &str, args: &Value, may_write: bool) -> Result<Value, String> {
        if connector != GITHUB {
            return Err(format!("No connector {connector}"));
        }
        let settings = self.settings();
        let repo = args["repo"].as_str().filter(|repo| valid_repo(repo)).ok_or("repo is owner/name")?;
        let write = matches!(action, "comment" | "open_pr" | "open_issues");
        if write && !may_write {
            return Err(format!("{action} writes in public: it runs only right after a checkpoint you approved"));
        }
        let number = || args["number"].as_u64().ok_or("number is required");
        let text = |name: &str| args[name].as_str().map(str::to_string).ok_or(format!("{name} is required"));
        if action == "open_issues" {
            return self.open_issues(&settings, repo, args).await;
        }
        let (method, path, body) = match action {
            "read_issue" => (reqwest::Method::GET, format!("/repos/{repo}/issues/{}", number()?), None),
            "comment" => {
                let body = text("body")?;
                self.scan(&body)?;
                (reqwest::Method::POST, format!("/repos/{repo}/issues/{}/comments", number()?), Some(json!({ "body": body })))
            }
            "open_pr" => {
                let (title, body) = (text("title")?, args["body"].as_str().unwrap_or("").to_string());
                self.scan(&title)?;
                self.scan(&body)?;
                (
                    reqwest::Method::POST,
                    format!("/repos/{repo}/pulls"),
                    Some(json!({ "title": title, "body": body, "head": text("head")?, "base": text("base")? })),
                )
            }
            other => return Err(format!("GitHub has no action {other}")),
        };
        let mut request = self.request(&settings, method, &path);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(|error| format!("GitHub did not answer: {error}"))?;
        let status = response.status();
        let value: Value = response.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            return Err(format!("GitHub answered {status}: {}", value["message"].as_str().unwrap_or("")));
        }
        Ok(match action {
            "read_issue" => json!({
                "number": value["number"], "title": value["title"], "state": value["state"], "body": value["body"],
                "labels": value["labels"], "author": value["user"]["login"], "url": value["html_url"],
            }),
            _ => json!({ "url": value["html_url"], "number": value["number"] }),
        })
    }
}

impl Connectors {
    /// Opens one issue per entry of a JSON file (`[{title, body}]`), with
    /// `labels` on each. Every text is scanned first: one bad entry sends none.
    async fn open_issues(&self, settings: &GitHubSettings, repo: &str, args: &Value) -> Result<Value, String> {
        let file = args["file"].as_str().ok_or("file is required")?;
        let bytes = std::fs::read(file).map_err(|error| format!("Cannot read {file}: {error}"))?;
        let entries: Vec<Value> = serde_json::from_slice(&bytes).map_err(|error| format!("{file} is not a JSON list: {error}"))?;
        for entry in &entries {
            let title = entry["title"].as_str().filter(|title| !title.trim().is_empty()).ok_or("Every issue needs a title")?;
            self.scan(title)?;
            self.scan(entry["body"].as_str().unwrap_or(""))?;
        }
        let labels = args["labels"].clone();
        let mut opened = Vec::new();
        for entry in &entries {
            let mut body = json!({ "title": entry["title"], "body": entry["body"].as_str().unwrap_or("") });
            if labels.is_array() {
                body["labels"] = labels.clone();
            }
            let response = self
                .request(settings, reqwest::Method::POST, &format!("/repos/{repo}/issues"))
                .json(&body)
                .send()
                .await
                .map_err(|error| format!("GitHub did not answer: {error}"))?;
            let status = response.status();
            let value: Value = response.json().await.unwrap_or(Value::Null);
            if !status.is_success() {
                return Err(format!("GitHub answered {status} after {} opened: {}", opened.len(), value["message"].as_str().unwrap_or("")));
            }
            opened.push(json!({ "number": value["number"], "url": value["html_url"] }));
        }
        Ok(json!({ "opened": opened }))
    }
}

pub fn not_found() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "connector-not-found", "No such connector", false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{runs::Runs, session::RuntimeSpec, tasks::TaskManager, triggers::TriggerInput};
    use axum::{
        extract::{Path as AxumPath, State},
        http::HeaderMap,
        response::IntoResponse,
        routing::{get, post},
        Json, Router,
    };

    /// A stand-in for the parts of GitHub's API the connector uses.
    #[derive(Default)]
    struct Fake {
        issues: Vec<Value>,
        events: Vec<Value>,
        releases: Vec<Value>,
        comments: Vec<Value>,
        not_modified: u64,
    }

    type Shared = Arc<Mutex<Fake>>;

    fn listed(fake: &Shared, headers: &HeaderMap, items: Vec<Value>) -> axum::response::Response {
        use sha2::Digest as _;
        let etag = format!("\"{}\"", hex::encode(sha2::Sha256::digest(serde_json::to_vec(&items).unwrap()))[..16].to_string());
        if headers.get("if-none-match").and_then(|value| value.to_str().ok()) == Some(etag.as_str()) {
            lock(fake).not_modified += 1;
            return StatusCode::NOT_MODIFIED.into_response();
        }
        ([("etag", etag)], Json(items)).into_response()
    }

    async fn serve(fake: Shared) -> String {
        let app = Router::new()
            .route("/repos/{o}/{r}/issues", get(|State(fake): State<Shared>, headers: HeaderMap| async move {
                let mut items = lock(&fake).issues.clone();
                items.reverse();
                listed(&fake, &headers, items)
            }))
            .route("/repos/{o}/{r}/issues/events", get(|State(fake): State<Shared>, headers: HeaderMap| async move {
                let mut items = lock(&fake).events.clone();
                items.reverse();
                listed(&fake, &headers, items)
            }))
            .route("/repos/{o}/{r}/releases", get(|State(fake): State<Shared>, headers: HeaderMap| async move {
                let mut items = lock(&fake).releases.clone();
                items.reverse();
                listed(&fake, &headers, items)
            }))
            .route("/repos/{o}/{r}/issues/{n}", get(|State(fake): State<Shared>, AxumPath((_o, _r, n)): AxumPath<(String, String, u64)>| async move {
                let issue = lock(&fake).issues.iter().find(|issue| issue["number"] == n).cloned();
                match issue {
                    Some(issue) => Json(issue).into_response(),
                    None => (StatusCode::NOT_FOUND, Json(json!({ "message": "Not Found" }))).into_response(),
                }
            }))
            .route("/repos/{o}/{r}/issues/{n}/comments", post(|State(fake): State<Shared>, AxumPath((_o, _r, n)): AxumPath<(String, String, u64)>, Json(body): Json<Value>| async move {
                lock(&fake).comments.push(json!({ "number": n, "body": body["body"] }));
                (StatusCode::CREATED, Json(json!({ "html_url": format!("https://example.test/{n}#c"), "id": 1 })))
            }))
            .with_state(fake);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{address}")
    }

    fn issue(number: u64, pull: bool) -> Value {
        let mut issue = json!({ "number": number, "title": format!("Issue {number}"), "user": { "login": "someone" }, "labels": [], "html_url": format!("https://example.test/{number}"), "state": "open", "body": "It breaks" });
        if pull {
            issue["pull_request"] = json!({});
        }
        issue
    }

    struct Fixture {
        connectors: Arc<Connectors>,
        triggers: Arc<Triggers>,
        runs: Arc<Runs>,
        fake: Shared,
        home: tempfile::TempDir,
        _workspace: tempfile::TempDir,
    }

    async fn setup() -> Fixture {
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-runtime.mjs");
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let sessions = Arc::new(SessionManager::new(Some(RuntimeSpec::node_script(&fixture)), home.path().to_path_buf(), home.path().join("data"), None, 50, None));
        sessions.add_workspaces(&[workspace.path().to_string_lossy().into_owned()]).unwrap();
        let tasks = TaskManager::new(sessions.clone());
        let runs = Runs::new(home.path(), sessions.clone(), tasks.clone());
        let triggers = Triggers::new(home.path(), sessions.clone(), tasks, runs.clone());
        let connectors = Connectors::new(home.path(), sessions, triggers.clone());
        runs.set_connectors(connectors.clone());
        runs.launch();
        let fake: Shared = Arc::new(Mutex::new(Fake::default()));
        let url = serve(fake.clone()).await;
        connectors
            .update(GitHubSettings { enabled: false, repos: vec!["acme/app".into()], every_seconds: None, token_variable: None, api_url: Some(url) })
            .unwrap();
        Fixture { connectors, triggers, runs, fake, home, _workspace: workspace }
    }

    #[tokio::test]
    async fn new_happenings_become_events_once_and_the_past_does_not() {
        let fixture = setup().await;
        {
            let mut fake = lock(&fixture.fake);
            fake.issues.push(issue(1, false));
            fake.events.push(json!({ "id": 10, "event": "labeled", "label": { "name": "bug" }, "issue": issue(1, false), "actor": { "login": "someone" } }));
            fake.releases.push(json!({ "id": 100, "tag_name": "v1.0.0", "name": "1.0.0", "draft": false, "prerelease": false, "html_url": "https://example.test/r/100" }));
        }
        let notes = Arc::new(Mutex::new(Vec::new()));
        let sink = notes.clone();
        fixture.triggers.set_waker(move |note| sink.lock().unwrap().push(note));
        let on = |event: &str, filter: Value, text: &str| {
            fixture
                .triggers
                .create(crate::triggers::BY_USER, serde_json::from_value::<TriggerInput>(json!({ "source": { "kind": "event", "event": event }, "filter": filter, "action": { "kind": "wakeAssistant", "text": text } })).unwrap())
                .unwrap()
        };
        on("github.issue.opened", json!({ "repo": "acme/app" }), "new issue {{number}}: {{title}}");
        on("github.issue.labeled", json!({ "label": "bug" }), "labeled {{number}} {{label}}");
        on("github.release.published", json!({ "tag": "v*-rc.*" }), "release {{tag}}");
        on("github.pr.opened", json!({}), "pr {{number}}");
        // The first look only notes where the repository is.
        fixture.connectors.poll().await;
        assert!(notes.lock().unwrap().is_empty(), "{:?}", notes.lock().unwrap());
        {
            let mut fake = lock(&fixture.fake);
            fake.issues.push(issue(2, false));
            fake.issues.push(issue(3, true));
            fake.events.push(json!({ "id": 11, "event": "labeled", "label": { "name": "bug" }, "issue": issue(2, false), "actor": { "login": "someone" } }));
            fake.events.push(json!({ "id": 12, "event": "subscribed", "issue": issue(2, false), "actor": { "login": "someone" } }));
            fake.releases.push(json!({ "id": 101, "tag_name": "v1.1.0-rc.1", "name": "draft", "draft": true, "prerelease": true, "html_url": "x" }));
            fake.releases.push(json!({ "id": 102, "tag_name": "v1.1.0-rc.2", "name": "rc", "draft": false, "prerelease": true, "html_url": "x" }));
        }
        fixture.connectors.poll().await;
        let mut seen = notes.lock().unwrap().clone();
        seen.sort();
        assert_eq!(seen, ["labeled 2 bug", "new issue 2: Issue 2", "pr 3", "release v1.1.0-rc.2"], "{seen:?}");
        // Nothing new: GitHub says so (conditional requests) and nothing fires.
        fixture.connectors.poll().await;
        assert_eq!(notes.lock().unwrap().len(), 4);
        assert_eq!(lock(&fixture.fake).not_modified, 3);
        // A restart remembers where each repository was.
        let again = Connectors::new(fixture.home.path(), fixture.connectors.sessions.clone(), fixture.triggers.clone());
        again.poll().await;
        assert_eq!(notes.lock().unwrap().len(), 4);
        let snapshot = fixture.connectors.snapshot();
        assert_eq!(snapshot["connectors"][0]["status"]["events"], 4, "{snapshot}");
        assert!(snapshot["connectors"][0]["status"]["lastError"].is_null(), "{snapshot}");
    }

    #[tokio::test]
    async fn public_writes_go_out_only_after_the_user_approved_and_without_local_paths() {
        let fixture = setup().await;
        lock(&fixture.fake).issues.push(issue(5, false));
        let url = fixture.connectors.settings().api_url.unwrap();
        let graph = |id: &str, nodes: Value, edges: Value| -> crate::runs::Graph {
            serde_json::from_value(json!({ "id": id, "params": { "number": "number" }, "start": "read", "nodes": nodes, "edges": edges })).unwrap()
        };
        let read = json!({ "kind": "connector", "connector": "github", "action": "read_issue", "args": { "repo": "acme/app", "number": "{{number}}" } });
        let comment = |body: &str| json!({ "kind": "connector", "connector": "github", "action": "comment", "args": { "repo": "acme/app", "number": "{{number}}", "body": body } });
        // Writing without a checkpoint before it is refused.
        fixture.runs.save_graph(graph("rash", json!({ "read": read, "say": comment("Thanks") }), json!([{ "from": "read", "to": "say", "when": "done" }]))).unwrap();
        let rash = fixture.runs.start("rash", None, serde_json::from_value(json!({ "number": 5 })).unwrap(), json!({ "by": "user" }), Vec::new()).unwrap();
        let failed = until_state(&fixture.runs, rash["runId"].as_str().unwrap(), "failed").await;
        assert_eq!(failed["attempts"][0]["evidence"]["answer"]["title"], "Issue 5", "{failed}");
        assert!(failed["attempts"][1]["evidence"]["error"].as_str().unwrap().contains("checkpoint"), "{failed}");
        assert!(lock(&fixture.fake).comments.is_empty());
        // After the user approves, it goes out.
        let careful = graph(
            "careful",
            json!({ "read": read, "ok": { "kind": "checkpoint", "ask": "Post the comment on {{number}}?" }, "say": comment("Thanks for #{{number}}") }),
            json!([{ "from": "read", "to": "ok", "when": "done" }, { "from": "ok", "to": "say", "when": "approved" }]),
        );
        fixture.runs.save_graph(careful).unwrap();
        let run = fixture.runs.start("careful", None, serde_json::from_value(json!({ "number": 5 })).unwrap(), json!({ "by": "user" }), Vec::new()).unwrap();
        let run_id = run["runId"].as_str().unwrap().to_string();
        until_state(&fixture.runs, &run_id, "waiting").await;
        fixture.runs.decide(&run_id, crate::runs::Decision { decision: "approve".into(), node: None, note: None }).unwrap();
        until_state(&fixture.runs, &run_id, "finished").await;
        assert_eq!(lock(&fixture.fake).comments, vec![json!({ "number": 5, "body": "Thanks for #5" })]);
        // A local path never goes out.
        let local = format!("see {}", fixture.home.path().join("runs").display());
        let refused = fixture.connectors.act(GITHUB, "comment", &json!({ "repo": "acme/app", "number": 5, "body": local }), true).await;
        assert!(refused.unwrap_err().contains("local path"));
        assert_eq!(lock(&fixture.fake).comments.len(), 1);
        assert!(url.starts_with("http://127.0.0.1"));
    }

    #[tokio::test]
    async fn the_shipped_issue_loop_reads_the_issue_and_holds_its_steps_to_their_files() {
        let fixture = setup().await;
        lock(&fixture.fake).issues.push(issue(9, false));
        let params = json!({ "repo": "acme/app", "number": 9, "workspace": fixture._workspace.path(), "base": "develop", "test": "echo ok" });
        let run = fixture.runs.start("issue-loop", None, serde_json::from_value(params).unwrap(), json!({ "by": "user" }), Vec::new()).unwrap();
        // The stand-in agent writes no triage: the step is undelivered, and
        // the graph has no way on from there.
        let failed = until_state(&fixture.runs, run["runId"].as_str().unwrap(), "failed").await;
        let answer = failed["attempts"][0]["evidence"]["answerFile"].as_str().unwrap();
        assert!(answer.ends_with("answer.json") && answer.contains("read-1"), "{failed}");
        assert!(std::fs::read_to_string(answer).unwrap().contains("Issue 9"));
        assert_eq!(failed["attempts"][1]["result"], "undelivered", "{failed}");
        assert!(failed["attempts"][1]["evidence"]["missing"][0].as_str().unwrap().ends_with("triage.md"), "{failed}");
    }

    #[test]
    fn settings_are_checked() {
        assert!(valid_repo("shisa-ai/jouzu-desktop"));
        assert!(!valid_repo("nope"));
        assert!(!valid_repo("a/b/c"));
        assert!(!valid_repo("a/../b"));
    }

    async fn until_state(runs: &Runs, run_id: &str, state: &str) -> Value {
        for _ in 0..400 {
            let run = runs.get(run_id).unwrap();
            if run["state"] == state {
                return run;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("{run_id} never became {state}: {}", runs.get(run_id).unwrap());
    }
}
