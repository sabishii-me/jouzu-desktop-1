// Commit attribution against a real jouzu runtime, in throwaway folders:
//   node commit-attribution.mjs <jouzu dist/cli.js>
// with ATTR_ON=1 (setting on) or ATTR_ON=0. A loopback provider makes the agent
// run `git commit` once through its bash tool; prints the commit message and
// whether the pull request line reached the system prompt. No network, no
// credentials, never the user's data folder.
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const [, , jouzuCli] = process.argv;
const extDir = join(import.meta.dirname, '..', '..', '..', 'packaging', 'launcher', 'extensions', 'jouzu-attribution');
const providerFile = join(import.meta.dirname, 'matrix-provider.mjs');
const home = mkdtempSync(join(tmpdir(), 'attr-home-'));
const repo = mkdtempSync(join(tmpdir(), 'attr-repo-'));
mkdirSync(join(home, 'agent', 'extensions'), { recursive: true });
cpSync(extDir, join(home, 'agent', 'extensions', 'jouzu-attribution'), { recursive: true });
const on = process.env.ATTR_ON === '1';
writeFileSync(join(home, 'agent', 'tools.json'), JSON.stringify({ commitAttribution: { enabled: on } }));
const genv = { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@x', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(repo, '.none') };
delete genv.GIT_CONFIG_COUNT;
spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env: genv });
let calls = 0; const systems = [];
const server = createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const data = JSON.parse(body); calls++;
    systems.push(data.messages.filter(m => m.role === 'system' || m.role === 'developer').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n'));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', created: 1, model: 'deterministic', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    chunk({ role: 'assistant' });
    if (calls === 1) {
      chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'git commit -q --allow-empty -m "agent commit" && git log -1 --format=%B' }) } }] });
      chunk({}, 'tool_calls');
    } else { chunk({ content: 'done' }); chunk({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
}).listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const env = { ...genv, JOUZU_HOME: home, PI_CODING_AGENT_DIR: join(home, 'agent'), JOUZU_NO_UPDATE: '1', PI_SKIP_VERSION_CHECK: '1', MATRIX_BASE_URL: `http://127.0.0.1:${port}/v1` };
  const child = spawn(process.execPath, [jouzuCli, '--mode', 'rpc', '-e', providerFile], { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '', settled = false, err = '';
  child.stderr.on('data', c => err += c);
  child.stdout.on('data', c => { buf += c; for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) { try { const e = JSON.parse(buf.slice(0, i)); if (e.type === 'agent_settled') settled = true; if (e.type === 'response' && e.success === false) console.log('ERR', JSON.stringify(e)); } catch {} } });
  child.stdin.write(JSON.stringify({ type: 'set_model', id: 'm', provider: 'matrix-fixture', modelId: 'deterministic' }) + '\n');
  child.stdin.write(JSON.stringify({ type: 'prompt', id: 'p', message: 'commit please' }) + '\n');
  const t0 = Date.now();
  const tick = setInterval(() => {
    if (settled || Date.now() - t0 > 90000) {
      clearInterval(tick); child.kill(); server.close();
      const log = spawnSync('git', ['log', '-1', '--format=%B'], { cwd: repo, env: genv, encoding: 'utf8' });
      console.log('settled', settled, 'calls', calls);
      console.log('COMMIT:\n' + log.stdout + log.stderr);
      console.log('PR guideline in prompt:', systems.some(s => s.includes('Generated with Jouzu Desktop')));
      if (!settled) console.log(err.slice(-2000));
    }
  }, 200);
});
