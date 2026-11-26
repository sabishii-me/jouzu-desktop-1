import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { platformName } from './common.mjs';

// Records one acceptance item (suite C or D) of the plan, as it was seen. No judgement
// beyond the plan's own "expected" lines: PASS when every expected line was seen, FAIL
// otherwise. Evidence files must exist under <out>.
//
//   node harness/run/record.mjs --out <folder> --plan <plan.json> --machine <name> \
//     --id <item id> --result PASS|FAIL --actual "<what was seen>" --evidence accept/a.png,accept/b.txt [--lang en]
//
// Print an item's steps and expected results first:
//   node harness/run/record.mjs --plan <plan.json> --show <item id>

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, item, index, all) => item.startsWith('--') ? [...pairs, [item.slice(2), all[index + 1]]] : pairs, []));
const plan = JSON.parse(readFileSync(resolve(args.plan), 'utf8'));
const find = id => (plan.acceptance ?? []).find(item => item.id === id);

if (args.show) {
  const item = find(args.show);
  if (!item) { console.error(`No acceptance item ${args.show} in the plan`); process.exit(2); }
  console.log(`${item.id} ${item.title}\n\nSteps:\n${item.steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}\n\nExpected (all must be seen for PASS):\n${item.expected.map(s => `  - ${s}`).join('\n')}\n\nEvidence to keep: ${item.evidence ?? 'a screenshot of the end state'}`);
  process.exit(0);
}

for (const name of ['out', 'machine', 'id', 'result', 'actual']) if (!args[name]) { console.error(`--${name} is required`); process.exit(2); }
const item = find(args.id);
if (!item) { console.error(`No acceptance item ${args.id} in the plan`); process.exit(2); }
if (!['PASS', 'FAIL'].includes(args.result)) { console.error('--result is PASS or FAIL'); process.exit(2); }
const out = resolve(args.out);
mkdirSync(out, { recursive: true });
const evidence = (args.evidence ?? '').split(',').map(s => s.trim()).filter(Boolean);
const missing = evidence.filter(path => !existsSync(join(out, path)));
if (!evidence.length || missing.length) { console.error(`Evidence is required and must exist under ${out}${missing.length ? `; missing: ${missing.join(', ')}` : ''}`); process.exit(2); }
const record = {
  phase: 'acceptance', id: item.id, suite: item.suite, case: item.title, language: args.lang ?? '-',
  machine: args.machine, platform: platformName(), status: args.result, actual: args.actual, evidence,
  problems: args.result === 'FAIL' ? [args.actual] : [], at: new Date().toISOString(),
};
appendFileSync(join(out, 'results.jsonl'), `${JSON.stringify(record)}\n`);
console.log(`${record.status} ${item.id} ${item.title}`);
