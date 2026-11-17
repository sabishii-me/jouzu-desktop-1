import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression check for #99 and the message lost right after "New session": the first
// new session after the host starts gets the default model with no client listing
// the models. Against a host JUST started on a throwaway home (JOUZU_E2E_HOST_HOME:
// the host's --home, with at least one usable model): create a new session at once,
// then read it until its model is known: it must be ready, and the catalog's default
// when one is saved (with none saved, the runtime picks it, as for a first sign-in).
// A send made before then is refused with a code (no-model), never accepted and lost.
// Never touches the user's data folder.
const hostHome = process.env.JOUZU_E2E_HOST_HOME;
const workspace = process.env.JOUZU_E2E_WORKSPACE;
if (!hostHome || !workspace) {
  console.error('JOUZU_E2E_HOST_HOME or JOUZU_E2E_WORKSPACE is not set; skipping the first session model check.');
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
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); };

const raw = async (path, body) => {
  const response = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};
const created = await call('/v1/sessions', { workspacePath: workspace });
const atCreate = created.model ?? null;
if (atCreate?.state !== 'ready') {
  const early = await raw(`/v1/sessions/${created.sessionId}/messages`, { clientMessageId: 'early', text: 'hello' });
  check('a send before the session has a model is refused with a code', early.status === 409 && ['no-model', 'model-unavailable'].includes(early.body?.error?.code), `${early.status} ${JSON.stringify(early.body)}`);
}
let model = atCreate;
for (let attempt = 0; attempt < 120 && model?.state !== 'ready'; attempt += 1) {
  await new Promise(resolve => setTimeout(resolve, 250));
  model = (await call(`/v1/sessions/${created.sessionId}`)).model;
}
const catalog = await call('/v1/models');
const expected = catalog.default ? `${catalog.default.provider}/${catalog.default.id}` : null;
const shown = model?.provider && model?.id ? `${model.provider}/${model.id}` : null;
const listed = catalog.models.some(row => `${row.provider}/${row.id}` === shown);
check(
  'a session created right after the host started gets its model by itself',
  model?.state === 'ready' && (expected ? shown === expected : listed),
  `at create: ${atCreate?.state ?? 'none'} | default: ${expected ?? 'none'} | shown: ${shown ?? 'none'} (${model?.state ?? 'none'})`,
);

writeFileSync('first-session-model-result.json', `${JSON.stringify({ results }, null, 2)}\n`);
for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name}: ${result.detail}`);
process.exit(results.every(result => result.ok) ? 0 : 1);
