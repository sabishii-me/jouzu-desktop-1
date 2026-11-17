//! The model catalog: the one list of chat models and the one default model.
//!
//! The host owns it. It is loaded when the host starts and again after every
//! configuration change (sign-in, keys, providers, catalogs, the default model),
//! never because a client asked for it. Each load that changes what clients see
//! raises `revision`; the host then publishes `models.changed` with the view.
//!
//! Rows come from Jouzu's `available-models` control action: the runtime
//! projection joined with the active catalog's limits and prices, thinking levels
//! from pi-ai. The host never reads `cache/model-catalog/**`. The answer depends on
//! sign-ins, keys, providers and catalogs, so it is never kept across host starts
//! (issue #84).
//!
//! The default model exists in one place only: the runtime's default-model
//! setting, which `available-models` reports. When the person picks a model in a
//! session it is the default at once (`choose_default`), and the host writes it
//! to the runtime behind the answer (see `lib.rs`); until a listing reports it,
//! the choice stands over what the runtime still says. The next new session
//! uses the last selected model.

use std::{path::Path, sync::Mutex};

use serde_json::{json, Value};

use crate::{control::ControlManager, session::ApiError};

/// A model as a session refers to it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelRef {
    pub provider: String,
    pub id: String,
}

impl ModelRef {
    pub fn new(provider: &str, id: &str) -> Self {
        Self {
            provider: provider.to_string(),
            id: id.to_string(),
        }
    }

    /// A `{provider, id}` value (the runtime's `get_state` model, a saved file).
    pub fn from_value(value: &Value) -> Option<Self> {
        let provider = value.get("provider").and_then(Value::as_str)?;
        let id = value.get("id").and_then(Value::as_str)?;
        (!provider.is_empty() && !id.is_empty()).then(|| Self::new(provider, id))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    /// Never listed yet; the first load is running or about to.
    Loading,
    /// Listed at least once. A later failed load keeps the rows and sets `stale`.
    Ready,
    /// The first load failed; nothing is known.
    Failed,
}

impl State {
    fn as_str(self) -> &'static str {
        match self {
            State::Loading => "loading",
            State::Ready => "ready",
            State::Failed => "failed",
        }
    }
}

/// Whether a load changed what clients see.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Change {
    None,
    /// The default, the stale flag or the error changed, or the first listing
    /// arrived (it tells what the runtimes already loaded).
    View,
    /// The list of models changed since the last listing: a runtime started
    /// before has another catalog.
    Models,
}

/// What the catalog says about a model a session uses.
#[derive(Clone, Debug, PartialEq)]
pub enum Lookup {
    /// The catalog is not listed yet (loading, or its first load failed).
    Unknown,
    Listed(Value),
    /// Listed, and this model is not in it (signed out, removed, not a chat model).
    Missing,
}

struct Inner {
    revision: u64,
    state: State,
    models: Vec<Value>,
    /// The default the last listing reported.
    default: Option<ModelRef>,
    /// The person's last pick, while the runtime does not report it yet.
    chosen: Option<ModelRef>,
    stale: bool,
    error: Option<String>,
}

pub struct ModelCatalog {
    inner: Mutex<Inner>,
    /// One load at a time; a load asked for while one runs waits and runs after it,
    /// so it sees every change made before it was asked for.
    loading: tokio::sync::Mutex<()>,
    /// One write of the default model at a time (see `lib.rs`).
    saving: tokio::sync::Mutex<()>,
}

impl Default for ModelCatalog {
    fn default() -> Self {
        Self::new()
    }
}

