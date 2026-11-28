import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

// The installed app on macOS and Linux, started the way a person starts it, on a throwaway
// home of its own (ABN_APP = the installed app's executable: /usr/bin/jouzu-desktop for the
// .deb, the AppImage, or ".../Jouzu Desktop.app/Contents/MacOS/Jouzu Desktop").
//
// Linux: the app runs under its own session bus (the tray's Quit menu lives there) and, when the
// machine has no display, a virtual one. Its window is driven through WebKitWebDriver (package
// webkit2gtk-driver), which starts the app itself; the app allows that only with
// TAURI_WEBVIEW_AUTOMATION=true, as tauri-driver sets it.
// macOS: WKWebView has no WebDriver, so the app runs without window driving (window: null).
//
// Every process is started in its own process group and the group is ended afterwards, so a
// case never leaves an app, host, runtime, bus or display behind.

const sleep = ms => new Promise(r => setTimeout(r, ms));
const linux = process.platform === 'linux';
const mac = process.platform === 'darwin';

const freePort = () => new Promise(resolvePort => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolvePort(port)); }); });
const have = name => { try { execFileSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' }); return true; } catch { return false; } };

/** Where the app keeps its files under a given HOME (managed_paths.rs). */
export function managedHome(home) {
  if (mac) return join(home, 'Library', 'Application Support', 'Shisa.ai', 'JouzuDesktop');
  return join(home, '.local', 'share', 'Shisa.ai', 'JouzuDesktop');
}

/**
 * Start the app on a new HOME under root. seed: a managed folder whose runtime/, app/ and bin/
 * are linked in (an earlier run of the same app installed them), so the app starts without
 * downloading. Answers { home, managed, window, group }.
 */
export async function startApp({ executable, root, env, seed, name }) {
  const home = join(root, name);
  const managed = managedHome(home);
  mkdirSync(managed, { recursive: true });
  if (seed) for (const part of ['runtime', 'app', 'bin']) if (existsSync(join(seed, part)) && !existsSync(join(managed, part))) symlinkSync(join(seed, part), join(managed, part));
  const appEnv = { ...env, HOME: home, USERPROFILE: home, TAURI_WEBVIEW_AUTOMATION: 'true' };
  delete appEnv.XDG_DATA_HOME;
  const busFile = join(home, 'bus-address');
  let child;
  let webdriver = null;
  if (linux) {
    const display = process.env.DISPLAY ? [] : ['xvfb-run', '-a'];
    const drive = have('WebKitWebDriver');
    const port = drive ? await freePort() : null;
    const inner = drive ? [...display, 'WebKitWebDriver', `--port=${port}`] : [...display, executable];
    const script = 'printf %s "$DBUS_SESSION_BUS_ADDRESS" > "$0"; exec "$@"';
    child = spawn('dbus-run-session', ['--', 'sh', '-c', script, busFile, ...inner], { env: appEnv, cwd: home, stdio: 'ignore', detached: true });
    if (drive) {
      const until = Date.now() + 30_000;
      let session = null;
      while (!session && Date.now() < until) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capabilities: { alwaysMatch: { 'webkitgtk:browserOptions': { binary: executable, args: [] } } } }) });
          const body = await response.json();
          if (body.value?.sessionId) session = body.value.sessionId;
          else if (body.value?.error) throw new Error(`WebKitWebDriver: ${body.value.message ?? body.value.error}`);
        } catch (error) { if (/WebKitWebDriver:/.test(error.message)) throw error; await sleep(300); }
      }
      if (!session) throw new Error('WebKitWebDriver did not start the app within 30 s');
      webdriver = `http://127.0.0.1:${port}/session/${session}`;
    }
  } else {
    child = spawn(executable, [], { env: appEnv, cwd: home, stdio: 'ignore', detached: true });
  }
  return { home, managed, window: webdriver, group: child.pid, busFile, child };
}

/** End everything a started app left in its process group. */
export function endGroup(group) {
  try { process.kill(-group, 'SIGKILL'); } catch { /* gone */ }
}

/**
 * Quit the app as a person does. Linux: the tray's "Quit Jouzu" item, clicked over the session
 * bus as the desktop's tray does (com.canonical.dbusmenu Event "clicked"). macOS: no scripting
 * access to the menu without accessibility permission, so the app is sent SIGTERM; the record
 * says which way it was asked.
 */
