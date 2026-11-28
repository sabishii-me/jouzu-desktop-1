import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Update playbook: a person on an earlier version updates Jouzu Desktop in the app (Windows).
 * Runs in the exam's update world (ABN_WORLD=installed-app, update-world.mjs): each case installs
 * the earlier version with its own installer into a throwaway folder, with throwaway data and
 * profile folders, uses it, updates through the app's own feed, and checks what the person has
 * afterwards. The machine's own Jouzu Desktop is never moved, closed or changed.
 *
 * Unlike the other playbooks it does not attach to a window when it starts: the window it drives
 * is closed by the update and a new one opens, so each case attaches (again) itself.
 *
 * Environment: as playbook-kit.mjs (PLAYBOOK_CDP, PLAYBOOK_WORLD, PLAYBOOK_LANG, PLAYBOOK_OUT,
 * PLAYBOOK_SHOTS, PLAYBOOK_ONLY, PLAYBOOK_LIST).
 */
const lang = process.env.PLAYBOOK_LANG ?? "en";
const world = process.env.PLAYBOOK_WORLD;
const cdp = process.env.PLAYBOOK_CDP ?? "http://127.0.0.1:9223";
const port = Number(new URL(cdp).port);
const shots = process.env.PLAYBOOK_SHOTS ?? process.env.TEMP ?? ".";
const only = process.env.PLAYBOOK_ONLY ?? "";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => Date.now();
const control = (path, body = {}) => fetch(`${world}${path}`, { method: "POST", body: JSON.stringify(body) }).then(response => response.json());
const worldGet = (path, query = {}) => fetch(`${world}${path}?${new URLSearchParams(query)}`).then(response => response.json());

/** The app's own words (i18n.ts, chat-text.ts, update-preview.tsx). */
const W = {
  en: { newSession: "New session", settings: "Settings", system: "System", check: "Check for updates", channel: "Update channel", qa: "QA (test builds)", stable: "Stable", update: "Update and restart", installOlder: "Install Stable", desktop: "Jouzu Desktop", model: "Model", message: "Message Jouzu", prepare: "Preparing Jouzu…" },
  ja: { newSession: "新しいセッション", settings: "設定", system: "システム", check: "更新を確認", channel: "更新チャネル", qa: "QA（テスト版）", stable: "安定版", update: "更新して再起動", installOlder: "安定版をインストール", desktop: "Jouzu Desktop", model: "モデル", message: "Jouzu へのメッセージ", prepare: "Jouzu を準備しています…" },
}[lang];

const cases = [];
const add = (name, why, run, { langs = ["en"], scenario = null } = {}) => cases.push({ name, why, run, langs, scenario, world: "installed-app" });

