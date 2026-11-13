// See scripts/build-app.mjs: a packaged build stamps the host and the shell
// with the same id. Builds outside that script are "dev".
fn main() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.build-id");
    println!("cargo:rerun-if-changed={}", path.display());
    let id = std::fs::read_to_string(&path)
        .map(|text| text.trim().to_string())
        .unwrap_or_default();
    let id = if id.is_empty() { "dev".to_string() } else { id };
    println!("cargo:rustc-env=JOUZU_BUILD_ID={id}");
}
