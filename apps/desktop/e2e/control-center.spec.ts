import { test, expect } from '@playwright/test';
import { expect as expectBase, type Locator } from '@playwright/test';
import { UI_BASE, stubHost, type HostStub } from './host-control';

// An error reads as one sentence that says what failed; the raw text is behind Details.
async function expectError(alert: Locator, sentence: string, raw: string) {
  await expectBase(alert).toContainText(sentence);
  await alert.getByRole('button', { name: 'Details', exact: true }).click();
  await expectBase(alert).toContainText(raw);
}
const state = {schemaVersion:1,profile:'core',account:{signedIn:false},credentials:[],customProviders:[],providers:[{id:'openai',name:'OpenAI'}],models:[]};
// The System rows for Git Bash and the terminal exist only on Windows, which the window reads from the user agent.
test.use({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' });
const control = (legacy: boolean) => (body: any) => {
  const result: any = { ...state };
  if (body?.action === 'profile') result.profile = body.profile;
  if (legacy) delete result.customProviders;
  return result;
};
// The runtime installation as the host reports it (AppView.installation). On
// Windows it carries the Git Bash and Windows Terminal reports the System rows show.
const environment = (git: string, root: string) => ({ path: root + '\\bin\\bash.exe', git, bash: 'GNU bash, version 5.2.37(1)-release' });
const systemGit = () => ({ bundled: null, managed: null, system: environment('git version 2.51.0.windows.1', 'C:\\Program Files\\Git'), bundled_present: false, managed_present: false, system_present: true, archive: true, effective: environment('git version 2.51.0.windows.1', 'C:\\Program Files\\Git') });
const systemTerminal = () => ({ bundled: null, system: { path: 'C:\\Program Files\\WindowsApps\\wt.exe', version: '1.25.2733.0' }, bundled_present: false, archive: false, version: '1.25.2733.0', effective: 'C:\\Program Files\\WindowsApps\\wt.exe' });
const installed = (tools: { git: unknown; terminal: unknown } = { git: systemGit(), terminal: systemTerminal() }) => ({ state: 'ready', version: '0.2.5', nodeVersion: 'v24.22.2', expectedVersion: '0.2.5', tools });
/** Per test: the installation the host starts with, and what `POST /v1/runtime/{action}` does. */
const runtimeFixtures: Record<string, { installation: Record<string, unknown>; runtime?: (action: string, host: HostStub) => void }> = {};
const asked: string[] = [];
test.beforeEach(async ({page}, testInfo) => {
  asked.length = 0;
  const fixture = runtimeFixtures[testInfo.title] ?? { installation: installed() };
  await stubHost(page, {
    control: control(testInfo.title.includes('rejects old protocol')),
    installation: fixture.installation,
    runtime: (action, host) => { asked.push(action); fixture.runtime?.(action, host); },
  });
});
for (const legacy of [false,true]) {
 test(`control center ${legacy ? 'rejects old protocol without crashing' : 'opens all tabs'}`, async ({page}) => {
  const errors: string[]=[]; page.on('pageerror', error=>errors.push(error.message));
  await page.addInitScript(({state,legacy}) => {
   (window as any).isTauri = true;
   (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
   localStorage.setItem('jouzu.ui.language','en');
   (window as any).__TAURI_INTERNALS__ = {
    metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},
    transformCallback:()=>1, unregisterCallback:()=>{},
    invoke:async (command:string, args?:any) => {
     if(command==='shell_state') return {ready:true,bash:true,recent:[],platform:'windows'};
     if(command==='component_versions') return {jouzu:'0.1.18',development:true};
     if(command==='control_request') {if(args?.request?.action==='profile')state.profile=args.request.profile;const result={...state};if(legacy)delete (result as any).customProviders;return result;}
     if(command==='environment_read') return [];
     if(command.includes('version'))return '0.1.0';
     return 1;
    }
   };
  },{state,legacy});
  await page.goto(UI_BASE);
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();
  if(legacy) await expectError(dialog.getByRole('alert'), 'Something went wrong', 'incompatible');
  else { await dialog.getByRole('button',{name:'Add provider',exact:true}).click(); await expect(dialog.getByRole('combobox',{name:'Service',exact:true})).toBeVisible(); await expect(dialog.getByRole('button',{name:'Add provider',exact:true})).toHaveCount(0); await expect(dialog.getByRole('combobox')).toHaveCount(1); await dialog.getByRole('combobox',{name:'Service',exact:true}).click(); await page.getByRole('option',{name:'Custom provider',exact:true}).click(); await expect(dialog.getByRole('textbox',{name:'API base URL'})).toBeVisible(); }
  await dialog.getByRole('tab',{name:'Environment',exact:true}).click();
  await expect(dialog.getByRole('button',{name:'Add variable',exact:true})).toBeVisible();
  await dialog.getByRole('button',{name:'Add variable',exact:true}).click();
  await dialog.getByRole('textbox',{name:'Name',exact:true}).fill('TEST_TOKEN');
  await dialog.getByLabel('Value',{exact:true}).fill('fixture-secret');
  await dialog.getByRole('button',{name:'Save',exact:true}).click();
  await expect(dialog.getByLabel('Value',{exact:true})).toHaveCount(0);
  await expect(dialog.getByText('TEST_TOKEN',{exact:true})).toBeVisible();
  await dialog.getByRole('button',{name:'Edit',exact:true}).click();
  await expect(dialog.getByLabel('Value',{exact:true})).toHaveValue('fixture-secret');
  await dialog.getByRole('tab',{name:'Language',exact:true}).click();
  await expect(dialog.getByRole('combobox',{name:'Interface language'})).toBeVisible();
  await expect(dialog.getByRole('combobox')).toHaveCount(3);
  const toggle=dialog.getByRole('switch',{name:'Japanese-first mode',exact:true});
  if(!legacy) {
   await expect(toggle).not.toBeChecked();
   await toggle.click(); await expect(toggle).toBeChecked();
   await toggle.click(); await expect(toggle).not.toBeChecked();
  } else await expect(toggle).toBeDisabled();
  await expect(dialog.getByText(/Changing the interface language does not turn this off/)).toBeVisible();
  expect(errors).toEqual([]);
 });
}

const updateStub = (config: {
  desktopVersion: string; desktopTarget?: string; desktopAvailable: boolean;
  configured: boolean; desktopCheckFails?: boolean; desktopDowngrade?: boolean;
}) => {
  const callbacks: Record<number, Function> = {};
  const listeners: Record<string, number[]> = {};
  let next = 1;
  localStorage.setItem('jouzu.ui.language', 'en');
  (window as any).isTauri = true;
  (window as any).__logs = [];
  (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  (window as any).__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    unregisterCallback: () => {},
    transformCallback: (fn: Function) => { callbacks[next] = fn; return next++; },
    invoke: async (command: string, args: any) => {
      if (command === 'plugin:event|listen') { (listeners[args.event] ??= []).push(args.handler); return next++; }
      if (command === 'plugin:event|unlisten' || command === 'plugin:event|emit') return null;
      if (command === 'component_versions') return { development: true, desktopUpdaterConfigured: config.configured };
      if (command === 'environment_read') return [];
      if (command === 'plugin:dialog|confirm' || command === 'plugin:dialog|message') return true;
      if (command === 'log_event') { (window as any).__logs.push(args.message); return null; }
      // The app's own update commands (src-tauri update_channel.rs), which pick the feed by channel.
      if (command === 'update_channel' || command === 'update_channel_set') return args?.channel ?? 'stable';
      if (command === 'update_check') {
        if (config.desktopCheckFails) throw new Error('network');
        return config.desktopAvailable
        ? { version: config.desktopTarget, notes: 'Desktop only', channel: 'stable', downgrade: !!config.desktopDowngrade }
        : null;
      }
      if (command === 'update_install') return new Promise(() => {});
      if (command.includes('version')) return config.desktopVersion;
      return 1;
    },
  };
};

async function openSystem(page: any) {
  await page.goto(UI_BASE);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'System', exact: true }).click();
  return dialog;
}

