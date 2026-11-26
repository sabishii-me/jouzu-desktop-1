import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

export function platformName() {
  return process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
}

/** Every record in <out>/results.jsonl (suite runs and acceptance records), oldest first. */
export function readResults(out) {
  const file = join(out, 'results.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

/**
 * A baseline: the recorded results of the last release on the same kind of machine, as
 * results.txt lines ("PASS [en] <case>: <problems>"; without a language tag the line holds
 * for every language). Case names can hold ": ", so a line is matched against the known
 * names (longest first). Re-run lines are ignored. Returns Map("<lang>\t<case>" -> status).
 */
export function readBaseline(file, names) {
  const map = new Map();
  if (!file) return map;
  const known = [...names].sort((a, b) => b.length - a.length);
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^(PASS|FAIL|SKIP|ERROR)\s+(?:\[([\w-]+)\]\s+)?(.+)$/);
    if (!m || /\(re-run \d+\)/.test(line)) continue;
    const [, status, language, rest] = m;
    const name = known.find(item => rest === item || rest.startsWith(`${item}:`) || rest.startsWith(`${item} `));
    if (name) map.set(`${language ?? '*'}\t${name}`, status);
  }
  return map;
}
export function baselineOf(map, language, name) {
  return map.get(`${language}\t${name}`) ?? map.get(`*\t${name}`) ?? null;
}

/** What the two results say together. A fact for the report; it never decides anything. */
export function comparison(base, now, hasBaseline) {
  if (!hasBaseline) return 'N/A: no release on this platform';
  if (!base) return 'no baseline record';
  if (base === 'SKIP' || now === 'SKIP') return '-';
  const bad = status => status === 'FAIL' || status === 'ERROR';
  if (base === 'PASS' && bad(now)) return 'REGRESSION';
  if (bad(base) && bad(now)) return 'also fails in baseline';
  if (bad(base) && now === 'PASS') return 'fixed since baseline';
  return 'same';
}
