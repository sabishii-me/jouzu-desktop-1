import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression check for #84: the model catalog follows settings changes.
// Against a running host on a throwaway home (JOUZU_E2E_HOST_HOME: the host's --home,
// with at least one usable model): read the catalog, add a provider through Settings
// and save its key: the host lists the catalog again by itself (no client asks) and it
// is listed without restarting anything; remove its key: it is gone. It never touches the user's data folder or contacts a provider.
const hostHome = process.env.JOUZU_E2E_HOST_HOME;
if (!hostHome) {
  console.error('JOUZU_E2E_HOST_HOME is not set; skipping the model list check.');
  process.exit(2);
}
const host = JSON.parse(readFileSync(join(hostHome, 'host.json'), 'utf8'));
const base = `http://127.0.0.1:${host.port}`;
const headers = { authorization: `Bearer ${host.token}`, 'content-type': 'application/json' };
const call = async (path, body) => {
  const response = await fetch(base + path, body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers });
  const json = await response.json();
  if (!response.ok) throw new Error(`${path}: ${JSON.stringify(json)}`);
  return json;
};
const providers = list => [...new Set(list.models.map(model => model.provider))].sort();
/** The catalog once `ready(catalog)` holds, or the last one read after 30 s. The host lists it
 * again by itself after every settings change, and raises its revision only when what clients
 * see changes, so a change that leaves the list as it was is waited for by its content. */
const catalogWhen = async ready => {
  let catalog;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    catalog = await call('/v1/models');
    if (ready(catalog)) return catalog;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return catalog;
};
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); };

const id = `added-${Date.now().toString(36)}`;
const first = await call('/v1/models');
const before = providers(first);
// Without a key the provider is not usable, so the list stays as it was.
await call('/v1/control', { action: 'custom-provider', provider: id, url: 'http://127.0.0.1:43123/v1', model: 'deterministic' });
await call('/v1/control', { action: 'provider-key', provider: id, token: 'fixture-key' });
const after = providers(await catalogWhen(catalog => providers(catalog).includes(id)));
check('a provider added in Settings is listed without a restart', after.includes(id), `before: ${before.join(', ')} | after: ${after.join(', ')}`);
// Removing its key takes it off the list again (the signed-out case).
await call('/v1/control', { action: 'provider-remove', provider: id });
const removed = providers(await catalogWhen(catalog => !providers(catalog).includes(id)));
check('a provider whose key was removed leaves the list', !removed.includes(id), `after removal: ${removed.join(', ')}`);

writeFileSync('model-list-fresh-result.json', `${JSON.stringify({ results }, null, 2)}\n`);
for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name}: ${result.detail}`);
process.exit(results.every(result => result.ok) ? 0 : 1);
