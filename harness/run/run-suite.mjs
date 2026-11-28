import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { platformName, readResults, slug } from './common.mjs';
import { listPlaybook, loadCatalog, matchCode, selected } from './catalog.mjs';

// The neutral suite runner. It runs the cases the plan selects from the case catalog
// (release-checks/cases/*.yaml; plan.select {suites, scenarios, priorities, ids}, none = all),
// each on its own, in its own throwaway home, host, browser and fixture provider (abnormal-exam.mjs with
// ABN_ONLY set to that one case), and records what happened. It judges nothing beyond
// the case's own checks, never stops early, and never decides what a failure means.
//
//   node harness/run/run-suite.mjs --plan <plan.json> --out <folder> --machine <name> [--langs en,ja]
//
// The app under test is given exactly as for abnormal-exam.mjs (ABN_HOST + ABN_DIST +
// ABN_RUNTIME_APP [+ ABN_UNIX_LAYOUT], or ABN_INSTALL + ABN_MANAGED, or ABN_SHELL); those
// variables are passed through unchanged.
//
// Rules it keeps:
//   - One case = one fresh world. A case that crashes or hangs the app cannot touch the next.
//   - Every case has a time limit (plan.caseTimeoutMinutes). Past it, everything the case
//     started is stopped and the case is recorded as ERROR. The run goes on.
//   - Four results only: PASS, FAIL (the case's checks failed), ERROR (no verdict: timeout,
//     crash, the world could not start, or the case skipped itself without a reason the plan
//     declared), SKIP (only for a reason declared in the plan for this platform).
//   - Every result is appended to <out>/results.jsonl the moment the case ends, so nothing is
//     lost if the machine stops. Started again with the same --out, the runner carries on
//     after the last recorded case.
//   - Re-runs come only after every case ran once: each FAIL and ERROR is run again
//     plan.reruns times (default 3). A re-run never changes the first result; it is recorded
//     next to it.
//   - At the end it writes report.md and results.txt (report.mjs). It writes no conclusions.
//   - Disk: when a case ends (PASS, FAIL, ERROR or timeout alike) its throwaway world is
//     deleted; only small evidence is kept (the case's screenshots and reports, and log, session
//     and settings files of at most 1 MB each, 20 MB per case, copied to <case>/kept/). Before
//     each case the runner checks the disk: if the run's folder is over plan.diskCapMB (default
//     2000) or the drive has less than plan.minFreeMB free (default 5000), it stops the run
//     with an error that says so, and the report lists the cases not run.
//   - At the end every product FAIL is filed as a GitHub issue, deduplicated against the issues
//     already there (file-issues.mjs; plan.issueRepo; --no-issues turns it off).

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, item, index, all) => item.startsWith('--') ? [...pairs, [item.slice(2), all[index + 1]]] : pairs, []));
for (const name of ['plan', 'out', 'machine']) if (!args[name]) { console.error(`--${name} is required`); process.exit(2); }
const plan = JSON.parse(readFileSync(resolve(args.plan), 'utf8'));
const out = resolve(args.out);
mkdirSync(out, { recursive: true });
const here = import.meta.dirname;
// RUN_EXAM / RUN_CATALOG replace the exam and the case catalog only to test this runner (test/selftest.sh).
const exam = resolve(process.env.RUN_EXAM ?? join(here, '..', 'e2e-runtime', 'abnormal-exam.mjs'));
const catalog = loadCatalog(process.env.RUN_CATALOG ? resolve(process.env.RUN_CATALOG) : undefined);
const chosen = selected(catalog, plan.select);
const platform = platformName();
const languages = (args.langs ?? process.env.ABN_LANGS ?? 'en').split(',').map(item => item.trim()).filter(Boolean);
const timeoutMs = (plan.caseTimeoutMinutes ?? 10) * 60_000;
const reruns = plan.reruns ?? 3;
const diskCapMB = plan.diskCapMB ?? 2000;
const minFreeMB = plan.minFreeMB ?? 5000;
const resultsFile = join(out, 'results.jsonl');
let port = Number(process.env.ABN_PORT ?? 9400);

// ---- Entry check: a normal user account. As root or an administrator the app can write
// read-only files, so 'Settings file cannot be written' could not test anything (2026-11-26:
// every case runs everywhere, as a normal user). ----
function elevated() {
  if (process.platform === 'win32') { try { execFileSync('net', ['session'], { stdio: 'ignore' }); return true; } catch { return false; } }
  return typeof process.getuid === 'function' && process.getuid() === 0;
}
if (elevated() && !process.env.RUN_SELFTEST) { console.error('Entry criterion not met: this account is root or an administrator. Run the suite as a normal user.'); process.exit(2); }

