import { chromium } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startFixtureServer } from './fixture-server.mjs';

// The abnormal-path exam: e2e/abnormal-playbook.mjs on a throwaway home, with a world the
// playbook can break and repair (provider faults, runtime kills, a slow runtime start, a
// frozen app, bad files). It never touches a user's data folder and only ever stops
// processes it started itself.
//
// The world a case needs (ABN_WORLD, set per case by the runner from the case's own list entry):
//   (empty)          a person who uses Jouzu: the fixture model saved, old sessions, the runtime linked
//   new-user         nothing prepared: no runtime, model, settings or sessions; the host is laid out as
//                    an installation and installs its runtime itself (needs the network, as a person's
//                    first run does; the machine's proxy and CA settings are passed on)
//   shisa-stand-in   as empty, and JOUZU_SHISA_PLATFORM_URL points Shisa.AI sign-in at the fixture's stand-in
// Three ways to run it:
//   Installed app, as a person starts it (release acceptance, Windows):
//     ABN_SHELL    the installed "Jouzu Desktop.exe"; it runs with its own LOCALAPPDATA, so
//                  its data folder, WebView profile and host files are all throwaway.
//                  Windows lets one Jouzu Desktop run at a time: if the person's own app is
//                  open the exam stops and says so; it never closes it.
//     ABN_MANAGED  as below
//   Installed package's host and UI in a test browser (no app window):
//     ABN_INSTALL  the installed app folder (holds jouzu-host.exe or resources\host\)
//     ABN_MANAGED  the installation's managed folder (%LOCALAPPDATA%\Shisa.ai\JouzuDesktop);
//                  only its runtime/, app/ and bin/ are used, linked read-only
//   Source build (development):
//     ABN_HOST     a built jouzu-host
//     ABN_DIST     the built UI
//     ABN_RUNTIME_APP  a folder with the runtime's bootstrap.mjs (node_modules/jouzu)
//     ABN_UNIX_LAYOUT  macOS/Linux: run the runtime as an installation there does, from
//                  <home>/runtime/node/bin/node and <home>/app, without --runtime (#181)
// Common:
//   ABN_EXTENSIONS the desktop extensions folder to install into the throwaway home (source build or unpacked package)
//   ABN_LANGS    interface languages to run, comma separated (default en,ja)
//   ABN_ONLY     run only the cases whose names contain this text (several: separate with |)
//   ABN_OUT      report folder (default ./abnormal-exam-<time>)
//   ABN_PLAYBOOK the playbook in e2e/ to run in this world (default abnormal-playbook.mjs;
//                ui-states.mjs records every screen and state for a UI audit, no pass/fail)
const here = import.meta.dirname;
const launcher = resolve(here, '..');
const out = resolve(process.env.ABN_OUT ?? `abnormal-exam-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(out, { recursive: true });
const windows = process.platform === 'win32';
// The kind of world a case needs: '' (a person who uses Jouzu: the fixture model, old sessions),
// 'new-user' (nothing prepared), or 'shisa-stand-in' (as '' and Shisa.AI sign-in goes to the fixture's stand-in).
const newUser = process.env.ABN_WORLD === 'new-user';
const shisaStandIn = process.env.ABN_WORLD === 'shisa-stand-in';
let fixturePortNow = null;
const children = new Set();
const sleep = ms => new Promise(r => setTimeout(r, ms));

function installed() {
  if (process.env.ABN_SHELL) {
    const managed = process.env.ABN_MANAGED ?? join(process.env.LOCALAPPDATA ?? '', 'Shisa.ai', 'JouzuDesktop');
    if (!existsSync(process.env.ABN_SHELL)) throw new Error(`No app at ${process.env.ABN_SHELL}`);
    return { shell: process.env.ABN_SHELL, managed };
  }
  const install = process.env.ABN_INSTALL;
  if (!install) return null;
  const managed = process.env.ABN_MANAGED ?? join(process.env.LOCALAPPDATA ?? '', 'Shisa.ai', 'JouzuDesktop');
  const host = [join(install, 'jouzu-host.exe'), join(install, 'resources', 'host', 'jouzu-host.exe'), join(install, 'host', 'jouzu-host.exe')].find(existsSync);
  const dist = [join(install, 'dist'), join(install, 'resources', 'dist'), join(install, '_up_', 'dist')].find(path => existsSync(join(path, 'index.html')));
  if (!host || !dist) throw new Error(`No host or UI found in ${install}`);
  return { install, managed, host, dist };
}

/** A throwaway root: the host's home, its data folder, a workspace, the runtime linked in. */
function makeRoot(fixturePort, pkg) {
  const root = mkdtempSync(join(tmpdir(), 'jouzu-abnormal-'));
  if (newUser) {
    // ABN_WORLD=new-user: a person who never used Jouzu. Nothing is prepared: no runtime, no
    // model, no settings, no sessions. The app installs its runtime itself (release playbook N1).
    const home = pkg?.shell ? join(root, 'localappdata', 'Shisa.ai', 'JouzuDesktop') : join(root, 'home');
    const data = join(home, 'data');
    const workspace = join(root, 'workspace');
    for (const dir of [home, workspace]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(root, 'runtime-delay.json'), '{"ms":0}');
    return { root, home, data, workspace };
  }
  // The app keeps its files in %LOCALAPPDATA%\Shisa.ai\JouzuDesktop; the exam gives it its own.
  const home = pkg?.shell ? join(root, 'localappdata', 'Shisa.ai', 'JouzuDesktop') : join(root, 'home');
  const data = join(home, 'data');
  const workspace = join(root, 'workspace');
  for (const dir of [home, join(data, 'agent'), workspace]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(workspace, 'README.md'), '# Abnormal path workspace\n');
  if (pkg) {
    for (const part of ['runtime', 'app', 'bin']) {
      if (existsSync(join(pkg.managed, part))) symlinkSync(join(pkg.managed, part), join(home, part), 'junction');
    }
  }
  // The fixture provider as a saved provider: the only model this home has.
  writeFileSync(join(data, 'agent', 'models.json'), JSON.stringify({
    providers: {
      fixture: {
        baseUrl: `http://127.0.0.1:${fixturePort}/v1`, api: 'openai-completions', apiKey: '$FIXTURE_SECRET',
        models: [
          { id: 'deterministic', name: 'Fixture model', reasoning: false, input: ['text', 'image'], contextWindow: 32000, maxTokens: 1024 },
          { id: 'second', name: 'Fixture second model', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1024 },
        ],
      },
      // A second custom connection, as a person adds one in Settings: it can be removed (#171).
      extra: {
        baseUrl: `http://127.0.0.1:${fixturePort}/v1`, api: 'openai-completions', apiKey: '$FIXTURE_SECRET',
        models: [{ id: 'extra-model', name: 'Extra model', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1024 }],
      },
    },
  }, null, 2));
  // A packaged install writes the desktop extensions into the runtime's agent folder; a source
  // build or an unpacked package does not, so they are copied in (ABN_EXTENSIONS = the package's
  // packaging/desktop/extensions folder). Without them the image tool's refresh reaches the model.
  if (process.env.ABN_EXTENSIONS) cpSync(resolve(process.env.ABN_EXTENSIONS), join(data, 'agent', 'extensions'), { recursive: true });
  writeFileSync(join(data, 'agent', 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'deterministic' }, null, 2));
  writeFileSync(join(root, 'runtime-delay.json'), '{"ms":0}');
  writeOldSessions(data, workspace);
  return { root, home, data, workspace };
}

