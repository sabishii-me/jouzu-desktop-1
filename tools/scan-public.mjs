// This repository is public. Before anything is committed, this scans the
// files about to be committed (or the paths given) for what must never be
// published: keys and tokens, personal folders, and the names of private
// machines or people. Exits 1 and lists every hit.
//
//   node tools/scan-public.mjs              scans the staged files
//   node tools/scan-public.mjs <paths...>   scans those files or folders
//
// Private words to look for (machine names, user names) are given in the
// QA_PRIVATE_WORDS environment variable, comma separated, so the list itself
// is never published. Images are not read; their words are, from the atlas
// index, which is why every state records its words.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const patterns = [
  ["api key or token", /\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/u],
  ["token in a URL", /[?&](token|key|secret|password)=[A-Za-z0-9._~-]{8,}/iu],
  ["bearer credential", /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/u],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/u],
  ["personal Windows folder", /[A-Za-z]:\\+Users\\+(?!Public\b|Default\b|runneradmin\b|test\b|<)[^\\\s"']+/iu],
  ["personal home folder", /\/(home|Users)\/(?!runner\b|user\b|test\b|<)[a-z][\w.-]+/u],
  ["email address", /\b[A-Za-z0-9._%+-]+@(?!example\.(com|org)\b|users\.noreply\.github\.com\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/u],
];
const words = (process.env.QA_PRIVATE_WORDS ?? "").split(",").map(word => word.trim()).filter(Boolean);
for (const word of words) patterns.push([`private word`, new RegExp(word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu")]);

function files(paths) {
  return paths.flatMap(path => statSync(path).isDirectory()
    ? readdirSync(path).filter(name => name !== "node_modules" && name !== ".git").flatMap(name => files([join(path, name)]))
    : [path]);
}
const given = process.argv.slice(2);
const list = given.length
  ? files(given)
  : execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], { encoding: "utf8" }).split("\n").filter(Boolean);

let hits = 0;
for (const file of list) {
  if (/\.(png|jpe?g|gif|webp)$/iu.test(file)) continue;
  let text;
  try { text = readFileSync(file, "utf8"); } catch { continue; }
  text.split("\n").forEach((line, index) => {
    for (const [what, pattern] of patterns) {
      if (file.endsWith("scan-public.mjs") && what !== "private word") continue;
      if (pattern.test(line)) {
        hits += 1;
        console.log(`${file}:${index + 1}: ${what}`);
      }
    }
  });
}
console.log(hits ? `${hits} finding(s): nothing may be committed until they are gone.` : `${list.length} file(s) clean.`);
process.exit(hits ? 1 : 0);
