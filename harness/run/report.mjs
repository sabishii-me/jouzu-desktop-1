import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { baselineOf, comparison, readBaseline, readResults } from './common.mjs';

// Writes <out>/report.md and <out>/results.txt from <out>/results.jsonl. Runs nothing.
//
//   node harness/run/report.mjs --out <folder> --plan <plan.json> [--baseline <results.txt>]
//
// The report holds facts only: each case's result, its re-runs, the baseline result and
// what the two say together, the evidence folder, and (if <out>/triage.json exists) the
// issue and severity given after the run. Acceptance items of the plan that have no record
// are listed as NOT RUN.

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, item, index, all) => item.startsWith('--') ? [...pairs, [item.slice(2), all[index + 1]]] : pairs, []));
const out = resolve(args.out);
const plan = JSON.parse(readFileSync(resolve(args.plan), 'utf8'));
const run = existsSync(join(out, 'run.json')) ? JSON.parse(readFileSync(join(out, 'run.json'), 'utf8')) : {};
const records = readResults(out);
const triage = existsSync(join(out, 'triage.json')) ? JSON.parse(readFileSync(join(out, 'triage.json'), 'utf8')) : {};
const platform = run.platform ?? records[0]?.platform;
// plan.baselines[platform] is one results file, or one per language ({en: file, ja: file}),
// relative to the plan. --baseline <file> overrides it for every language.
const planned_ = args.baseline ? args.baseline : plan.baselines?.[platform] ?? null;
const hasBaseline = Boolean(planned_);
const suiteRecords = records.filter(r => r.phase === 'first' || r.phase === 'rerun');
const names = [...new Set(suiteRecords.map(r => r.case))];
const baseline = new Map();
const baselineNotes = [];
const planDir = resolve(args.plan, '..');
for (const [language, file] of typeof planned_ === 'string' ? [['*', planned_]] : Object.entries(planned_ ?? {})) {
  const path = args.baseline ? resolve(file) : resolve(planDir, file);
  if (!existsSync(path)) { baselineNotes.push(`missing baseline file for ${language}: ${file}`); continue; }
  for (const [key, status] of readBaseline(path, names)) {
    const [tag, name] = key.split('\t');
    baseline.set(`${language === '*' ? tag : language}\t${name}`, status);
  }
}
const baselineFile = typeof planned_ === 'string' ? planned_ : JSON.stringify(planned_);
const cell = text => String(text ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const tri = (language, name) => triage[`${language}\t${name}`] ?? triage[name] ?? {};

const firsts = suiteRecords.filter(r => r.phase === 'first');
const rows = firsts.map(first => {
  const again = suiteRecords.filter(r => r.phase === 'rerun' && r.case === first.case && r.language === first.language);
  const base = baselineOf(baseline, first.language, first.case);
  return { ...first, reruns: again, base, label: comparison(base, first.status, hasBaseline), triage: tri(first.language, first.case) };
});
const count = status => rows.filter(row => row.status === status).length;

// Acceptance items (suites C and D) planned for this machine or platform.
const planned = (plan.acceptance ?? []).filter(item => (!item.platforms || item.platforms.includes(platform)) && (!item.machines || !run.machine || item.machines.includes(run.machine)));
const accepted = records.filter(r => r.phase === 'acceptance');
const acceptanceRows = planned.map(item => {
  const last = accepted.filter(r => r.id === item.id).at(-1);
  return { item, record: last, status: last?.status ?? 'NOT RUN', triage: tri('*', item.id) };
});

const lines = [];
lines.push(`# ${plan.version}: ${run.machine ?? ''} (${platform ?? ''})`, '');
lines.push(`- Plan: ${plan.planId ?? args.plan}`);
lines.push(`- App: ${Object.entries(run.app ?? {}).map(([k, v]) => `${k}=${v}`).join(', ')}`);
lines.push(`- Harness commit: ${run.harness ?? 'unknown'}`);
lines.push(`- Languages: ${(run.languages ?? []).join(', ')}`);
lines.push(`- Baseline: ${hasBaseline ? `${plan.baselineVersion ?? ''} ${baselineFile}` : 'none on this platform'}`);
for (const note of baselineNotes) lines.push(`- ${note}`);
lines.push(`- Started ${run.startedAt ?? '?'}, finished ${run.finishedAt ?? 'not finished'}`, '');
lines.push('## Counts', '');
lines.push(`| Planned | Ran | PASS | FAIL | ERROR | SKIP | Regressions | Acceptance planned | Acceptance recorded |`);
lines.push('|---|---|---|---|---|---|---|---|---|');
lines.push(`| ${run.cases ?? '?'} | ${rows.length} | ${count('PASS')} | ${count('FAIL')} | ${count('ERROR')} | ${count('SKIP')} | ${rows.filter(row => row.label === 'REGRESSION').length} | ${planned.length} | ${acceptanceRows.filter(row => row.status !== 'NOT RUN').length} |`, '');

lines.push('## Every result that is not PASS', '');
lines.push('| # | Case | Lang | Suite | Result | Re-runs | Baseline | Together | Problems | Evidence | Issue | Severity |');
lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
let number = 0;
for (const row of rows.filter(r => r.status !== 'PASS')) {
  number += 1;
  const reruns = row.reruns.length ? `${row.reruns.filter(r => r.status === 'PASS').length}/${row.reruns.length} PASS` : '-';
  lines.push(`| ${number} | ${cell(row.case)} | ${row.language} | ${row.suite} | ${row.status} | ${reruns} | ${row.base ?? '-'} | ${row.label} | ${cell([...row.problems, ...(row.leftProcesses?.length ? [`left running: ${row.leftProcesses.join(', ')}`] : [])].join('; '))} | ${row.evidence} | ${row.triage.issue ?? ''} | ${row.triage.severity ?? ''} |`);
}
for (const row of acceptanceRows.filter(r => r.status !== 'PASS')) {
  number += 1;
  lines.push(`| ${number} | ${cell(`${row.item.id} ${row.item.title}`)} | ${row.record?.language ?? '-'} | ${row.item.suite} | ${row.status} | - | - | - | ${cell(row.record?.actual ?? '')} | ${cell((row.record?.evidence ?? []).join(', '))} | ${row.triage.issue ?? ''} | ${row.triage.severity ?? ''} |`);
}
if (!number) lines.push('| - | none | | | | | | | | | | |');
lines.push('');

lines.push('## All suite cases', '');
lines.push('| Case | Lang | Suite | Result | Baseline | Together | Time (s) | Left running after the case |');
lines.push('|---|---|---|---|---|---|---|---|');
for (const row of rows) lines.push(`| ${cell(row.case)} | ${row.language} | ${row.suite} | ${row.status} | ${row.base ?? '-'} | ${row.label} | ${Math.round((row.ms ?? 0) / 1000)} | ${(row.leftProcesses ?? []).join(', ')} |`);
lines.push('');

lines.push('## Acceptance items', '');
lines.push('| Item | Suite | Title | Result | Actual | Evidence |');
lines.push('|---|---|---|---|---|---|');
for (const row of acceptanceRows) lines.push(`| ${row.item.id} | ${row.item.suite} | ${cell(row.item.title)} | ${row.status} | ${cell(row.record?.actual ?? '')} | ${cell((row.record?.evidence ?? []).join(', '))} |`);
if (!acceptanceRows.length) lines.push('| - | | none planned for this machine | | | |');
lines.push('');

writeFileSync(join(out, 'report.md'), `${lines.join('\n')}\n`);
const text = suiteRecords.map(r => `${r.status} [${r.language}] ${r.case}${r.phase === 'rerun' ? ` (re-run ${r.attempt})` : ''}${r.problems.length ? `: ${r.problems.join('; ')}` : ''}`);
writeFileSync(join(out, 'results.txt'), `${text.join('\n')}\n`);
console.log(`report: ${join(out, 'report.md')}`);