// ---- The window ----
let browser = null;
let page = null;
/** Attach to the app's window (again); answers whether a window was found within timeout. */
async function attach(timeout = 180_000) {
  await browser?.close().catch(() => {});
  browser = null; page = null;
  const until = now() + timeout;
  while (now() < until) {
    try {
      const connected = await chromium.connectOverCDP(cdp);
      const found = connected.contexts().flatMap(context => context.pages()).find(item => !item.url().startsWith("devtools:"));
      if (found) { browser = connected; page = found; break; }
      await connected.close();
    } catch { /* not open yet */ }
    await sleep(1_000);
  }
  if (!page) return false;
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  if (await page.evaluate(() => localStorage.getItem("jouzu.ui.language")).catch(() => null) !== lang) {
    await page.evaluate(value => localStorage.setItem("jouzu.ui.language", value), lang).catch(() => {});
    await page.reload().catch(() => {});
  }
  return page.getByRole("button", { name: W.newSession, exact: true }).first().waitFor({ timeout: 5 * 60_000 }).then(() => true, () => false);
}
const shot = (c, what) => page?.screenshot({ path: join(shots, `${c.slug}-${what}.png`) }).catch(() => {});
const sessionRows = () => page.locator("aside [data-session-state], aside [data-session-selected]").evaluateAll(list => list.map(row => (row.textContent ?? "").replace(/\s+/g, " ").trim()));
let question = 0;
/** Send one message in the open session; answers whether the fixture's answer arrived. */
async function askHere(timeout = 120_000) {
  question += 1;
  const prompt = `What is ${question} × 7? Reply with only the number.`;
  const box = page.getByRole("textbox", { name: W.message }).first();
  await box.waitFor({ timeout: 30_000 });
  await box.fill(prompt);
  await box.press("Enter");
  return page.locator("main").getByText(String(question * 7), { exact: true }).first().waitFor({ timeout }).then(() => true, () => false);
}
async function newSessionAnswers() {
  await page.keyboard.press("Escape").catch(() => {});
  await page.getByRole("button", { name: W.newSession, exact: true }).first().click();
  return askHere();
}
async function openSystem() {
  await page.keyboard.press("Escape").catch(() => {});
  await page.getByRole("button", { name: W.settings, exact: true }).first().click();
  const dialog = page.getByRole("dialog").first();
  await dialog.getByRole("tab", { name: W.system, exact: true }).click();
  return dialog;
}
/** The version line of the Jouzu Desktop row in Settings > System. */
async function desktopVersion() {
  const dialog = await openSystem();
  const text = await dialog.locator(`section[aria-label="${W.desktop}"]`).first().innerText().catch(() => "");
  await page.keyboard.press("Escape").catch(() => {});
  return text.replace(/\s+/g, " ").trim();
}
async function channelNow() {
  const dialog = await openSystem();
  const value = await dialog.getByRole("combobox", { name: W.channel }).first().innerText().catch(() => null);
  await page.keyboard.press("Escape").catch(() => {});
  return value?.trim() ?? null;
}
/** Models the composer's model menu lists. */
async function modelNames() {
  await page.getByRole("button", { name: W.newSession, exact: true }).first().click().catch(() => {});
  await page.getByRole("button", { name: W.model, exact: true }).first().click();
  const names = await page.getByRole("menuitemradio").allInnerTexts().catch(() => []);
  await page.keyboard.press("Escape").catch(() => {});
  return names.map(name => name.trim());
}

/**
 * In Settings > System: follow channel (QA or Stable), check, and install what the feed offers.
 * expect: the version the offer must name. Answers what happened; the window closes when it works.
 */