impl ModelCatalog {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                revision: 0,
                state: State::Loading,
                models: Vec::new(),
                default: None,
                chosen: None,
                stale: false,
                error: None,
            }),
            loading: tokio::sync::Mutex::new(()),
            saving: tokio::sync::Mutex::new(()),
        }
    }

    /// Older hosts kept a listing on disk; it may describe another account.
    pub fn remove_legacy_file(host_home: &Path) {
        let _ = std::fs::remove_file(host_home.join("host-state").join("models.json"));
    }

    fn inner(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl Inner {
    fn default(&self) -> Option<&ModelRef> {
        self.chosen.as_ref().or(self.default.as_ref())
    }
}

impl ModelCatalog {
    /// The catalog as every client shows it (`GET /v1/models`, `models.changed`).
    pub fn view(&self) -> Value {
        let inner = self.inner();
        let default = inner.default().and_then(|default| {
            row_of(&inner.models, default).map(|row| {
                json!({ "provider": default.provider, "id": default.id, "name": row.get("name").cloned().unwrap_or(Value::Null) })
            })
        });
        json!({
            "revision": inner.revision,
            "state": inner.state.as_str(),
            "models": inner.models,
            "default": default,
            "stale": inner.stale,
            "error": inner.error,
        })
    }

    pub fn revision(&self) -> u64 {
        self.inner().revision
    }

    /// Listed at least once: a model it does not list cannot be used.
    pub fn loaded(&self) -> bool {
        self.inner().state == State::Ready
    }

    /// The first listing has not answered yet.
    pub fn loading(&self) -> bool {
        self.inner().state == State::Loading
    }

    /// The model a new conversation starts on, when the runtime has a default it
    /// can chat with.
    pub fn default_model(&self) -> Option<ModelRef> {
        let inner = self.inner();
        let default = inner.default()?.clone();
        row_of(&inner.models, &default).map(|_| default)
    }

    /// The person picked `model`: it is the default from now on. Returns whether
    /// that changed what clients see. The caller writes it to the runtime and
    /// reports the outcome with `default_saved`.
    pub fn choose_default(&self, model: &ModelRef) -> Change {
        let mut inner = self.inner();
        if row_of(&inner.models, model).is_none() {
            return Change::None;
        }
        let before = inner.default().cloned();
        // While an earlier pick may still be written, this one is written too,
        // even when the runtime already reports it: the last write must be it.
        inner.chosen = if inner.chosen.is_none() && inner.default.as_ref() == Some(model) {
            None
        } else {
            Some(model.clone())
        };
        if inner.default() == before.as_ref() {
            return Change::None;
        }
        inner.revision += 1;
        Change::View
    }

    /// Held while the default model is written to the runtime.
    pub async fn saving(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.saving.lock().await
    }

    /// The pick that should be in the runtime's settings now, if any.
    pub fn unsaved_default(&self) -> Option<ModelRef> {
        self.inner().chosen.clone()
    }

    /// Writing `model` to the runtime failed: the default is what the runtime
    /// reports again, unless the person picked another one meanwhile.
    pub fn default_not_saved(&self, model: &ModelRef) -> Change {
        let mut inner = self.inner();
        if inner.chosen.as_ref() != Some(model) {
            return Change::None;
        }
        inner.chosen = None;
        if inner.default.as_ref() == Some(model) {
            return Change::None;
        }
        inner.revision += 1;
        Change::View
    }

    pub fn lookup(&self, model: &ModelRef) -> Lookup {
        let inner = self.inner();
        if inner.state != State::Ready {
            return Lookup::Unknown;
        }
        match row_of(&inner.models, model) {
            Some(row) => Lookup::Listed(row.clone()),
            None => Lookup::Missing,
        }
    }

    /// List the models again; with `refresh`, Jouzu first refreshes its published
    /// catalogs. A failure keeps the rows already listed and marks them stale.
    /// Returns what changed for clients, and the failure if there was one.
    pub async fn load(&self, control: &ControlManager, refresh: bool) -> (Change, Result<(), ApiError>) {
        let _one = self.loading.lock().await;
        let listed = async {
            if refresh {
                control
                    .request(json!({ "action": "refresh-catalogs" }))
                    .await?;
            }
            control
                .request_for_host(json!({ "action": "available-models" }))
                .await
        }
        .await;
        match listed {
            Ok(answer) => (self.apply(&answer), Ok(())),
            Err(error) => {
                let error = ApiError::new(
                    axum::http::StatusCode::SERVICE_UNAVAILABLE,
                    "models-unavailable",
                    error.message,
                    true,
                );
                (self.failed(&error.message), Err(error))
            }
        }
    }

    /// Take a listing from `available-models`.
    fn apply(&self, answer: &Value) -> Change {
        let models: Vec<Value> = answer
            .get("models")
            .and_then(Value::as_array)
            .map(|rows| rows.iter().filter(|row| chat_model(row)).cloned().collect())
            .unwrap_or_default();
        let default = match (
            answer.get("defaultProvider").and_then(Value::as_str),
            answer.get("defaultModel").and_then(Value::as_str),
        ) {
            (Some(provider), Some(id)) => Some(ModelRef::new(provider, id)),
            _ => None,
        };
        let mut inner = self.inner();
        let before = inner.default().cloned();
        // A pick the runtime now reports is settled; one it does not report
        // yet is still being written and stands.
        if inner.chosen.is_some() && inner.chosen == default {
            inner.chosen = None;
        }
        let shown = inner.chosen.clone().or_else(|| default.clone());
        let change = if inner.state == State::Ready && inner.models != models {
            Change::Models
        } else if inner.state != State::Ready || before != shown || inner.stale || inner.error.is_some() {
            Change::View
        } else {
            Change::None
        };
        inner.state = State::Ready;
        inner.models = models;
        inner.default = default;
        inner.stale = false;
        inner.error = None;
        if change != Change::None {
            inner.revision += 1;
        }
        change
    }

    fn failed(&self, message: &str) -> Change {
        let mut inner = self.inner();
        let before = (inner.state, inner.stale, inner.error.clone());
        match inner.state {
            State::Ready => inner.stale = true,
            State::Loading | State::Failed => inner.state = State::Failed,
        }
        inner.error = Some(message.to_string());
        if before == (inner.state, inner.stale, inner.error.clone()) {
            return Change::None;
        }
        inner.revision += 1;
        Change::View
    }

    /// A listing given directly, for tests of the host and its sessions.
    #[doc(hidden)]
    pub fn set_listing(&self, answer: Value) -> Change {
        self.apply(&answer)
    }
}

fn row_of<'a>(models: &'a [Value], model: &ModelRef) -> Option<&'a Value> {
    models.iter().find(|row| {
        row.get("provider").and_then(Value::as_str) == Some(model.provider.as_str())
            && row.get("id").and_then(Value::as_str) == Some(model.id.as_str())
    })
}

