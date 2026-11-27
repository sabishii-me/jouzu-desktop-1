import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

// The case catalog: release-checks/cases/*.yaml, one entry per test case (ISO/IEC/IEEE 29119-3
// fields). It is the one list of what is tested; the playbooks hold the code that runs it.
//
//   node harness/run/catalog.mjs --check            validate the catalog and match it to the code
//   node harness/run/catalog.mjs --table <file.md>  write the table people read
//
// A catalog entry names its code by file and case name (automation.impl). The check fails
// when an automated entry has no code, when code has no entry, or when the two disagree on
// languages or world.

const here = import.meta.dirname;
export const casesDir = resolve(here, '..', '..', 'release-checks', 'cases');
export const e2eDir = resolve(here, '..', 'e2e');

const ENUMS = {
  suite: ['smoke', 'main', 'regression', 'abnormal'],
  priority: ['high', 'medium', 'low'],
  type: ['functional', 'performance', 'install', 'update', 'security', 'i18n'],
  world: ['user', 'new-user', 'shisa-stand-in', 'installed-app', 'installed-package'],
  status: ['automated', 'planned', 'gap', 'deferred'],
  platform: ['windows', 'macos', 'linux'],
  language: ['en', 'ja', 'zh-Hans', 'zh-Hant'],
};
const KEYS = ['id', 'legacy', 'title', 'suite', 'scenario', 'priority', 'type', 'purpose', 'preconditions', 'data', 'steps', 'limits', 'measures', 'languages', 'platforms', 'automation', 'links', 'added'];
export const ALL_LANGUAGES = ENUMS.language;
export const ALL_PLATFORMS = ENUMS.platform;

/** Every catalog entry, with its file; throws with every problem found. */
export function loadCatalog(dir = casesDir) {
  const entries = [];
  const problems = [];
  for (const file of readdirSync(dir).filter(name => name.endsWith('.yaml')).sort()) {
    let list;
    try { list = parse(readFileSync(join(dir, file), 'utf8')); } catch (error) { problems.push(`${file}: not valid YAML: ${error.message}`); continue; }
    if (!Array.isArray(list)) { problems.push(`${file}: must be a list of cases`); continue; }
    for (const entry of list) entries.push({ ...entry, file });
  }
  const seen = new Map();
  for (const entry of entries) {
    const where = `${entry.file} ${entry.id ?? '(no id)'}`;
    const need = (ok, text) => { if (!ok) problems.push(`${where}: ${text}`); };
    for (const key of Object.keys(entry)) need(key === 'file' || KEYS.includes(key), `unknown field "${key}"`);
    need(/^[A-Z]+-\d{3}$/.test(entry.id ?? ''), 'id must look like AREA-123');
    if (seen.has(entry.id)) problems.push(`${where}: id used twice (also in ${seen.get(entry.id)})`);
    seen.set(entry.id, entry.file);
    for (const key of ['title', 'purpose']) need(typeof entry[key] === 'string' && entry[key].trim(), `${key} is required`);
    need(ENUMS.suite.includes(entry.suite), `suite must be one of ${ENUMS.suite.join(', ')}`);
    need(/^U\d+$/.test(entry.scenario ?? ''), 'scenario must be U1-U12');
    need(ENUMS.priority.includes(entry.priority), `priority must be one of ${ENUMS.priority.join(', ')}`);
    need(ENUMS.type.includes(entry.type), `type must be one of ${ENUMS.type.join(', ')}`);
    need(ENUMS.world.includes(entry.preconditions?.world), `preconditions.world must be one of ${ENUMS.world.join(', ')}`);
    need(Array.isArray(entry.steps) && entry.steps.length > 0 && entry.steps.every(step => step?.do && step?.expect), 'steps must be a list of {do, expect}');
    for (const key of ['legacy', 'measures', 'links']) need(entry[key] === undefined || Array.isArray(entry[key]), `${key} must be a list`);
    need(entry.languages === undefined || (Array.isArray(entry.languages) && entry.languages.every(item => ENUMS.language.includes(item))), `languages must be from ${ENUMS.language.join(', ')}`);
    need(entry.platforms === undefined || (Array.isArray(entry.platforms) && entry.platforms.every(item => ENUMS.platform.includes(item))), `platforms must be from ${ENUMS.platform.join(', ')}`);
    need(entry.limits === undefined || (Array.isArray(entry.limits) && entry.limits.every(item => item?.what && item?.line && item?.by)), 'limits must be a list of {what, line, by}: every line says who set it');
    const automation = entry.automation ?? {};
    need(ENUMS.status.includes(automation.status), `automation.status must be one of ${ENUMS.status.join(', ')}`);
    if (automation.status === 'automated') need(automation.impl?.file && (automation.impl.case || automation.impl.check), 'an automated case names its code: automation.impl {file, case}');
    if (automation.status === 'gap') need(automation.reason, 'a gap says why it cannot be automated: automation.reason');
  }
  if (problems.length) throw new Error(`The case catalog has problems:\n${problems.join('\n')}`);
  return entries.map(entry => ({
    ...entry,
    languages: entry.languages ?? ALL_LANGUAGES,
    platforms: entry.platforms ?? ALL_PLATFORMS,
    world: entry.preconditions.world,
  }));
}

