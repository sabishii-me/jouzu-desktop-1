//! The runtime's latest answers about models and image providers, kept so a
//! client never waits for a list it has already been given.
//!
//! Every runtime the host starts reads the same configuration, so they register
//! the same models: the last list any of them answered (`get_available_models`)
//! is what the next one will answer too. The host keeps that answer, and the
//! model a blank runtime reported at start (`get_state`), and nothing else: it is
//! a copy of the runtime's words, never a list or default of the host's own. A
//! newer answer replaces it; a configuration change forgets it, and answers from
//! runtimes started before that change are not taken (`generation`).
//!
//! The generation is the host's configuration generation: every configuration
//! change raises it (`forget`), and AppView publishes it with each answer, so a
//! client knows whether what it shows is for the current configuration.
//!
//! The image report (`agent/jouzu-image/report.json`) is the image tool's answer,
//! written by the extension inside a runtime when the host sends it
//! `/jouzu-image-refresh <token>`. It counts only when it carries the token of the
//! current generation; the token also names this host process, so a report left
//! from an earlier start is never taken for a new one.

use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
};

use serde_json::{json, Value};

#[derive(Default)]
struct Known {
    models: Vec<Value>,
    /// A runtime answered `get_available_models` for this generation; an empty
    /// list is then an answer, not a wait.
    answered: bool,
    start_model: Option<Value>,
}

#[derive(Default)]
struct Image {
    /// The newest report taken, possibly from an earlier generation.
    report: Option<Value>,
    /// The generation a refresh was sent for.
    requested: Option<u64>,
}

pub struct KnownModels {
    known: Mutex<Known>,
    image: Mutex<Image>,
    generation: AtomicU64,
    /// Names this host process in the image report's token.
    boot: u64,
    /// Where the image tool writes its report.
    report_path: OnceLock<PathBuf>,
    /// Runs after an answer for the current generation changed what is known.
    listener: OnceLock<Box<dyn Fn() + Send + Sync>>,
}

impl Default for KnownModels {
    fn default() -> Self {
        Self {
            known: Mutex::default(),
            image: Mutex::default(),
            generation: AtomicU64::new(0),
            boot: rand::random(),
            report_path: OnceLock::new(),
            listener: OnceLock::new(),
        }
    }
}

impl KnownModels {
    pub fn new() -> Self {
        Self::default()
    }

    /// Set once when the host starts: AppView is published again after each answer.
    pub fn on_change(&self, action: impl Fn() + Send + Sync + 'static) {
        let _ = self.listener.set(Box::new(action));
    }

    fn changed(&self) {
        if let Some(action) = self.listener.get() {
            action();
        }
    }

