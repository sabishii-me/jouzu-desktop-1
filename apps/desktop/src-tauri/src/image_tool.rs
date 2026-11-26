use std::path::{Path, PathBuf};

/// The desktop's own pi extension, installed into the agent's extension folder.
/// Every file of it is listed here; the runtime loads `index.js`.
const FILES: [(&str, &str); 8] = [
    ("package.json", include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../packaging/desktop/extensions/jouzu-image/package.json"))),
    ("index.js", include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../packaging/desktop/extensions/jouzu-image/index.js"))),
    ("report.mjs", include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../packaging/desktop/extensions/jouzu-image/report.mjs"))),
    ("artifacts.mjs", include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../packaging/desktop/extensions/jouzu-image/artifacts.mjs"))),
    ("providers/errors.mjs", include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../packaging/desktop/extensions/jouzu-image/providers/errors.mjs"))),
    ("providers/shisa.mjs", include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../packaging/desktop/extensions/jouzu-image/providers/shisa.mjs"))),
    ("providers/codex.mjs", include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../packaging/desktop/extensions/jouzu-image/providers/codex.mjs"))),
    ("providers/runtime.mjs", include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../packaging/desktop/extensions/jouzu-image/providers/runtime.mjs"))),
];

fn directory(home: &Path) -> PathBuf {
    home.join("agent").join("extensions").join("jouzu-image")
}

/// Write the extension into the Jouzu home's agent folder, where the runtime loads it.
/// Idempotent: a newer desktop replaces the files. The tool's settings
/// (`agent/tools.json`) belong to the host, its report to the extension.
pub fn ensure(home: &Path) -> Result<(), String> {
    let directory = directory(home);
    std::fs::create_dir_all(directory.join("providers")).map_err(|error| format!("Could not create the image extension: {error}"))?;
    for (name, content) in FILES {
        std::fs::write(directory.join(name), content).map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Called after a runtime install and on app start, so existing installs get it too.
#[tauri::command]
pub fn image_tool_ensure() -> Result<(), String> {
    let home = crate::runtime::effective_home()?;
    ensure(&home)?;
    // The desktop's other extension is installed at the same moments.
    crate::attribution_extension::ensure(&home)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_extension_lands_where_pi_looks_for_it() {
        let managed = tempfile::tempdir().unwrap();
        ensure(managed.path()).unwrap();
        let directory = managed.path().join("agent/extensions/jouzu-image");
        for (name, _) in FILES {
            assert!(directory.join(name).is_file(), "{name} missing");
        }
        let manifest = std::fs::read_to_string(directory.join("package.json")).unwrap();
        assert!(manifest.contains("pi"));
    }
}
