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
//   - the issue it belongs to is, in this order: an issue that names the case ID (in its title,
//     text or a comment; open ones first) and says the same failure (at least half of the
//     failure's words); else an issue the failure names (#179: ...) or the catalog links (#123);
//     else a new one. An issue that names the case but describes another failure is mentioned
//     in the comment or new issue, not commented on;
//   - an open issue gets a comment with this run's results; a closed one gets the comment and is
//     listed as needing a decision, never reopened here (its fix may not be in the build under
//     test, or the case's expectation may be out of date); a new one is opened with the label bug.
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
// --search-only (for a machine whose GitHub sign-in may only search) reads nothing but search:
// comments and run marks are then not checked, and an issue's state is 'unknown'.
// --plan-only still reads everything; it only does not write.
const searchOnly = Boolean(args['search-only']);
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
const commentBody = (group, closed) => `${closed ? `The case fails on ${meta.version ?? 'this build'}${closed === 'unknown' ? '' : ' while this issue is closed'}. The issue is left as it is: reopening is decided by people (the fix may not be in this build yet, or the case may need updating).\n\n` : 'Seen again.\n\n'}${resultsOf(group)}\n\n${evidence(group)}\n\n---\n${caseLines(group)}\n${runMark}\n`;

// ---- Decide and act ----
const actions = [];
const errors = [];
// How much of a failure's wording an issue already says: the share of the failure's words (4
// letters or more, quoted UI text included) found in the issue's title, text and comments.
const words = text => [...new Set(String(text).toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [])];
const overlap = (problem, text) => { const want = words(problem); if (!want.length) return 0; const have = new Set(words(text)); return want.filter(word => have.has(word)).length / want.length; };
const SAME = 0.5;
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Issues this run is already on (its run mark, in the text or a comment), found by search so
// that it holds with --search-only too.
let marked = new Set();
try { marked = new Set((await search(`repo:${repo} is:issue "${runMark}"`)).map(item => item.number)); } catch (error) { errors.push(`searching for this run's mark: ${error.message}`); }

for (const group of groups) {
  let target = null;
  const related = [];
  const problems = group.rows.flatMap(row => row.problems ?? []).filter(item => !/could not finish|Timeout \d+ms/i.test(item));
  const score = text => Math.max(0, ...problems.map(problem => overlap(problem, text)));
  try {
    // 1. An issue that names the case ID (open first, newest first) and says the same failure.
    //    One that names the case but describes another failure is a different finding: it is
    //    mentioned, not commented on.
    const candidates = [];
    for (const id of group.ids) {
      for (const item of await search(`repo:${repo} is:issue "${id}"`)) {
        const text = `${item.title}\n${item.body ?? ''}\n${(await comments(item.number)).map(c => c.body).join('\n')}`;
        if (!new RegExp(`(^|[^A-Z0-9-])${escape(id)}([^0-9]|$)`).test(text)) continue;
        if (!candidates.some(c => c.item.number === item.number)) candidates.push({ item, score: score(text) });
      }
    }
    candidates.sort((a, b) => (a.item.state === 'open' ? 0 : 1) - (b.item.state === 'open' ? 0 : 1) || b.item.number - a.item.number);
    target = candidates.find(c => c.score >= SAME)?.item ?? null;
    for (const c of candidates) if (c.item !== target) related.push(c.item.number);
    // 2. An issue the failure itself names ("#179: ..."), then the issues the catalog links.
    const named = group.rows.flatMap(row => row.problems ?? []).map(item => item.match(/^#(\d+):/)?.[1]).filter(Boolean).map(Number);
    if (!target) for (const number of [...new Set([...named, ...group.ids.flatMap(id => linkedIssues(catalog.get(id)))])]) { target = await issue(number); if (target) break; }
  } catch (error) { errors.push(`searching for ${group.ids.join(', ')}: ${error.message}`); }
  const also = related.filter(number => number !== target?.number);
  const alsoLine = also.length ? `\n\nThe same case also has ${also.map(n => `#${n}`).join(', ')}, which describes a different failure.` : '';
  if (target) {
    const already = marked.has(target.number) || (await comments(target.number).catch(() => [])).some(c => (c.body ?? '').includes(runMark)) || (target.body ?? '').includes(runMark);
    // A closed issue is never reopened here: whether its fix is in the build under test, or the
    // case's expectation is still right, is for people to decide. It is commented on and listed.
    const closed = target.state === 'closed' ? true : target.state === 'unknown' ? 'unknown' : false;
    const kind = already ? 'nothing (this run is already on it)' : closed === true ? 'comment (issue closed: needs a decision)' : closed ? 'comment (state unknown)' : 'comment';
    actions.push({ ids: group.ids, kind, issue: target.number, title: target.title, related: also, body: already ? null : commentBody(group, closed).replace('\n\n---\n', `${alsoLine}\n\n---\n`) });
  } else {
    actions.push({ ids: group.ids, kind: 'open', issue: null, title: titleOf(group), related: also, body: newBody(group).replace('\n\n---\n', `${alsoLine}\n\n---\n`), labels: ['bug'] });
  }
}

if (!planOnly) {
  for (const action of actions) {
    try {
      if (action.kind === 'open') action.issue = (await api('POST', `/repos/${repo}/issues`, { title: action.title, body: action.body, labels: action.labels })).number;
      else if (action.body) {
        await api('POST', `/repos/${repo}/issues/${action.issue}/comments`, { body: action.body });
      }
      action.done = true;
    } catch (error) { action.done = false; errors.push(`${action.kind} for ${action.ids.join(', ')}: ${error.message}`); }
  }
}

writeFileSync(join(out, 'issue-actions.json'), `${JSON.stringify({ repo, runMark, planOnly, actions, errors }, null, 2)}\n`);
writeFileSync(join(out, 'issues.json'), `${JSON.stringify({ repo, findings: actions.map(a => ({ ids: a.ids, issue: a.issue, kind: a.kind, related: a.related, done: a.done ?? false })), closedIssuesFailing: actions.filter(a => /closed/.test(a.kind)).map(a => ({ ids: a.ids, issue: a.issue })), harnessGaps }, null, 2)}\n`);
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
