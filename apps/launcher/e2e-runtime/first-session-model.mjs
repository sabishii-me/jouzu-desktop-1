import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression check for #99 and the message lost right after "New session". Against a
// host JUST started on a throwaway home (JOUZU_E2E_HOST_HOME: the host's --home, with
// at least one usable model): a new session has no model until one is picked. That
// is a plain state ("none"), never an error, and the host takes no model of its own
// for it (not the runtime's start model either). A send before the pick is refused
// with a code (no-model), never accepted and lost; a model the catalog does not list
// cannot be picked; after a pick of a listed model the send is accepted.
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
check('a new session starts with no model, as a plain state', created.model?.state === 'none' && !created.model?.id, JSON.stringify(created.model));
const early = await raw(`/v1/sessions/${created.sessionId}/messages`, { clientMessageId: 'early', text: 'hello' });
check('a send before a model is picked is refused with a code', early.status === 409 && early.body?.error?.code === 'no-model', `${early.status} ${JSON.stringify(early.body)}`);
let catalog = await call('/v1/models');
// On a cold home the runtime's first answer can be an empty list; its catalog
// arrives a few seconds later as a new revision.
for (let attempt = 0; attempt < 120 && !(catalog.state === 'ready' && catalog.models.length); attempt += 1) {
  await new Promise(resolve => setTimeout(resolve, 250));
  catalog = await call('/v1/models');
}
check('the model list arrives by itself', catalog.state === 'ready' && catalog.models.length > 0, `${catalog.state} with ${catalog.models.length} models`);
// The host waits for nothing: after the list, the session still has no model of its own.
const after = (await call(`/v1/sessions/${created.sessionId}`)).model;
check('the host does not pick a model for the session', after?.state === 'none' && !after?.id, JSON.stringify(after));
const gone = await raw(`/v1/sessions/${created.sessionId}/model`, { provider: 'e2e-missing', model: 'not-listed' });
check('a model the catalog does not list cannot be picked', gone.status === 409 && gone.body?.error?.code === 'model-unavailable', `${gone.status} ${JSON.stringify(gone.body)}`);
const row = catalog.models[0];
if (row) {
  const picked = await raw(`/v1/sessions/${created.sessionId}/model`, { provider: row.provider, model: row.id });
  const model = (await call(`/v1/sessions/${created.sessionId}`)).model;
  check('a picked model is the session\'s model', picked.status === 200 && model?.state === 'ready' && model.id === row.id, `${picked.status} ${JSON.stringify(model)}`);
  const sent = await raw(`/v1/sessions/${created.sessionId}/messages`, { clientMessageId: 'after-pick', text: 'Reply with OK.' });
  check('a send after the pick is accepted', sent.status === 202, `${sent.status} ${JSON.stringify(sent.body)}`);
}

writeFileSync('first-session-model-result.json', `${JSON.stringify({ results }, null, 2)}\n`);
for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name}: ${result.detail}`);
process.exit(results.every(result => result.ok) ? 0 : 1);