/** A Windows window with nothing else to stub than the installation the host reports. */
const windowsWindow = () => {
  (window as any).isTauri = true;
  (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  localStorage.setItem('jouzu.ui.language', 'en');
  (window as any).__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    transformCallback: () => 1, unregisterCallback: () => {},
    invoke: async (command: string) => {
      (window as any).__invoked = ((window as any).__invoked ?? []).concat(command);
      if (command === 'plugin:dialog|message') return 'Ok';
      if (command === 'component_versions') return { development: true };
      if (command === 'environment_read') return [];
      if (command.includes('version')) return '0.1.0';
      return 1;
    },
  };
};

test('the System section shows both update rows with their state', async ({ page }) => {
  await page.addInitScript(updateStub, { desktopVersion: '0.1.20', desktopAvailable: false, configured: true });
  const dialog = await openSystem(page);
  // The Jouzu row shows the version the host installed.
  const jouzu = dialog.locator('section[aria-label="Jouzu"]');
  await expect(jouzu.getByText('0.2.5')).toBeVisible();
  const desktop = dialog.locator('section[aria-label="Jouzu Desktop"]');
  await expect(desktop.getByText('0.1.20')).toBeVisible();
  await expect(desktop.getByRole('button')).toHaveCount(0);
  // The check's outcome reaches the log, because the interface is where that check runs.
  expect(await page.evaluate(() => (window as any).__logs)).toContain('desktop update check result=current');
});

