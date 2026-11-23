// Adds one version's UI states to the atlas.
//
//   node tools/atlas-build.mjs --version 1.1.5-rc.1 --run <exam out folder> [--device desktop-1280] [--theme dark] [--source "installed app"]
//
// <exam out folder> is what harness/e2e-runtime/abnormal-exam.mjs wrote with
// ABN_PLAYBOOK=ui-states.mjs: one folder per language holding <state id>.png and
// <state id>.json. Each image is stored once, by the SHA-256 of its bytes, in
// atlas/blobs/; the version gets atlas/versions/<version>/index.json naming the
// image and the on-screen words of every state. A state that did not change
// between versions adds no new image. Running it again for the same version,
// language, device and theme replaces those entries.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (value.startsWith("--") ? [...pairs, [value.slice(2), all[index + 1]]] : pairs), []));
const { version, run } = args;
if (!version || !run) {
  console.error("usage: node tools/atlas-build.mjs --version <v> --run <exam out folder> [--device <name>] [--theme <name>] [--source <text>]");
  process.exit(2);
}
const device = args.device ?? "desktop-1280";
const theme = args.theme ?? "dark";
const blobs = join(root, "atlas", "blobs");
const folder = join(root, "atlas", "versions", version);
mkdirSync(blobs, { recursive: true });
mkdirSync(folder, { recursive: true });

const indexFile = join(folder, "index.json");
const index = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, "utf8")) : { version, states: [] };
index.updatedAt = new Date().toISOString();
if (args.source) index.source = args.source;

let added = 0;
let stored = 0;
for (const lang of readdirSync(run).filter(name => statSync(join(run, name)).isDirectory() && /^[a-z]{2}(-[A-Za-z]+)?$/u.test(name))) {
  index.states = index.states.filter(state => !(state.lang === lang && state.device === device && state.theme === theme));
  for (const file of readdirSync(join(run, lang)).filter(name => name.endsWith(".png")).sort()) {
    const id = file.slice(0, -4);
    const bytes = readFileSync(join(run, lang, file));
    const hash = createHash("sha256").update(bytes).digest("hex");
    const blob = join(blobs, `${hash}.png`);
    if (!existsSync(blob)) {
      copyFileSync(join(run, lang, file), blob);
      stored += 1;
    }
    const wordsFile = join(run, lang, `${id}.json`);
    const meta = existsSync(wordsFile) ? JSON.parse(readFileSync(wordsFile, "utf8")) : {};
    index.states.push({ id, lang, device, theme, group: meta.group ?? "", name: meta.name ?? id, note: meta.note ?? "", blob: `${hash}.png`, words: meta.words ?? null });
    added += 1;
  }
}
index.states.sort((a, b) => `${a.id}|${a.lang}|${a.device}|${a.theme}`.localeCompare(`${b.id}|${b.lang}|${b.device}|${b.theme}`));
writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`);

// The viewer opens from disk (file://), where it cannot list folders or fetch
// JSON, so the list of versions is also written as a script it loads.
const versions = readdirSync(join(root, "atlas", "versions")).filter(name => existsSync(join(root, "atlas", "versions", name, "index.json"))).sort();
writeFileSync(join(root, "atlas", "versions.json"), `${JSON.stringify(versions, null, 2)}\n`);
mkdirSync(join(root, "viewer", "data"), { recursive: true });
writeFileSync(join(root, "viewer", "data", `${version}.js`), `window.ATLAS = window.ATLAS || {};\nwindow.ATLAS[${JSON.stringify(version)}] = ${JSON.stringify(index)};\n`);
writeFileSync(join(root, "viewer", "data", "versions.js"), `window.ATLAS_VERSIONS = ${JSON.stringify(versions)};\n`);
console.log(`${version}: ${added} states recorded (${device}, ${theme}), ${stored} new images.`);
if (added === 0) process.exit(1);
