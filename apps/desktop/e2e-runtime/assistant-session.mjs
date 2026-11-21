// The Assistant on the real runtime: a jouzu session with its own configuration.
//
// Starts a host on throwaway folders with the runtime of an extracted official
// setup, a loopback OpenAI-compatible model configured the way a user adds one
// (models.json), turns the Assistant on with that model, and checks:
//   - the runtime accepts the Assistant's arguments and becomes ready;
//   - the model is offered the Assistant's tools and read-only ones, nothing
//     that runs commands or writes files, and the Assistant's prompt;
//   - a tool call goes through the jouzu-assistant extension to the host and back;
//   - the bridge takes no token but the runtime's own (the host's is refused).
// Never contacts a paid provider. Results: assistant-session-result.json.
//
//   JOUZU_E2E_RUNTIME=<folder with bootstrap.mjs and node_modules/jouzu>
//   JOUZU_E2E_HOST_BIN=<jouzu-host binary> (default: host/target/debug/jouzu-host)
//   node e2e-runtime/assistant-session.mjs
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const runtime = process.env.JOUZU_E2E_RUNTIME;
if (!runtime) { console.error('JOUZU_E2E_RUNTIME is not set'); process.exit(2); }
const bin = process.env.JOUZU_E2E_HOST_BIN ?? join(here, '..', 'host', 'target', 'debug', process.platform === 'win32' ? 'jouzu-host.exe' : 'jouzu-host');
const root = mkdtempSync(join(tmpdir(), 'jouzu-assistant-e2e-'));
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

