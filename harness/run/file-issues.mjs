#!/usr/bin/env node
// Files every product FAIL of a run as a GitHub issue, without waiting for a review, and never twice.
//
//   node harness/run/file-issues.mjs --out <run folder> [--repo owner/name] [--plan-only]
//
// The runner calls it at the end of every run (plan.issueRepo, default shisa-ai/jouzu-desktop;
// --no-issues on the runner, or RUN_SELFTEST, turns it off).
//
// One issue per finding, not per language or attempt:
//   - cases are grouped by case ID; cases that name the same finding in legacy/links (N1, O8,
//     P25: a letter and a number) are one finding;
//   - the issue it belongs to is, in this order: an issue that already carries the line
//     "QA case: <ID>" (in its text or a comment, open or closed); else an issue the catalog
//     links (#123); else a new one;
//   - an open issue gets a comment with this run's results; a closed one gets the comment and is
//     reopened, because the case fails again; a new one is opened with the label bug.
//   - each comment carries "QA run: <version> <machine> <started>", so filing the same run again
//     changes nothing.
// Severity and priority are not set here: they are the product owner's.
// ERROR results are not product findings (the harness could not run the case): they are listed in
// <out>/issues.json under harnessGaps and in the report, and never filed.
//
// GitHub access: GH_TOKEN or GITHUB_TOKEN (REST), else the gh command line if it is signed in.
// If an issue cannot be written, nothing is guessed: every planned action is in
// <out>/issue-actions.json, the run says so loudly, and the actions can be carried out later.
// --plan-only writes the actions without writing to GitHub (searching still happens).
// <out>/triage.json gets each case's issue number, so report.md shows it (severity is kept).

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCatalog } from './catalog.mjs';
import { readResults } from './common.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, item, index, all) => item.startsWith('--') ? [...pairs, [item.slice(2), all[index + 1]?.startsWith('--') || all[index + 1] === undefined ? true : all[index + 1]]] : pairs, []));
if (!args.out) { console.error('--out is required'); process.exit(2); }
const out = args.out;
const repo = typeof args.repo === 'string' ? args.repo : 'shisa-ai/jouzu-desktop';
const planOnly = Boolean(args['plan-only']);
const CATALOG_URL = 'https://github.com/sabishii-me/jouzu-desktop-1/blob/claude/project-thread-5d0uzg/release-checks/cases/CASES.md';

