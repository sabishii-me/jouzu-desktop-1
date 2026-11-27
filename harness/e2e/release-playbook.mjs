import { join } from "node:path";
import {
  SEL, add, ask, chatSession, control, conversation, conversationText, fault, freshSession, idle, judgeRecovers, lang,
  judgeNoEndlessWait, layout, openSettings, more, named, namedMore, newSession, now, page, problems, redSquarePng, replyArrives, runCases, sendButton,
  shots, sidebar, sleep, slug, stopButton, technical, textbox, typeAndSend, waitRowState, rowState, post, waiting, world, fixture,
} from "./playbook-kit.mjs";

/**
 * Release playbook: the paths of the release playbook (P1-P29) and the main user scenarios
 * (N1-N4), as cases the neutral runner runs one by one on every platform and language.
 *
 * Each case is one thing a person does. It passes when the person sees what the playbook's
 * "expected (what the user sees)" column says; timings come from the host's own log
 * (host.log), measured the same way on every machine. No case needs a person: the model is
 * the fixture provider in the throwaway home, and the world (host restart, a second folder,
 * the files) is the exam's.
 *
 * Every case also runs the shared end check (P29): nothing floats over the page, and no
 * raw technical text is shown as a main sentence.
 *
 * Scenarios (release/1.1.5 user-centred draft): U1 new install, U2 update from the last
 * release, U3 update between rcs, U4 everyday chat, U5 sign-in and models, U6 provider or
 * network trouble, U7 runtime trouble, U8 settings, U9 saved sessions, U10 image tool,
 * U11 folders, U12 security.
 */

// ---- The world, as this playbook needs it ----
const worldGet = (path, query = {}) => fetch(`${world}${path}?${new URLSearchParams(query)}`).then(response => response.json());
const requests = () => fetch(`${fixture}/__requests`).then(response => response.json());
/** The host's own API, called from the app's page as the app calls it (its token in the app window, the host cookie in a browser). */
function host(path, init = {}) {
  return page.evaluate(async ({ path, init }) => {
    const endpoint = window.__JOUZU_HOST__ ?? { baseUrl: location.origin, token: "" };
    const headers = { "content-type": "application/json", ...(endpoint.token ? { authorization: `Bearer ${endpoint.token}` } : {}) };
    const response = await fetch(`${endpoint.baseUrl}/v1${path}`, { ...init, headers, credentials: "include" });
    return { status: response.status, body: await response.json().catch(() => null) };
  }, { path, init });
}
/** The app ends and starts again on the same data, as a person quits and opens it. */
async function reopen(body = {}) {
  const restarted = await control("/host/restart", body);
  if (!restarted.url) throw new Error(`the host did not restart: ${JSON.stringify(restarted)}`);
  const start = now();
  await page.goto(restarted.url);
  await page.evaluate(value => localStorage.setItem("jouzu.ui.language", value), lang);
  await page.reload();
  return start;
}
/** host.log lines (JSON) with this mark, newest last; only those after `since` (ms). */
async function marks(mark, since = 0) {
  const file = await worldGet("/file", { path: "logs/host.log" });
  return (file.text ?? "").split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } })
    .filter(entry => entry.fields?.mark === mark || entry.event === mark)
    .filter(entry => Date.parse(entry.ts) >= since);
}
/** The saved session files, name -> size. */
async function sessionFiles() {
  const listed = await worldGet("/list", { path: "data/state/sessions" });
  return Object.fromEntries((listed.files ?? []).filter(file => file.name.endsWith(".jsonl")).map(file => [file.name, file.size]));
}
const rows = () => sidebar().locator("[data-session-state], [data-session-selected]").count();
const shot = (c, what) => page.screenshot({ path: join(shots, `${slug(c.record.name)}-${what}.png`) }).catch(() => {});

/** P29, the end check every case shares: no floating message, no raw technical text as a main sentence. */
async function endCheck(c) {
  const floating = await page.evaluate(() => [...document.querySelectorAll("body *")].filter(element => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.position === "fixed" && rect.width > 0 && rect.height > 0 && !element.closest('[role="dialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]')
      && /\S/.test(element.innerText ?? "") && (element.matches('[role="alert"], [role="status"], [data-sonner-toast], [data-toast]') || element.querySelector('[role="alert"]'));
  }).map(element => (element.innerText ?? "").trim().slice(0, 80)));
  if (floating.length) c.fail(`P29: a floating message is shown: ${floating.join(" | ")}`);
  for (const item of await problems()) {
    if (technical.test(item.text)) c.fail(`P29: raw technical text in a main sentence (${item.scope}): "${item.text}"`);
  }
}
/** A release case: its scenario, and the shared end check after it. */
const release = (name, scenario, why, run, langs = ["en", "ja"], world = null) => add(name, why, async c => {
  c.note(`scenario ${scenario}`);
  await run(c);
  if (!c.record.skipped) await endCheck(c);
}, { langs, scenario, world });

// ---- U4 / U9: starting the app and saved sessions ----

release("P1 Cold start opens the last session", "U4", "After the app is closed and opened again, loading ends on the session the person was in: its history and title are there and a message can be sent at once.", async c => {
  await freshSession();
  const first = ask();
  await typeAndSend(first.prompt);
  if (!await replyArrives(first.answer)) { c.fail("the first reply never arrived"); return; }
  await idle();
  const since = Date.now();
  const start = await reopen();
  const shown = await conversation().getByText(first.prompt, { exact: true }).first().waitFor({ timeout: 30_000 }).then(() => now() - start, () => null);
  if (shown === null) { c.fail("after the restart the last session's history was not shown within 30 s"); await shot(c, "no-history"); return; }
  c.metric("openToHistoryMs", shown);
  const ready = (await marks("loading.ready", since))[0];
  const started = (await marks("host.start", since))[0];
  if (ready && started) c.metric("hostStartToLoadingReadyMs", Date.parse(ready.ts) - Date.parse(started.ts));
  if (!(await conversationText()).includes(first.answer)) c.fail("the last session's reply is missing from its history");
  const next = ask();
  await typeAndSend(next.prompt);
  if (!await replyArrives(next.answer)) c.fail("a message sent right after the start got no reply within 30 s");
});

release("P2 Without a remembered session the folder's latest one opens", "U9", "When the window remembers only the folder, its most recent session opens with its whole history, tool results included.", async c => {
  await freshSession();
  await typeAndSend("TOOL read the readme please");
  await conversation().getByText("tool finished", { exact: false }).first().waitFor({ timeout: 30_000 }).catch(() => c.fail("the tool reply never arrived"));
  await idle();
  await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith("jouzu.chat.entry.")) localStorage.removeItem(key); });
  await reopen();
  await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith("jouzu.chat.entry.")) localStorage.removeItem(key); });
  await page.reload();
  const opened = await conversation().getByText("TOOL read the readme please", { exact: true }).first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
  if (!opened) { c.fail("the folder's latest session did not open"); await shot(c, "not-opened"); return; }
  const text = await conversationText();
  if (!text.includes("tool finished")) c.fail("the reply after the tool is missing from the history");
  if (!/README|Abnormal path workspace|read/i.test(text)) c.fail("the tool call or its result is missing from the history");
  if (/Unsupported content/i.test(text)) c.fail('the history shows "Unsupported content"');
});

