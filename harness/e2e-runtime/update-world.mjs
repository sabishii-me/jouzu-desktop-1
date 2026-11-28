import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The installed-app world for updates (Windows): the app installed by its own installer at its
// real place, %LOCALAPPDATA%\Shisa.ai\JouzuDesktop, which is both its install folder and its data
// folder, and updated in place by the app itself through its update feed. An update can only be
// tested there: the installer the app downloads installs where the registry says the app is.
//
// The test machine's own Jouzu Desktop is put aside first and put back afterwards: its folder,
// the WebView folders named by the bundle id, its registry entries (uninstall entry, install
// location, installer language) and its shortcuts. If a run is cut off, the next run refuses to
// start until the aside copy is back (restoreAside), so nothing of the machine is lost.
//
//   ABN_UPDATE_FROM_RELEASE  the last release's installer (setup .exe), for UPD-001 and UPD-005
//   ABN_UPDATE_FROM_RC       the previous release candidate's installer, for UPD-002
//   ABN_UPDATE_TO            the version under test the feed must offer (for example 1.1.5-rc.4)

const BUNDLE = 'ai.shisa.jouzu.desktop';
const PRODUCT = 'Jouzu Desktop';
const KEYS = [
  `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PRODUCT}`,
  'HKCU\\Software\\Shisa, Inc.',
  'HKCU\\Software\\Shisa.ai\\JouzuDesktop',
];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const local = () => process.env.LOCALAPPDATA;
const roaming = () => process.env.APPDATA;
export const managedFolder = () => join(local(), 'Shisa.ai', 'JouzuDesktop');
const shortcutFolders = () => [join(roaming(), 'Microsoft', 'Windows', 'Start Menu', 'Programs'), join(process.env.USERPROFILE, 'Desktop')];
const ps = script => execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** The places this world takes over; each is moved to <place>.qa-aside while it runs. */
function places() {
  return [managedFolder(), join(local(), BUNDLE), join(roaming(), BUNDLE)];
}

/** Processes started from the app's folder (the app, its host, its runtimes' Node). */
export function appProcesses() {
  const folder = managedFolder().toLowerCase().replace(/'/g, "''");
  const text = ps(`Get-CimInstance Win32_Process | Where-Object { ($_.ExecutablePath -and $_.ExecutablePath.ToLower().StartsWith('${folder}')) -or ($_.CommandLine -and $_.CommandLine.ToLower().Contains('${folder}')) } | ForEach-Object { "$($_.ProcessId)|$($_.Name)" }`);
  return text.trim().split(/\r?\n/).filter(Boolean).map(line => { const [pid, name] = line.trim().split('|'); return { pid: Number(pid), name }; });
}
function endAppProcesses() {
  const pids = appProcesses().map(row => row.pid);
  if (pids.length) try { execFileSync('taskkill.exe', [...pids.flatMap(pid => ['/PID', String(pid)]), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
}

/** Put the machine's own Jouzu Desktop aside. Refuses while it runs, or when an earlier aside copy is still there. */
export function putAside(saveDir) {
  for (const place of places()) if (existsSync(`${place}.qa-aside`)) throw new Error(`${place}.qa-aside exists: an earlier update test was cut off. Put it back (rename it to ${place}) before running again.`);
  if (appProcesses().length) throw new Error('Jouzu Desktop is running on this computer. Close it to run the update test (the test never closes it).');
  mkdirSync(saveDir, { recursive: true });
  const saved = { places: [], keys: [], shortcuts: [] };
  for (const place of places()) if (existsSync(place)) { renameSync(place, `${place}.qa-aside`); saved.places.push(place); }
  KEYS.forEach((key, index) => {
    const file = join(saveDir, `key-${index}.reg`);
    try { execFileSync('reg.exe', ['export', key, file, '/y'], { stdio: 'ignore' }); saved.keys.push({ key, file }); } catch { saved.keys.push({ key, file: null }); }
  });
  for (const folder of shortcutFolders()) {
    if (!existsSync(folder)) continue;
    for (const name of readdirSync(folder).filter(item => /^Jouzu/i.test(item))) {
      const copy = join(saveDir, `shortcut-${saved.shortcuts.length}-${name}`);
      cpSync(join(folder, name), copy, { recursive: true });
      saved.shortcuts.push({ path: join(folder, name), copy });
    }
  }
  writeFileSync(join(saveDir, 'aside.json'), JSON.stringify(saved, null, 2));
  return saved;
}

/** Remove what the test installed and put the machine's own Jouzu Desktop back exactly as it was. */
export function restoreAside(saveDir) {
  const file = join(saveDir, 'aside.json');
  if (!existsSync(file)) return { restored: false };
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  endAppProcesses();
  for (const place of places()) {
    if (existsSync(place)) {
      // A folder still in use is renamed away first so the machine's own copy can go back.
      try { rmSync(place, { recursive: true, force: true }); } catch { renameSync(place, `${place}.qa-test-${Date.now()}`); }
    }
  }
  for (const place of saved.places) if (existsSync(`${place}.qa-aside`)) renameSync(`${place}.qa-aside`, place);
  for (const { key, file: keyFile } of saved.keys) {
    try { execFileSync('reg.exe', ['delete', key, '/f'], { stdio: 'ignore' }); } catch { /* the test made none */ }
    if (keyFile) execFileSync('reg.exe', ['import', keyFile], { stdio: 'ignore' });
  }
  for (const folder of shortcutFolders()) {
    if (!existsSync(folder)) continue;
    for (const name of readdirSync(folder).filter(item => /^Jouzu/i.test(item))) rmSync(join(folder, name), { recursive: true, force: true });
  }
  for (const { path, copy } of saved.shortcuts) cpSync(copy, path, { recursive: true });
  rmSync(file);
  return { restored: true, places: saved.places.length };
}

/** Run an installer or uninstaller silently and wait for it. */
export async function runSilently(program, args = ['/S'], timeout = 10 * 60_000) {
  const child = spawn(program, args, { stdio: 'ignore', windowsHide: true });
  const code = await new Promise((resolveCode, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${program} did not finish within ${timeout / 60_000} min`)); }, timeout);
    child.on('exit', value => { clearTimeout(timer); resolveCode(value); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
  });
  return code;
}

/** What the registry says is installed. */
export function installedVersion() {
  try {
    const text = execFileSync('reg.exe', ['query', KEYS[0], '/v', 'DisplayVersion'], { encoding: 'utf8' });
    return text.match(/DisplayVersion\s+REG_SZ\s+(\S+)/)?.[1] ?? null;
  } catch { return null; }
}

export const appExe = () => join(managedFolder(), `${PRODUCT}.exe`);

/** Start the installed app as a person does, its window open to the test over CDP on port. */
export function startInstalled(env, port, cwd) {
  const child = spawn(appExe(), [], { env: { ...env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }, cwd, stdio: 'ignore', detached: true });
  child.unref();
  return child.pid;
}
