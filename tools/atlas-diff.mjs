// What changed in the UI between two versions of the atlas.
//
//   node tools/atlas-diff.mjs <older version> <newer version> [--json out.json]
//
// A state is the same state when its id, language, device and theme match. It
// reports states that appeared, disappeared, look different (another image) or
// say different words. It judges nothing: every change it lists must be marked
// intended (with its issue or PR) or a regression by the reviewer, and an
// unmarked change or a regression blocks the release.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [older, newer] = process.argv.slice(2).filter(value => !value.startsWith("--"));
const jsonAt = process.argv.indexOf("--json");
if (!older || !newer) {
  console.error("usage: node tools/atlas-diff.mjs <older version> <newer version> [--json out.json]");
  process.exit(2);
}
const load = version => JSON.parse(readFileSync(join(root, "atlas", "versions", version, "index.json"), "utf8"));
const key = state => `${state.id}|${state.lang}|${state.device}|${state.theme}`;
const before = new Map(load(older).states.map(state => [key(state), state]));
const after = new Map(load(newer).states.map(state => [key(state), state]));

const changes = [];
for (const [at, state] of after) {
  const was = before.get(at);
  if (!was) { changes.push({ kind: "added", key: at, after: state.blob }); continue; }
  const looks = was.blob !== state.blob;
  const says = JSON.stringify(was.words) !== JSON.stringify(state.words);
  if (looks || says) changes.push({ kind: looks && says ? "looks-and-says" : looks ? "looks" : "says", key: at, before: was.blob, after: state.blob });
}
for (const [at, state] of before) if (!after.has(at)) changes.push({ kind: "removed", key: at, before: state.blob });

const counts = changes.reduce((all, change) => ({ ...all, [change.kind]: (all[change.kind] ?? 0) + 1 }), {});
console.log(`${older} -> ${newer}: ${after.size} states, ${changes.length} changed ${JSON.stringify(counts)}`);
for (const change of changes) console.log(`${change.kind.padEnd(15)} ${change.key}`);
if (jsonAt > 0) writeFileSync(process.argv[jsonAt + 1], `${JSON.stringify({ older, newer, changes }, null, 2)}\n`);