/** P3 and P5: an old session of this folder, opened and sent to, stays one session with its title. */
release("P3 P5 Sending in an old session keeps it whole", "U9", "Opening an old session of the same folder and sending: the history stays, the title does not change, the same file is written, no new row appears; after a reload and a full restart it is still there.", async c => {
  await freshSession();
  const first = ask();
  await typeAndSend(first.prompt);
  if (!await replyArrives(first.answer)) { c.fail("the first reply never arrived"); return; }
  await idle();
  await reopen();
  await newSession().waitFor({ timeout: 60_000 });
  // Another session, so the old one is not the one on screen.
  await freshSession();
  const other = ask();
  await typeAndSend(other.prompt);
  await replyArrives(other.answer);
  await idle();
  const filesBefore = await sessionFiles();
  const rowsBefore = await rows();
  const row = sidebar().getByText(first.prompt, { exact: false }).first();
  const title = ((await row.textContent().catch(() => "")) ?? "").trim();
  const start = now();
  await row.click().catch(() => c.fail("the old session is not in the list"));
  const history = await conversation().getByText(first.prompt, { exact: true }).first().waitFor({ timeout: 10_000 }).then(() => now() - start, () => null);
  if (history === null) { c.fail("the old session's history did not show within 10 s"); return; }
  c.metric("clickToHistoryMs", history);
  if (history > 1_000) c.note(`history took ${history} ms (proposed line 1 s, not yet decided)`);
  const next = ask();
  await typeAndSend(next.prompt);
  if (!await replyArrives(next.answer)) c.fail("the old session got no reply within 30 s");
  await idle();
  const text = await conversationText();
  if (!text.includes(first.prompt) || !text.includes(first.answer)) c.fail("the earlier history disappeared after sending");
  const filesAfter = await sessionFiles();
  const added = Object.keys(filesAfter).filter(name => !(name in filesBefore));
  if (added.length) c.fail(`sending in the old session wrote a new session file: ${added.join(", ")}`);
  const grown = Object.keys(filesBefore).filter(name => filesAfter[name] > filesBefore[name]);
  if (grown.length !== 1) c.fail(`expected exactly one session file to grow, ${grown.length} did`);
  if (await rows() > rowsBefore) c.fail("a new row appeared in the list");
  const titleNow = ((await sidebar().getByText(first.prompt, { exact: false }).first().textContent().catch(() => "")) ?? "").trim();
  if (title && titleNow && !titleNow.includes(first.prompt)) c.fail(`the title changed: "${title}" -> "${titleNow}"`);
  // P5: a reload and a full restart.
  await page.reload();
  await newSession().waitFor({ timeout: 60_000 });
  if (!await sidebar().getByText(first.prompt, { exact: false }).count()) c.fail("P5: after a reload the old session is gone from the list");
  await reopen();
  await newSession().waitFor({ timeout: 60_000 });
  if (!await sidebar().getByText(first.prompt, { exact: false }).count()) c.fail("P5: after a full restart the old session is gone from the list");
});

/** The folder group in the sidebar whose name is `name`, and whether `text` is listed inside it. */
async function listedUnder(name, text) {
  return page.evaluate(({ name, text }) => {
    const groups = [...document.querySelectorAll("aside li, aside [role='treeitem'], aside [role='group'], aside section, aside div")]
      .filter(group => [...group.querySelectorAll("*")].some(node => node.childElementCount === 0 && node.textContent?.trim() === name));
    const smallest = groups.filter(group => (group.textContent ?? "").includes(text)).sort((a, b) => (a.textContent ?? "").length - (b.textContent ?? "").length)[0];
    if (!smallest) return false;
    // The smallest element holding both must not also hold another folder's name row first.
    return true;
  }, { name, text });
}

release("P4 An old session of another folder stays in its folder", "U9", "Opening an old session that belongs to another folder and sending: same as P3, and the session stays in its own folder (the file's header says which).", async c => {
  const made = await control("/workspace", { name: "second-folder" });
  if (!made.path) { c.fail("could not make a second folder"); return; }
  const adding = await host("/workspaces", { method: "POST", body: JSON.stringify({ paths: [made.path] }) });
  if (adding.status !== 200) { c.fail(`the host did not add the folder: ${adding.status} ${JSON.stringify(adding.body)}`); return; }
  await page.reload();
  await newSession().waitFor({ timeout: 60_000 });
  const folder = sidebar().getByText("second-folder", { exact: true }).first();
  if (!await folder.count()) { c.fail("the second folder is not in the list after adding it"); await shot(c, "no-folder"); return; }
  // A new session in that folder: the folder picker of the new-session page, as a person chooses it.
  await freshSession();
  await page.getByRole("button", { name: /^(Choose workspace|ワークスペースを選択|选择工作区|選擇工作區)$/ }).first().click().catch(() => c.fail("no folder picker on the new-session page"));
  await page.getByRole("menuitemradio").filter({ hasText: "second-folder" }).first().click().catch(() => c.fail("the second folder is not offered in the folder picker"));
  await textbox().waitFor({ timeout: 10_000 });
  const first = ask();
  await typeAndSend(first.prompt);
  if (!await replyArrives(first.answer)) { c.fail("the first reply in the second folder never arrived"); return; }
  await idle();
  const fileOf = async () => {
    for (const name of Object.keys(await sessionFiles())) {
      const file = await worldGet("/file", { path: `data/state/sessions/${name}` });
      if (file.text?.includes(first.prompt)) return { name, header: JSON.parse(file.text.split("\n")[0]) };
    }
    return null;
  };
  const before = await fileOf();
  if (!before) { c.fail("no session file holds the message"); return; }
  if (before.header.cwd !== made.path) c.fail(`the new session was saved for folder ${before.header.cwd}, not ${made.path}`);
  await reopen();
  await newSession().waitFor({ timeout: 60_000 });
  // Start from the first folder, as a person who opened the app there.
  await sidebar().getByText("Session from an older version", { exact: false }).first().click().catch(() => {});
  await sleep(1_000);
  const filesBefore = await sessionFiles();
  await sidebar().getByText(first.prompt, { exact: false }).first().click().catch(() => c.fail("the old session of the second folder is not in the list"));
  if (!await conversation().getByText(first.prompt, { exact: true }).first().waitFor({ timeout: 10_000 }).then(() => true, () => false)) { c.fail("its history did not show within 10 s"); return; }
  const next = ask();
  await typeAndSend(next.prompt);
  if (!await replyArrives(next.answer)) c.fail("the old session got no reply within 30 s");
  await idle();
  const after = await fileOf();
  if (!after || after.name !== before.name) c.fail("the message was not written to the session's own file");
  else if (after.header.cwd !== made.path) c.fail(`the session moved to folder ${after.header.cwd}`);
  const added = Object.keys(await sessionFiles()).filter(name => !(name in filesBefore));
  for (const name of added) {
    const file = await worldGet("/file", { path: `data/state/sessions/${name}` });
    const text = file.text ?? "";
    let header = {}; try { header = JSON.parse(text.split("\n")[0]); } catch {}
    // A file that holds this session's messages is a copy of it; a file with no messages is a prepared empty session.
    if (text.includes(first.prompt) || text.includes(next.prompt)) c.fail(`sending copied the session into a new file ${name} (folder ${header.cwd})`);
    else c.note(`a new session file without messages appeared meanwhile: ${name} (folder ${header.cwd})`);
  }
  if (!await listedUnder("second-folder", first.prompt)) c.fail("the session is not listed under its own folder");
  await page.reload();
  await newSession().waitFor({ timeout: 60_000 });
  if (!await listedUnder("second-folder", first.prompt)) c.fail("after a reload the session is not listed under its own folder");
});

// ---- U1: a new user ----

/** First-run page texts (the app's own words, en and ja; the other languages run the same steps). */
const FIRST = {
  en: { proceed: "Continue", signIn: "Sign in to Shisa.AI", service: "Service", custom: "Custom provider", providerId: "Provider ID", endpoint: "API base URL", modelId: "Model ID", apiKey: "API key", save: "Save", failed: "Installation failed" },
  ja: { proceed: "次へ", signIn: "Shisa.AI にログイン", service: "サービス", custom: "カスタムプロバイダー", providerId: "プロバイダー ID", endpoint: "API ベース URL", modelId: "モデル ID", apiKey: "API キー", save: "保存", failed: "インストールに失敗しました" },
}[lang];

