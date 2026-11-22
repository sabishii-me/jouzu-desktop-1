// The task loop engine end to end, closed loop: no person, no network.
//
// Starts a host on throwaway folders with the runtime of an extracted official
// setup, a loopback model that does what each shipped brief asks (writes the
// files it names), and a loopback GitHub. The script is the user: it sets up
// the GitHub connector and two triggers the way the user would, then answers
// every checkpoint through the user's API. It checks:
//   - a new issue on GitHub starts the shipped issue loop through a trigger;
//   - triage, root cause and fix run as real tasks and their outputs are kept;
//   - a checkpoint waits, shows up as a todo and as a report in the Assistant;
//   - "send back" reruns the named step with the user's note;
//   - failing tests send the run back to the fix, passing tests go on;
//   - nothing is written to GitHub before the user approves; the PR is opened after;
//   - a host restart while a checkpoint waits keeps the run and its todo;
//   - a published release starts the QA release loop, which files the
//     regressions as labelled issues only after approval.
// Results: loop-drill-result.json.
//
//   JOUZU_E2E_RUNTIME=<folder with bootstrap.mjs and node_modules/jouzu>
//   JOUZU_E2E_HOST_BIN=<jouzu-host binary> (default: host/target/debug/jouzu-host)
//   node e2e-runtime/loop-drill.mjs
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const runtime = process.env.JOUZU_E2E_RUNTIME;
if (!runtime) { console.error('JOUZU_E2E_RUNTIME is not set'); process.exit(2); }
const bin = process.env.JOUZU_E2E_HOST_BIN ?? join(here, '..', 'host', 'target', 'debug', process.platform === 'win32' ? 'jouzu-host.exe' : 'jouzu-host');
const root = mkdtempSync(join(tmpdir(), 'jouzu-loop-drill-'));
const started = Date.now();
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail, atSeconds: Math.round((Date.now() - started) / 1000) });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const REPO = 'acme/app';