/// Whether the runtime offers this row for chat. Jouzu registers a catalog
/// offering with Pi only when the catalog gives its output limit; the control
/// listing still shows such offerings (translation models), and choosing one
/// used to fail later with "Model not found". They are not chat models, so the
/// catalog leaves them out instead of listing them as unusable.
fn chat_model(row: &Value) -> bool {
    let catalog = row
        .get("provider")
        .and_then(Value::as_str)
        .is_some_and(|provider| provider.starts_with("catalog:"));
    let no_limit = row.get("maxTokens").map(Value::is_null).unwrap_or(true);
    !(catalog && no_limit)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn listing(default: &str) -> Value {
        json!({
            "models": [
                { "provider": "catalog:x", "id": "chotto", "name": "Shisa Translate", "maxTokens": null },
                { "provider": "catalog:x", "id": "qwen", "name": "Qwen 3.8", "maxTokens": 32768 },
                { "provider": "capy", "id": "other", "name": "Other" }
            ],
            "defaultProvider": "catalog:x",
            "defaultModel": default,
        })
    }

    #[test]
    fn nothing_is_known_before_the_first_listing() {
        let catalog = ModelCatalog::new();
        assert!(!catalog.loaded());
        assert_eq!(catalog.lookup(&ModelRef::new("capy", "other")), Lookup::Unknown);
        assert_eq!(catalog.view()["state"], "loading");
        assert_eq!(catalog.view()["revision"], 0);
    }

    #[test]
    fn a_listing_raises_the_revision_only_when_it_changes_what_clients_see() {
        let catalog = ModelCatalog::new();
        // The first listing describes what runtimes already loaded: not a new list.
        assert_eq!(catalog.set_listing(listing("qwen")), Change::View);
        assert_eq!(catalog.revision(), 1);
        assert_eq!(catalog.set_listing(listing("qwen")), Change::None);
        assert_eq!(catalog.revision(), 1);
        let mut other_default = listing("qwen");
        other_default["defaultProvider"] = json!("capy");
        other_default["defaultModel"] = json!("other");
        assert_eq!(catalog.set_listing(other_default), Change::View);
        assert_eq!(catalog.revision(), 2);
        assert_eq!(catalog.default_model(), Some(ModelRef::new("capy", "other")));
    }

    #[test]
    fn a_new_list_of_models_is_a_models_change() {
        let catalog = ModelCatalog::new();
        catalog.set_listing(listing("qwen"));
        let mut fewer = listing("qwen");
        fewer["models"].as_array_mut().unwrap().pop();
        assert_eq!(catalog.set_listing(fewer), Change::Models);
    }

    /// The last pick is the default at once, stands over listings that still
    /// report an older default, and settles when the runtime reports it.
    #[test]
    fn the_last_pick_is_the_default_until_the_runtime_reports_it() {
        let catalog = ModelCatalog::new();
        catalog.set_listing(listing("qwen"));
        let other = ModelRef::new("capy", "other");
        let qwen = ModelRef::new("catalog:x", "qwen");
        assert_eq!(catalog.choose_default(&other), Change::View);
        assert_eq!(catalog.default_model(), Some(other.clone()));
        // Picking the runtime's own default again while `other` may still be
        // written: `qwen` must be written too, so it is kept as the pick.
        assert_eq!(catalog.choose_default(&qwen), Change::View);
        assert_eq!(catalog.unsaved_default(), Some(qwen.clone()));
        // A listing taken after `other` was written still shows the pick.
        let mut written_other = listing("qwen");
        written_other["defaultProvider"] = json!("capy");
        written_other["defaultModel"] = json!("other");
        catalog.set_listing(written_other);
        assert_eq!(catalog.default_model(), Some(qwen.clone()));
        // The runtime reports the pick: settled.
        catalog.set_listing(listing("qwen"));
        assert_eq!(catalog.unsaved_default(), None);
        assert_eq!(catalog.default_model(), Some(qwen));
    }

    #[test]
    fn a_pick_that_could_not_be_saved_gives_way_to_the_runtime_default() {
        let catalog = ModelCatalog::new();
        catalog.set_listing(listing("qwen"));
        let other = ModelRef::new("capy", "other");
        catalog.choose_default(&other);
        assert_eq!(catalog.default_not_saved(&other), Change::View);
        assert_eq!(catalog.default_model(), Some(ModelRef::new("catalog:x", "qwen")));
        // A model the catalog does not list is never the default.
        assert_eq!(catalog.choose_default(&ModelRef::new("capy", "gone")), Change::None);
    }

    /// Shisa Translate (no output limit) is not a chat model: not listed, and
    /// not offered as the default.
    #[test]
    fn models_the_runtime_cannot_chat_with_are_not_listed() {
        let catalog = ModelCatalog::new();
        catalog.set_listing(listing("chotto"));
        let view = catalog.view();
        let ids: Vec<&str> = view["models"].as_array().unwrap().iter().map(|row| row["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["qwen", "other"]);
        assert_eq!(catalog.default_model(), None);
        assert!(view["default"].is_null());
        assert_eq!(catalog.lookup(&ModelRef::new("catalog:x", "chotto")), Lookup::Missing);
    }

    #[test]
    fn a_failed_listing_keeps_the_rows_and_marks_them_stale() {
        let catalog = ModelCatalog::new();
        assert_eq!(catalog.failed("down"), Change::View);
        assert_eq!(catalog.view()["state"], "failed");
        assert!(!catalog.loaded());
        catalog.set_listing(listing("qwen"));
        let revision = catalog.revision();
        assert_eq!(catalog.failed("down"), Change::View);
        assert_eq!(catalog.revision(), revision + 1);
        let view = catalog.view();
        assert_eq!(view["state"], "ready");
        assert_eq!(view["stale"], true);
        assert_eq!(view["error"], "down");
        assert!(matches!(catalog.lookup(&ModelRef::new("capy", "other")), Lookup::Listed(_)));
        assert_eq!(catalog.failed("down"), Change::None, "the same failure again changes nothing");
    }

    #[test]
    fn no_configured_model_is_an_empty_list_not_a_failure() {
        let catalog = ModelCatalog::new();
        catalog.set_listing(json!({ "models": [], "defaultProvider": null, "defaultModel": null }));
        assert!(catalog.loaded());
        assert_eq!(catalog.view()["models"], json!([]));
        assert_eq!(catalog.default_model(), None);
    }

    /// Issue #84: a listing an older host left on disk is removed, never served.
    #[test]
    fn a_listing_left_on_disk_is_removed() {
        let home = tempfile::tempdir().unwrap();
        let directory = home.path().join("host-state");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("models.json"), "{}").unwrap();
        ModelCatalog::remove_legacy_file(home.path());
        assert!(!directory.join("models.json").exists());
    }
}