// The model: a tool call when asked, then an answer naming what the tool returned.
const requests = [];
const model = createServer((request, response) => {
  let body = '';
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    const data = JSON.parse(body || '{}');
    const messages = data.messages ?? [];
    const text = message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
    const system = messages.filter(message => message.role === 'system' || message.role === 'developer').map(text).join('\n');
    const tools = (data.tools ?? []).map(tool => tool.function?.name ?? tool.name);
    const user = [...messages].reverse().find(message => message.role === 'user');
    const toolResult = messages.find(message => message.role === 'tool' && message.tool_call_id === 'e2e-call');
    const said = messages.some(message => message.role === 'tool' && message.tool_call_id === 'e2e-say');
    requests.push({ system, tools, user: user ? text(user) : '' });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish = null) => response.write(`data: ${JSON.stringify({ id: 'e2e', object: 'chat.completion.chunk', created: 1, model: 'deterministic', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    chunk({ role: 'assistant' });
    if (user && text(user).includes('CALL list_workspaces') && !toolResult) {
      chunk({ tool_calls: [{ index: 0, id: 'e2e-call', type: 'function', function: { name: 'list_workspaces', arguments: '{}' } }] });
      chunk({}, 'tool_calls');
    } else if (!said) {
      // It speaks through say, as the Assistant must.
      const words = toolResult ? `tool said: ${text(toolResult).slice(0, 300)}` : 'hello from the fixture';
      chunk({ tool_calls: [{ index: 0, id: 'e2e-say', type: 'function', function: { name: 'say', arguments: JSON.stringify({ text: words }) } }] });
      chunk({}, 'tool_calls');
    } else {
      // The turn's final text is not a reply: the host must not show it.
      chunk({ content: 'FINAL TEXT NOT A REPLY' });
      chunk({}, 'stop');
    }
    response.end('data: [DONE]\n\n');
  });
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
const modelUrl = `http://127.0.0.1:${model.address().port}/v1`;

// A model the user added (the runtime's own configuration file), and a folder.
const data = join(root, 'data');
mkdirSync(join(data, 'agent'), { recursive: true });
writeFileSync(join(data, 'agent', 'models.json'), JSON.stringify({ providers: { 'assistant-e2e': {
  baseUrl: modelUrl, api: 'openai-completions', apiKey: 'fixture',
  models: [{ id: 'deterministic', name: 'Deterministic', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } }));
const dist = join(root, 'dist');
mkdirSync(dist);
writeFileSync(join(dist, 'index.html'), '<html></html>');
const folder = join(root, 'work');
mkdirSync(folder);

const host = spawn(bin, ['--dist', dist, '--home', join(root, 'home'), '--runtime-home', data,
  '--runtime', process.execPath, '--runtime-arg', join(runtime, 'bootstrap.mjs'), '--runtime-arg', '--mode', '--runtime-arg', 'rpc'],
  { stdio: ['ignore', 'pipe', 'inherit'] });
const ready = await new Promise((resolve, reject) => {
  createInterface({ input: host.stdout }).once('line', line => resolve(JSON.parse(line)));
  host.once('exit', code => reject(new Error(`host exited ${code}`)));
});
const base = `http://127.0.0.1:${ready.port}/v1`;
const api = async (method, path, body, token = ready.token) => {
  const response = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json().catch(() => null) };
};
const until = async (what, test, seconds = 180) => {
  for (let tick = 0; tick < seconds * 4; tick += 1) {
    const value = await test();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`timed out: ${what}`);
};

try {
  await api('POST', '/workspaces', { paths: [folder] });
  const on = await api('PUT', '/assistant', { enabled: true, model: { provider: 'assistant-e2e', id: 'deterministic' } });
  check('turned on with a model from models.json', on.status === 200, JSON.stringify(on.body?.error ?? ''));
  const state = await until('ready', async () => {
    const { body } = await api('GET', '/assistant');
    return ['idle', 'stopped'].includes(body?.phase) ? body : null;
  });
  check('the runtime accepts the arguments and is ready', state.phase === 'idle', state.error ?? '');

  await api('POST', '/assistant/messages', { text: 'CALL list_workspaces' });
  const reply = await until('reply', async () => {
    const { body } = await api('GET', '/assistant/messages?limit=20');
    return body?.messages?.find(row => row.kind === 'assistant' || row.kind === 'error');
  }, 120);
  check('a tool call goes through the extension to the host', reply.kind === 'assistant' && reply.text.includes('work'), reply.text.slice(0, 200));
  await until('turn ends', async () => (await api('GET', '/assistant')).body?.phase === 'idle', 60);
  const shown = (await api('GET', '/assistant/messages?limit=20')).body?.messages ?? [];
  check('only what it says reaches the user', shown.filter(row => row.kind === 'assistant').length === 1 && !shown.some(row => row.text?.includes('FINAL TEXT')), JSON.stringify(shown.map(row => row.text)).slice(0, 300));

  const offered = new Set(requests[0]?.tools ?? []);
  check('offered its own tools', ['say', 'list_workspaces', 'start_task', 'read_inbox', 'memory_write', 'list_projects'].every(name => offered.has(name)), [...offered].join(','));
  check('offered read-only tools', offered.has('read'), '');
  const coder = ['bash', 'write', 'edit', 'powershell'].filter(name => offered.has(name));
  check('offered nothing that runs commands or writes files', coder.length === 0, coder.join(','));
  check('runs on the Assistant prompt, not the coder prompt', requests[0]?.system.includes('Jouzu Desktop Assistant') && !requests[0]?.system.includes('You are a coding assistant'), '');
  check('its skills are listed', requests[0]?.system.includes('write-a-brief'), '');

  const refused = await api('POST', '/assistant/bridge', { name: 'list_workspaces', arguments: {} });
  check('the bridge refuses the host token', refused.status === 401, String(refused.status));
} catch (error) {
  check('run', false, String(error?.message ?? error));
} finally {
  host.kill();
  model.close();
}
writeFileSync(join(here, 'assistant-session-result.json'), JSON.stringify({ checks, system: requests[0]?.system ?? null, requests: requests.map(({ tools, user }) => ({ tools, user })) }, null, 2));
process.exit(checks.every(item => item.ok) ? 0 : 1);
