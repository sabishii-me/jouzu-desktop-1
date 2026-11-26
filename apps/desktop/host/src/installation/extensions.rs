//! The desktop's own pi extensions, written into the agent folder of Jouzu's
//! home, where the runtime loads them. They belong to this build: each start
//! and each installation writes the copy this host carries.

use std::path::Path;

macro_rules! packaged {
    ($path:literal) => {
        include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../packaging/desktop/extensions/", $path))
    };
}

/// The image tool (`generate_image`).
const IMAGE: &[(&str, &str)] = &[
    ("package.json", packaged!("jouzu-image/package.json")),
    ("index.js", packaged!("jouzu-image/index.js")),
    ("report.mjs", packaged!("jouzu-image/report.mjs")),
    ("choice.mjs", packaged!("jouzu-image/choice.mjs")),
    ("choice.d.mts", packaged!("jouzu-image/choice.d.mts")),
    ("artifacts.mjs", packaged!("jouzu-image/artifacts.mjs")),
    ("providers/errors.mjs", packaged!("jouzu-image/providers/errors.mjs")),
    ("providers/shisa.mjs", packaged!("jouzu-image/providers/shisa.mjs")),
    ("providers/codex.mjs", packaged!("jouzu-image/providers/codex.mjs")),
    ("providers/runtime.mjs", packaged!("jouzu-image/providers/runtime.mjs")),
];

/// Commit attribution ("Mark commits made by the agent", Settings > Tools, off by
/// default). The extension writes its own hooks folder from `hook.sh` when the
/// setting is on.
const ATTRIBUTION: &[(&str, &str)] = &[
    ("package.json", packaged!("jouzu-attribution/package.json")),
    ("index.js", packaged!("jouzu-attribution/index.js")),
    ("hook.sh", packaged!("jouzu-attribution/hook.sh")),
];

fn write(home: &Path, name: &str, files: &[(&str, &str)]) -> Result<(), String> {
    let directory = home.join("agent").join("extensions").join(name);
    for (file, body) in files {
        let path = directory.join(file);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("Could not create the {name} extension: {error}"))?;
        }
        if std::fs::read(&path).ok().as_deref() != Some(body.as_bytes()) {
            std::fs::write(&path, body).map_err(|error| format!("Could not write the {name} extension: {error}"))?;
        }
    }
    Ok(())
}

/// Write both extensions. Idempotent: a newer desktop replaces the files.
pub fn ensure(home: &Path) -> Result<(), String> {
    write(home, "jouzu-image", IMAGE)?;
    write(home, "jouzu-attribution", ATTRIBUTION)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_extensions_land_where_pi_looks_for_them() {
        let home = tempfile::tempdir().unwrap();
        ensure(home.path()).unwrap();
        let image = home.path().join("agent/extensions/jouzu-image");
        for (file, _) in IMAGE {
            assert!(image.join(file).is_file(), "{file}");
        }
        assert!(std::fs::read_to_string(image.join("package.json")).unwrap().contains("pi"));
        let attribution = home.path().join("agent/extensions/jouzu-attribution");
        for file in ["package.json", "index.js", "hook.sh"] {
            assert!(attribution.join(file).is_file(), "{file}");
        }
        assert!(!ATTRIBUTION[2].1.contains('\r'), "the hook must stay LF for sh");
    }

    /// Every file of each packaged extension is carried: a file added to the
    /// extension and missing here would leave the runtime without it.
    #[test]
    fn every_packaged_file_is_carried() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../packaging/desktop/extensions");
        for (name, files) in [("jouzu-image", IMAGE), ("jouzu-attribution", ATTRIBUTION)] {
            let mut packaged = Vec::new();
            let mut pending = vec![root.join(name)];
            while let Some(directory) = pending.pop() {
                for entry in std::fs::read_dir(&directory).unwrap() {
                    let path = entry.unwrap().path();
                    if path.is_dir() {
                        pending.push(path);
                    } else {
                        let relative = path.strip_prefix(root.join(name)).unwrap().to_string_lossy().replace('\\', "/");
                        packaged.push(relative);
                    }
                }
            }
            packaged.sort();
            let mut carried: Vec<String> = files.iter().map(|(file, _)| file.to_string()).collect();
            carried.sort();
            assert_eq!(carried, packaged, "{name}");
        }
    }

    #[test]
    fn a_stale_copy_is_replaced() {
        let home = tempfile::tempdir().unwrap();
        ensure(home.path()).unwrap();
        let index = home.path().join("agent/extensions/jouzu-image/index.js");
        std::fs::write(&index, "old").unwrap();
        ensure(home.path()).unwrap();
        assert_eq!(std::fs::read_to_string(&index).unwrap(), IMAGE[1].1);
    }
}
