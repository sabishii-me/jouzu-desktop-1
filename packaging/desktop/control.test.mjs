import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// The host (control/adapter.rs) and the runtime installer (runtime_install.rs) embed
// control.mjs and run it with `node --input-type=module --eval <script> -- <root> <app>`.
// These tests run it exactly that way, so the program has no file location: anything
// it imports relative to itself fails here as it fails in the installed app.
const script = readFileSync(new URL('./control.mjs', import.meta.url), 'utf8');

function run(app, home, request) {
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script, '--', dirname(app), app], {
    input: `${JSON.stringify(request)}\n`, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, JOUZU_HOME: home, JOUZU_NO_UPDATE: '1', NODE_OPTIONS: '', NODE_PATH: '' },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/);
  return JSON.parse(result.stdout);
}

// A stand-in runtime with only the modules control.mjs loads before these actions
// fail. Its settings manager records a real write error instead of throwing, the
// way the runtime's does.
const runtimeModules = {
  'jouzu/dist/paths.js': `import { join } from 'node:path';
export const resolveJouzuPaths = ({ homeOverride }) => ({ home: homeOverride, agentDir: join(homeOverride, 'agent'), configDir: homeOverride, stateDir: join(homeOverride, 'state') });`,
  'jouzu/dist/profile-choice.js': `export const readProfileChoice = () => null; export const writeProfileChoice = () => {};`,
  '@earendil-works/pi-coding-agent/dist/core/auth-storage.js': `import { readFileSync } from 'node:fs';
export class AuthStorage {
  static create(file) { try { readFileSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } return new AuthStorage(); }
}`,
  '@earendil-works/pi-coding-agent/dist/core/model-runtime.js': `export class ModelRuntime {
  static async create() { return new ModelRuntime(); }
  getModel(provider, model) { return provider === 'fixture-provider' && model === 'fixture-model' ? { id: model } : undefined; }
  getProviders() { return []; }
}`,
  '@earendil-works/pi-coding-agent/dist/core/settings-manager.js': `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
export class SettingsManager {
  static create(configDir, agentDir) { return new SettingsManager(agentDir); }
  constructor(agentDir) { this.file = join(agentDir, 'settings.json'); this.errors = []; this.next = {}; }
  drainErrors() { const errors = this.errors; this.errors = []; return errors; }
  setDefaultModelAndProvider(provider, model) { this.next = { defaultProvider: provider, defaultModel: model }; }
  async flush() { try { writeFileSync(this.file, JSON.stringify(this.next)); } catch (error) { this.errors.push({ path: this.file, error }); } }
}`,
};

function fixture({ runtime = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'jouzu-control-'));
  const app = join(root, 'app');
  const home = join(root, 'home');
  mkdirSync(join(home, 'agent'), { recursive: true });
  mkdirSync(app, { recursive: true });
  if (runtime) {
    for (const [name, source] of Object.entries(runtimeModules)) {
      const file = join(app, 'node_modules', name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, source);
    }
  }
  return { root, app, home };
}

test('control program answers in JSON when run with --eval, even without a runtime', () => {
  const { root, app, home } = fixture({ runtime: false });
  try {
    assert.deepEqual(run(app, home, { action: 'status' }), { error: 'Could not read Jouzu configuration. No settings were changed.' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('control program reports only the local cause when the default model cannot be saved', () => {
  const { root, app, home } = fixture();
  try {
    mkdirSync(join(home, 'agent', 'settings.json'));
    const { error } = run(app, home, { action: 'default-model', provider: 'fixture-provider', model: 'fixture-model' });
    assert.match(error, /settings\.json: (EISDIR|EPERM|EACCES) \(open\)$/);
    assert.doesNotMatch(error, /Could not save the default model/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('control program keeps the generic catalog message when there is no local cause', () => {
  const { root, app, home } = fixture();
  try {
    assert.deepEqual(run(app, home, { action: 'catalog-accept', revision: '', digest: '' }), { error: 'The held catalog could not be applied. Refresh the model list and retry.' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('control program keeps the generic sentence before a local cause for other actions', () => {
  const { root, app, home } = fixture();
  try {
    mkdirSync(join(home, 'agent', 'auth.json'));
    const { error } = run(app, home, { action: 'status' });
    assert.match(error, /^Could not read Jouzu configuration\. No settings were changed\.\n(.*auth\.json: )?(EISDIR|EPERM|EACCES) \(read\)$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