/** The cases a playbook file defines, as it lists them itself. */
export function listPlaybook(file, env = process.env) {
  const path = resolve(e2eDir, file);
  return JSON.parse(execFileSync(process.execPath, [path], { env: { ...env, PLAYBOOK_LIST: '1', PLAYBOOK_SHOTS: join(env.TMPDIR ?? env.TEMP ?? '/tmp', 'playbook-list') }, encoding: 'utf8' }))
    .map(item => ({ ...item, playbook: path, file }));
}

/** Catalog and code must name the same cases the same way. Returns the problems found. */
export function matchCode(catalog, listed) {
  const problems = [];
  const byKey = new Map(listed.map(item => [`${item.file}\t${item.name}`, item]));
  const used = new Set();
  for (const entry of catalog.filter(item => item.automation.status === 'automated' && item.automation.impl.case)) {
    const key = `${entry.automation.impl.file}\t${entry.automation.impl.case}`;
    const code = byKey.get(key);
    if (!code) { problems.push(`${entry.id}: no case "${entry.automation.impl.case}" in ${entry.automation.impl.file}`); continue; }
    if (used.has(key)) problems.push(`${entry.id}: the case "${code.name}" is claimed by two catalog entries`);
    used.add(key);
    const same = (a, b) => [...a].sort().join() === [...b].sort().join();
    if (!same(entry.languages, code.langs)) problems.push(`${entry.id}: catalog languages ${entry.languages.join(',')} but the code runs ${code.langs.join(',')}`);
    if ((code.world ?? 'user') !== entry.world) problems.push(`${entry.id}: catalog world ${entry.world} but the code asks for ${code.world ?? 'user'}`);
  }
  for (const item of listed) if (!used.has(`${item.file}\t${item.name}`)) problems.push(`${item.file}: case "${item.name}" has no catalog entry`);
  return problems;
}

/** The plan's choice of cases: plan.select {suites, scenarios, priorities, ids}; empty = every case. */
export function selected(catalog, select = {}) {
  return catalog.filter(entry => (!select.suites || select.suites.includes(entry.suite))
    && (!select.scenarios || select.scenarios.includes(entry.scenario))
    && (!select.priorities || select.priorities.includes(entry.priority))
    && (!select.ids || select.ids.includes(entry.id)));
}

/** The table people read, written from the catalog (release-checks/cases/CASES.md). */
export function table(catalog) {
  const cell = text => String(text ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = ['# Jouzu Desktop test cases', '', 'Generated from release-checks/cases/*.yaml by `node harness/run/catalog.mjs --table`. Edit the YAML, not this file.', ''];
  const count = status => catalog.filter(entry => entry.automation.status === status).length;
  lines.push(`${catalog.length} cases: ${count('automated')} automated, ${count('planned')} planned, ${count('gap')} gap, ${count('deferred')} deferred.`, '');
  for (const suite of ENUMS.suite) {
    const rows = catalog.filter(entry => entry.suite === suite);
    if (!rows.length) continue;
    lines.push(`## ${suite} (${rows.length})`, '', '| ID | Old | Title | Scenario | Priority | Platforms | Languages | Automation |', '|---|---|---|---|---|---|---|---|');
    for (const entry of rows) {
      const automation = entry.automation.status === 'automated' ? `automated (${entry.automation.impl.file})` : `${entry.automation.status}${entry.automation.reason ? `: ${entry.automation.reason}` : ''}`;
      lines.push(`| ${entry.id} | ${cell((entry.legacy ?? []).join(' '))} | ${cell(entry.title)} | ${entry.scenario} | ${entry.priority} | ${entry.platforms.length === 3 ? 'all' : entry.platforms.join(', ')} | ${entry.languages.length === 4 ? 'all' : entry.languages.join(', ')} | ${cell(automation)} |`);
    }
    lines.push('');
  }
  lines.push('## Steps', '');
  for (const entry of catalog) {
    lines.push(`### ${entry.id} ${entry.title}`, '', entry.purpose, '');
    if (entry.preconditions.state) lines.push(`Before: ${entry.preconditions.state}`, '');
    if (entry.data) lines.push(`Data: ${entry.data}`, '');
    lines.push('| # | Do | Expect |', '|---|---|---|');
    entry.steps.forEach((step, index) => lines.push(`| ${index + 1} | ${cell(step.do)} | ${cell(step.expect)} |`));
    for (const limit of entry.limits ?? []) lines.push('', `Limit: ${limit.what}: ${limit.line} (set by ${limit.by}${limit.status ? `, ${limit.status}` : ''})`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const args = process.argv.slice(2);
  try {
    const catalog = loadCatalog();
    if (args.includes('--check')) {
      const playbooks = [...new Set(catalog.filter(entry => entry.automation.impl?.case).map(entry => entry.automation.impl.file))];
      const problems = matchCode(catalog, playbooks.flatMap(file => listPlaybook(file)));
      if (problems.length) { console.error(`Catalog and code do not match:\n${problems.join('\n')}`); process.exit(1); }
      console.log(`Catalog OK: ${catalog.length} cases, ${catalog.filter(entry => entry.automation.status === 'automated').length} automated, every case in ${playbooks.join(' and ')} has an entry.`);
    }
    const at = args.indexOf('--table');
    if (at >= 0) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(resolve(args[at + 1]), table(catalog));
      console.log(`table: ${args[at + 1]}`);
    }
  } catch (error) { console.error(error.message); process.exit(1); }
}