// ---- The cases: chosen from the catalog, run by the playbook code the catalog names. ----
const playbookFiles = [...new Set(catalog.filter(entry => entry.automation.impl?.case).map(entry => entry.automation.impl.file))];
const listed = playbookFiles.flatMap(file => listPlaybook(file, { ...process.env, TMPDIR: out }));
const mismatch = matchCode(catalog, listed);
if (mismatch.length) { console.error(`Entry criterion not met: the case catalog and the code do not match:\n${mismatch.join('\n')}`); process.exit(2); }
// ABN_ONLY matches by contained text: one name inside another would run two cases at once.
const clashes = listed.flatMap(a => listed.filter(b => a !== b && b.name.toLowerCase().includes(a.name.toLowerCase())).map(b => `"${a.name}" is inside "${b.name}"`));
if (clashes.length) { console.error(`Case names overlap; the runner cannot run them one by one:\n${clashes.join('\n')}`); process.exit(2); }
const codeOf = entry => listed.find(item => item.file === entry.automation.impl.file && item.name === entry.automation.impl.case);
const confirmation = new Set(plan.confirmation ?? []);
const excluded = new Set(plan.exclude ?? []);
const runnable = chosen.filter(entry => entry.automation.status === 'automated' && entry.automation.impl.case && entry.platforms.includes(platform) && !excluded.has(entry.id));
const queue = languages.flatMap(language => runnable.filter(entry => entry.languages.includes(language)).map(entry => ({
  id: entry.id, name: entry.automation.impl.case, language, suite: confirmation.has(entry.id) || confirmation.has(entry.automation.impl.case) ? 'B' : 'A',
  layer: entry.suite, playbook: codeOf(entry).playbook, scenario: entry.scenario, world: entry.world === 'user' ? null : entry.world,
})));
// Chosen cases this platform should run but no code runs: listed in the report as not covered.
const notCovered = chosen.filter(entry => entry.platforms.includes(platform) && entry.automation.status !== 'automated')
  .map(entry => ({ id: entry.id, title: entry.title, suite: entry.suite, status: entry.automation.status, why: entry.automation.reason ?? entry.automation.note ?? '' }));
const declaredSkip = (item) => (plan.declaredSkips ?? []).find(skip => (skip.case === item.id || skip.case === item.name) && (!skip.platforms || skip.platforms.includes(platform)));

writeFileSync(join(out, 'run.json'), `${JSON.stringify({
  plan: resolve(args.plan), version: plan.version, machine: args.machine, platform, languages,
  app: Object.fromEntries(['ABN_HOST', 'ABN_DIST', 'ABN_RUNTIME_APP', 'ABN_UNIX_LAYOUT', 'ABN_INSTALL', 'ABN_MANAGED', 'ABN_SHELL', 'ABN_EXTENSIONS'].filter(name => process.env[name]).map(name => [name, process.env[name]])),
  harness: harnessCommit(), select: plan.select ?? 'all', cases: queue.length, notCovered, startedAt: new Date().toISOString(),
}, null, 2)}\n`);

function harnessCommit() {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: here, encoding: 'utf8' }).trim(); } catch { return 'unknown'; }
}