release("N1 A new user's first run", "U1", "A person who never used Jouzu opens it: the app prepares its runtime by itself, asks for the languages, offers Shisa.AI sign-in and another provider, and after a provider is saved a new session answers, with no restart and nothing for the person to fix.", async c => {
  const state = await worldGet("/state");
  if (state.world !== "new-user") { c.skip("this case needs the new-user world (ABN_WORLD=new-user)"); return; }
  const start = now();
  const proceed = page.getByRole("button", { name: FIRST.proceed, exact: true });
  const signIn = page.getByRole("button", { name: FIRST.signIn, exact: true });
  const failed = page.getByText(FIRST.failed, { exact: false });
  // The runtime is prepared while the first-run pages show; the person only moves on.
  let languagePage = false;
  let failure = null;
  const until = now() + 9 * 60_000;
  while (now() < until) {
    if (await failed.first().isVisible().catch(() => false)) { failure = (await page.locator("main, body").first().innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 400); break; }
    if (await signIn.first().isVisible().catch(() => false)) break;
    if (await proceed.first().isVisible().catch(() => false) && await proceed.first().isEnabled().catch(() => false)) { languagePage = true; await proceed.first().click().catch(() => {}); }
    await sleep(500);
  }
  await shot(c, "first-run");
  if (failure) {
    c.fail(`the first run failed to prepare: ${failure}`);
    return;
  }
  if (!await signIn.first().isVisible().catch(() => false)) {
    const seen = (await page.locator("main").first().innerText().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 200);
    c.fail(`the first-run pages did not reach the model connection page within 9 min (language page shown: ${languagePage}; the page shows: "${seen}")`);
    return;
  }
  c.metric("toConnectPageMs", now() - start);
  if (!languagePage) c.fail("the first run did not ask for the languages before the model connection");
  // Another provider on the same page: the fixture, an OpenAI-compatible API.
  await page.getByRole("combobox", { name: FIRST.service, exact: true }).first().click();
  await page.getByRole("option", { name: FIRST.custom, exact: true }).click();
  await page.getByLabel(FIRST.providerId, { exact: true }).fill("first-run");
  await page.getByLabel(FIRST.endpoint, { exact: true }).fill(`${fixture}/v1`);
  await page.getByLabel(FIRST.modelId, { exact: true }).fill("deterministic");
  await page.getByLabel(FIRST.apiKey, { exact: true }).fill("fixture-key");
  const saved = now();
  await page.getByRole("button", { name: FIRST.save, exact: true }).click();
  if (!await newSession().waitFor({ timeout: 120_000 }).then(() => true, () => false)) { c.fail("after saving the provider the app did not open the chat within 2 min"); await shot(c, "after-save"); return; }
  c.metric("saveToChatMs", now() - saved);
  await freshSession();
  const first = ask();
  await typeAndSend(first.prompt);
  if (!await replyArrives(first.answer)) { c.fail("the first message got no reply within 30 s"); return; }
  await idle();
  c.metric("firstRunToFirstReplyMs", now() - start);
  const restarts = await marks("host.start");
  if (restarts.length > 1) c.fail(`the host started ${restarts.length} times during the first run`);
}, ["en", "ja"], "new-user");

// ---- U5: sign-in ----

const SIGN = {
  en: { providers: "Model providers", signIn: "Sign in to Shisa.AI", signOut: "Sign out", loginUrl: "Sign-in URL", deviceCode: "Device code", connected: "Connected to Shisa.AI." },
  ja: { providers: "モデルプロバイダー", signIn: "Shisa.AI にログイン", signOut: "ログアウト", loginUrl: "ログイン URL", deviceCode: "デバイスコード", connected: "Shisa.AI に接続しています。" },
}[lang];
const standIn = () => fetch(`${fixture}/__shisa`).then(response => response.json());

release("N4 Sign in to Shisa.AI and sign out", "U5", "In Settings the person signs in to Shisa.AI: the app shows the sign-in address and the device code, and once the device is approved in the browser it says it is connected, with no restart. Signing out tells Shisa.AI to revoke the device and the app shows the signed-out state again. Nothing is shown as an error. (The approval is made by a stand-in for the Shisa.AI platform, through the runtime's own address setting.)", async c => {
  const state = await worldGet("/state");
  if (state.world !== "shisa-stand-in") { c.skip("this case needs the Shisa.AI stand-in world (ABN_WORLD=shisa-stand-in)"); return; }
  const dialog = await openSettings(SIGN.providers);
  const signIn = dialog.getByRole("button", { name: SIGN.signIn, exact: true }).first();
  if (!await signIn.waitFor({ timeout: 15_000 }).then(() => true, () => false)) { c.fail("Settings offers no Shisa.AI sign-in"); await shot(c, "no-sign-in"); return; }
  const start = now();
  await signIn.click();
  // The device code and address the platform gave, shown for the person to check in the browser.
  const code = dialog.getByLabel(SIGN.deviceCode, { exact: true });
  const shownCode = await code.waitFor({ timeout: 15_000 }).then(() => code.inputValue(), () => null);
  const calls = await standIn();
  if (shownCode === null) c.fail("no device code was shown after Sign in");
  else if (shownCode !== `QA-${1000 + calls.issued}`) c.fail(`the device code shown (${shownCode}) is not the one Shisa.AI gave (QA-${1000 + calls.issued})`);
  const shownUrl = await dialog.getByLabel(SIGN.loginUrl, { exact: true }).inputValue().catch(() => null);
  if (!shownUrl?.startsWith("https://platform.shisa.ai/connect")) c.fail(`the sign-in address shown is not Shisa.AI's: ${shownUrl}`);
  // Approved by the stand-in on its second poll: the app says it is connected.
  const connected = await dialog.getByText(SIGN.connected, { exact: false }).first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
  if (!connected) { c.fail("30 s after the device was approved the app does not say it is connected"); await shot(c, "not-connected"); return; }
  c.metric("signInToConnectedMs", now() - start);
  await shot(c, "connected");
  const after = await standIn();
  if (!after.calls.some(call => call.path === "/device/link/ack" && call.bearer)) c.fail("the app did not confirm the link to Shisa.AI (no acknowledgement)");
  for (const item of await problems()) c.fail(`after signing in a problem is shown: "${item.text}"`);
  // Sign out.
  const signOut = dialog.getByRole("button", { name: SIGN.signOut, exact: true }).first();
  if (!await signOut.isVisible().catch(() => false)) { c.fail("no Sign out after signing in"); return; }
  await signOut.click();
  const back = await dialog.getByRole("button", { name: SIGN.signIn, exact: true }).first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
  if (!back) c.fail("30 s after Sign out the app does not show the signed-out state");
  const ended = await standIn();
  if (!ended.calls.some(call => call.path === "/device/link/revoke" && call.bearer)) c.fail("signing out did not ask Shisa.AI to revoke the device");
  for (const item of await problems()) c.fail(`after signing out a problem is shown: "${item.text}"`);
  await page.keyboard.press("Escape");
  // Everyday use is unchanged: the fixture model still answers.
  await judgeRecovers(c);
}, ["en", "ja"], "shisa-stand-in");

// ---- U4: new sessions, Stop, steer and the queue ----

release("P7 A new session answers at once", "U4", "A new session in this folder can be used at once: from the host taking the message to the reply's first output is under 2 s (playbook gate; target 0.5 s).", async c => {
  await chatSession();
  const since = Date.now();
  await freshSession();
  const next = ask();
  await typeAndSend(next.prompt);
  if (!await replyArrives(next.answer)) { c.fail("the new session got no reply within 30 s"); return; }
  const accepted = (await marks("message.accepted", since)).at(-1);
  const output = accepted && (await marks("message.first_output", since)).find(entry => entry.fields?.clientMessageId === accepted.fields?.clientMessageId);
  if (!accepted || !output) { c.fail("host.log has no message.accepted / message.first_output for the message"); return; }
  const ms = Date.parse(output.ts) - Date.parse(accepted.ts);
  c.metric("acceptedToFirstOutputMs", ms);
  if (ms > 2_000) c.fail(`a new session took ${ms} ms from accepted to first output (gate 2 s)`);
  else if (ms > 500) c.note(`over the 0.5 s target (${ms} ms)`);
});

