use std::path::Path;

/// The desktop's commit attribution extension ("Mark commits made by the agent",
/// Settings > Tools, off by default), installed beside the image extension.
const MANIFEST: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../packaging/desktop/extensions/jouzu-attribution/package.json"
));
const EXTENSION: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../packaging/desktop/extensions/jouzu-attribution/index.js"
));
const HOOK: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../packaging/desktop/extensions/jouzu-attribution/hook.sh"
));

/// Write the extension into the Jouzu home's agent folder, where the runtime loads it.
/// Idempotent: a newer desktop replaces the files. The extension writes its own
/// hooks folder from `hook.sh` when the setting is on.
pub fn ensure(home: &Path) -> Result<(), String> {
    let directory = home.join("agent").join("extensions").join("jouzu-attribution");
    std::fs::create_dir_all(&directory).map_err(|error| format!("Could not create the attribution extension: {error}"))?;
    std::fs::write(directory.join("package.json"), MANIFEST).map_err(|error| error.to_string())?;
    std::fs::write(directory.join("index.js"), EXTENSION).map_err(|error| error.to_string())?;
    std::fs::write(directory.join("hook.sh"), HOOK).map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_extension_lands_where_pi_looks_for_it() {
        let home = tempfile::tempdir().unwrap();
        ensure(home.path()).unwrap();
        let directory = home.path().join("agent/extensions/jouzu-attribution");
        for file in ["package.json", "index.js", "hook.sh"] {
            assert!(directory.join(file).is_file(), "{file}");
        }
        assert!(!HOOK.contains('\r'), "the hook must stay LF for sh");
    }
}