    /// Set once when the host starts: the runtime home's agent folder.
    pub fn read_reports_in(&self, agent_dir: PathBuf) {
        let _ = self.report_path.set(agent_dir.join("jouzu-image").join("report.json"));
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Known> {
        self.known.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The configuration generation a runtime started under. Its answers count
    /// only while no configuration change came after it.
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    /// The configuration changed: what runtimes said before no longer holds.
    pub fn forget(&self) {
        let mut known = self.lock();
        self.generation.fetch_add(1, Ordering::SeqCst);
        *known = Known::default();
    }

    /// A runtime answered `get_available_models`.
    pub fn remember_list(&self, generation: u64, models: &[Value]) {
        let changed = {
            let mut known = self.lock();
            if generation != self.generation() || (known.answered && known.models.as_slice() == models) {
                false
            } else {
                known.models = models.to_vec();
                known.answered = true;
                true
            }
        };
        if changed {
            self.changed();
        }
    }

    /// A blank runtime (warm, or a new conversation's) reported its model.
    pub fn remember_start_model(&self, generation: u64, model: Option<&Value>) {
        let changed = {
            let mut known = self.lock();
            let model = model.filter(|model| model.get("id").is_some()).cloned();
            if generation != self.generation() || known.start_model == model {
                false
            } else {
                known.start_model = model;
                true
            }
        };
        if changed {
            self.changed();
        }
    }

    /// The models block of AppView: `updating` until a runtime of the current
    /// generation answered.
    pub fn models_view(&self) -> Value {
        let known = self.lock();
        let generation = self.generation();
        json!({
            "generation": known.answered.then_some(generation),
            "state": if known.answered { "ready" } else { "updating" },
            "list": known.models,
            "startModel": known.start_model,
        })
    }

    fn image_lock(&self) -> std::sync::MutexGuard<'_, Image> {
        self.image.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The word a refresh carries and its report must repeat.
    pub fn image_token(&self, generation: u64) -> String {
        format!("{:016x}-{generation}", self.boot)
    }

    /// The first ready runtime of a generation asks for the image report; the
    /// others do not. `None` once someone asked, or for an old generation.
    pub fn claim_image_refresh(&self, generation: u64) -> Option<String> {
        let mut image = self.image_lock();
        if generation != self.generation() || image.requested == Some(generation) {
            return None;
        }
        image.requested = Some(generation);
        Some(self.image_token(generation))
    }

    /// The refresh did not finish: the next ready runtime asks again.
    pub fn release_image_refresh(&self, generation: u64) {
        let mut image = self.image_lock();
        if image.requested == Some(generation) {
            image.requested = None;
        }
    }

    /// Read the report the image tool wrote. It is taken when it was computed
    /// for the current generation and differs from the one held.
    pub fn read_image_report(&self) {
        let Some(path) = self.report_path.get() else {
            return;
        };
        let Some(report) = std::fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        else {
            return;
        };
        if self.remember_image_report(report) {
            self.changed();
        }
    }

    fn remember_image_report(&self, report: Value) -> bool {
        let current = self.image_token(self.generation());
        if report.get("generation").and_then(Value::as_str) != Some(current.as_str()) {
            return false;
        }
        let mut image = self.image_lock();
        if image.report.as_ref() == Some(&report) {
            return false;
        }
        image.report = Some(report);
        true
    }

    /// The report part of AppView's tools block: `checking` until a report for
    /// the current generation was taken. The last report stays for reference.
    pub fn image_view(&self) -> (Value, &'static str) {
        let image = self.image_lock();
        let current = self.image_token(self.generation());
        let fresh = image
            .report
            .as_ref()
            .and_then(|report| report.get("generation"))
            .and_then(Value::as_str)
            == Some(current.as_str());
        (image.report.clone().unwrap_or(Value::Null), if fresh { "ready" } else { "checking" })
    }

    /// The latest list a runtime answered; empty when none has yet.
    pub fn list(&self) -> Vec<Value> {
        self.lock().models.clone()
    }

    /// The model a blank runtime last reported at start.
    pub fn start_model(&self) -> Option<Value> {
        self.lock().start_model.clone()
    }

    /// The listed entry for `provider`/`id`, as the runtime described it.
    pub fn find(&self, provider: &str, id: &str) -> Option<Value> {
        self.lock()
            .models
            .iter()
            .find(|model| is_model(model, provider, id))
            .cloned()
    }
}

/// Whether a runtime model entry is `provider`/`id`.
pub fn is_model(model: &Value, provider: &str, id: &str) -> bool {
    model.get("provider").and_then(Value::as_str) == Some(provider)
        && model.get("id").and_then(Value::as_str) == Some(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn answers_from_before_a_configuration_change_are_not_taken() {
        let known = KnownModels::new();
        let before = known.generation();
        known.remember_list(before, &[json!({ "provider": "a", "id": "x" })]);
        assert_eq!(known.list().len(), 1);
        known.forget();
        assert!(known.list().is_empty());
        // A runtime started before the change answers late: ignored.
        known.remember_list(before, &[json!({ "provider": "a", "id": "x" })]);
        assert!(known.list().is_empty());
        known.remember_list(known.generation(), &[json!({ "provider": "b", "id": "y" })]);
        assert!(known.find("b", "y").is_some());
        assert!(known.find("a", "x").is_none());
    }

    #[test]
    fn models_are_updating_until_the_current_generation_answers() {
        let known = KnownModels::new();
        let calls = std::sync::Arc::new(AtomicU64::new(0));
        let counter = calls.clone();
        known.on_change(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(known.models_view()["state"], "updating");
        let before = known.generation();
        known.remember_list(before, &[]);
        // An empty list is an answer.
        assert_eq!(known.models_view()["state"], "ready");
        assert_eq!(known.models_view()["generation"], before);
        known.forget();
        assert_eq!(known.models_view()["state"], "updating");
        known.remember_list(before, &[json!({ "provider": "a", "id": "x" })]);
        assert_eq!(known.models_view()["state"], "updating");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        known.remember_list(known.generation(), &[json!({ "provider": "a", "id": "x" })]);
        // The same answer again publishes nothing.
        known.remember_list(known.generation(), &[json!({ "provider": "a", "id": "x" })]);
        assert_eq!(known.models_view()["state"], "ready");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn an_image_report_counts_only_for_the_current_generation() {
        let folder = tempfile::tempdir().unwrap();
        let known = KnownModels::new();
        known.read_reports_in(folder.path().to_path_buf());
        let write = |generation: &str| {
            std::fs::create_dir_all(folder.path().join("jouzu-image")).unwrap();
            std::fs::write(
                folder.path().join("jouzu-image/report.json"),
                json!({ "schema": 1, "generation": generation, "usable": true, "providers": [] }).to_string(),
            )
            .unwrap();
        };
        assert_eq!(known.image_view().1, "checking");
        // Only one runtime asks per generation.
        let token = known.claim_image_refresh(known.generation()).unwrap();
        assert!(known.claim_image_refresh(known.generation()).is_none());
        // A report from an earlier host start is not taken.
        write("0000000000000000-0");
        known.read_image_report();
        assert_eq!(known.image_view().1, "checking");
        write(&token);
        known.read_image_report();
        assert_eq!(known.image_view().1, "ready");
        // A configuration change: checking again, the old report kept for reference.
        known.forget();
        let (report, state) = known.image_view();
        assert_eq!(state, "checking");
        assert_eq!(report["generation"], token.as_str());
        let next = known.claim_image_refresh(known.generation()).unwrap();
        assert_ne!(next, token);
        known.release_image_refresh(known.generation());
        assert!(known.claim_image_refresh(known.generation()).is_some());
    }
}