release("P11 Stop while a tool runs", "U4", "Stop while a tool is running: the turn ends safely, the tool is shown as stopped (not running), nothing is shown as an error, and the next message is answered.", async c => {
  await freshSession();
  await typeAndSend("TOOLWAIT run the long command");
  // The status line names the running tool (tool names are not translated): "Running bash · 0:03".
  const running = await page.waitForFunction(() => /\bbash\b/.test(document.body.innerText), null, { timeout: 30_000 }).then(() => true, () => false);
  if (!running) { c.fail("the tool never showed as running"); await shot(c, "no-tool"); return; }
  await sleep(1_500);
  const start = now();
  await stopButton().click({ timeout: 3_000 }).catch(() => c.fail("no Stop to press while the tool runs"));
  const back = await idle(10_000);
  c.metric("stopToSendMs", now() - start);
  if (!back) c.fail("Send did not come back within 10 s after Stop");
  else if (now() - start > 2_000) c.fail(`Stop took ${now() - start} ms to give Send back (limit 2 s)`);
  await sleep(1_000);
  const shown = await problems();
  if (shown.length) c.fail(`Stop was shown as a problem: ${shown.map(item => item.text).join(" | ")}`);
  const spinning = await waiting();
  if (spinning.length) c.fail(`the stopped tool still shows as running: ${spinning.join(" | ")}`);
  await judgeRecovers(c);
});

release("N3 The app ends for an update while a reply runs", "U2", "An update ends the app while a reply is running (on Windows the installer ends the host and its runtimes at once, as here). When the app opens again the session is there, the interrupted message has an end the person can see (not still running, not waiting forever), and the next message is answered.", async c => {
  await freshSession();
  await typeAndSend("TOOLWAIT run the long command before the update");
  const running = await page.waitForFunction(() => /\bbash\b/.test(document.body.innerText), null, { timeout: 30_000 }).then(() => true, () => false);
  if (!running) { c.fail("the reply never started running"); return; }
  await sleep(1_500);
  // The update: the app ends with the reply running, and the new version starts on the same data.
  const since = Date.now();
  const start = await reopen();
  // Judge what the person sees once loading has ended (the app's own mark), not the loading screen.
  let ready = false;
  for (const until = now() + 60_000; now() < until && !ready; await sleep(250)) ready = (await marks("loading.ready", since)).length > 0;
  if (!ready) { c.fail("the app did not finish loading within 60 s after the update"); await shot(c, "loading"); return; }
  await newSession().waitFor({ timeout: 10_000 });
  c.metric("restartToReadyMs", now() - start);
  await sleep(1_000);
  const row = sidebar().getByText("TOOLWAIT run the long command before the update", { exact: false }).first();
  if (!await row.count()) { c.fail("the session with the interrupted reply is gone from the list"); return; }
  if (!await conversation().getByText("TOOLWAIT run the long command before the update", { exact: false }).first().isVisible().catch(() => false)) await row.click().catch(() => {});
  if (!await conversation().getByText("TOOLWAIT run the long command before the update", { exact: false }).first().waitFor({ timeout: 10_000 }).then(() => true, () => false)) { c.fail("the interrupted message is not in the session after the update"); return; }
  await shot(c, "after-update");
  // What the person sees about the interrupted message (evidence for triage).
  const held = await page.locator("[data-flow-hold]").allInnerTexts().catch(() => []);
  if (held.length) c.note(`after the update the app shows: ${held.map(text => text.replace(/\s+/g, " ").trim()).join(" | ")}`);
  if (await stopButton().isVisible().catch(() => false)) {
    const ended = await idle(15_000);
    if (!ended) c.fail("15 s after the app opened again the interrupted reply still shows as running");
  }
  await judgeNoEndlessWait(c);
  await judgeRecovers(c);
});

/** The queued-message area above the composer. */
const queue = () => page.getByRole("region", { name: named("queued") });

release("P27 Two messages sent while a reply runs are each used once", "U4", "While a reply runs, two messages go to the queue above the composer (not into the conversation yet) and the button says Steer; the runtime takes them in order, each shows once in the conversation, the model is asked about each once, and the queue empties.", async c => {
  await freshSession();
  await typeAndSend("LONG reply while two more are sent");
  await page.waitForFunction(selector => /line 3\b/.test(document.querySelector(selector)?.textContent ?? ""), '[aria-label="Conversation"], [aria-label="会話"]', { timeout: 30_000 }).catch(() => {});
  const one = "First steer: say ONE.";
  const two = "Second steer: say TWO.";
  await textbox().fill(one);
  const steerLabel = await sendButton().getAttribute("aria-label").catch(() => null) ?? await sendButton().textContent().catch(() => "");
  if (!new RegExp(`${more.steer}|Steer`, "i").test(steerLabel ?? "") && !await page.getByRole("button", { name: namedMore("steer") }).count()) c.fail(`the send button does not say Steer while a reply runs (shows "${steerLabel}")`);
  await sendButton().click();
  await textbox().fill(two);
  await sendButton().click();
  await sleep(500);
  const inQueue = [await queue().getByText(one).count(), await queue().getByText(two).count()];
  if (inQueue.some(count => count !== 1)) c.fail(`the two messages are not each in the queue once (${inQueue.join(", ")})`);
  const early = [await conversation().getByText(one, { exact: true }).count(), await conversation().getByText(two, { exact: true }).count()];
  if (early.some(count => count > 0)) c.fail("a queued message showed in the conversation before the runtime took it");
  await idle(60_000);
  await sleep(1_000);
  // The person's own messages: an exact match (the fixture's reply quotes them).
  const times = [await conversation().getByText(one, { exact: true }).count(), await conversation().getByText(two, { exact: true }).count()];
  if (times.some(count => count !== 1)) c.fail(`each message should show once in the conversation (shown ${times.join(", ")} times)`);
  const text = await conversationText();
  if (text.indexOf(one) > text.indexOf(two)) c.fail("the two messages are in the wrong order");
  const asked = await requests();
  for (const item of [one, two]) {
    const finals = asked.filter(request => request.text.includes(item)).length;
    if (finals > 1) c.fail(`the model was asked about "${item}" ${finals} times`);
    if (!asked.some(request => request.users?.some(user => user.includes(item)))) c.fail(`the model was never given "${item}"`);
  }
  if (await queue().getByText(one).count() || await queue().getByText(two).count()) c.fail("the queue did not empty");
});

release("P28 Queued messages can be deleted, edited and kept on Stop", "U4", "A queued message that is deleted is never sent; edit puts its text and image back in the composer; after Stop the rest wait with Continue and Discard, Continue sends once, and Stop is not shown as an error.", async c => {
  await freshSession();
  await typeAndSend("LONG reply while the queue is changed");
  await sleep(1_500);
  const gone = "Delete me: never send this.";
  const edited = "Edit me: back to the composer.";
  const kept = "Keep me: send once after Continue.";
  for (const item of [gone, edited, kept]) { await textbox().fill(item); await sendButton().click(); await sleep(300); }
  const rowOf = text => queue().locator("li, [role='listitem'], div").filter({ hasText: text }).last();
  // Delete
  const remove = rowOf(gone).getByRole("button", { name: /delete|remove|削除|删除|刪除/i }).first();
  if (await remove.count()) await remove.click(); else c.fail("no delete control on a queued message");
  // Edit
  const edit = rowOf(edited).getByRole("button", { name: /edit|編集|编辑|編輯/i }).first();
  if (await edit.count()) {
    await edit.click();
    await sleep(300);
    const value = await textbox().inputValue().catch(() => "");
    if (!value.includes(edited)) c.fail(`edit did not put the text back in the composer (composer shows "${value}")`);
    await textbox().fill("");
  } else c.fail("no edit control on a queued message");
  // Stop
  await stopButton().click({ timeout: 3_000 }).catch(() => c.fail("no Stop to press"));
  await idle(10_000);
  await sleep(800);
  const shown = await problems();
  if (shown.length) c.fail(`Stop was shown as a problem: ${shown.map(item => item.text).join(" | ")}`);
  const waitingRow = rowOf(kept);
  if (!await waitingRow.count()) c.fail("the remaining queued message is gone after Stop");
  const resume = queue().getByRole("button", { name: named("continue") }).first();
  if (!await resume.count()) c.fail("no Continue for the waiting message after Stop");
  if (!await queue().getByRole("button", { name: named("discard") }).count()) c.fail("no Discard for the waiting message after Stop");
  if (await resume.count()) { await resume.click(); await idle(30_000); await sleep(1_000); }
  const asked = await requests();
  if (asked.some(request => request.users?.some(user => user.includes(gone)))) c.fail("the deleted message was sent to the model");
  const keptTimes = asked.filter(request => request.text.includes(kept)).length;
  if (keptTimes !== 1) c.fail(`the kept message was asked ${keptTimes} times after Continue (expected once)`);
  const shownTimes = await conversation().getByText(kept, { exact: true }).count();
  if (shownTimes !== 1) c.fail(`the kept message shows ${shownTimes} times in the conversation (expected once)`);
});