// ---- The model: does what the brief asks, nothing more. ----
const modelLog = [];
let fixes = 0;
const text = message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
function plan(brief) {
  const path = name => new RegExp(`(\\S*${name.replace('.', '\\.')})`).exec(brief)?.[1]?.replace(/[.,]$/, '');
  if (brief.includes('Triage GitHub issue')) return [[path('triage.md'), '# Triage\n\nReproduced: the button does nothing.\nNo duplicates found.\nSeverity: medium.\n']];
  if (brief.includes('Find the root cause')) return [[path('plan.md'), `# Plan\n\nRoot cause: the click handler is missing.\nFix: add it. Test: fixed.txt exists.\n${brief.includes('NOTE:') ? 'Checked the note.\n' : ''}`]];
  if (brief.includes('Fix GitHub issue')) {
    fixes += 1;
    // The first fix forgets the change, so the tests fail once.
    const files = [[path('fix.md'), `# Fix attempt ${fixes}\n`]];
    if (fixes > 1) files.push(['fixed.txt', 'fixed\n']);
    return files;
  }
  if (brief.includes('was installed and toured')) return [
    [path('classified.md'), '# Differences\n\n1. Settings button moved: regression.\n'],
    [path('regressions.json'), JSON.stringify([{ title: 'Settings button moved off screen', body: 'Steps: open Settings.\nExpected: button visible.\nActual: it is off screen.' }])],
  ];
  return [];
}
const model = createServer((request, response) => {
  let body = '';
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    const data = JSON.parse(body || '{}');
    const messages = data.messages ?? [];
    const system = messages.filter(message => message.role === 'system' || message.role === 'developer').map(text).join('\n');
    const firstUser = messages.find(message => message.role === 'user');
    const last = messages.at(-1);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish = null) => response.write(`data: ${JSON.stringify({ id: 'drill', object: 'chat.completion.chunk', created: 1, model: 'deterministic', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    const end = () => response.end('data: [DONE]\n\n');
    chunk({ role: 'assistant' });
    const assistant = system.includes('Jouzu Desktop Assistant');
    if (last?.role === 'tool' || last?.role === 'toolResult') {
      if (!assistant) chunk({ content: 'Done.' });
      chunk({}, 'stop');
      return end();
    }
    if (assistant) {
      // The Assistant only acknowledges what it is told.
      chunk({ tool_calls: [{ index: 0, id: `say-${modelLog.length}`, type: 'function', function: { name: 'say', arguments: JSON.stringify({ text: 'Noted.' }) } }] });
      chunk({}, 'tool_calls');
      modelLog.push({ who: 'assistant' });
      return end();
    }
    const brief = firstUser ? text(firstUser) : '';
    const files = plan(brief);
    modelLog.push({ who: 'task', brief: brief.slice(0, 60), files: files.map(([file]) => file) });
    if (!files.length) { chunk({ content: 'Nothing to do.' }); chunk({}, 'stop'); return end(); }
    files.forEach(([path, content], index) => chunk({ tool_calls: [{ index, id: `w${modelLog.length}-${index}`, type: 'function', function: { name: 'write', arguments: JSON.stringify({ path, content }) } }] }));
    chunk({}, 'tool_calls');
    end();
  });
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
const modelUrl = `http://127.0.0.1:${model.address().port}/v1`;

// ---- GitHub: the endpoints the connector uses, with ETags. ----
const gh = { issues: [], events: [], releases: [], pulls: [], comments: [], opened: [], tokens: new Set(), version: 0 };
const issue = number => ({ number, title: `Button does nothing (${number})`, user: { login: 'someone' }, labels: [], html_url: `https://example.test/${number}`, state: 'open', body: 'Clicking Save does nothing.' });
const github = createServer((request, response) => {
  let body = '';
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    gh.tokens.add(request.headers.authorization ?? '');
    const url = new URL(request.url, 'http://x');
    const send = (status, value, etag) => {
      const headers = { 'content-type': 'application/json' };
      if (etag) headers.etag = etag;
      response.writeHead(status, headers).end(value === undefined ? undefined : JSON.stringify(value));
    };
    const list = (items) => {
      const etag = `"v${gh.version}"`;
      if (request.headers['if-none-match'] === etag) return send(304);
      send(200, items, etag);
    };
    const path = url.pathname.replace(`/repos/${REPO}`, '');
    if (request.method === 'GET' && path === '/issues') return list([...gh.issues].reverse());
    if (request.method === 'GET' && path === '/issues/events') return list([...gh.events].reverse());
    if (request.method === 'GET' && path === '/releases') return list([...gh.releases].reverse());
    const one = /^\/issues\/(\d+)$/.exec(path);
    if (request.method === 'GET' && one) {
      const found = gh.issues.find(item => item.number === Number(one[1]));
      return found ? send(200, found) : send(404, { message: 'Not Found' });
    }
    if (request.method === 'POST' && path === '/pulls') {
      const pull = { ...JSON.parse(body), number: 100 + gh.pulls.length, html_url: `https://example.test/pull/${100 + gh.pulls.length}` };
      gh.pulls.push(pull);
      return send(201, pull);
    }
    if (request.method === 'POST' && path === '/issues') {
      const opened = { ...JSON.parse(body), number: 200 + gh.opened.length, html_url: `https://example.test/${200 + gh.opened.length}` };
      gh.opened.push(opened);
      return send(201, opened);
    }
    if (request.method === 'POST' && /^\/issues\/\d+\/comments$/.test(path)) {
      gh.comments.push(JSON.parse(body));
      return send(201, { id: 1, html_url: 'https://example.test/c' });
    }
    send(404, { message: 'Not Found' });
  });
});
await new Promise(resolve => github.listen(0, '127.0.0.1', resolve));
const githubUrl = `http://127.0.0.1:${github.address().port}`;