test('an older Stable build is offered as a downgrade, not an update (#176)', async ({ page }) => {
  await page.addInitScript(updateStub, {
    desktopVersion: '1.1.4-rc.1', desktopTarget: '1.0.23', desktopAvailable: true, desktopDowngrade: true, configured: true,
  });
  const dialog = await openSystem(page);
  const desktop = dialog.locator('section[aria-label="Jouzu Desktop"]');
  await expect(desktop.getByText('Back to Stable (older than this build) 1.0.23')).toBeVisible();
  await expect(desktop.getByRole('button', { name: 'Install Stable', exact: true })).toBeVisible();
  await expect(desktop.getByText('Update available')).toHaveCount(0);
  await expect(desktop.getByText("What's new")).toHaveCount(0);
  // The confirmation says what will happen: an older build, then a restart.
  await desktop.getByRole('button', { name: 'Install Stable', exact: true }).click();
  const confirm = page.getByRole('dialog');
  await expect(confirm.getByRole('heading', { name: 'Install Stable', exact: true })).toBeVisible();
  await expect(confirm.getByText('This installs a version older than the one you are running. Jouzu Desktop restarts after installing.')).toBeVisible();
});

test('a failed update check is reported and recorded', async ({ page }) => {
  await page.addInitScript(updateStub, { desktopVersion: '0.1.20', desktopAvailable: false, configured: true, desktopCheckFails: true });
  const dialog = await openSystem(page);
  const desktop = dialog.locator('section[aria-label="Jouzu Desktop"]');
  await expectError(desktop.getByRole('alert'), 'Could not check for updates', 'network');
  const logs: string[] = await page.evaluate(() => (window as any).__logs);
  expect(logs.some(line => line.startsWith('desktop update check failed error='))).toBe(true);
});