// ---- U4 / U5 / U7: more than one session, switching, models, many steps, cut-off tools ----

/** The tools shown in the conversation, as their chips name them: "bash · running", "read · done", "bash · failed". */
const toolChips = () => conversation().locator('button[aria-label*=" · "]').evaluateAll(list => list.map(button => button.getAttribute("aria-label") ?? "").filter(label => !/^Thinking · /.test(label)));
/** Tools in the conversation still marked as running (a chip, or an opened card whose state dot pulses). */
const runningTools = async () => (await toolChips()).filter(label => / · running$/.test(label)).length + await conversation().locator("section span.rounded-full.animate-pulse").count();
/** The conversation's text with live timers taken out, to compare what is shown at two moments. */
const steady = async () => (await conversationText()).replace(/\d+:\d{2}/g, "").replace(/\s+/g, " ").trim();

release("P8 A new session while another one is running", "U4", "A new session can be opened while another reply runs; the running one is not affected and both rows show their state.", async c => {
  await freshSession();
  const long = "LONG reply while a new session starts";
  await typeAndSend(long);
  if (!await page.waitForFunction(selector => /line 2\b/.test(document.querySelector(selector)?.textContent ?? ""), SEL.conversation, { timeout: 30_000 }).then(() => true, () => false)) { c.fail("the long reply never started"); return; }
  await freshSession();
  const next = ask();
  await typeAndSend(next.prompt);
  if (!await replyArrives(next.answer)) c.fail("the new session got no reply within 30 s while the other one ran");
  const busy = await waitRowState(long, ["running"], 3_000);
  if (busy !== "running") c.fail(`while its reply runs, the first session's row shows "${busy}", not running`);
  const finished = await waitRowState(long, ["done", null], 25_000);
  if (finished === "running") c.fail("the first session's row still shows running 25 s later (its reply lasts about 12 s)");
  else c.note(`the first session's row after its reply ended: ${finished ?? "no state icon"}`);
  await sidebar().getByText(long, { exact: false }).first().click().catch(() => c.fail("the first session is not in the list"));
  const whole = await conversation().getByText("line 40", { exact: false }).first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
  if (!whole) c.fail("the first session's reply did not reach its end (line 40) while the other session was used");
  const own = await conversationText();
  if (own.includes(next.prompt)) c.fail("the second session's message shows in the first session");
});

release("P9 Switching away and back shows the reply as it was live", "U4", "Switching to another session and back, while a reply runs and after it ended, shows the same tool calls and results as live, never \"Unsupported content\".", async c => {
  await chatSession();
  const other = (await conversationText()).match(/What is \d+ × 7\?/)?.[0];
  await freshSession();
  const prompt = "STEPS:3 read the readme three times";
  await typeAndSend(prompt);
  if (!await page.waitForFunction(selector => /step 2 thinking/.test(document.querySelector(selector)?.textContent ?? ""), SEL.conversation, { timeout: 30_000 }).then(() => true, () => false)) { c.fail("the reply's steps never showed"); return; }
  const away = async () => {
    await sidebar().getByText(other ?? "×", { exact: false }).first().click();
    await sleep(500);
    const start = now();
    await sidebar().getByText(prompt, { exact: false }).first().click();
    const back = await conversation().getByText(prompt, { exact: true }).first().waitFor({ timeout: 10_000 }).then(() => now() - start, () => null);
    if (back !== null) c.metric("switchMs", back);
    return back !== null;
  };
  if (!await away()) { c.fail("switching back while the reply ran did not show the session within 10 s"); return; }
  if (!await conversation().getByText("all 3 steps done", { exact: false }).first().waitFor({ timeout: 30_000 }).then(() => true, () => false)) { c.fail("after switching back the reply never reached its end"); await shot(c, "no-end"); return; }
  await idle(10_000);
  await sleep(500);
  const live = await steady();
  for (const k of [1, 2, 3]) if (!live.includes(`step ${k} thinking`)) c.fail(`step ${k} is missing after switching back during the reply`);
  if (!await away()) { c.fail("switching back after the reply ended did not show the session within 10 s"); return; }
  await sleep(1_000);
  const after = await steady();
  if (after !== live) c.fail(`after switching away and back the reply looks different: live "${live.slice(-300)}" / now "${after.slice(-300)}"`);
  if (/Unsupported content/i.test(after)) c.fail('the reply shows "Unsupported content" after switching back');
  if (await runningTools()) c.fail("a tool of the finished reply shows as running after switching back");
});

release("P12 Switching the model", "U5", "The model list shows only chat models, also before the first message; the next turn uses the chosen model and the model shown is the one used.", async c => {
  await freshSession();
  const button = page.getByRole("button", { name: { en: "Model", ja: "モデル", "zh-Hans": "模型", "zh-Hant": "模型" }[lang], exact: true }).first();
  if (!await button.isVisible().catch(() => false)) { c.fail("the new session shows no model button before the first message"); await shot(c, "no-model"); return; }
  await button.click();
  const items = page.getByRole("menuitemradio");
  await items.first().waitFor({ timeout: 10_000 }).catch(() => {});
  const listed = (await items.allInnerTexts()).map(text => text.replace(/\s+/g, " ").trim());
  if (!listed.length) { c.fail("the model list is empty"); await shot(c, "empty"); return; }
  c.note(`models listed: ${listed.join(" | ")}`);
  const notChat = listed.filter(text => /translate|embedding|image/i.test(text));
  if (notChat.length) c.fail(`the model list offers models that are not chat models: ${notChat.join(" | ")}`);
  const second = items.filter({ hasText: "Fixture second model" }).first();
  if (!await second.count()) { c.fail("the second model of the provider is not in the list"); return; }
  const start = now();
  await second.click();
  const shown = await page.waitForFunction(selector => /Fixture second model/.test(document.querySelector(selector)?.textContent ?? ""), SEL.composer, { timeout: 10_000 }).then(() => now() - start, () => null);
  if (shown === null) c.fail("the composer does not show the chosen model within 10 s");
  else c.metric("switchMs", shown);
  const before = (await requests()).length;
  const next = ask();
  await typeAndSend(next.prompt);
  if (!await replyArrives(next.answer)) { c.fail("no reply after choosing the model"); return; }
  const used = (await requests()).slice(before).filter(request => request.text.includes(next.prompt)).map(request => request.model);
  if (!used.length) c.fail("the provider was not asked");
  else if (used.some(model => model !== "second")) c.fail(`the provider was asked with model ${used.join(", ")}, not the chosen one (second)`);
  await idle();
  if (!/Fixture second model/.test(await page.locator(SEL.composer).first().innerText().catch(() => ""))) c.fail("after the reply the composer no longer shows the model that was used");
});