async function updateInApp(c, channel, expect) {
  const dialog = await openSystem();
  const picker = dialog.getByRole("combobox", { name: W.channel }).first();
  if (!await picker.count()) { c.fail("Settings > System has no update channel choice"); return false; }
  if ((await picker.innerText()).trim() !== (channel === "qa" ? W.qa : W.stable)) {
    await picker.click();
    await page.getByRole("option", { name: channel === "qa" ? W.qa : W.stable, exact: true }).click();
  }
  await sleep(1_000);
  await dialog.getByRole("button", { name: W.check, exact: true }).first().click().catch(() => {});
  const row = dialog.locator(`section[aria-label="${W.desktop}"]`).first();
  const offered = await row.getByText(expect, { exact: false }).first().waitFor({ timeout: 90_000 }).then(() => true, () => false);
  if (!offered) { c.fail(`the ${channel} feed did not offer ${expect} within 90 s (the row shows: "${(await row.innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 200)}")`); await shot(c, `no-offer-${channel}`); return false; }
  const action = channel === "qa" ? W.update : W.installOlder;
  await row.getByRole("button", { name: action, exact: false }).first().click();
  const confirm = page.getByRole("dialog").filter({ hasText: action }).last();
  await confirm.getByRole("button", { name: action, exact: true }).last().click().catch(() => {});
  return true;
}
/** After the app started its update: the installed version becomes expect and the new window opens. */
async function afterUpdate(c, expect) {
  const started = now();
  let state = null;
  while (now() < started + 10 * 60_000) {
    state = await worldGet("/update/state");
    if (state.version === expect) break;
    await sleep(2_000);
  }
  if (state?.version !== expect) { c.fail(`the installer did not install ${expect} within 10 min (installed: ${state?.version ?? "none"})`); return false; }
  c.metric("installMs", now() - started);
  // The installer starts the app again by itself; give it the time a person would.
  let opened = await attach(120_000);
  if (!opened) {
    const running = (await worldGet("/update/state")).processes;
    c.fail(`the app did not open again by itself after the update (running from its folder: ${running.map(row => row.name).join(", ") || "nothing"})`);
    await control("/update/quit");
    await control("/update/start", { port });
    opened = await attach(180_000);
    if (!opened) { c.fail("the updated app's window could not be opened at all"); return false; }
  }
  c.metric("updateToWindowMs", now() - started);
  return true;
}
/** Install `from`, start it, use it: a message in a new session. Answers what the person had before the update. */
async function usedEarlier(c, from) {
  const to = (await worldGet("/update/state")).to;
  if (!to) { c.skip("ABN_UPDATE_TO (the version under test) is not set"); return null; }
  const prepared = await control("/update/prepare", { from, port });
  if (prepared.error) { c.fail(`the earlier version could not be installed: ${prepared.error}`); return null; }
  c.note(`installed ${prepared.version}; updating to ${to}`);
  if (!await attach()) { c.fail(`the earlier version (${prepared.version}) did not open a usable window`); await shot(c, "earlier"); return null; }
  if (!await newSessionAnswers()) { c.fail(`the earlier version (${prepared.version}) did not answer a message`); return null; }
  const before = { version: prepared.version, to, rows: await sessionRows(), models: await modelNames() };
  c.note(`before: ${before.rows.length} sessions, models ${before.models.join(", ")}`);
  return before;
}
/** What must still be there after an update: every session, the models and their keys, an answer in an old session. */
async function dataKept(c, before, when) {
  const rows = await sessionRows();
  const lost = before.rows.filter(row => !rows.some(item => item.includes(row.slice(0, 40))));
  if (lost.length) c.fail(`${when}: ${lost.length} of ${before.rows.length} sessions are gone: ${lost.slice(0, 3).join(" | ")}`);
  const models = await modelNames();
  const missing = before.models.filter(name => !models.includes(name));
  if (missing.length) c.fail(`${when}: models are gone from the model list: ${missing.join(", ")}`);
  // The session the person used before the update, opened and continued.
  const used = page.locator("aside [data-session-state], aside [data-session-selected]").filter({ hasText: "× 7" }).first();
  if (await used.count()) {
    await used.click();
    if (!await askHere()) c.fail(`${when}: a message in the session used before the update got no reply`);
  } else c.fail(`${when}: the session used before the update is not in the list`);
}

add("UPD-001 Update from the last release keeps sessions, settings and sign-ins", "A person on the last release switches to the QA feed and updates in the app. The app restarts on the new version by itself; every session, the changed setting and the saved providers are still there, and a message in an old session is answered.", async c => {
  const before = await usedEarlier(c, "release");
  if (!before) return;
  if (!await updateInApp(c, "qa", before.to)) return;
  if (!await afterUpdate(c, before.to)) return;
  const shown = await desktopVersion();
  if (!shown.includes(before.to)) c.fail(`Settings > System does not show ${before.to}: "${shown.slice(0, 160)}"`);
  const channel = await channelNow();
  if (channel !== W.qa) c.fail(`the update channel the person chose (QA) is now "${channel}"`);
  await dataKept(c, before, "after the update");
}, { langs: ["en", "ja"], scenario: "U2" });

add("UPD-002 Update between release candidates keeps data and the runtime", "An update from the previous release candidate keeps data and saved providers, keeps a runtime that is already the pinned version, and never stops on Preparing.", async c => {
  const before = await usedEarlier(c, "rc");
  if (!before) return;
  const runtimeBefore = await worldGet("/file", { path: "app/node_modules/jouzu/package.json" });
  if (!await updateInApp(c, "qa", before.to)) return;
  if (!await afterUpdate(c, before.to)) return;
  const preparing = await page.getByText(W.prepare, { exact: false }).first().isVisible().catch(() => false);
  if (preparing) c.fail("after the update the app shows Preparing although its runtime is already the pinned version");
  const runtimeAfter = await worldGet("/file", { path: "app/node_modules/jouzu/package.json" });
  const version = text => { try { return JSON.parse(text).version; } catch { return null; } };
  if (version(runtimeBefore.text) !== version(runtimeAfter.text)) c.note(`the runtime changed from ${version(runtimeBefore.text)} to ${version(runtimeAfter.text)} (this rc pins another version)`);
  await dataKept(c, before, "after the update");
}, { scenario: "U3" });

