import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// This is a checked-in, repository-owned fixture runtime. It intentionally implements
// only the modules loaded by control.mjs and its SettingsManager performs a real fs
// open/write, so the test does not depend on an installed Desktop runtime.
const runtime = fileURLToPath(new URL('./control-test-runtime/', import.meta.url));
const control = fileURLToPath(new URL('./control.mjs', import.meta.url));
const node = process.execPath;

function run(home, request) {
  const result = spawnSync(node, [control, runtime, runtime], {
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

test('real control adapter reports the sanitized local cause for a structural settings failure', () => {
  const home = fixture();
  try {
    mkdirSync(join(home, 'agent', 'settings.json'));
    const result = run(home, { action: 'default-model', provider: 'fixture-provider', model: 'fixture-model' });
    assert.match(result.error, /settings\.json.*\b(EISDIR|ENOTDIR|EPERM)\b.*\(open\)/);
    assert.doesNotMatch(result.error, /Could not save the default model|Refresh the model list and retry\./);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('real control adapter keeps the generic catalog fallback when there is no local cause', () => {
  const home = fixture();
  try {
    const result = run(home, { action: 'catalog-accept', revision: '', digest: '' });
    assert.equal(result.error, 'The held catalog could not be applied. Refresh the model list and retry.');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