/**
 * Saved sessions as earlier versions and accidents leave them: an older format, a file
 * cut off mid-line (power loss), an entry type this version does not know, an empty
 * file, and a session whose folder was deleted. The playbook opens them.
 */
function writeOldSessions(data, workspace) {
  const directory = join(data, 'state', 'sessions');
  mkdirSync(directory, { recursive: true });
  const at = minute => `2026-01-0${minute}T00:00:00.000Z`;
  const user = (text, minute) => JSON.stringify({ type: 'message', timestamp: at(minute), message: { role: 'user', content: [{ type: 'text', text }] } });
  const reply = (text, minute) => JSON.stringify({ type: 'message', timestamp: at(minute), message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' } });
  const write = (name, lines) => writeFileSync(join(directory, `${at(name[0]).replace(/[:.]/g, '-')}_${name}.jsonl`), lines.join('\n') + (lines.length ? '\n' : ''));
  write('1-older-version', [
    JSON.stringify({ type: 'session', version: 1, id: 'older-version', timestamp: at(1), cwd: workspace }),
    JSON.stringify({ type: 'message', timestamp: at(1), message: { role: 'user', content: 'Session from an older version' } }),
    JSON.stringify({ type: 'message', timestamp: at(1), message: { role: 'assistant', content: 'An answer written by an older version.' } }),
  ]);
  write('2-half-written', [
    JSON.stringify({ type: 'session', version: 3, id: 'half-written', timestamp: at(2), cwd: workspace }),
    user('Half written session', 2),
    reply('The last line of this file was cut off.', 2),
    '{"type":"message","timestamp":"2026-01-02T00:00:01.000Z","message":{"role":"assistant","content":[{"type":"text","text":"cut of',
  ]);
  write('3-unknown-entry', [
    JSON.stringify({ type: 'session', version: 3, id: 'unknown-entry', timestamp: at(3), cwd: workspace }),
    user('Session with an unknown entry', 3),
    JSON.stringify({ type: 'entry_from_a_future_version', timestamp: at(3), data: { anything: true } }),
    reply('An answer after an unknown entry.', 3),
  ]);
  write('4-empty', []);
  write('5-folder-deleted', [
    JSON.stringify({ type: 'session', version: 3, id: 'folder-deleted', timestamp: at(5), cwd: join(dirname(workspace), 'deleted-folder') }),
    user('Session whose folder was deleted', 5),
    reply('This folder no longer exists.', 5),
  ]);
}

/** Only what a person's machine would give the app: no keys or tokens of this machine. */
function cleanEnv(root, extra) {
  const keep = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS',
    // The machine's network settings, as a person's machine gives them to every app.
    'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS'];
  const env = {};
  for (const name of keep) if (process.env[name] !== undefined) env[name] = process.env[name];
  return {
    ...env,
    HOME: root, USERPROFILE: root, LOCALAPPDATA: join(root, 'localappdata'), APPDATA: join(root, 'appdata'),
    NODE_OPTIONS: `--import=${pathToFileURL(join(here, 'runtime-delay.mjs')).href}`,
    // The fixture provider's key comes from the environment, as a person's own variable
    // would: a change in Settings > Environment must reach open sessions (#173).
    FIXTURE_SECRET: 'fixture-key',
    JOUZU_E2E_RUNTIME_DELAY: join(root, 'runtime-delay.json'),
    // The address switch the runtime has for Shisa.AI sign-in, pointed at the fixture's stand-in (N4).
    ...(shisaStandIn && fixturePortNow ? { JOUZU_SHISA_PLATFORM_URL: `http://127.0.0.1:${fixturePortNow}/shisa` } : {}),
    ...extra,
  };
}

/** A source build's stand-in for the installation: its app/ is the runtime folder, so the configuration service runs. */
function sourceInstall(root) {
  const install = join(root, 'install');
  if (!existsSync(join(install, 'app'))) { mkdirSync(install, { recursive: true }); symlinkSync(resolve(process.env.ABN_RUNTIME_APP), join(install, 'app'), 'junction'); }
  return install;
}

/** The installed app as a person starts it; the host is its child. */
function startShell(stack, port) {
  const { pkg, paths } = stack;
  // USERPROFILE is the exam root too, and WebView2 opens no debugging port when that
  // profile has no AppData\Local, so give it the folders a real profile has.
  for (const dir of ['localappdata', 'appdata', join('AppData', 'Local'), join('AppData', 'Roaming')]) mkdirSync(join(paths.root, dir), { recursive: true });
  const env = cleanEnv(paths.root, { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` });
  const child = spawn(pkg.shell, [], { env, cwd: paths.workspace, stdio: 'ignore', detached: false });
  children.add(child);
  child.on('exit', () => children.delete(child));
  stack.shell = child;
}
async function shellHost(stack, timeout = 60_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (stack.shell.exitCode !== null) throw new Error('Jouzu Desktop exited at once: another Jouzu Desktop is probably open on this computer. Close it to run the installed-app exam (the exam never closes it).');
    const host = descendants(stack.shell.pid).find(row => /jouzu-host/i.test(row.name));
    // The app reads the host's token itself; the exam only needs the host's process.
    if (host && existsSync(join(stack.paths.home, 'host.json'))) { stack.host = { pid: host.pid }; return; }
    await sleep(500);
  }
  throw new Error('The installed app did not start its host within 60 s');
}

function startHost(stack) {
  const { pkg, paths } = stack;
  // stack.managed: the source build runs its runtime as an installation does, from <home>\app
  // and a Node it is given, so the runtime's files can go missing and come back (#87).
  // A new user's host is laid out as an installation is and given no runtime: it installs one (N1).
  const args = pkg || newUser
    ? ['--dist', pkg ? pkg.dist : resolve(process.env.ABN_DIST), '--home', paths.home, '--runtime-home', paths.data, '--install', paths.home]
    : stack.managed
      ? ['--dist', resolve(process.env.ABN_DIST), '--home', paths.home, '--runtime-home', paths.data, '--install', sourceInstall(paths.root)]
      : process.env.ABN_UNIX_LAYOUT
        // An installation's layout on macOS/Linux (#181): <install>/runtime/node/bin/node and <install>/app; no --runtime.
        ? (() => { const install = sourceInstall(paths.root); const bin = join(paths.home, 'runtime', 'node', 'bin'); if (!existsSync(join(paths.home, 'app'))) symlinkSync(resolve(process.env.ABN_RUNTIME_APP), join(paths.home, 'app')); if (!existsSync(join(bin, 'node'))) { mkdirSync(bin, { recursive: true }); symlinkSync(process.execPath, join(bin, 'node')); } return ['--dist', resolve(process.env.ABN_DIST), '--home', paths.home, '--runtime-home', paths.data, '--install', install]; })()
      : ['--dist', resolve(process.env.ABN_DIST), '--home', paths.home, '--runtime-home', paths.data, '--install', sourceInstall(paths.root),
        '--runtime', process.execPath, '--runtime-arg', join(resolve(process.env.ABN_RUNTIME_APP), 'bootstrap.mjs'), '--runtime-arg', '--mode', '--runtime-arg', 'rpc'];
  for (const dir of ['localappdata', 'appdata']) mkdirSync(join(paths.root, dir), { recursive: true });
  try { rmSync(join(paths.home, 'host.json')); } catch { /* first start */ }
  const env = cleanEnv(paths.root, !pkg && !newUser && stack.managed ? { JOUZU_HOST_NODE: process.execPath } : {});
  const child = spawn(pkg ? pkg.host : resolve(process.env.ABN_HOST), args, { env, cwd: paths.workspace, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  children.add(child);
  child.on('exit', () => children.delete(child));
  stack.host = child;
  // Since #130 the host gives its port and token only to its starter, on its first output
  // line; host.json no longer has the token. Older hosts (1.1.3 and before) have it there.
  stack.ready = null;
  let text = '';
  child.stdout.on('data', chunk => {
    if (stack.ready) return;
    text += chunk;
    const end = text.indexOf('\n');
    if (end < 0) return;
    try { stack.ready = JSON.parse(text.slice(0, end)); } catch { stack.ready = {}; }
  });
}

async function hostInfo(stack, timeout = 30_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (stack.ready?.token && stack.ready?.port) return stack.ready;
    try {
      const file = JSON.parse(readFileSync(join(stack.paths.home, 'host.json'), 'utf8'));
      if (file.token && file.port) return file;
    } catch { /* not yet */ }
    if (stack.host?.exitCode != null) throw new Error(`The host exited (${stack.host.exitCode}) before it was ready`);
    await sleep(200);
  }
  throw new Error('The host did not start');
}

// ---- Processes: only descendants of the host this exam started. ----
function processTable() {
  if (windows) {
    const text = execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)|$($_.CommandLine)" }'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return text.trim().split(/\r?\n/).map(line => { const [pid, ppid, name, ...args] = line.trim().split('|'); return { pid: Number(pid), ppid: Number(ppid), name, args: args.join('|') }; });
  }
  if (process.platform === 'darwin') {
    // macOS has no /proc: one ps for pid, parent and short name (ucomm), one for full command lines.
    const ps = format => execFileSync('ps', ['-axww', '-o', format], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n');
    const args = new Map();
    for (const line of ps('pid=,args=')) { const m = line.match(/^\s*(\d+)\s(.*)$/); if (m) args.set(Number(m[1]), m[2].trim()); }
    return ps('pid=,ppid=,ucomm=').flatMap(line => {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) return [];
      const commandLine = args.get(Number(m[1])) ?? '';
      // A runtime renames itself "jouzu": on macOS that changes its command line, not its ucomm.
      return [{ pid: Number(m[1]), ppid: Number(m[2]), name: /^jouzu\b/.test(commandLine) ? 'jouzu' : m[3].trim(), args: commandLine }];
    });
  }
  return readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(pid => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ');
      return [{ pid: Number(pid), ppid, name: stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')')), args }];
    } catch { return []; }
  });
}
function descendants(rootPid) {
  const table = processTable();
  const found = [];
  let frontier = [rootPid];
  while (frontier.length) {
    const next = table.filter(row => frontier.includes(row.ppid));
    found.push(...next);
    frontier = next.map(row => row.pid);
  }
  return found;
}
/**
 * Runtime processes: the host's own children that run Jouzu in RPC mode. A runtime renames
 * its process to "jouzu" (Linux), so the name is enough there; on Windows it is node.exe
 * and its command line says rpc. Helpers such as the configuration service are not runtimes.
 */
function runtimes(hostPid) {
  return processTable().filter(row => row.ppid === hostPid && (/^jouzu$/.test(row.name) || (/node/i.test(row.name) && /\brpc\b/.test(row.args))));
}
function kill(pid) { return killAll([pid]).length === 1; }
/**
 * Kill these processes at the same moment. One by one took about 2 s on Windows, and the
 * host meanwhile moved the session onto a warm runtime that was also on the list: one
 * "kill" became a crash loop. Returns the ids that are gone afterwards.
 */
function killAll(pids) {
  if (!pids.length) return [];
  if (windows) {
    try { execFileSync('taskkill.exe', [...pids.flatMap(pid => ['/PID', String(pid)]), '/T', '/F'], { stdio: 'ignore' }); } catch { /* some were gone already */ }
    const alive = new Set(processTable().map(row => row.pid));
    return pids.filter(pid => !alive.has(pid));
  }
  return pids.filter(pid => { try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; } });
}
function suspend(pids, on) {
  if (!pids.length) return;
  if (windows) {
    const script = `Add-Type -Name P -Namespace W -MemberDefinition '[DllImport("ntdll.dll")] public static extern int Nt${on ? 'Suspend' : 'Resume'}Process(System.IntPtr h);'; foreach ($p in @(${pids.join(',')})) { try { [W.P]::Nt${on ? 'Suspend' : 'Resume'}Process((Get-Process -Id $p).Handle) | Out-Null } catch {} }`;
    execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { stdio: 'ignore' });
  } else {
    for (const pid of pids) { try { process.kill(pid, on ? 'SIGSTOP' : 'SIGCONT'); } catch { /* gone */ } }
  }
}

/**
 * The world the playbook may change, over HTTP on 127.0.0.1:
 *   GET  /state                       host and runtime process ids, and whether it is the app window
 *   POST /host/restart {runtime}      the host ends and starts again on the same home; answers the new page URL;
 *                                     runtime "missing" starts it without the runtime's files, "normal" as before
 *   POST /runtime/restore             the runtime's files are put in place while the app runs
 *   POST /runtime/kill {which}        kill the newest runtime, or "all" of them
 *   POST /runtime/kill-loop {ms}      kill every runtime that appears, for ms
 *   POST /runtime/delay {ms}          later runtime starts wait ms
 *   POST /freeze {ms}                 freeze the host and its runtimes for ms (a computer asleep)
 *   POST /file {path, text|remove|readOnly}  change a file under the home (path relative to it)
 *   GET  /file?path=                  read it back
 *   POST /workspace {name}            make another workspace folder beside the first; answers its path
 *   GET  /list?path=                  the files in a folder under the home (name, size, mtimeMs)
 */
function worldServer(stack) {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', async () => {
      const url = new URL(request.url, 'http://x');
      const input = body ? JSON.parse(body) : {};
      const reply = value => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
      try {
        const hostPid = stack.host.pid;
        if (url.pathname === '/state') return reply({ world: newUser ? 'new-user' : shisaStandIn ? 'shisa-stand-in' : 'user', proxy: Boolean(process.env.HTTPS_PROXY || process.env.https_proxy), host: hostPid, runtimes: runtimes(hostPid).map(row => row.pid), home: stack.paths.home, workspace: stack.paths.workspace, shell: Boolean(stack.shell) });
        if (url.pathname === '/host/restart') {
          // The app ends and starts again on the same home (#162). Only when the exam started
          // the host itself; the installed app's own window is not restarted here.
          if (stack.shell) return reply({ unsupported: 'installed app window' });
          killAll([hostPid, ...descendants(hostPid).map(row => row.pid)]);
          await sleep(1_000);
          // {runtime: "missing"}: the runtime's files are gone when the app starts (#87).
          const app = join(stack.paths.home, 'app');
          if (input.runtime === 'missing') {
            stack.managed = true;
            if (existsSync(app)) renameSync(app, `${app}.away`);
          } else if (input.runtime === 'normal') {
            stack.managed = false;
            if (existsSync(`${app}.away`) && !existsSync(app)) renameSync(`${app}.away`, app);
          }
          startHost(stack);
          const info = await hostInfo(stack, 30_000);
          return reply({ url: `http://127.0.0.1:${info.port}/?token=${info.token}` });
        }
        if (url.pathname === '/runtime/kill') {
          const list = runtimes(hostPid).sort((a, b) => b.pid - a.pid);
          const chosen = input.which === 'all' ? list : list.slice(0, 1);
          return reply({ killed: killAll(chosen.map(row => row.pid)) });
        }
        if (url.pathname === '/runtime/kill-loop') {
          const until = Date.now() + (input.ms ?? 10_000);
          let killed = 0;
          while (Date.now() < until) { killed += killAll(runtimes(hostPid).map(row => row.pid)).length; await sleep(300); }
          return reply({ killed });
        }
        if (url.pathname === '/runtime/restore') {
          // The runtime's files are put in place while the app runs (a late first-run
          // preparation or a repair, #87).
          const app = join(stack.paths.home, 'app');
          if (existsSync(`${app}.away`)) renameSync(`${app}.away`, app);
          else if (!existsSync(app)) symlinkSync(resolve(process.env.ABN_RUNTIME_APP), app, 'junction');
          return reply({ restored: existsSync(join(app, 'bootstrap.mjs')) });
        }
        if (url.pathname === '/runtime/delay') {
          writeFileSync(join(stack.paths.root, 'runtime-delay.json'), JSON.stringify({ ms: input.ms ?? 0 }));
          return reply({ ms: input.ms ?? 0 });
        }
        if (url.pathname === '/freeze') {
          const pids = [hostPid, ...descendants(hostPid).map(row => row.pid)];
          suspend(pids, true);
          await sleep(input.ms ?? 30_000);
          suspend(pids, false);
          return reply({ frozen: pids.length });
        }
        if (url.pathname === '/workspace') {
          // Another folder the person works in, beside the first one (release playbook P4).
          const path = join(stack.paths.root, String(input.name ?? 'second-workspace').replace(/[^A-Za-z0-9_-]/g, '-'));
          mkdirSync(path, { recursive: true });
          writeFileSync(join(path, 'README.md'), `# ${input.name ?? 'second workspace'}\n`);
          return reply({ path });
        }
        if (url.pathname === '/list') {
          // The files in a folder under the home, with size and time (release playbook: which session file was written).
          const path = resolve(stack.paths.home, input.path ?? url.searchParams.get('path') ?? '');
          if (!path.startsWith(resolve(stack.paths.home))) throw new Error('outside the home');
          if (!existsSync(path)) return reply({ files: [] });
          return reply({ files: readdirSync(path).map(name => { const info = statSync(join(path, name)); return { name, size: info.size, mtimeMs: info.mtimeMs, dir: info.isDirectory() }; }) });
        }
        if (url.pathname === '/file') {
          const path = resolve(stack.paths.home, input.path ?? url.searchParams.get('path') ?? '');
          if (!path.startsWith(resolve(stack.paths.home))) throw new Error('outside the home');
          if (request.method === 'GET') return reply({ exists: existsSync(path), text: existsSync(path) && statSync(path).isFile() ? readFileSync(path, 'utf8') : null });
          if (input.remove) rmSync(path, { recursive: true, force: true });
          if (input.text !== undefined) { mkdirSync(dirname(path), { recursive: true }); try { chmodSync(path, 0o644); } catch { /* new */ } writeFileSync(path, input.text); }
          if (input.readOnly !== undefined) {
            if (windows) execFileSync('attrib.exe', [input.readOnly ? '+R' : '-R', path], { stdio: 'ignore' });
            else chmodSync(path, input.readOnly ? 0o444 : 0o644);
            // An administrator (root) writes read-only files anyway: say whether it held.
            let writable = true;
            try { const handle = (await import('node:fs')).openSync(path, 'r+'); (await import('node:fs')).closeSync(handle); } catch { writable = false; }
            return reply({ ok: true, effective: input.readOnly ? !writable : writable });
          }
          return reply({ ok: true });
        }
        response.writeHead(404).end();
      } catch (error) {
        response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(error?.message ?? error) }));
      }
    });
  });
  return new Promise(resolvePromise => server.listen(0, '127.0.0.1', () => resolvePromise({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

async function openBrowser(info, language, port) {
  const browser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const base = `http://127.0.0.1:${info.port}`;
  await context.addInitScript(lang => { localStorage.setItem('jouzu.ui.language', lang); }, language);
  const page = await context.newPage();
  await page.goto(`${base}/?token=${info.token}`);
  return browser;
}

function runPlaybook(env) {
  return new Promise(resolvePromise => {
    const child = spawn(process.execPath, [join(launcher, 'e2e', process.env.ABN_PLAYBOOK ?? 'abnormal-playbook.mjs')], { cwd: launcher, env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'inherit'] });
    child.on('exit', code => {
      let result = null;
      try { result = JSON.parse(readFileSync(env.PLAYBOOK_OUT, 'utf8')); } catch { /* none */ }
      resolvePromise({ code, result });
    });
  });
}

const report = { startedAt: new Date().toISOString(), mode: null, runs: [] };
const pkg = installed();
report.mode = pkg?.shell ? `installed app ${pkg.shell}` : pkg ? `installed package's host and UI in a test browser ${pkg.install}` : `source build ${process.env.ABN_HOST}`;
if (!pkg) for (const name of ['ABN_HOST', 'ABN_DIST', 'ABN_RUNTIME_APP']) if (!process.env[name]) { console.error(`${name} is not set`); process.exit(2); }
const languages = (process.env.ABN_LANGS ?? 'en,ja').split(',').map(item => item.trim()).filter(Boolean);
let port = Number(process.env.ABN_PORT ?? 9240);
try {
  for (const language of languages) {
    const fixture = await startFixtureServer(0);
    fixturePortNow = fixture.port;
    const stack = { pkg, paths: makeRoot(fixture.port, pkg) };
    let browser = null;
    if (pkg?.shell) {
      startShell(stack, port);
      await shellHost(stack);
    } else {
      startHost(stack);
      const info = await hostInfo(stack);
      browser = await openBrowser(info, language, port);
    }
    const world = await worldServer(stack);
    const file = join(out, `abnormal-${language}.json`);
    const run = await runPlaybook({
      PLAYBOOK_CDP: `http://127.0.0.1:${port}`, PLAYBOOK_OUT: file, PLAYBOOK_SHOTS: join(out, language),
      PLAYBOOK_FIXTURE: `http://127.0.0.1:${fixture.port}`, PLAYBOOK_WORLD: world.url, PLAYBOOK_LANG: language,
      PLAYBOOK_ONLY: process.env.ABN_ONLY ?? '',
    });
    report.runs.push({ language, root: stack.paths.root, code: run.code, result: run.result });
    await browser?.close();
    world.server.close();
    fixture.server.close();
    kill(stack.host.pid);
    if (stack.shell) kill(stack.shell.pid);
    try { cpSync(join(stack.paths.home, 'logs'), join(out, `logs-${language}`), { recursive: true }); } catch { /* no logs */ }
    port += 1;
  }
} catch (error) {
  report.runs.push({ error: String(error?.stack ?? error) });
} finally {
  for (const child of children) kill(child.pid);
}
report.finishedAt = new Date().toISOString();
report.pass = report.runs.length > 0 && report.runs.every(run => run.result?.pass);
writeFileSync(join(out, 'abnormal-exam.json'), `${JSON.stringify(report, null, 2)}\n`);
for (const run of report.runs) {
  if (run.error) { console.log(`ERROR ${run.error}`); continue; }
  for (const item of run.result?.cases ?? []) console.log(`${item.skipped ? 'SKIP' : item.ok ? 'PASS' : 'FAIL'} [${run.language}] ${item.name}${item.ok ? '' : `: ${item.problems.join('; ')}`}`);
}
console.log(report.pass ? 'Abnormal-path exam passed.' : 'Abnormal-path exam failed.');
process.exit(report.pass ? 0 : 1);