// ---- GitHub ----
let token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
async function api(method, path, body) {
  if (token) {
    const response = await fetch(`https://api.github.com${path}`, { method, headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'qa-runner' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    // A token GitHub does not take: use the gh command line's own sign-in instead.
    if (response.status === 401) { token = null; return api(method, path, body); }
    if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }
  const cli = ['api', '-X', method, path];
  if (body !== undefined) cli.push('--input', '-');
  const text = execFileSync('gh', cli, { input: body === undefined ? undefined : JSON.stringify(body), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  return text.trim() ? JSON.parse(text) : null;
}
const search = async q => (await api('GET', `/search/issues?q=${encodeURIComponent(q)}&per_page=20`)).items ?? [];
// --plan-only reads nothing but search (an issue's state is then 'unknown', and
// the action says to reopen it if it is closed).
const searchOnly = planOnly;
const comments = async number => searchOnly ? [] : api('GET', `/repos/${repo}/issues/${number}/comments?per_page=100`);
const issue = async number => searchOnly ? { number, state: 'unknown', title: '' } : api('GET', `/repos/${repo}/issues/${number}`);

// ---- The run's findings ----
const results = readResults(out).filter(row => row.phase);
const meta = existsSync(join(out, 'run.json')) ? JSON.parse(readFileSync(join(out, 'run.json'), 'utf8')) : {};
const runMark = `QA run: ${meta.version ?? '?'} ${meta.machine ?? '?'} ${meta.startedAt ?? ''}`.trim();
const catalog = new Map(loadCatalog().map(entry => [entry.id, entry]));
const firsts = results.filter(row => row.phase === 'first');
const reruns = (row) => results.filter(other => other.phase === 'rerun' && other.case === row.case && other.language === row.language);
const fails = firsts.filter(row => row.status === 'FAIL' && row.id);
const harnessGaps = firsts.filter(row => row.status === 'ERROR').map(row => ({ id: row.id, language: row.language, problems: row.problems }));

const findingTokens = entry => [...(entry?.legacy ?? []), ...(entry?.links ?? [])].map(String).filter(item => /^[A-Z]\d+$/.test(item));
const linkedIssues = entry => (entry?.links ?? []).map(String).map(item => item.match(/^#(\d+)$/)?.[1]).filter(Boolean).map(Number);
const groups = [];
for (const row of fails) {
  const entry = catalog.get(row.id);
  const tokens = findingTokens(entry);
  let group = groups.find(item => item.ids.includes(row.id) || tokens.some(token => item.tokens.includes(token)));
  if (!group) groups.push(group = { ids: [], tokens: [], rows: [] });
  if (!group.ids.includes(row.id)) group.ids.push(row.id);
  for (const token of tokens) if (!group.tokens.includes(token)) group.tokens.push(token);
  group.rows.push(row);
}

// ---- Words ----
const sentence = text => { const s = String(text).replace(/^the case could not finish: /i, ''); return s.charAt(0).toUpperCase() + s.slice(1); };
function titleOf(group) {
  const problems = group.rows.flatMap(row => row.problems ?? []);
  const best = problems.find(item => !/could not finish|Timeout \d+ms/i.test(item)) ?? problems[0] ?? `${group.ids.join(', ')} fails`;
  const whole = sentence(best).replace(/^#\d+: /, '');
  let title = whole.split(/ \(|; |: "/)[0];
  if (title.length < 45) title = whole.split(/ \(|; /)[0];
  if (title.length > 100) title = `${title.slice(0, 97).replace(/\s+\S*$/, '')}...`;
  return title;
}
const fence = text => String(text).replace(/\|/g, '\\|');
function resultsOf(group) {
  const lines = [];
  for (const row of group.rows) {
    const again = reruns(row);
    const passed = again.filter(item => item.status === 'PASS').length;
    lines.push(`- **${row.id}**, ${meta.version ?? ''}, ${row.platform ?? meta.platform ?? ''}, ${row.language}: FAIL${again.length ? ` (re-runs: ${passed} of ${again.length} passed)` : ''}`);
    for (const problem of row.problems ?? []) lines.push(`  - ${fence(problem)}`);
    for (const note of row.notes ?? []) if (!/^scenario U\d+$/.test(note)) lines.push(`  - note: ${fence(note)}`);
  }
  return lines.join('\n');
}
function stepsOf(group) {
  return group.ids.map(id => {
    const entry = catalog.get(id);
    if (!entry) return `**${id}**`;
    const steps = entry.steps.map((step, index) => `${index + 1}. ${step.do} Expected: ${step.expect}`).join('\n');
    return `**${id}: ${entry.title}**\n\n${entry.preconditions?.state ? `Before: ${entry.preconditions.state}\n\n` : ''}${steps}`;
  }).join('\n\n');
}
const caseLines = group => group.ids.map(id => `QA case: ${id}`).join('\n');
const evidence = group => `Evidence: the run's results.jsonl and case folders (${[...new Set(group.rows.map(row => row.evidence))].join(', ')}), kept with the QA run.`;
const newBody = group => `## What happens\n\n${resultsOf(group)}\n\n## Steps and expected result\n\n${stepsOf(group)}\n\n${evidence(group)}\nThe cases are described in the [case catalog](${CATALOG_URL}).\n\n---\n${caseLines(group)}\n${runMark}\n`;
const commentBody = (group, reopen) => `${reopen === 'unknown' ? 'The case fails again on this run.\n\n' : reopen ? 'The case fails again, so this issue is reopened.\n\n' : 'Seen again.\n\n'}${resultsOf(group)}\n\n${evidence(group)}\n\n---\n${caseLines(group)}\n${runMark}\n`;

// ---- Decide and act ----
const actions = [];
const errors = [];
for (const group of groups) {
  let target = null;
  try {
    for (const id of group.ids) {
      if (target) break;
      const found = await search(`repo:${repo} is:issue "QA case: ${id}"`);
      for (const item of found) {
        const text = `${item.body ?? ''}\n${(await comments(item.number)).map(c => c.body).join('\n')}`;
        if (text.split('\n').some(line => line.trim() === `QA case: ${id}`)) { target = item; break; }
      }
    }
    // An issue the failure itself names ("#179: ...") comes before the case's other links.
    const named = group.rows.flatMap(row => row.problems ?? []).map(item => item.match(/^#(\d+):/)?.[1]).filter(Boolean).map(Number);
    if (!target) for (const number of [...new Set([...named, ...group.ids.flatMap(id => linkedIssues(catalog.get(id)))])]) { target = await issue(number); if (target) break; }
  } catch (error) { errors.push(`searching for ${group.ids.join(', ')}: ${error.message}`); }
  if (target) {
    const already = (await comments(target.number).catch(() => [])).some(c => (c.body ?? '').includes(runMark)) || (target.body ?? '').includes(runMark);
    const reopen = target.state === 'closed';
    const kind = already ? 'nothing (this run is already on it)' : reopen ? 'comment and reopen' : target.state === 'unknown' ? 'comment, and reopen if closed' : 'comment';
    actions.push({ ids: group.ids, kind, issue: target.number, title: target.title, body: already ? null : commentBody(group, target.state === 'unknown' ? 'unknown' : reopen) });
  } else {
    actions.push({ ids: group.ids, kind: 'open', issue: null, title: titleOf(group), body: newBody(group), labels: ['bug'] });
  }
}

if (!planOnly) {
  for (const action of actions) {
    try {
      if (action.kind === 'open') action.issue = (await api('POST', `/repos/${repo}/issues`, { title: action.title, body: action.body, labels: action.labels })).number;
      else if (action.body) {
        await api('POST', `/repos/${repo}/issues/${action.issue}/comments`, { body: action.body });
        if (action.kind === 'comment and reopen') await api('PATCH', `/repos/${repo}/issues/${action.issue}`, { state: 'open' });
      }
      action.done = true;
    } catch (error) { action.done = false; errors.push(`${action.kind} for ${action.ids.join(', ')}: ${error.message}`); }
  }
}

writeFileSync(join(out, 'issue-actions.json'), `${JSON.stringify({ repo, runMark, planOnly, actions, errors }, null, 2)}\n`);
writeFileSync(join(out, 'issues.json'), `${JSON.stringify({ repo, findings: actions.map(a => ({ ids: a.ids, issue: a.issue, kind: a.kind, done: a.done ?? false })), harnessGaps }, null, 2)}\n`);
const triageFile = join(out, 'triage.json');
const triage = existsSync(triageFile) ? JSON.parse(readFileSync(triageFile, 'utf8')) : {};
for (const action of actions) if (action.issue) for (const row of fails.filter(item => action.ids.includes(item.id))) {
  const key = `${row.language}\t${row.case}`;
  triage[key] = { ...(triage[key] ?? {}), issue: `#${action.issue}` };
}
writeFileSync(triageFile, `${JSON.stringify(triage, null, 2)}\n`);

for (const action of actions) console.log(`${action.ids.join(', ')}: ${action.kind}${action.issue ? ` #${action.issue}` : ''}${planOnly ? ' (planned)' : action.done === false ? ' NOT DONE' : ''}`);
if (harnessGaps.length) console.log(`Not filed (harness could not run the case): ${[...new Set(harnessGaps.map(g => g.id))].join(', ')}`);
if (errors.length) { console.error(`*** ISSUES NOT FILED: ${errors.length} problem(s); the planned actions are in ${join(out, 'issue-actions.json')} ***\n${errors.join('\n')}`); process.exit(4); }
