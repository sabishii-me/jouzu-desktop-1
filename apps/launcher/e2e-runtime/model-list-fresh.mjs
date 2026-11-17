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
/** The catalog once the host has listed it again after `revision` (it does so after every settings change). */
const catalogAfter = async revision => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const catalog = await call('/v1/models');
    if (catalog.revision > revision) return catalog;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`the catalog was not listed again after revision ${revision}`);
};
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); };

const id = `added-${Date.now().toString(36)}`;
const first = await call('/v1/models');
const before = providers(first);
await call('/v1/control', { action: 'custom-provider', provider: id, url: 'http://127.0.0.1:43123/v1', model: 'deterministic' });
const added = await catalogAfter(first.revision);
await call('/v1/control', { action: 'provider-key', provider: id, token: 'fixture-key' });
const listed = await catalogAfter(added.revision);
const after = providers(listed);
check('a provider added in Settings is listed without a restart', after.includes(id), `before: ${before.join(', ')} | after: ${after.join(', ')}`);
// Removing its key takes it off the list again (the signed-out case).
await call('/v1/control', { action: 'provider-remove', provider: id });
const removed = providers(await catalogAfter(listed.revision));
check('a provider whose key was removed leaves the list', !removed.includes(id), `after removal: ${removed.join(', ')}`);

writeFileSync('model-list-fresh-result.json', `${JSON.stringify({ results }, null, 2)}\n`);
for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name}: ${result.detail}`);
process.exit(results.every(result => result.ok) ? 0 : 1);
