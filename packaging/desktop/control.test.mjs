import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const runtime = process.env.JOUZU_E2E_RUNTIME ?? join(process.env.LOCALAPPDATA ?? '', 'Shisa.ai', 'JouzuDesktop');
const control = fileURLToPath(new URL('./control.mjs', import.meta.url));
const node = runtime && join(runtime, 'runtime', 'node', process.platform === 'win32' ? 'node.exe' : 'node');
const app = runtime && join(runtime, 'app');

function run(home, request) {
  const result = spawnSync(node, [control, runtime, app], {
    input: `${JSON.stringify(request)}\n`, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, JOUZU_HOME: home, JOUZU_NO_UPDATE: '1', PI_SKIP_VERSION_CHECK: '1' },
  });
  assert.equal(result.status, 1, result.stderr);
  return JSON.parse(result.stdout);
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'jouzu-control-'));
  mkdirSync(join(home, 'agent'), { recursive: true });
  return home;
}

const available = runtime && existsSync(node) && existsSync(join(app, 'node_modules/jouzu/dist'));
test('real control adapter reports the local cause alone for an unwritable settings file', { skip: !available && 'JOUZU_E2E_RUNTIME is required' }, (t) => {
  const home = fixture();
  try {
    const status = spawnSync(node, [control, runtime, app], {
      input: '{"action":"status"}\n', encoding: 'utf8', windowsHide: true,
      env: { ...process.env, JOUZU_HOME: home, JOUZU_NO_UPDATE: '1', PI_SKIP_VERSION_CHECK: '1' },
    });
    const state = JSON.parse(status.stdout);
    const file = join(home, 'agent', 'settings.json');
    writeFileSync(file, JSON.stringify({ defaultProvider: state.defaultProvider, defaultModel: state.defaultModel }));
    chmodSync(file, 0o444);
    const result = run(home, { action: 'default-model', provider: state.defaultProvider, model: state.defaultModel });
    if (!result.error || !/\b(EPERM|EACCES|EROFS)\b/.test(result.error)) {
      t.skip(`the platform did not enforce the unwritable fixture: ${JSON.stringify(result)}`);
      return;
    }
    assert.match(result.error, /settings\.json.*\b(EPERM|EACCES|EROFS)\b.*\(open\)/);
    assert.doesNotMatch(result.error, /Refresh the model list and retry\./);
    assert.equal(result.error.split('\n')[0].includes('Could not save the default model'), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('real control adapter keeps the generic catalog fallback when there is no local cause', { skip: !available && 'JOUZU_E2E_RUNTIME is required' }, () => {
  const home = fixture();
  try {
    const result = run(home, { action: 'catalog-accept', revision: 'missing', digest: 'missing' });
    assert.equal(result.error, 'The held catalog could not be applied. Refresh the model list and retry.');
    assert.doesNotMatch(result.error, /Invalid catalog revision/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// The catalog decision state is produced by the runtime, so this test uses the
// real adapter and skips when the supplied runtime has no held revision to decide.
for (const action of ['catalog-accept', 'catalog-reject']) {
  test(`real control adapter reports a catalog ${action} file cause without a guessed prefix`, { skip: !available && 'JOUZU_E2E_RUNTIME is required' }, (t) => {
    const home = fixture();
    try {
      const status = spawnSync(node, [control, runtime, app], {
        input: '{"action":"status"}\n', encoding: 'utf8', windowsHide: true,
        env: { ...process.env, JOUZU_HOME: home, JOUZU_NO_UPDATE: '1', PI_SKIP_VERSION_CHECK: '1' },
      });
      const state = JSON.parse(status.stdout);
      if (!state.catalog?.held) {
        t.skip('the runtime fixture has no held catalog revision');
        return;
      }
      chmodSync(join(home, 'agent'), 0o555);
      const result = run(home, { action, revision: state.catalog.held.revision, digest: state.catalog.held.digest, sourceId: state.catalog.held.sourceId });
      assert.match(result.error, /\b(EPERM|EACCES|EROFS)\b/);
      assert.doesNotMatch(result.error, /Refresh the model list and retry\./);
      assert.equal(result.error.split('\n')[0].includes('held catalog could not'), false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}
