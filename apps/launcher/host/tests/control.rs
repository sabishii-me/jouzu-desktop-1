//! Control exercised against the real adapter.
//!
//! These tests spawn the real `control.mjs` with the real Node. They need a real Jouzu
//! application directory for the adapter's module imports, which cannot live in the
//! repository; without `JOUZU_HOST_TEST_APP` they skip and say so instead of passing
//! silently. `JOUZU_HOST_TEST_HOME`, when set, is a real JOUZU_HOME to read instead of
//! an empty temporary one.

use std::{path::PathBuf, sync::Arc};

use jouzu_host::{control::ControlManager, models::Models};
use serde_json::json;

fn app_dir() -> Option<PathBuf> {
    let value = std::env::var_os("JOUZU_HOST_TEST_APP")?;
    let app = PathBuf::from(value);
    if !app.join("bootstrap.mjs").is_file() || !app.join("node_modules/jouzu/dist/cli.js").is_file()
    {
        eprintln!(
            "skipped: JOUZU_HOST_TEST_APP={} is not a Jouzu app directory",
            app.display()
        );
        return None;
    }
    Some(app)
}

fn manager(app: &PathBuf, home: &PathBuf) -> Arc<ControlManager> {
    let install = app.parent().expect("app has a parent");
    let runtime_home = home.join("data");
    std::fs::create_dir_all(&runtime_home).unwrap();
    // The bundled Node under the install, unless JOUZU_HOST_TEST_NODE names one.
    let node = std::env::var_os("JOUZU_HOST_TEST_NODE").map(PathBuf::from);
    Arc::new(ControlManager::new(install, install, node, home, &runtime_home, None).expect("control manager"))
}

#[tokio::test]
async fn available_models_include_thinking_levels() {
    let Some(app) = app_dir() else { return };
    let Some(home) = std::env::var_os("JOUZU_HOST_TEST_HOME").map(PathBuf::from) else {
        eprintln!("skipped: set JOUZU_HOST_TEST_HOME to a real JOUZU_HOME with models");
        return;
    };
    let manager = manager(&app, &home);

    let value = manager
        .request(json!({ "action": "available-models" }))
        .await
        .expect("available-models");
    let models = value["models"].as_array().expect("models array");
    assert!(!models.is_empty(), "no models: {value}");
    for model in models {
        assert!(
            model["thinkingLevels"].is_array(),
            "thinkingLevels missing: {model}"
        );
        assert!(model["provider"].is_string(), "provider missing: {model}");
        assert!(model["id"].is_string(), "id missing: {model}");
    }
}

#[tokio::test]
async fn status_runs_the_real_adapter() {
    let Some(app) = app_dir() else { return };
    let temp = tempfile::tempdir().unwrap();
    let home = match std::env::var_os("JOUZU_HOST_TEST_HOME") {
        Some(value) => PathBuf::from(value),
        None => temp.path().to_path_buf(),
    };
    let manager = manager(&app, &home);

    let value = manager
        .request(json!({ "action": "status" }))
        .await
        .expect("status");

    assert_eq!(value["schemaVersion"], 1, "unexpected status payload: {value}");
    assert!(value["models"].is_array(), "models is not an array: {value}");
    assert!(
        value["providers"].is_array(),
        "providers is not an array: {value}"
    );
    eprintln!("status models: {}", value["models"]);
}

#[tokio::test]
async fn an_unknown_action_is_refused_without_spawning() {
    let Some(app) = app_dir() else { return };
    let temp = tempfile::tempdir().unwrap();
    let manager = manager(&app, &temp.path().to_path_buf());

    let error = manager
        .request(json!({ "action": "definitely-not-an-action" }))
        .await
        .expect_err("unknown action");

    assert_eq!(error.code, "invalid-request");
}

#[tokio::test]
async fn cancelling_idle_control_is_a_no_op() {
    let Some(app) = app_dir() else { return };
    let temp = tempfile::tempdir().unwrap();
    let manager = manager(&app, &temp.path().to_path_buf());

    assert!(!manager.cancel(None));
    assert!(!manager.cancel(Some("c-never-started")));
}

#[tokio::test]
async fn models_snapshot_comes_from_the_real_adapter() {
    let Some(app) = app_dir() else { return };
    let temp = tempfile::tempdir().unwrap();
    let home = match std::env::var_os("JOUZU_HOST_TEST_HOME") {
        Some(value) => PathBuf::from(value),
        None => {
            eprintln!("skipped: set JOUZU_HOST_TEST_HOME to a real JOUZU_HOME with models");
            return;
        }
    };
    let control = manager(&app, &home);
    let cache = temp.path().join("host");
    let models = Models::new(&cache);

    let snapshot = models.get(&control).await.expect("model snapshot");
    let list = snapshot["models"].as_array().expect("models array");
    assert!(!list.is_empty(), "adapter returned no models: {snapshot}");
    assert!(snapshot["generatedAt"].is_string());
    assert_eq!(snapshot["stale"], false);
    let first = &list[0];
    assert!(first["provider"].is_string() && first["id"].is_string() && first["name"].is_string());
    assert!(cache.join("host-state").join("models.json").is_file(), "snapshot was not cached");

    // A second read is served from the cache: no adapter process is needed.
    let cached = models.get(&control).await.expect("cached snapshot");
    assert_eq!(cached["generatedAt"], snapshot["generatedAt"]);
}

#[tokio::test]
async fn a_fresh_home_has_no_usable_model() {
    let Some(app) = app_dir() else { return };
    let temp = tempfile::tempdir().unwrap();
    let control = manager(&app, &temp.path().to_path_buf());
    let models = Models::new(temp.path());

    // No provider is configured in a fresh home; the host must say so instead of
    // exposing the unconfigured global catalog as selectable models.
    let error = models.get(&control).await.expect_err("fresh home has no model");
    assert_eq!(error.code, "models-unavailable", "{error:?}");
}