// ---- The user's machine: a model they added, a project folder. ----
const data = join(root, 'data');
mkdirSync(join(data, 'agent'), { recursive: true });
writeFileSync(join(data, 'agent', 'models.json'), JSON.stringify({ providers: { drill: {
  baseUrl: modelUrl, api: 'openai-completions', apiKey: 'fixture',
  models: [{ id: 'deterministic', name: 'Deterministic', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } }));
writeFileSync(join(data, 'agent', 'settings.json'), JSON.stringify({ defaultProvider: 'drill', defaultModel: 'deterministic' }));
const dist = join(root, 'dist');
mkdirSync(dist);
writeFileSync(join(dist, 'index.html'), '<html></html>');
const folder = join(root, 'app');
mkdirSync(folder);
const qaFolder = join(root, 'qa');
mkdirSync(qaFolder);

let host;
let base;
let token;
async function startHost() {
  host = spawn(bin, ['--dist', dist, '--home', join(root, 'home'), '--runtime-home', data,
    '--runtime', process.execPath, '--runtime-arg', join(runtime, 'bootstrap.mjs'), '--runtime-arg', '--mode', '--runtime-arg', 'rpc'],
  { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, LOOP_DRILL_GITHUB_TOKEN: 'drill-token' } });
  const ready = await new Promise((resolve, reject) => {
    createInterface({ input: host.stdout }).once('line', line => resolve(JSON.parse(line)));
    host.once('exit', code => reject(new Error(`host exited ${code}`)));
  });
  base = `http://127.0.0.1:${ready.port}/v1`;
  token = ready.token;
}
async function stopHost() {
  const exited = new Promise(resolve => host.once('exit', resolve));
  host.kill();
  await exited;
}
const api = async (method, path, body) => {
  const response = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json().catch(() => null) };
};
const until = async (what, test, seconds = 120) => {
  for (let tick = 0; tick < seconds * 4; tick += 1) {
    const value = await test();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`timed out: ${what}`);
};
const run = async id => (await api('GET', `/runs/${id}`)).body;
// Waits until the run waits on the user at `node`, or ends.
const waitAt = async (id, node) => until(`run ${id} waits at ${node}`, async () => {
  const value = await run(id);
  const current = value?.attempts?.at(-1);
  if (['finished', 'failed', 'stopped'].includes(value?.state)) return value;
  return value?.state === 'waiting' && current?.node === node ? value : null;
});
const path = (value) => value.attempts.map(attempt => `${attempt.node}:${attempt.result ?? '…'}`).join(' ');
const reports = async () => ((await api('GET', '/assistant/messages?limit=200')).body?.messages ?? []).filter(row => row.kind === 'report');

try {
  await startHost();
  await api('POST', '/workspaces', { paths: [folder, qaFolder] });
  const on = await api('PUT', '/assistant', { enabled: true, model: { provider: 'drill', id: 'deterministic' } });
  check('the Assistant is on', on.status === 200, JSON.stringify(on.body?.error ?? ''));

  // The user's setup: the connector, then what should start which loop.
  const shipped = (await api('GET', '/graphs')).body;
  const ids = JSON.stringify(shipped).match(/issue-loop|qa-release-loop/g) ?? [];
  check('both shipped graphs are installed', ids.includes('issue-loop') && ids.includes('qa-release-loop'), [...new Set(ids)].join(','));
  // An issue that is already there before the connector is set up.
  gh.issues.push(issue(1)); gh.version += 1;
  const connector = await api('PUT', '/connectors/github', { enabled: true, repos: [REPO], everySeconds: 3600, tokenVariable: 'LOOP_DRILL_GITHUB_TOKEN', apiUrl: githubUrl });
  check('the GitHub connector is set up', connector.status === 200, JSON.stringify(connector.body?.error ?? ''));
  const test = `node -e "process.exit(require('fs').existsSync('fixed.txt') ? 0 : 1)"`;
  const issueTrigger = await api('POST', '/triggers', { name: 'Work new issues', source: { kind: 'event', event: 'github.issue.opened' }, filter: { repo: REPO },
    action: { kind: 'startRun', graph: 'issue-loop', params: { repo: '{{repo}}', number: '{{number}}', workspace: folder, base: 'develop', test } } });
  const releaseTrigger = await api('POST', '/triggers', { name: 'Check QA releases', source: { kind: 'event', event: 'github.release.published' }, filter: { repo: REPO, tag: 'v*-rc.*' },
    action: { kind: 'startRun', graph: 'qa-release-loop', params: { repo: '{{repo}}', tag: '{{tag}}', workspace: qaFolder, tour: 'node -e "console.log(\'1 difference: settings button\')"' } } });
  check('the user adds two triggers', issueTrigger.status === 201 && releaseTrigger.status === 201, `${issueTrigger.status} ${releaseTrigger.status} ${JSON.stringify(issueTrigger.body?.error ?? releaseTrigger.body?.error ?? '')}`);

  // The first look is a baseline: the issue that was already there starts nothing.
  await api('POST', '/connectors/github/poll');
  check('the first look starts nothing', ((await api('GET', '/runs')).body?.runs ?? []).length === 0);
  check('the token comes from the variable the user named', gh.tokens.has('Bearer drill-token'), [...gh.tokens].join(','));

  // ---- Issue loop ----
  gh.issues.push(issue(7)); gh.version += 1;
  await api('POST', '/connectors/github/poll');
  const runs = await until('a run starts', async () => (await api('GET', '/runs')).body?.runs?.find(item => item.graphId === 'issue-loop'), 20);
  check('a new issue starts the issue loop', runs.params?.number === 7, JSON.stringify(runs.params));
  const id = runs.runId;

  let value = await waitAt(id, 'scope');
  check('read and triage ran, then it waits for the user', value.state === 'waiting', path(value));
  const triage = value.attempts.find(attempt => attempt.node === 'triage');
  check('triage wrote its output', triage?.evidence?.missing?.length === 0 && existsSync(triage?.evidence?.outputs?.[0] ?? ''), JSON.stringify(triage?.evidence?.missing));
  const todos = (await api('GET', '/todos')).body?.todos ?? [];
  check('the checkpoint is a todo with what to read', todos.some(todo => todo.runId === id && todo.node === 'scope' && JSON.stringify(todo.show).includes('triage.md')), JSON.stringify(todos.map(todo => todo.node)));
  const waiting = await until('a report', async () => (await reports()).find(row => row.report?.type === 'waiting' && row.report?.runId === id));
  check('the Assistant pane says the run waits', Boolean(waiting), JSON.stringify(waiting?.report ?? {}).slice(0, 200));

  // Send triage back once.
  await api('POST', `/runs/${id}/decision`, { decision: 'sendBack', node: 'triage', note: 'NOTE: check the keyboard too' });
  value = await waitAt(id, 'scope');
  check('send back reruns triage with the note', value.attempts.filter(attempt => attempt.node === 'triage').length === 2, path(value));

  await api('POST', `/runs/${id}/decision`, { decision: 'approve' });
  value = await waitAt(id, 'plan');
  check('approve goes on to the root cause', value.state === 'waiting', path(value));

  // The host restarts while the user has not answered.
  await stopHost();
  await startHost();
  value = await run(id);
  check('after a restart the run still waits at the plan', value?.state === 'waiting' && value.attempts.at(-1).node === 'plan', value ? path(value) : 'gone');
  check('and the todo is still there', ((await api('GET', '/todos')).body?.todos ?? []).some(todo => todo.runId === id));

  check('nothing was written to GitHub before approval', gh.pulls.length === 0 && gh.comments.length === 0 && gh.opened.length === 0);
  await api('POST', `/runs/${id}/decision`, { decision: 'approve' });
  value = await waitAt(id, 'accept');
  const tests = value.attempts.filter(attempt => attempt.node === 'tests').map(attempt => attempt.result);
  check('failing tests went back to the fix, passing tests to the user', JSON.stringify(tests) === '["failed","passed"]', path(value));
  check('still nothing written to GitHub', gh.pulls.length === 0);

  await api('POST', `/runs/${id}/decision`, { decision: 'approve' });
  value = await waitAt(id, 'merged');
  check('after approval the pull request is opened', gh.pulls.length === 1 && gh.pulls[0].head === 'loop/issue-7' && gh.pulls[0].base === 'develop', JSON.stringify(gh.pulls));
  await api('POST', `/runs/${id}/decision`, { decision: 'approve' });
  value = await until('run ends', async () => { const v = await run(id); return v?.state === 'finished' ? v : null; }, 30);
  check('the issue loop finishes', value.state === 'finished', path(value));
  const ended = await until('ended report', async () => (await reports()).find(row => row.report?.type === 'ended' && row.report?.runId === id), 20);
  check('the Assistant pane says it ended', Boolean(ended));

  // ---- QA release loop ----
  gh.releases.push({ id: 50, tag_name: 'v2.0.0-rc.1', name: 'rc', draft: false, prerelease: true, html_url: 'https://example.test/r/50' }); gh.version += 1;
  await api('POST', '/connectors/github/poll');
  const qa = await until('qa run', async () => (await api('GET', '/runs')).body?.runs?.find(item => item.graphId === 'qa-release-loop'), 20);
  value = await waitAt(qa.runId, 'decide');
  check('a release starts the QA loop; tour and classify run, then it waits', value.state === 'waiting', path(value));
  check('no issue filed before approval', gh.opened.length === 0);
  await api('POST', `/runs/${qa.runId}/decision`, { decision: 'approve' });
  value = await until('qa ends', async () => { const v = await run(qa.runId); return ['finished', 'failed'].includes(v?.state) ? v : null; }, 30);
  check('after approval the regression is filed with its label', value.state === 'finished' && gh.opened.length === 1 && JSON.stringify(gh.opened[0].labels) === '["regression"]', JSON.stringify(gh.opened));

  // A second release of a stable tag does not match the filter.
  gh.releases.push({ id: 51, tag_name: 'v2.0.0', name: 'stable', draft: false, prerelease: false, html_url: 'x' }); gh.version += 1;
  await api('POST', '/connectors/github/poll');
  await new Promise(resolve => setTimeout(resolve, 1000));
  check('a stable tag does not start the QA loop', ((await api('GET', '/runs')).body?.runs ?? []).filter(item => item.graphId === 'qa-release-loop').length === 1);
} catch (error) {
  check('drill', false, String(error?.stack ?? error));
} finally {
  try { await stopHost(); } catch {}
  model.close();
  github.close();
}
const seconds = Math.round((Date.now() - started) / 1000);
console.log(`${checks.filter(item => item.ok).length}/${checks.length} in ${seconds} s`);
writeFileSync(join(here, 'loop-drill-result.json'), JSON.stringify({ seconds, checks, model: modelLog, github: { pulls: gh.pulls, opened: gh.opened, comments: gh.comments } }, null, 2));
process.exit(checks.every(item => item.ok) ? 0 : 1);