release("P23 A reply with many steps keeps every step on screen", "U4", "In a reply of five or more steps (thinking, tool, thinking) each step's reasoning and tool stay on screen; after a reload and a restart it looks the same.", async c => {
  await freshSession();
  const prompt = "STEPS:6 read the readme six times";
  const start = now();
  await typeAndSend(prompt);
  const ended = await conversation().getByText("all 6 steps done", { exact: false }).first().waitFor({ timeout: 90_000 }).then(() => true, () => false);
  c.metric("stepWaitMs", now() - start);
  if (!ended) { c.fail("the 6-step reply did not end within 90 s"); await shot(c, "not-ended"); return; }
  await idle(10_000);
  const check = async when => {
    const text = await conversationText();
    const missing = [1, 2, 3, 4, 5, 6].filter(k => !text.includes(`step ${k} thinking`));
    if (missing.length) c.fail(`${when}: the thinking of step ${missing.join(", ")} is not on screen`);
    const tools = (await toolChips()).length;
    if (tools < 6) c.fail(`${when}: ${tools} tools on screen, 6 expected`);
    if (await runningTools()) c.fail(`${when}: a tool shows as running after the reply ended`);
    return text.replace(/\s+/g, " ").trim();
  };
  const live = await check("at the end of the reply");
  await page.reload();
  await newSession().waitFor({ timeout: 60_000 });
  if (!await conversation().getByText(prompt, { exact: true }).first().isVisible().catch(() => false)) await sidebar().getByText(prompt, { exact: false }).first().click().catch(() => {});
  await conversation().getByText("all 6 steps done", { exact: false }).first().waitFor({ timeout: 15_000 }).catch(() => c.fail("after a reload the reply is not shown"));
  const reloaded = await check("after a reload");
  if (reloaded !== live) c.fail("after a reload the reply looks different from the live one");
  await reopen();
  await newSession().waitFor({ timeout: 60_000 });
  if (!await conversation().getByText(prompt, { exact: true }).first().isVisible().catch(() => false)) await sidebar().getByText(prompt, { exact: false }).first().click().catch(() => {});
  await conversation().getByText("all 6 steps done", { exact: false }).first().waitFor({ timeout: 15_000 }).catch(() => c.fail("after a restart the reply is not shown"));
  const restarted = await check("after a restart");
  if (restarted !== live) c.fail("after a restart the reply looks different from the live one");
});

