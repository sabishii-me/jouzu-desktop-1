//! Control exercised against the real adapter.
//!
//! These tests spawn the real `control.mjs` with the real Node. They need a real Jouzu
//! application directory for the adapter's module imports, which cannot live in the
//! repository; without `JOUZU_HOST_TEST_APP` they skip and say so instead of passing
//! silently. `JOUZU_HOST_TEST_HOME`, when set, is a real JOUZU_HOME to read instead of
//! an empty temporary one.

use std::{path::PathBuf, sync::Arc};

use jouzu_host::{control::ControlManager, models::ModelCatalog};
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
    Arc::new(ControlManager::new(install, install, node, &runtime_home, None).expect("control manager"))
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
async fn the_catalog_is_listed_from_the_real_adapter() {
    let Some(app) = app_dir() else { return };
    let home = match std::env::var_os("JOUZU_HOST_TEST_HOME") {
        Some(value) => PathBuf::from(value),
        None => {
            eprintln!("skipped: set JOUZU_HOST_TEST_HOME to a real JOUZU_HOME with models");
            return;
        }
    };
    let control = manager(&app, &home);
    let catalog = ModelCatalog::new();

    let (_, result) = catalog.load(&control, false).await;
    result.expect("catalog listing");
    let view = catalog.view();
    assert_eq!(view["state"], "ready", "{view}");
    assert_eq!(view["stale"], false);
    assert!(view["revision"].as_u64().unwrap() >= 1);
    let list = view["models"].as_array().expect("models array");
    assert!(!list.is_empty(), "adapter returned no models: {view}");
    let first = &list[0];
    assert!(first["provider"].is_string() && first["id"].is_string() && first["name"].is_string());
}

#[tokio::test]
async fn a_fresh_home_lists_no_model() {
    let Some(app) = app_dir() else { return };
    let temp = tempfile::tempdir().unwrap();
    let control = manager(&app, &temp.path().to_path_buf());
    let catalog = ModelCatalog::new();

    // No provider is configured in a fresh home: the catalog is listed and
    // empty, instead of exposing the unconfigured global catalog as selectable
    // models. Listed-and-empty is an answer, not a failure.
    let (_, result) = catalog.load(&control, false).await;
    result.expect("catalog listing");
    let view = catalog.view();
    assert_eq!(view["state"], "ready", "{view}");
    assert_eq!(view["models"], json!([]), "{view}");
    assert!(view["default"].is_null(), "{view}");
}


/// The stand-in app in `tests/fixtures/fake-app` runs the real adapter on every
/// platform: the catalog lists its model and default, and choosing a default
/// that the catalog does not list is refused.
#[tokio::test]
async fn the_catalog_and_its_default_through_the_adapter() {
    let install = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-app");
    let home = tempfile::tempdir().unwrap();
    // The host runs the adapter on the runtime's Node; here, the one on PATH.
    let node = std::process::Command::new(if cfg!(windows) { "where" } else { "which" })
        .arg("node")
        .output()
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .and_then(|text| text.lines().next().map(|line| PathBuf::from(line.trim())));
    let Some(node) = node.filter(|path| path.is_file()) else {
        eprintln!("skipped: no node on PATH");
        return;
    };
    let control = Arc::new(
        ControlManager::new(&install, &install, Some(node), home.path(), None).expect("control manager"),
    );
    let catalog = ModelCatalog::new();

    let (_, result) = catalog.load(&control, false).await;
    result.expect("catalog listing");
    let view = catalog.view();
    assert_eq!(view["state"], "ready", "{view}");
    assert_eq!(view["models"][0]["name"], "fixture-model", "{view}");
    assert_eq!(view["default"]["id"], "model", "{view}");

    control
        .request(json!({ "action": "default-model", "provider": "fixture", "model": "model" }))
        .await
        .expect("a listed model is saved as the default");
    let refused = control
        .request(json!({ "action": "default-model", "provider": "fixture", "model": "gone" }))
        .await;
    assert!(refused.is_err(), "an unlisted default was saved");
}
