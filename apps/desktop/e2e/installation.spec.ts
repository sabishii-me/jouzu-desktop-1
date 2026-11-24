import { test, expect, type Page } from '@playwright/test';
import { UI_BASE, stubHost, type HostStub } from './host-control';

// The runtime installation is the host's (ADR 0026): the window renders
// `AppView.installation` and nothing else about it. These run the same in the
// desktop window and in a browser, which has no shell to ask.

const settings = () => ({ schemaVersion: 1, modelReady: true, profile: 'core', account: { signedIn: true }, credentials: [], customProviders: [], providers: [], models: [] });
const workspaces = [{ id: 'w1', path: '/home/user/project', environment: { kind: 'linux' } }];

async function desktopWindow(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    w.isTauri = true;
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    w.__shellCalls = [] as string[];
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (command: string) => {
        w.__shellCalls.push(command);
        if (command === 'component_versions') return { development: true };
        if (command.includes('version')) return '0.1.0';
        return 1;
      },
    };
  });
}

/** POST /v1/sessions while the installation is not ready: the window must not ask. */
function countEarlySessions(page: Page, ready: () => boolean) {
  const early = { count: 0 };
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/v1/sessions' && request.method() === 'POST' && !ready()) early.count += 1;
  });
  return early;
}

for (const client of ['desktop', 'browser'] as const) {
  test(`a first run shows the host's installation and opens the workspace when it is ready (${client})`, async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('jouzu.ui.language', 'en'));
    if (client === 'desktop') await desktopWindow(page);
    let host!: HostStub;
    let ready = false;
    await stubHost(page, {
      workspaces,
      control: (_body, stub) => { host = stub; return settings(); },
      installation: { state: 'installing', action: 'install', step: 'node', downloaded: 10 * 1048576, total: 50 * 1048576, tools: null },
    });
    const early = countEarlySessions(page, () => ready);
    await page.goto(UI_BASE);
    await expect(page.getByRole('heading', { name: 'Preparing Jouzu…' })).toBeVisible();
    await expect(page.getByText('Downloading Node…')).toBeVisible();
    await expect(page.getByText('10 / 50 MB')).toBeVisible();

    await expect.poll(() => host).toBeTruthy();
    host.installation({ state: 'installing', action: 'install', step: 'packages', tools: null });
    await expect(page.getByText('Installing packages…')).toBeVisible();

    ready = true;
    host.installation({ state: 'ready', version: '0.2.5', nodeVersion: 'v24.22.2', expectedVersion: '0.2.5', tools: null });
    await expect(page.getByRole('button', { name: 'New session', exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Preparing Jouzu…' })).toHaveCount(0);
    expect(early.count).toBe(0);
    if (client === 'desktop') {
      // Whether the runtime is there is not the shell's to say.
      const calls: string[] = await page.evaluate(() => (window as any).__shellCalls);
      for (const command of ['runtime_report', 'runtime_install', 'image_tool_ensure', 'jouzu_update']) expect(calls).not.toContain(command);
    }
  });
}

test('a failed installation shows its reason, and Retry asks the host to install again', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('jouzu.ui.language', 'en'));
  await desktopWindow(page);
  const asked: string[] = [];
  await stubHost(page, {
    workspaces,
    control: settings,
    installation: { state: 'failed', action: 'install', error: { code: 'runtime-install-failed', params: { message: 'Could not download https://nodejs.org/dist/v24.22.2/SHASUMS256.txt: offline' } }, tools: null },
    runtime: (action, host) => {
      asked.push(action);
      host.installation({ state: 'installing', action, step: 'packages', tools: null });
      setTimeout(() => host.installation({ state: 'ready', version: '0.2.5', tools: null }), 500);
    },
  });
  await page.goto(UI_BASE);
  await expect(page.getByText('Installation failed')).toBeVisible();
  await expect(page.getByText(/SHASUMS256\.txt: offline/)).toBeVisible();
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('button', { name: 'New session', exact: true })).toBeVisible({ timeout: 15_000 });
  expect(asked).toEqual(['install']);
  await expect(page.getByText(/runtime files are missing/i)).toHaveCount(0);
});

test('an installation that goes away while the window is open shows the prepare page again', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('jouzu.ui.language', 'en'));
  await desktopWindow(page);
  let host!: HostStub;
  await stubHost(page, {
    workspaces,
    control: (_body, stub) => { host = stub; return settings(); },
    installation: { state: 'ready', version: '0.2.5', tools: null },
  });
  await page.goto(UI_BASE);
  await expect(page.getByRole('button', { name: 'New session', exact: true })).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => host).toBeTruthy();
  host.installation({ state: 'installing', action: 'install', step: 'packages', tools: null });
  await expect(page.getByText('Installing packages…')).toBeVisible();
  host.installation({ state: 'ready', version: '0.2.5', tools: null });
  await expect(page.getByRole('button', { name: 'New session', exact: true })).toBeVisible({ timeout: 15_000 });
});
