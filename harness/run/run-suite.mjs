import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { platformName, readResults, slug } from './common.mjs';

// The neutral suite runner. It runs every case of the abnormal-path playbook on its own,
// in its own throwaway home, host, browser and fixture provider (abnormal-exam.mjs with
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

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, item, index, all) => item.startsWith('--') ? [...pairs, [item.slice(2), all[index + 1]]] : pairs, []));
for (const name of ['plan', 'out', 'machine']) if (!args[name]) { console.error(`--${name} is required`); process.exit(2); }
const plan = JSON.parse(readFileSync(resolve(args.plan), 'utf8'));
const out = resolve(args.out);
mkdirSync(out, { recursive: true });
const here = import.meta.dirname;
// RUN_EXAM / RUN_PLAYBOOK replace the exam and playbook only to test this runner (test/selftest.mjs).
const exam = resolve(process.env.RUN_EXAM ?? join(here, '..', 'e2e-runtime', 'abnormal-exam.mjs'));
const playbook = resolve(process.env.RUN_PLAYBOOK ?? join(here, '..', 'e2e', 'abnormal-playbook.mjs'));
const platform = platformName();
const languages = (args.langs ?? process.env.ABN_LANGS ?? 'en').split(',').map(item => item.trim()).filter(Boolean);
const timeoutMs = (plan.caseTimeoutMinutes ?? 10) * 60_000;
const reruns = plan.reruns ?? 3;
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

// ---- The cases, from the playbook itself. ----
const listed = JSON.parse(execFileSync(process.execPath, [playbook], { env: { ...process.env, PLAYBOOK_LIST: '1', PLAYBOOK_SHOTS: join(out, '.list') }, encoding: 'utf8' }));
// ABN_ONLY matches by contained text: one name inside another would run two cases at once.
const clashes = listed.flatMap(a => listed.filter(b => a !== b && b.name.toLowerCase().includes(a.name.toLowerCase())).map(b => `"${a.name}" is inside "${b.name}"`));
if (clashes.length) { console.error(`Case names overlap; the runner cannot run them one by one:\n${clashes.join('\n')}`); process.exit(2); }
const confirmation = new Set(plan.confirmation ?? []);
const excluded = new Set(plan.exclude ?? []);
const queue = languages.flatMap(language => listed.filter(item => item.langs.includes(language) && !excluded.has(item.name)).map(item => ({ name: item.name, language, suite: confirmation.has(item.name) ? 'B' : 'A' })));
const declaredSkip = (name) => (plan.declaredSkips ?? []).find(item => item.case === name && (!item.platforms || item.platforms.includes(platform)));

writeFileSync(join(out, 'run.json'), `${JSON.stringify({
  plan: resolve(args.plan), version: plan.version, machine: args.machine, platform, languages,
  app: Object.fromEntries(['ABN_HOST', 'ABN_DIST', 'ABN_RUNTIME_APP', 'ABN_UNIX_LAYOUT', 'ABN_INSTALL', 'ABN_MANAGED', 'ABN_SHELL', 'ABN_EXTENSIONS'].filter(name => process.env[name]).map(name => [name, process.env[name]])),
  harness: harnessCommit(), cases: queue.length, startedAt: new Date().toISOString(),
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
  const env = { ...process.env, ABN_ONLY: item.name, ABN_LANGS: item.language, ABN_OUT: folder, ABN_PORT: String(port), TEMP: temp, TMP: temp, TMPDIR: temp };
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

  const record = {
    case: item.name, language: item.language, suite: item.suite, phase, attempt, machine: args.machine, platform,
    status: 'ERROR', problems: [], notes: [], ms: Date.now() - started, exitCode: code,
    evidence: relative(out, folder).split('\\').join('/'),
    leftProcesses: left.map(row => row.name), at: new Date().toISOString(),
  };
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
    const declared = declaredSkip(item.name);
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

// ---- First pass: every case once, whatever happens. ----
const done = readResults(out);
const have = (item, phase, attempt) => done.some(r => r.case === item.name && r.language === item.language && r.phase === phase && (phase === 'first' || r.attempt === attempt));
for (const [index, item] of queue.entries()) {
  if (have(item, 'first', 1)) continue;
  console.log(`--- ${index + 1}/${queue.length}`);
  done.push(await runOnce(item, 'first', 1));
}

// ---- Re-runs: only after the whole pass, for every FAIL and ERROR. ----
for (const item of queue) {
  const first = done.find(r => r.case === item.name && r.language === item.language && r.phase === 'first');
  if (!first || !['FAIL', 'ERROR'].includes(first.status)) continue;
  for (let attempt = 1; attempt <= reruns; attempt += 1) {
    if (have(item, 'rerun', attempt)) continue;
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
console.log(`All ${queue.length} cases ran. Results: ${join(out, 'report.md')}`);
process.exit(0);