test('the Jouzu Desktop update confirms once before it restarts', async ({ page }) => {
  await page.addInitScript(updateStub, { desktopVersion: '0.1.20', desktopTarget: '0.1.21', desktopAvailable: true, configured: true });
  const dialog = await openSystem(page);
  const desktop = dialog.locator('section[aria-label="Jouzu Desktop"]');
  await desktop.getByRole('button', { name: 'Update and restart', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Update and restart' })).toBeVisible();
});

runtimeFixtures['the System section names the copy in use and offers installing the ones Jouzu ships'] = {
  installation: installed(),
  runtime: (action, host) => {
    host.installation({ ...installed(), operation: { action, step: 'tools', tool: 'git' } });
    // The host installs both tools in one operation, then reports them again.
    setTimeout(() => {
      const git = systemGit() as any;
      git.bundled = environment('git version 2.55.0.windows.5', 'C:\\Users\\test\\AppData\\Local\\Shisa.ai\\JouzuDesktop\\runtime\\git\\installed');
      git.effective = git.bundled;
      const terminal = systemTerminal() as any;
      terminal.bundled = { path: 'C:\\Users\\test\\AppData\\Local\\Shisa.ai\\JouzuDesktop\\runtime\\terminal\\installed\\WindowsTerminal.exe', version: '1.25.2733.0' };
      terminal.effective = terminal.bundled.path;
      host.installation(installed({ git, terminal }));
    }, 1500);
  },
};
test('the System section names the copy in use and offers installing the ones Jouzu ships', async ({page})=>{
 await page.addInitScript(windowsWindow);
 const dialog=await openSystem(page);
 // Nothing here switches copies: the row names the one in use and offers installing the shipped one.
 await expect(dialog.getByRole('radio')).toHaveCount(0);
 const bash=dialog.locator('section[aria-label="Git Bash"]');
 await expect(bash.getByText(/Git Bash installed on this PC/)).toBeVisible();
 const installBash=bash.getByRole('button',{name:/Install and use Jouzu's Git Bash/});
 await expect(installBash).toBeEnabled();
 await installBash.click();
 // One operation of the host's: both rows wait for it.
 await expect(installBash).toBeDisabled();
 const terminalRow=dialog.locator('section[aria-label="Windows Terminal"]');
 await expect(terminalRow.getByRole('button',{name:/Install and use Jouzu's Windows Terminal/})).toBeDisabled();
 // Installed: the rows name Jouzu's copies, and there is nothing left to install.
 await expect(bash.getByText(/Jouzu's Git Bash · 2\.55\.0/)).toBeVisible({ timeout: 10_000 });
 await expect(terminalRow.getByText(/Jouzu's Windows Terminal · 1\.25/)).toBeVisible();
 await expect(bash.locator('svg.animate-spin')).toHaveCount(0);
 await expect(bash.getByRole('button')).toBeDisabled();
 expect(asked).toEqual(['install']);
 // The shell has no say in it.
 const invoked: string[] = await page.evaluate(() => (window as any).__invoked ?? []);
 for (const command of ['git_bash', 'git_bash_install', 'terminal', 'terminal_install']) expect(invoked).not.toContain(command);
});

runtimeFixtures['a component row keeps its height while an action runs'] = {
  installation: installed({ git: systemGit(), terminal: { bundled: null, system: null, bundled_present: false, effective: null, archive: true, version: '1.25.2733.0' } }),
  runtime: (action, host) => host.installation({ ...installed({ git: systemGit(), terminal: { bundled: null, system: null, bundled_present: false, effective: null, archive: true, version: '1.25.2733.0' } }), operation: { action, step: 'tools', tool: 'terminal' } }),
};
test('a component row keeps its height while an action runs', async ({page})=>{
 await page.addInitScript(windowsWindow);
 const dialog=await openSystem(page);
 const row=dialog.locator('section[aria-label="Windows Terminal"]');
 const before=(await row.boundingBox())!.height;
 await row.getByRole('button',{name:/Install and use Jouzu's Windows Terminal/}).click();
 await expect(row.locator('svg.animate-spin')).toBeVisible();
 await page.waitForTimeout(600);
 const during=(await row.boundingBox())!.height;
 expect(during).toBe(before);
});

// Both components have a directory on disk and nothing in it that answers a launch.
runtimeFixtures['a component copy that is here but does not run is repaired, not installed'] = {
  installation: installed({
    git: { bundled: null, managed: null, system: null, bundled_present: true, managed_present: false, system_present: false, archive: true, effective: null },
    terminal: { bundled: null, system: null, bundled_present: true, archive: false, version: '1.25.2733.0', effective: null },
  }),
};
test('a component copy that is here but does not run is repaired, not installed', async ({page})=>{
 await page.addInitScript(windowsWindow);
 const dialog=await openSystem(page);
 const bash=dialog.locator('section[aria-label="Git Bash"]');
 await expect(bash.getByRole('button')).toHaveCount(1);
 await expect(bash.getByRole('button')).toBeEnabled();
 await expect(bash.getByRole('button')).toHaveText(/Repair/);
 const terminalRow=dialog.locator('section[aria-label="Windows Terminal"]');
 await expect(terminalRow.getByRole('button')).toHaveCount(1);
 await expect(terminalRow.getByRole('button')).toBeEnabled();
});

test('the terminal command row names what answers and takes precedence only when asked', async ({page})=>{
 await page.addInitScript(()=>{
  (window as any).isTauri=true;
  (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
  localStorage.setItem('jouzu.ui.language','en');
  const shadowed:any={directory:'C:/managed/bin',shims:true,onPath:true,position:'later',first:false,shadowed:true,commands:[{name:'jz',path:'C:/Users/test/AppData/Roaming/npm/jz.cmd'},{name:'jouzu',path:null}]};
  const answered:any={directory:'C:/managed/bin',shims:true,onPath:true,position:'first',first:true,shadowed:false,commands:[{name:'jz',path:'C:/managed/bin/jz.cmd'},{name:'jouzu',path:'C:/managed/bin/jouzu.cmd'}]};
  let entry:any={...shadowed};
  (window as any).__TAURI_INTERNALS__={
   metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},
   transformCallback:()=>1,unregisterCallback:()=>{},
   invoke:async(command:string)=>{(window as any).__invoked=((window as any).__invoked??[]).concat(command);if(command==='plugin:dialog|message')return 'Ok';
    if(command==='shell_state')return {ready:true,bash:false,recent:[],platform:'windows'};
    if(command==='component_versions')return {jouzu:'0.1.18',development:true};
    if(command==='environment_read')return [];
    if(command==='command_entry_report')return {...entry};
    if(command==='command_entry_use'){entry={...answered};return {...entry};}
    if(command==='command_entry_restore'){entry={...shadowed,commands:[{name:'jz',path:'C:/managed/bin/jz.cmd'},{name:'jouzu',path:'C:/Users/test/AppData/Roaming/npm/jouzu.cmd'}]};return {...entry};}
    if(command.includes('version'))return '0.1.0';
    return 1;
   }
  };
 });
 await page.goto(UI_BASE);
 await page.getByRole('button',{name:'Settings',exact:true}).click();
 const dialog=page.getByRole('dialog');
 await dialog.getByRole('tab',{name:'System',exact:true}).click();
 const row=dialog.locator('section[aria-label="Terminal command"]');
 // The command another installation answers with is named before anything is changed.
 await expect(row.getByRole('button')).toBeVisible();
 await row.getByRole('button').click();
 await expect.poll(async ()=> page.evaluate(()=>(window as any).__invoked)).toContain('command_entry_use');
 // Putting the previous one back is offered as its own action.
 await row.getByRole('button').click();
 await expect(row.getByRole('button')).toBeVisible();
});
