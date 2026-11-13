// Builds everything a packaged Jouzu Desktop ships, from one source tree:
// the web UI (`dist`) and the release host (`host/target/release`). Tauri runs
// this before it compiles the shell, so an installer can never pair a fresh UI
// with a host left over from an earlier build.
//
// Every build gets a new id in `.build-id`. The host and the shell both compile
// it in (see their build.rs); a release shell refuses to start a host with a
// different id, instead of running a mixed install.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const buildId = `${new Date().toISOString().replace(/[-:.]/gu, "")}-${randomBytes(4).toString("hex")}`;
writeFileSync(join(root, ".build-id"), `${buildId}\n`);
console.log(`Jouzu Desktop build ${buildId}`);

function run(command) {
  const result = spawnSync(command, { cwd: root, stdio: "inherit", shell: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("npm run build");
run("cargo build --release --locked --manifest-path host/Cargo.toml");