export function quitApp(app, appPid) {
  if (!linux) { process.kill(appPid, 'SIGTERM'); return 'SIGTERM (macOS: the menu is not scriptable here)'; }
  const address = readFileSync(app.busFile, 'utf8').trim();
  const bus = args => execFileSync('busctl', ['--user', ...args], { env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: address }, encoding: 'utf8' });
  const names = JSON.parse(bus(['--json=short', 'call', 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames'])).data[0].filter(item => item.startsWith(':'));
  for (const name of names) {
    let tree = '';
    try { tree = bus(['tree', name]); } catch { continue; }
    const path = tree.match(/\/org\/ayatana\/NotificationItem\/\S+\/Menu/)?.[0];
    if (!path) continue;
    const layout = JSON.parse(bus(['--json=short', 'call', name, path, 'com.canonical.dbusmenu', 'GetLayout', 'iias', '--', '0', '-1', '1', 'label']));
    const items = layout.data[1][2].map(item => ({ id: item.data[0], label: item.data[1].label?.data }));
    const quit = items.find(item => /^Quit\b/.test(item.label ?? ''));
    if (!quit) throw new Error(`the tray menu has no Quit item (items: ${items.map(item => item.label).join(', ')})`);
    bus(['call', name, path, 'com.canonical.dbusmenu', 'Event', 'isvu', String(quit.id), 'clicked', 's', '', '0']);
    return `tray menu "${quit.label}"`;
  }
  throw new Error('the app has no tray menu on its session bus');
}

/** A small WebDriver client for the app's window (W3C WebDriver over HTTP). */
export function webDriver(url) {
  const call = async (method, path, body) => {
    const response = await fetch(`${url}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = (await response.json()).value;
    if (value && value.error) throw new Error(`${value.error}: ${value.message}`);
    return value;
  };
  const api = {
    exec: (script, args = []) => call('POST', '/execute/sync', { script, args }),
    click: element => call('POST', `/element/${Object.values(element)[0]}/click`, {}),
    type: (element, text) => call('POST', `/element/${Object.values(element)[0]}/value`, { text }),
    clear: element => call('POST', `/element/${Object.values(element)[0]}/clear`, {}),
    screenshot: () => call('GET', '/screenshot'),
    end: () => call('DELETE', '').catch(() => {}),
  };
  return Object.assign(api, {
    /** The visible element of a kind (button, field, option, combobox, text) whose name is exactly name (or one of a list of names). */
    find: (kind, name) => api.exec(FIND, [kind, name]),
    /**
     * Find and click, again and again for up to timeout: the page re-renders (a stale element)
     * or something is still drawn over the element while it closes (an intercepted click).
     * Answers whether it was clicked.
     */
    tap: async (kind, name, timeout = 15_000) => {
      const until = Date.now() + timeout;
      for (;;) {
        try {
          const element = await api.find(kind, name);
          if (element) { await api.click(element); return true; }
        } catch (error) { if (!/intercepted|not interactable|stale/.test(error.message)) throw error; }
        if (Date.now() > until) return false;
        await sleep(400);
      }
    },
    /** Type into the field labelled name (its label, aria-label or placeholder). */
    fill: async (name, text) => {
      const element = await api.find('field', name);
      if (!element) throw new Error(`no field "${name}"`);
      await api.clear(element).catch(() => {});
      await api.type(element, text);
    },
    text: () => api.exec('return document.body.innerText'),
  });
}

// Runs in the page: arguments[0] kind, arguments[1] name. Names are what a person reads: the
// element's text, aria-label, its <label>, or its placeholder.
const FIND = `
const [kind, name] = arguments;
// A name may be a list: the window's words in the language picked and in English, whichever it shows.
const wanted = [].concat(name);
const shown = el => { const box = el.getBoundingClientRect(); return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
const text = el => (el.innerText || el.textContent || '').trim();
const labelled = el => {
  const names = [el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('title')];
  const by = el.getAttribute('aria-labelledby');
  if (by) names.push(by.split(/\\s+/).map(id => document.getElementById(id)).filter(Boolean).map(text).join(' '));
  for (const label of el.labels || []) names.push(text(label));
  return names.filter(Boolean).map(item => item.trim());
};
const selector = { button: 'button,[role=button],[role=tab],[role=menuitem],a', option: '[role=option],[role=menuitemradio],option', combobox: '[role=combobox],select,button[aria-haspopup]', field: 'input,textarea,[contenteditable=true]' }[kind];
if (kind === 'text') return [...document.querySelectorAll('body *')].find(el => shown(el) && el.children.length === 0 && wanted.some(item => text(el).includes(item))) || null;
return [...document.querySelectorAll(selector)].find(el => shown(el) && (wanted.includes(text(el)) || labelled(el).some(item => wanted.includes(item)))) || null;
`;
