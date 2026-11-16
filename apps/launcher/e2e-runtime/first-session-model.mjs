import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression check for #99: the first new session after the host starts gets the
// default model. At startup the UI creates the session before the model list is
// known, so the host had no default to give it, and nothing else ever did.
// Against a host JUST started on a throwaway home (JOUZU_E2E_HOST_HOME: the host's
// --home, with a usable default model) and before any client listed the models:
// create a new session, list the models, then read the session: it must have the
// default model, with nothing sent. Never touches the user's data folder.
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

const created = await call('/v1/sessions', { workspacePath: workspace });
const atCreate = created.model ?? null;
const list = await call('/v1/models');
const expected = list.defaultProvider && list.defaultModel ? `${list.defaultProvider}/${list.defaultModel}` : null;
let shown = null;
for (let attempt = 0; attempt < 20 && !shown; attempt += 1) {
  const info = await call(`/v1/sessions/${created.sessionId}`);
  shown = info.model?.provider && info.model?.id ? `${info.model.provider}/${info.model.id}` : null;
  if (!shown) await new Promise(resolve => setTimeout(resolve, 250));
}
check(
  'a session created before the model list has the default once it is listed',
  expected && shown === expected,
  `at create: ${atCreate ? `${atCreate.provider}/${atCreate.id}` : 'none'} | default: ${expected ?? 'none'} | shown: ${shown ?? 'none'}`,
);

writeFileSync('first-session-model-result.json', `${JSON.stringify({ results }, null, 2)}\n`);
for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name}: ${result.detail}`);
process.exit(results.every(result => result.ok) ? 0 : 1);
