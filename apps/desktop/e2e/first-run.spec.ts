import { test, expect } from '@playwright/test';
import { UI_BASE, stubHost } from './host-control';

// First run on a machine with no runtime yet (every macOS and Linux install, which
// download Node and Jouzu on first launch). The runtime report is local and answers at
// once; the host's folder list arrives later. Only the runtime report may decide whether
// the runtime is there: the window must prepare it first and open the workspace after,
// never the workspace with "runtime files are missing".
test('first run prepares the runtime before the workspace, whatever answers first', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('jouzu.ui.language', 'en');
    const w = window as any;
    w.isTauri = true;
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    w.__firstRun = { installed: false, installs: 0 };
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (command: string) => {
        const state = w.__firstRun;
        if (command === 'runtime_report') {
          if (!state.installed) throw 'Jouzu application files are missing. Please repair the installation.';
          return { version: '0.2.5', mandatory: false, node: true, nodeCurrent: true, git: true, root: '/x', app: '/x/app', nodeVersion: '24.0.0', terminal: false };
        }
        if (command === 'runtime_install') {
          state.installs += 1;
          await new Promise(resolve => setTimeout(resolve, 1500));
          state.installed = true;
          return '0.2.5';
        }
        if (command === 'component_versions') return { jouzu: '0.2.5', development: true };
        if (command.includes('version')) return '0.1.0';
        return 1;
      },
    };
  });
  await stubHost(page, {
    workspaces: [{ id: 'w1', path: '/home/user/project', environment: { kind: 'linux' } }],
    control: () => ({ schemaVersion: 1, modelReady: true, profile: 'core', account: { signedIn: true }, credentials: [], customProviders: [], providers: [], models: [] }),
  });
  // The host answers the folder list after the local runtime report.
  await page.route('**/v1/workspaces', async route => {
    await new Promise(resolve => setTimeout(resolve, 400));
    await route.fallback();
  });
  let sessionsBeforeInstall = 0;
  page.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/v1/sessions') && request.method() === 'POST') {
      void page.evaluate(() => (window as any).__firstRun.installed).then(installed => { if (!installed) sessionsBeforeInstall += 1; }).catch(() => {});
    }
  });

  await page.goto(UI_BASE);
  await expect(page.getByRole('heading', { name: 'Preparing Jouzu…' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New session', exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/runtime files are missing/i)).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__firstRun.installs)).toBe(1);
  expect(sessionsBeforeInstall).toBe(0);
});