// ---- Processes: only what this runner started, found by the case's own temp folder. ----
function processesUnder(folder) {
  const needle = resolve(folder).toLowerCase();
  try {
    if (process.platform === 'win32') {
      const text = execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.Name)|$($_.CommandLine)" }'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      return text.trim().split(/\r?\n/).map(line => { const [pid, name, ...rest] = line.trim().split('|'); return { pid: Number(pid), name, args: rest.join('|') }; }).filter(row => row.args.toLowerCase().includes(needle));
    }
    const text = execFileSync('ps', ['-axww', '-o', 'pid=,comm=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return text.split('\n').map(line => line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/)).filter(Boolean).map(m => ({ pid: Number(m[1]), name: m[2], args: m[3] })).filter(row => row.args.toLowerCase().includes(needle) && row.pid !== process.pid);
  } catch { return []; }
}
function killTree(child) {
  try {
    if (process.platform === 'win32') execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGKILL');
  } catch { /* already gone */ }
}
function killList(rows) {
  for (const row of rows) {
    try {
      if (process.platform === 'win32') execFileSync('taskkill.exe', ['/PID', String(row.pid), '/T', '/F'], { stdio: 'ignore' });
      else process.kill(row.pid, 'SIGKILL');
    } catch { /* gone */ }
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** One case, once, in its own world. Resolves to a result record; never throws. */
async function runOnce(item, phase, attempt) {
  const folder = join(out, 'cases', item.language, `${slug(item.name)}${phase === 'rerun' ? `-rerun-${attempt}` : ''}`);
  const temp = join(folder, 'tmp');
  mkdirSync(temp, { recursive: true });
  const started = Date.now();
  const log = join(folder, 'exam.log');
  port += 2;
  const env = { ...process.env, ABN_PLAYBOOK: relative(join(here, '..', 'e2e'), item.playbook), ABN_ONLY: item.name, ABN_WORLD: item.world ?? '', ABN_LANGS: item.language, ABN_OUT: folder, ABN_PORT: String(port), TEMP: temp, TMP: temp, TMPDIR: temp };
  const child = spawn(process.execPath, [exam], { env, cwd: resolve(here, '..', '..'), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
  let text = '';
  child.stdout.on('data', chunk => { text += chunk; });
  child.stderr.on('data', chunk => { text += chunk; });
  let timedOut = false;
  const code = await new Promise(resolveCode => {
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    child.on('error', error => { text += `\n${error.stack}`; clearTimeout(timer); resolveCode(null); });
    child.on('exit', exitCode => { clearTimeout(timer); resolveCode(exitCode); });
  });
  writeFileSync(log, text);
  // Whatever the case left running after it ended: recorded as a fact, then stopped.
  await sleep(timedOut ? 1_000 : 5_000);
  const left = processesUnder(temp);
  killList(left);
  const notDeleted = await keepAndDelete(temp, folder);

  const record = {
    id: item.id, case: item.name, language: item.language, suite: item.suite, layer: item.layer, scenario: item.scenario, playbook: relative(join(here, '..', 'e2e'), item.playbook).split('\\').join('/'), phase, attempt, machine: args.machine, platform,
    status: 'ERROR', problems: [], notes: [], ms: Date.now() - started, exitCode: code,
    evidence: relative(out, folder).split('\\').join('/'),
    leftProcesses: left.map(row => row.name), at: new Date().toISOString(),
  };
  if (notDeleted) record.notes.push(`harness: ${notDeleted}`);
  let report = null;
  try { report = JSON.parse(readFileSync(join(folder, 'abnormal-exam.json'), 'utf8')); } catch { /* none written */ }
  const run = report?.runs?.find(entry => entry.language === item.language) ?? report?.runs?.[0];
  const found = run?.result?.cases?.find(entry => entry.name === item.name);
  if (run?.result?.errors?.length) record.notes.push(...run.result.errors);
  if (timedOut) {
    record.problems.push(`no verdict within ${timeoutMs / 60_000} min; everything the case started was stopped`);
  } else if (!found) {
    record.problems.push(run?.error ? `the case did not run: ${String(run.error).split('\n')[0]}` : `the case did not run (exam exit code ${code}); see exam.log`);
  } else if (found.skipped) {
    const declared = declaredSkip(item);
    record.notes.push(...found.notes);
    if (declared) { record.status = 'SKIP'; record.notes.push(`planned: ${declared.reason}`); }
    else record.problems.push(`the case skipped itself, and the plan declares no skip for it on ${platform}: ${found.notes.join('; ')}`);
  } else {
    record.status = found.ok ? 'PASS' : 'FAIL';
    record.problems.push(...found.problems);
    record.notes.push(...found.notes);
    record.metrics = found.metrics;
    record.ms = found.ms ?? record.ms;
  }
  appendFileSync(resultsFile, `${JSON.stringify(record)}\n`);
  console.log(`${record.status} [${item.language}] ${item.name}${phase === 'rerun' ? ` (re-run ${attempt})` : ''}${record.problems.length ? `: ${record.problems.join('; ')}` : ''}`);
  return record;
}

// ---- Disk: each world is deleted when its case ends; a cap stops the run loudly. ----
/** Bytes under a folder (links not followed). */
function sizeOf(path) {
  let total = 0;
  const stack = [path];
  while (stack.length) {
    const next = stack.pop();
    let info; try { info = lstatSync(next); } catch { continue; }
    if (info.isDirectory()) { try { for (const name of readdirSync(next)) stack.push(join(next, name)); } catch { /* unreadable */ } } else total += info.size;
  }
  return total;
}
const KEEP = /\.(log|jsonl|json|txt|md)$/i;
const SKIP_DIRS = /^(node_modules|runtime|app|bin|cache|install|webview|EBWebView|warm|updates|\.cache|\.local)$/i;
/** Copy the world's small evidence files to <case>/kept/, then delete the world. Answers what could not be deleted. */
async function keepAndDelete(temp, folder) {
  const kept = join(folder, 'kept');
  let budget = 20 * 1024 * 1024;
  const stack = [temp];
  while (stack.length && budget > 0) {
    const next = stack.pop();
    let info; try { info = lstatSync(next); } catch { continue; }
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      if (next !== temp && SKIP_DIRS.test(next.split(/[\\/]/).pop())) continue;
      try { for (const name of readdirSync(next)) stack.push(join(next, name)); } catch { /* unreadable */ }
    } else if (KEEP.test(next) && info.size <= 1024 * 1024 && info.size <= budget) {
      const target = join(kept, relative(temp, next));
      try { mkdirSync(dirname(target), { recursive: true }); copyFileSync(next, target); budget -= info.size; } catch { /* in use */ }
    }
  }
  // Windows lets go of files a moment after their process ends: try a few times.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try { rmSync(temp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* retried below */ }
    if (!existsSync(temp)) return null;
    killList(processesUnder(temp));
    await sleep(2_000);
  }
  return `its throwaway world could not be deleted (${Math.round(sizeOf(temp) / 1048576)} MB left in ${temp})`;
}
/** Stop the run when it would fill the disk. */
function diskProblem() {
  const used = sizeOf(out) / 1048576;
  if (used > diskCapMB) return `the run's folder holds ${Math.round(used)} MB, over the plan's cap of ${diskCapMB} MB`;
  try {
    const fs = statfsSync(out);
    const free = (fs.bavail * fs.bsize) / 1048576;
    if (free < minFreeMB) return `the drive has ${Math.round(free)} MB free, under the plan's minimum of ${minFreeMB} MB`;
  } catch { /* statfs unavailable */ }
  return null;
}
let stoppedFor = null;
function checkDisk() {
  if (stoppedFor) return false;
  const problem = diskProblem();
  if (!problem) return true;
  stoppedFor = problem;
  const meta = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8'));
  meta.stoppedForDisk = problem;
  writeFileSync(join(out, 'run.json'), `${JSON.stringify(meta, null, 2)}\n`);
  console.error(`\n*** RUN STOPPED: ${problem}. No more cases are started; the report lists the cases not run. ***\n`);
  return false;
}

// ---- First pass: every case once, whatever happens. ----
const done = readResults(out);
const have = (item, phase, attempt) => done.some(r => r.case === item.name && r.language === item.language && r.phase === phase && (phase === 'first' || r.attempt === attempt));
for (const [index, item] of queue.entries()) {
  if (have(item, 'first', 1)) continue;
  if (!checkDisk()) break;
  console.log(`--- ${index + 1}/${queue.length}`);
  done.push(await runOnce(item, 'first', 1));
}

// ---- Re-runs: only after the whole pass, for every FAIL and ERROR. ----
for (const item of queue) {
  const first = done.find(r => r.case === item.name && r.language === item.language && r.phase === 'first');
  if (!first || !['FAIL', 'ERROR'].includes(first.status)) continue;
  for (let attempt = 1; attempt <= reruns; attempt += 1) {
    if (have(item, 'rerun', attempt)) continue;
    if (!checkDisk()) break;
    done.push(await runOnce(item, 'rerun', attempt));
  }
}

const meta = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8'));
meta.finishedAt = new Date().toISOString();
writeFileSync(join(out, 'run.json'), `${JSON.stringify(meta, null, 2)}\n`);
// The report is written by its own script so it can be written again later (with
// acceptance records, or a triage file) without running anything.
const reportArgs = [join(here, 'report.mjs'), '--out', out, '--plan', resolve(args.plan)];
if (args.baseline) reportArgs.push('--baseline', resolve(args.baseline));
try { execFileSync(process.execPath, reportArgs, { stdio: 'inherit' }); } catch { console.log('report.mjs failed; results.jsonl holds every result'); }
// Every product FAIL is filed as a GitHub issue now, deduplicated (file-issues.mjs), and the
// report is written again with the issue numbers. --no-issues (or the selftest) turns it off.
let issuesFiled = true;
if (!('no-issues' in args) && !process.env.RUN_SELFTEST) {
  try { execFileSync(process.execPath, [join(here, 'file-issues.mjs'), '--out', out, '--repo', plan.issueRepo ?? 'shisa-ai/jouzu-desktop'], { stdio: 'inherit' }); }
  catch { issuesFiled = false; console.error(`*** Some FAILs were not filed as issues: see ${join(out, 'issue-actions.json')} ***`); }
  try { execFileSync(process.execPath, reportArgs, { stdio: 'inherit' }); } catch { /* written above */ }
}
if (stoppedFor) {
  console.error(`*** RUN STOPPED EARLY: ${stoppedFor}. Cases not started are NOT RUN in ${join(out, 'report.md')}. ***`);
  process.exit(3);
}
console.log(`All ${queue.length} cases ran. Results: ${join(out, 'report.md')}`);
process.exit(issuesFiled ? 0 : 4);
