import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// The installed-app world for updates (Windows), isolated like every other world:
//   - the earlier version is installed by its own installer into a throwaway folder (/D=);
//   - the app's data, WebView profile and user folders are throwaway too (LOCALAPPDATA, APPDATA,
//     USERPROFILE point into the case's root; managed_paths.rs reads LOCALAPPDATA);
//   - the update the app downloads installs where the installer's registry entry says the app is,
//     which is that throwaway folder;
//   - afterwards the throwaway installation is uninstalled silently and its folder removed.
// The machine's own Jouzu Desktop is never moved, closed or changed.
//
// The installer's per-user registry entries have fixed names (the uninstall entry, the install
// location the update follows, the installer language). They are saved before the test installs
// and put back exactly afterwards, so an installation already on the machine keeps its entries.
// The test installs with /NS (no shortcuts), so no shortcut of the machine's own app is touched.
//
//   ABN_UPDATE_FROM_RELEASE  the last release's installer (setup .exe), for UPD-001 and UPD-005
//   ABN_UPDATE_FROM_RC       the previous release candidate's installer, for UPD-002 and UPD-003
//   ABN_UPDATE_TO            the version under test the feed must offer (for example 1.1.5-rc.4)

const PRODUCT = 'Jouzu Desktop';
const UNINSTALL_KEY = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PRODUCT}`;
const ps = script => execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** The throwaway places of one case. */
export function updatePaths(root) {
  return {
    install: join(root, 'install'),
    localappdata: join(root, 'localappdata'),
    appdata: join(root, 'appdata'),
    profile: join(root, 'profile'),
    managed: join(root, 'localappdata', 'Shisa.ai', 'JouzuDesktop'),
  };
}

const KEYS = [UNINSTALL_KEY, `HKCU\\Software\\Shisa, Inc.\\${PRODUCT}`, 'HKCU\\Software\\Shisa.ai\\JouzuDesktop\\Preferences'];

/** Save the installer's fixed registry entries as they are now (an entry that does not exist is saved as absent). */
export function saveKeys(dir) {
  mkdirSync(dir, { recursive: true });
  return KEYS.map((key, index) => {
    const file = join(dir, `key-${index}.reg`);
    try { execFileSync('reg.exe', ['export', key, file, '/y'], { stdio: 'ignore' }); return { key, file }; } catch { return { key, file: null }; }
  });
}
/** Put those entries back exactly as saved. */
export function restoreKeys(saved) {
  for (const { key, file } of saved ?? []) {
    try { execFileSync('reg.exe', ['delete', key, '/f'], { stdio: 'ignore' }); } catch { /* none now */ }
    if (file && existsSync(file)) execFileSync('reg.exe', ['import', file], { stdio: 'ignore' });
  }
}

/** Processes started from the throwaway installation (the app, its host, its runtimes' Node). */
export function appProcesses(install) {
  const folder = install.toLowerCase().replace(/'/g, "''");
  const text = ps(`Get-CimInstance Win32_Process | Where-Object { ($_.ExecutablePath -and $_.ExecutablePath.ToLower().StartsWith('${folder}')) -or ($_.CommandLine -and $_.CommandLine.ToLower().Contains('${folder}')) } | ForEach-Object { "$($_.ProcessId)|$($_.Name)" }`);
  return text.trim().split(/\r?\n/).filter(Boolean).map(line => { const [pid, name] = line.trim().split('|'); return { pid: Number(pid), name }; });
}
export function endAppProcesses(install) {
  const pids = appProcesses(install).map(row => row.pid);
  if (pids.length) try { execFileSync('taskkill.exe', [...pids.flatMap(pid => ['/PID', String(pid)]), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
  return pids.length;
}

/** Run an installer or uninstaller silently and wait for it. */
export async function runSilently(program, args = ['/S'], timeout = 10 * 60_000, env = process.env) {
  const child = spawn(program, args, { stdio: 'ignore', windowsHide: true, env });
  return new Promise((resolveCode, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${program} did not finish within ${timeout / 60_000} min`)); }, timeout);
    child.on('exit', value => { clearTimeout(timer); resolveCode(value); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
  });
}

/** What the registry says is installed for this user. */
export function installedVersion() {
  try {
    const text = execFileSync('reg.exe', ['query', UNINSTALL_KEY, '/v', 'DisplayVersion'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return text.match(/DisplayVersion\s+REG_SZ\s+(\S+)/)?.[1] ?? null;
  } catch { return null; }
}

/** Install the earlier version into the throwaway folder. NSIS takes /D= last and unquoted. */
export async function installInto(installer, paths, env) {
  mkdirSync(paths.install, { recursive: true });
  const code = await runSilently(installer, ['/S', '/NS', `/D=${paths.install}`], 10 * 60_000, env);
  const exe = join(paths.install, `${PRODUCT}.exe`);
  if (!existsSync(exe)) throw new Error(`the installer ended (${code}) without installing ${exe}`);
  return exe;
}

/** Remove the throwaway installation: its silent uninstaller removes its registry entries and shortcuts. */
export async function uninstallFrom(paths, env) {
  endAppProcesses(paths.install);
  const uninstaller = join(paths.install, 'uninstall.exe');
  if (existsSync(uninstaller)) await runSilently(uninstaller, ['/S'], 5 * 60_000, env);
  // The NSIS uninstaller runs from a temporary copy and returns at once: wait for the app to go.
  const exe = join(paths.install, `${PRODUCT}.exe`);
  const until = Date.now() + 120_000;
  while (existsSync(exe) && Date.now() < until) await new Promise(r => setTimeout(r, 1_000));
  return { removed: !existsSync(exe) };
}

/** Start the installed app as a person does, its window open to the test over CDP on port. */
export function startInstalled(paths, env, port, cwd) {
  const child = spawn(join(paths.install, `${PRODUCT}.exe`), [], { env: { ...env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }, cwd, stdio: 'ignore', detached: true });
  child.unref();
  return child.pid;
}