release("P26 A tool cut off when the runtime ends shows as interrupted", "U7", "A tool cut off when the runtime ends shows as interrupted or failed, never still running, and the next turn works; in an old session a tool call without a result also shows as interrupted. (Stop while a tool runs is P11.)", async c => {
  await freshSession();
  const prompt = "TOOLWAIT run the long command before the runtime ends";
  await typeAndSend(prompt);
  const running = await page.waitForFunction(() => /\bbash\b/.test(document.body.innerText), null, { timeout: 30_000 }).then(() => true, () => false);
  if (!running) { c.fail("the tool never showed as running"); await shot(c, "no-tool"); return; }
  await sleep(1_500);
  const killed = await control("/runtime/kill", { which: "all" });
  c.note(`runtimes ended: ${JSON.stringify(killed.killed ?? killed)}`);
  const settled = await idle(20_000);
  if (!settled) c.fail("20 s after the runtime ended the reply still shows as running");
  await sleep(1_000);
  if (await runningTools()) c.fail("the cut-off tool still shows as running");
  const spinning = await waiting();
  if (spinning.length) c.fail(`something still shows as running: ${spinning.join(" | ")}`);
  c.note(`the cut-off tool shows: ${(await toolChips()).join(" | ") || "(no tool)"}`);
  await shot(c, "cut-off");
  await judgeRecovers(c);
  // An old session whose tool call has no result, as a crash of an earlier version leaves it.
  const state = await worldGet("/state");
  const at = "2026-01-09T00:00:00.000Z";
  const lines = [
    { type: "session", version: 3, id: "tool-without-result", timestamp: at, cwd: state.workspace },
    { type: "message", id: "a1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: "Old session with a tool cut off" }] } },
    { type: "message", id: "a2", parentId: "a1", timestamp: at, message: { role: "assistant", content: [{ type: "toolCall", id: "old-call-1", name: "bash", arguments: { command: "sleep 30" } }], provider: "fixture", model: "deterministic", stopReason: "toolUse" } },
  ];
  await control("/file", { path: "data/state/sessions/2026-01-09T00-00-00-000Z_tool-without-result.jsonl", text: `${lines.map(line => JSON.stringify(line)).join("\n")}\n` });
  await reopen();
  await newSession().waitFor({ timeout: 60_000 });
  const row = sidebar().getByText("Old session with a tool cut off", { exact: false }).first();
  if (!await row.waitFor({ timeout: 10_000 }).then(() => true, () => false)) { c.fail("the old session is not in the list"); return; }
  await row.click();
  if (!await conversation().getByText("Old session with a tool cut off", { exact: true }).first().waitFor({ timeout: 10_000 }).then(() => true, () => false)) { c.fail("the old session did not open"); return; }
  await sleep(1_000);
  await shot(c, "old-session");
  if (await runningTools()) c.fail("in the old session the tool without a result shows as running");
  if (await stopButton().isVisible().catch(() => false)) c.fail("opening the old session shows Stop, as if its reply still ran");
  const shownOld = await toolChips();
  c.note(`the old session's tool shows: ${shownOld.join(" | ") || "(no tool)"}; status line: ${(await page.locator('[role="status"]').allInnerTexts().catch(() => [])).join(" | ") || "(none)"}`);
  if (!shownOld.length) c.fail("the old session's tool call is not shown at all");
});

release("P13 A question or approval from the agent", "U4", "When the agent needs an approval for a tool call, the app shows it with its choices and the session's row says it waits; the reply continues after Approve, and after Deny the reply ends without running the tool. (The review is switched on for the read tool in the saved tool settings, as the image tool has it by default.)", async c => {
  await control("/file", { path: "data/agent/tools.json", text: JSON.stringify({ reviewTools: ["read"] }) });
  const ask1 = async (prompt, choice) => {
    await freshSession();
    await typeAndSend(prompt);
    const dialog = page.getByRole("dialog").filter({ hasText: /read|README/ }).first();
    if (!await dialog.waitFor({ timeout: 30_000 }).then(() => true, () => false)) { c.fail(`no approval was shown for the tool call (${choice})`); await shot(c, `no-approval-${choice}`); return false; }
    const buttons = (await dialog.getByRole("button").allInnerTexts()).map(text => text.trim()).filter(Boolean);
    c.note(`approval choices: ${buttons.join(" | ")}`);
    const row = await waitRowState(prompt, ["waiting"], 5_000);
    if (row !== "waiting") c.fail(`while the approval waits, the session's row shows "${row}", not waiting`);
    const button = dialog.getByRole("button", { name: choice === "approve" ? /^(Approve|承認|批准|核准)$/ : /^(Deny|拒否|拒绝|拒絕)$/ }).first();
    if (!await button.count()) { c.fail(`the approval has no ${choice} choice`); return false; }
    await button.click();
    if (await dialog.isVisible().catch(() => false) && !await dialog.waitFor({ state: "hidden", timeout: 10_000 }).then(() => true, () => false)) c.fail(`the approval stayed on screen after ${choice}`);
    return true;
  };
  if (await ask1("TOOL read the readme with approval", "approve")) {
    if (!await conversation().getByText("tool finished", { exact: false }).first().waitFor({ timeout: 30_000 }).then(() => true, () => false)) c.fail("after Approve the reply did not continue to its end");
    await idle(10_000);
  }
  const before = (await requests()).length;
  if (await ask1("TOOL read the readme but deny it", "deny")) {
    const ended = await idle(30_000);
    if (!ended) c.fail("after Deny the reply did not end within 30 s");
    const after = (await requests()).slice(before);
    if (!after.some(request => request.text.includes("deny it")) ) c.fail("the provider was never asked");
    if (await runningTools()) c.fail("after Deny the tool shows as running");
  }
  await control("/file", { path: "data/agent/tools.json", remove: true });
  await judgeRecovers(c);
});

/** A saved session of about `megabytes` MB: many turns of plain text, as a long project leaves it. */
function largeSession(workspace, megabytes) {
  const at = "2026-01-08T00:00:00.000Z";
  const lines = [JSON.stringify({ type: "session", version: 3, id: "large-session", timestamp: at, cwd: workspace })];
  const filler = "This line is part of a very large old session. ".repeat(40);
  let parent = null;
  let size = lines[0].length;
  for (let turn = 1; size < megabytes * 1_000_000; turn += 1) {
    const user = { type: "message", id: `u${turn}`, parentId: parent, timestamp: at, message: { role: "user", content: [{ type: "text", text: turn === 1 ? "Large old session" : `Question ${turn}` }] } };
    const answer = { type: "message", id: `a${turn}`, parentId: `u${turn}`, timestamp: at, message: { role: "assistant", content: [{ type: "text", text: `Answer ${turn}. ${filler.repeat(5)}` }], provider: "fixture", model: "deterministic", stopReason: "stop" } };
    parent = `a${turn}`;
    for (const line of [user, answer]) { const text = JSON.stringify(line); lines.push(text); size += text.length + 1; }
  }
  // A long session has been compacted: the model is given a summary and the latest turn, not 20 MB.
  lines.push(JSON.stringify({ type: "compaction", id: "c1", parentId: parent, timestamp: at, summary: "The person asked many questions about the project; each was answered.", firstKeptEntryId: `u${Number(parent.slice(1))}`, tokensBefore: 30_000 }));
  return { text: `${lines.join("\n")}\n`, last: parent };
}

release("P6 A very large old session opens and answers", "U9", "The history of a saved session of 20 MB or more is readable at once, sending does not freeze the window, the status first says it is starting, and the reply arrives. (The session is generated, never a person's real one.)", async c => {
  const state = await worldGet("/state");
  const large = largeSession(state.workspace, 20);
  await control("/file", { path: "data/state/sessions/2026-01-08T00-00-00-000Z_large-session.jsonl", text: large.text });
  c.note(`session file: ${(large.text.length / 1e6).toFixed(1)} MB`);
  await reopen();
  await newSession().waitFor({ timeout: 60_000 });
  const row = sidebar().getByText("Large old session", { exact: false }).first();
  if (!await row.waitFor({ timeout: 15_000 }).then(() => true, () => false)) { c.fail("the large session is not in the list"); await shot(c, "not-listed"); return; }
  const start = now();
  await row.click();
  const lastAnswer = `Answer ${large.last.slice(1)}.`;
  const shown = await conversation().getByText(lastAnswer, { exact: false }).first().waitFor({ timeout: 30_000 }).then(() => now() - start, () => null);
  if (shown === null) { c.fail("the large session's latest history did not show within 30 s"); await shot(c, "no-history"); return; }
  c.metric("sessionHistoryMs", shown);
  if (shown > 1_000) c.note(`history took ${shown} ms (proposed line 1 s, not decided)`);
  // The window must answer while the session is attached: the longest gap between two answers of the page.
  let longest = 0;
  let polling = true;
  const poll = (async () => { let last = now(); while (polling) { await page.evaluate(() => 1).catch(() => {}); const at = now(); longest = Math.max(longest, at - last); last = at; await sleep(100); } })();
  const sent = now();
  const next = ask();
  await typeAndSend(next.prompt);
  let starting = false;
  const startWords = /Starting session|セッションを開始しています|正在启动会话|正在啟動工作階段/;
  const arrived = await (async () => {
    for (const until = now() + 120_000; now() < until; await sleep(150)) {
      if (startWords.test(await page.locator('[role="status"]').allInnerTexts().then(list => list.join(" ")).catch(() => ""))) starting = true;
      if (await replyArrives(next.answer, 1)) return now() - sent;
    }
    return null;
  })();
  polling = false;
  await poll;
  c.metric("longestFreezeMs", longest);
  if (arrived === null) { c.fail("the large session got no reply within 2 min"); return; }
  c.metric("firstOutputMs", arrived);
  if (!starting) c.note("the status line was not seen saying the session is starting");
  if (longest > 1_000) c.note(`the window did not respond for ${longest} ms while the large session started (no line decided)`);
});

release("P10 A background session keeps its state in the list", "U4", "A session nobody is looking at keeps its state up to date in the list (running, then finished) and is complete when opened again.", async c => {
  await chatSession();
  const other = (await conversationText()).match(/What is \d+ × 7\?/)?.[0] ?? "×";
  await freshSession();
  const long = "LONG reply in the background";
  const sent = now();
  await typeAndSend(long);
  await page.waitForFunction(selector => /line 2\b/.test(document.querySelector(selector)?.textContent ?? ""), SEL.conversation, { timeout: 30_000 }).catch(() => {});
  await sidebar().getByText(other, { exact: false }).first().click().catch(() => c.fail("the other session is not in the list"));
  await sleep(500);
  const running = await waitRowState(long, ["running"], 3_000);
  if (running !== "running") c.fail(`in the background the session's row shows "${running}", not running`);
  const done = await waitRowState(long, ["done", null], 40_000);
  if (done === "running") { c.fail("40 s later the background session's row still shows running (its reply lasts about 12 s)"); return; }
  c.metric("stateDelayMs", now() - sent);
  c.note(`row after the reply ended: ${done ?? "no state icon"} (the reply itself lasts about 12 s)`);
  await sidebar().getByText(long, { exact: false }).first().click();
  if (!await conversation().getByText("line 40", { exact: false }).first().waitFor({ timeout: 10_000 }).then(() => true, () => false)) c.fail("opened again, the background reply is not complete (no line 40)");
});

release("P15 Thirty open sessions still work", "U4", "With 30 sessions, the list shows them all, switching between them shows each one's history, and messages sent in several of them are answered.", async c => {
  const made = [];
  for (let k = 0; k < 30; k += 1) {
    await freshSession();
    const item = ask();
    await typeAndSend(item.prompt);
    if (!await replyArrives(item.answer)) { c.fail(`session ${k + 1} of 30 got no reply`); return; }
    await idle(10_000);
    made.push(item);
  }
  await sleep(1_000);
  const listed = (await Promise.all(made.map(item => sidebar().getByText(item.prompt, { exact: false }).count()))).filter(Boolean).length;
  if (listed < 30) c.fail(`only ${listed} of the 30 sessions are in the list`);
  const switches = [];
  for (const index of [0, 7, 15, 22, 29]) {
    const item = made[index];
    const start = now();
    await sidebar().getByText(item.prompt, { exact: false }).first().click().catch(() => {});
    const shown = await conversation().getByText(item.prompt, { exact: true }).first().waitFor({ timeout: 10_000 }).then(() => now() - start, () => null);
    if (shown === null) { c.fail(`session ${index + 1} did not show its history within 10 s`); continue; }
    switches.push(shown);
    if (index % 2 === 0) {
      const next = ask();
      const sent = now();
      await typeAndSend(next.prompt);
      if (!await replyArrives(next.answer)) c.fail(`session ${index + 1} got no reply within 30 s`);
      else c.metric(`firstOutputMs.${index + 1}`, now() - sent);
      await idle(10_000);
    }
  }
  if (switches.length) c.metric("switchMs", Math.max(...switches));
  const stuck = [];
  for (const item of made) if (await rowState(item.prompt) === "running") stuck.push(item.prompt);
  if (stuck.length) c.fail(`${stuck.length} finished sessions still show as running`);
});

release("P16 Reloading the window ten times and quitting leaves nothing behind", "U4", "After ten window reloads the app works and no runtime piles up; when the person quits, the host and every runtime it started end.", async c => {
  await chatSession();
  await sleep(2_000);
  const start = await worldGet("/state");
  c.metric("processCount.start", start.runtimes.length);
  if (start.handles !== null) c.metric("handleCount.start", start.handles);
  const counts = [];
  for (let k = 1; k <= 10; k += 1) {
    await page.reload();
    if (!await newSession().waitFor({ timeout: 60_000 }).then(() => true, () => false)) { c.fail(`after reload ${k} the app did not load within 60 s`); return; }
    await sleep(1_000);
    counts.push((await worldGet("/state")).runtimes.length);
  }
  c.note(`runtimes after each reload: ${counts.join(", ")} (${start.runtimes.length} before)`);
  const next = ask();
  await typeAndSend(next.prompt);
  if (!await replyArrives(next.answer)) c.fail("after ten reloads a message got no reply within 30 s");
  await idle(10_000);
  await sleep(3_000);
  const after = await worldGet("/state");
  c.metric("processCount.after", after.runtimes.length);
  if (after.handles !== null) c.metric("handleCount.after", after.handles);
  // Piling up: the count still rising over the last reloads (a pool that fills and stays is recorded).
  if (counts[9] > counts[6]) c.fail(`runtimes pile up with reloads: ${counts.join(", ")}`);
  else if (counts[9] > start.runtimes.length) c.note(`after the reloads ${counts[9]} runtimes run, ${start.runtimes.length} before; the count stopped rising after reload ${counts.indexOf(counts[9]) + 1}`);
  if (start.handles !== null && after.handles !== null && after.handles > start.handles) c.note(`the host holds ${after.handles - start.handles} more handles than before the reloads (no line decided)`);
  const quit = await control("/host/quit", {});
  if (quit.unsupported) { c.skip(`quitting is not available here: ${quit.unsupported}`); return; }
  c.metric("quitMs", quit.stoppedMs);
  if (quit.left?.length) c.fail(`after quitting, ${quit.left.length} of ${quit.before} processes were still running 15 s later: ${quit.left.map(row => row.name).join(", ")}`);
  // The app opens again for the end check.
  await page.goto(quit.url);
  await page.evaluate(value => localStorage.setItem("jouzu.ui.language", value), lang);
  await page.reload();
  await newSession().waitFor({ timeout: 60_000 }).catch(() => c.fail("the app did not open again after quitting"));
});

/** The status line's words while a reply runs (the line above the composer). */
const statusWords = () => page.locator('[role="status"]').allInnerTexts().then(list => list.map(text => text.replace(/\s+/g, " ").trim()).filter(Boolean)).catch(() => []);
const PHASE = {
  en: { waiting: "Waiting for model", thinking: /Thinking|Reasoning/, tool: "Running bash", writing: "Writing", working: "Working…" },
  ja: { waiting: "モデルを待っています", thinking: /思考|推論/, tool: "bash を実行中", writing: "書き込み中", working: "作業中…" },
}[lang];

release("P24 The status line says what the reply is doing", "U4", "While a reply runs, the status line says what is happening: waiting for the model (and for how long), thinking, which tool runs (and for how long), writing; never a bare Working.", async c => {
  await freshSession();
  await typeAndSend("PHASES show every phase");
  const seen = new Set();
  const bare = [];
  for (const until = now() + 40_000; now() < until; await sleep(150)) {
    for (const text of await statusWords()) {
      seen.add(text);
      if (text === PHASE.working) bare.push(text);
    }
    const reasoning = await page.getByRole("button", { name: PHASE.thinking }).count().catch(() => 0);
    if (reasoning) seen.add("(reasoning row)");
    if (await conversation().getByText("phases done", { exact: false }).count() && await idle(500)) break;
  }
  const words = [...seen];
  c.note(`status line showed: ${words.join(" | ")}`);
  const has = test => words.some(text => typeof test === "string" ? text.includes(test) : test.test(text));
  if (!has(PHASE.waiting)) c.fail("the status line never said it was waiting for the model");
  else if (!words.some(text => text.includes(PHASE.waiting) && /\d+:\d{2}/.test(text))) c.fail("waiting for the model was shown without how long");
  if (!has(PHASE.thinking) && !seen.has("(reasoning row)")) c.fail("the status line never said the model was thinking");
  if (!has(PHASE.tool)) c.fail("the status line never named the running tool (bash)");
  else if (!words.some(text => text.includes(PHASE.tool) && /\d+:\d{2}/.test(text))) c.fail("the running tool was shown without how long");
  if (!has(PHASE.writing)) c.fail("the status line never said the reply was being written");
  if (bare.length) c.fail(`the status line showed a bare "${PHASE.working}" ${bare.length} times`);
  if (!await conversation().getByText("phases done", { exact: false }).count()) c.fail("the reply did not reach its end within 40 s");
});

const RETRY = { en: "Model request failed, retrying", ja: "モデルへのリクエストが失敗しました。再試行中" }[lang];
const COMPACT = { en: "Compacting context", ja: "コンテキストを圧縮中" }[lang];

release("P25 Automatic retry and context compaction are shown", "U6", "A failed model request that is retried shows that it failed and is retried, with the count and the reason, and the reply arrives; compaction of a full context shows as such; neither looks stuck.", async c => {
  await freshSession();
  await post(fixture, "/__fault", { status: 500, times: 1 });
  const first = ask();
  await typeAndSend(first.prompt);
  const seen = new Set();
  let answered = false;
  for (const until = now() + 60_000; now() < until && !answered; await sleep(150)) {
    for (const text of await statusWords()) seen.add(text);
    answered = await replyArrives(first.answer, 1);
  }
  await post(fixture, "/__fault", {});
  const retryLines = [...seen].filter(text => text.includes(RETRY));
  c.note(`status line during the failed request: ${[...seen].join(" | ") || "(nothing)"}`);
  if (!answered) c.fail("after one failed request the reply did not arrive within 60 s");
  if (!retryLines.length) c.fail("the retry was not shown on the status line");
  else {
    if (!retryLines.some(text => /\d+\/\d+/.test(text))) c.fail(`the retry was shown without its count: "${retryLines[0]}"`);
    if (!retryLines.some(text => /\(.+\)/.test(text))) c.fail(`the retry was shown without its reason: "${retryLines[0]}"`);
  }
  await idle(10_000);
  for (const item of await problems()) c.fail(`after the retried request a problem is shown: "${item.text}"`);
  // Compaction: the provider reports the context nearly full; the runtime compacts after that
  // turn or before the next one. The status line is watched from the FULL message on.
  const during = new Set();
  const watch = async (until, done) => {
    for (; now() < until; await sleep(100)) {
      for (const text of await statusWords()) during.add(text);
      if (await page.getByText(COMPACT, { exact: false }).count().catch(() => 0)) during.add(COMPACT);
      if (await done()) return true;
    }
    return false;
  };
  // A session of its own: the retry above left a context edit, after which the runtime estimates
  // the context from the text instead of the provider's count.
  await freshSession();
  // Older turns with enough text to compact (the latest turns are always kept).
  await typeAndSend("BULK write a long answer");
  await conversation().getByText("bulk answer.", { exact: false }).first().waitFor({ timeout: 30_000 }).catch(() => c.fail("the BULK reply never arrived"));
  await idle(30_000);
  await typeAndSend("FULL fill the context");
  if (!await watch(now() + 30_000, () => conversation().getByText("the context is nearly full", { exact: false }).count())) c.fail("the FULL reply never arrived");
  await watch(now() + 5_000, () => Promise.resolve(false));
  const next = ask();
  await typeAndSend(next.prompt);
  const done = await watch(now() + 90_000, () => replyArrives(next.answer, 1));
  c.note(`status line around compaction: ${[...during].join(" | ") || "(nothing)"}`);
  // Whether the runtime compacted at all, from the session's own file.
  let compacted = false;
  for (const name of Object.keys(await sessionFiles())) {
    const file = await worldGet("/file", { path: `data/state/sessions/${name}` });
    if (file.text?.includes("FULL fill the context") && /"type":"compaction"/.test(file.text)) compacted = true;
  }
  c.note(`the session file has a compaction entry: ${compacted}`);
  if (!done) c.fail("after the context was full the next message got no reply within 90 s");
  if (![...during].some(text => text.includes(COMPACT))) c.fail(compacted ? `the runtime compacted the context but the app never said so ("${COMPACT}"); the status line showed: ${[...during].join(" | ")}` : "the context was reported nearly full (30,000 of 32,000 tokens) but no compaction happened or was shown");
  const raw = [...during].filter(text => /pi-vcc|\btok\b|summarized \d/.test(text));
  if (raw.length) c.fail(`the runtime's own compaction note is shown to the person as is: "${raw[0]}"`);
  await judgeNoEndlessWait(c);
});

await runCases();