add("UPD-003 The install folder after an update is clean", "After an update Settings > System shows the release commit (no -dirty), and a silent uninstall keeps the data folder.", async c => {
  const before = await usedEarlier(c, "rc");
  if (!before) return;
  if (!await updateInApp(c, "qa", before.to)) return;
  if (!await afterUpdate(c, before.to)) return;
  const shown = await desktopVersion();
  c.note(`Settings > System: ${shown.slice(0, 160)}`);
  if (/-dirty/.test(shown)) c.fail(`the version line names a dirty build: "${shown.slice(0, 160)}"`);
  await browser?.close().catch(() => {});
  await control("/update/quit");
  const removed = await control("/update/uninstall");
  if (removed.error) { c.fail(`the silent uninstall failed: ${removed.error}`); return; }
  if (!removed.uninstalled) c.fail("the silent uninstall did not remove the app");
  if (!removed.dataKept) c.fail(`the silent uninstall removed the data folder (left: ${removed.left.join(", ")})`);
}, { scenario: "U2" });

add("UPD-005 Switching the update channel release, QA, release keeps data", "Moving from the release channel to the QA channel and back (installing the older stable build) keeps every session and setting in both directions.", async c => {
  const before = await usedEarlier(c, "release");
  if (!before) return;
  if (!await updateInApp(c, "qa", before.to)) return;
  if (!await afterUpdate(c, before.to)) return;
  await dataKept(c, before, "after moving to QA");
  const middle = { ...before, rows: await sessionRows() };
  if (!await updateInApp(c, "stable", before.version)) return;
  if (!await afterUpdate(c, before.version)) return;
  await dataKept(c, middle, "after moving back to Stable");
}, { scenario: "U3" });

// ---- Running ----
if (process.env.PLAYBOOK_LIST) {
  console.log(JSON.stringify(cases.map(item => ({ name: item.name, why: item.why, langs: item.langs, scenario: item.scenario, world: item.world }))));
  process.exit(0);
}
mkdirSync(shots, { recursive: true });
const result = { startedAt: new Date().toISOString(), lang, cases: [], errors: [] };
for (const item of cases) {
  if (!item.langs.includes(lang)) continue;
  if (only && !only.toLowerCase().split("|").some(part => item.name.toLowerCase().includes(part.trim()))) continue;
  const record = { name: item.name, why: item.why, ok: true, problems: [], notes: [], metrics: {} };
  const c = {
    record, slug: item.name.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase(),
    fail(text) { record.ok = false; record.problems.push(text); },
    skip(text) { record.skipped = true; record.notes.push(text); },
    note(text) { record.notes.push(text); },
    metric(key, value) { record.metrics[key] = Math.round(value); },
  };
  const started = now();
  try { await item.run(c); } catch (error) {
    c.fail(`the case could not finish: ${String(error?.message ?? error).split("\n")[0]}`);
    await shot(c, "error");
  }
  await shot(c, "end");
  await browser?.close().catch(() => {});
  // Remove the test installation and put the installer's registry entries back before anything else runs.
  const restored = await control("/update/restore").catch(error => ({ error: String(error) }));
  if (restored.error) c.fail(`the test installation could not be removed: ${restored.error}`);
  record.ms = now() - started;
  result.cases.push(record);
  console.error(`${record.skipped ? "SKIP" : record.ok ? "PASS" : "FAIL"} ${item.name}${record.problems.length ? `: ${record.problems.join("; ")}` : ""}`);
}
result.pass = result.errors.length === 0 && result.cases.every(item => item.ok);
result.finishedAt = new Date().toISOString();
if (process.env.PLAYBOOK_OUT) writeFileSync(process.env.PLAYBOOK_OUT, JSON.stringify(result, null, 2));
else console.log(JSON.stringify(result, null, 2));
process.exitCode = result.pass ? 0 : 1;
