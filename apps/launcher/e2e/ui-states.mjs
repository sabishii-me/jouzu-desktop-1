import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * UI state tour: records every screen of the app in the states a person meets, for an
 * audit of duplicated and contradictory information. It judges nothing; each state is a
 * screenshot plus the words each part of the window shows at that moment
 * (header, sidebar, conversation, composer, open dialog or menu, status lines, problems).
 *
 * Runs in the abnormal exam's world (e2e-runtime/abnormal-exam.mjs, ABN_PLAYBOOK=ui-states.mjs),
 * so it can put the app in states that need a broken provider, runtime or file.
 * It never presses an update, install, sign-out or remove button.
 *
 * Inputs: PLAYBOOK_CDP, PLAYBOOK_FIXTURE, PLAYBOOK_WORLD, PLAYBOOK_LANG, PLAYBOOK_ONLY,
 * PLAYBOOK_OUT, PLAYBOOK_SHOTS (as in abnormal-playbook.mjs).
 */
const lang = process.env.PLAYBOOK_LANG ?? "en";
const fixture = process.env.PLAYBOOK_FIXTURE;
const world = process.env.PLAYBOOK_WORLD;
const only = process.env.PLAYBOOK_ONLY ?? "";
const shots = process.env.PLAYBOOK_SHOTS ?? process.env.TEMP ?? ".";
mkdirSync(shots, { recursive: true });

async function connect(url, timeout = 60_000) {
  const until = Date.now() + timeout;
  for (;;) {
    try {
      const connected = await chromium.connectOverCDP(url);
      const found = connected.contexts().flatMap(context => context.pages()).find(item => !item.url().startsWith("devtools:"));
      if (found) return { connected, found };
      await connected.close();
    } catch (error) { if (Date.now() > until) throw error; }
    if (Date.now() > until) throw new Error(`no app page at ${url}`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}
const { connected: browser, found: page } = await connect(process.env.PLAYBOOK_CDP ?? "http://127.0.0.1:9223");
const result = { startedAt: new Date().toISOString(), lang, cases: [], errors: [], states: [] };
const now = () => Date.now();
const sleep = ms => page.waitForTimeout(ms);
page.on("pageerror", error => result.errors.push(`page error: ${String(error)}`));

const post = (base, path, body = {}) => fetch(base + path, { method: "POST", body: JSON.stringify(body) }).then(response => response.json());
const fault = body => post(fixture, "/__fault", body);
const control = (path, body) => post(world, path, body);

// Accessible names in every interface language (src/chat-text.ts, src/i18n.ts).
const any = (...texts) => new RegExp(`^(${texts.map(text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`);
const N = {
  newSession: any("New session", "新しいセッション", "新会话", "新工作階段"),
  settings: any("Settings", "設定", "设置"),
  stop: any("Stop", "停止"),
  retry: any("Retry", "再試行", "重试", "重試"),
  composer: ["Message composer", "メッセージ入力", "消息输入框", "訊息輸入框"],
  conversation: ["Conversation", "会話", "对话", "對話"],
  workspaces: ["Workspaces", "ワークスペース", "工作区", "工作區"],
  message: /message|メッセージ|消息|訊息/i,
  artifacts: any("Toggle artifacts panel", "アーティファクトパネルの切り替え", "切换产物面板", "切換產物面板"),
  split: any("Split pane", "ペインを分割", "分割窗格", "拆分窗格"),
  archived: any("Show archived sessions", "アーカイブ済みセッションを表示", "显示已归档会话", "顯示已封存工作階段"),
  channel: /update channel|更新チャネル|更新通道/i,
  // Never pressed by this tour.
  forbidden: /update|install|更新|インストール|安装|安裝|sign out|サインアウト|退出|登出|remove|削除|删除|刪除|delete|uninstall|reset/i,
};
const css = list => `:is(${list.map(text => `[aria-label="${text}"]`).join(", ")})`;
const SEL = { composer: css(N.composer), conversation: css(N.conversation), workspaces: css(N.workspaces) };
const newSession = () => page.getByRole("button", { name: N.newSession }).first();
const textbox = () => page.getByRole("textbox", { name: N.message }).first();
const sendButton = () => page.locator(`${SEL.composer} button[type="submit"]`).first();
const stopButton = () => page.locator(SEL.composer).getByRole("button", { name: N.stop }).first();
const conversationText = async () => (await page.locator(SEL.conversation).first().textContent().catch(() => "")) ?? "";
const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70);

/** What each part of the window says right now. */
async function words() {
  return page.evaluate(SEL => {
    const visible = element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden"; };
    const text = element => (element && visible(element) ? (element.innerText ?? "").replace(/\n{2,}/g, "\n").trim() : null);
    const names = root => root ? [...root.querySelectorAll("button, [role=combobox], [role=tab], a")].filter(visible).map(element => {
      const label = element.getAttribute("aria-label") || element.getAttribute("title") || (element.innerText ?? "").trim();
      const state = [element.disabled || element.getAttribute("aria-disabled") === "true" ? "disabled" : "", element.getAttribute("aria-selected") === "true" || element.getAttribute("aria-pressed") === "true" ? "on" : "", element.getAttribute("aria-expanded") === "true" ? "open" : ""].filter(Boolean).join(",");
      return state ? `${label} [${state}]` : label;
    }).filter(Boolean) : [];
    const conversation = document.querySelector(SEL.conversation);
    const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]')].filter(visible);
    return {
      header: text(document.querySelector("header")),
      headerControls: names(document.querySelector("header")),
      sidebar: text(document.querySelector(`aside${SEL.workspaces}`)),
      conversationTail: (text(conversation) ?? "").slice(-1500),
      composer: text(document.querySelector(SEL.composer)),
      composerControls: names(document.querySelector(SEL.composer)),
      // The strip around the composer: whatever sits between the conversation and the composer.
      aroundComposer: (() => { const composer = document.querySelector(SEL.composer); const parent = composer?.parentElement; return parent ? [...parent.children].filter(child => child !== composer && visible(child) && !child.contains(conversation)).map(child => text(child)).filter(Boolean) : []; })(),
      overlays: dialogs.map(element => ({ role: element.getAttribute("role") ?? "popper", text: text(element), controls: names(element) })),
      status: [...document.querySelectorAll('[role="status"]')].filter(visible).map(element => (element.textContent ?? "").trim()).filter(Boolean),
      problems: [...document.querySelectorAll('[role="alert"], [data-result="failed"], [data-reply-failed], [data-send-failed], [data-no-reply], [data-flow-hold], [data-session-blocked], [data-reconnecting]')].filter(visible).map(element => (element.innerText || element.getAttribute("aria-label") || "").trim()),
      page: (document.body.innerText ?? "").slice(0, 4000),
    };
  }, SEL);
}

let currentGroup = "";
/** Record one state: a screenshot and its words. */
async function capture(name, note = "") {
  const id = `${slug(currentGroup)}--${slug(name)}`;
  const file = join(shots, `${id}.png`);
  await page.screenshot({ path: file }).catch(error => result.errors.push(`screenshot ${id}: ${error.message}`));
  let shown = null;
  try { shown = await words(); } catch (error) { shown = { error: String(error.message) }; }
  result.states.push({ group: currentGroup, name, id, note, at: new Date().toISOString(), shot: `${id}.png`, words: shown });
  writeFileSync(join(shots, `${id}.json`), JSON.stringify({ group: currentGroup, name, note, words: shown }, null, 2));
}

/** Open each menu-like control inside `root` and record it; never presses a forbidden one. */
async function menusIn(rootSelector, label) {
  const handles = await page.locator(`${rootSelector} :is(button[aria-haspopup], button[aria-expanded], [role=combobox])`).all();
  for (const handle of handles) {
    if (!await handle.isVisible().catch(() => false) || await handle.isDisabled().catch(() => true)) continue;
    const name = (await handle.getAttribute("aria-label").catch(() => null)) || (await handle.innerText().catch(() => "")).trim().slice(0, 40) || "menu";
    if (N.forbidden.test(name) && !/model|モデル|模型/i.test(name)) continue;
    await handle.click({ timeout: 3_000 }).catch(() => {});
    await sleep(500);
    await capture(`${label} menu ${name}`);
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(200);
  }
}

async function freshSession() {
  await page.keyboard.press("Escape").catch(() => {});
  await newSession().click();
  await textbox().waitFor({ timeout: 10_000 });
}
async function send(text) {
  await textbox().fill(text);
  await page.waitForFunction(SEL => !document.querySelector(`${SEL.composer} button[type="submit"]`)?.disabled, SEL, { timeout: 20_000 }).catch(() => {});
  await sendButton().click({ timeout: 5_000 });
}
async function idle(timeout = 15_000) {
  const until = now() + timeout;
  while (now() < until) {
    if (!await stopButton().isVisible().catch(() => false) && await sendButton().isVisible().catch(() => false)) return true;
    await sleep(100);
  }
  return false;
}
async function problemShown(timeout) {
  const until = now() + timeout;
  while (now() < until) {
    const count = await page.locator('[role="alert"], [data-reply-failed], [data-send-failed], [data-no-reply], [data-session-blocked]').count();
    if (count) return true;
    await sleep(150);
  }
  return false;
}
let question = 20;
const ask = () => { question += 1; return { prompt: `What is ${question} × 7? Reply with only the number.`, answer: String(question * 7) }; };
async function replyArrives(answer, timeout = 30_000) {
  const until = now() + timeout;
  while (now() < until) {
    if (new RegExp(`(^|\\D)${answer}(\\D|$)`).test((await conversationText()).replace(/What is \d+ × \d+\? Reply with only the number\./g, ""))) return true;
    await sleep(150);
  }
  return false;
}
async function openSettings() {
  await page.getByRole("button", { name: N.settings }).first().click();
  const dialog = page.getByRole("dialog").first();
  await dialog.waitFor({ timeout: 5_000 });
  return dialog;
}

const groups = [];
const group = (name, run, { langs = ["en", "ja", "zh-Hans", "zh-Hant"] } = {}) => groups.push({ name, run, langs });

// ---- Session and chat ----
group("New session", async () => {
  await newSession().click();
  await capture("at click +0 ms");
  await sleep(300);
  await capture("at click +300 ms");
  await textbox().waitFor({ timeout: 10_000 });
  await sleep(2_000);
  await capture("ready");
  await menusIn(SEL.composer, "composer");
  await menusIn("header", "header");
});

group("Runtime starts slowly", async () => {
  await control("/runtime/delay", { ms: 8_000 });
  await control("/runtime/kill", { which: "all" });
  await sleep(1_000);
  await newSession().click();
  await sleep(700);
  await capture("new session while the runtime starts");
  const { prompt, answer } = ask();
  await send(prompt);
  await sleep(1_000);
  await capture("sent while the runtime starts");
  await control("/runtime/delay", { ms: 0 });
  await replyArrives(answer, 30_000);
  await capture("reply after slow start");
});

group("Reply lifecycle", async () => {
  await freshSession();
  await fault({ firstByteMs: 6_000 });
  const first = ask();
  await send(first.prompt);
  await sleep(1_200);
  await capture("waiting for the first word");
  const second = ask();
  await textbox().fill(second.prompt);
  await sendButton().click({ timeout: 5_000 }).catch(() => {});
  await sleep(800);
  await capture("second message queued during a run");
  await menusIn(SEL.composer, "running composer");
  await fault({});
  await replyArrives(second.answer, 40_000);
  await idle(20_000);
  await sleep(1_000);
  await capture("both replies done");
  await send("LONG reply please");
  await page.waitForFunction(SEL => /line 3\b/.test(document.querySelector(SEL.conversation)?.textContent ?? ""), SEL, { timeout: 30_000 }).catch(() => {});
  await capture("streaming");
  await stopButton().click({ timeout: 3_000 }).catch(() => {});
  await sleep(300);
  await capture("just after Stop");
  await idle(10_000);
  await sleep(1_500);
  await capture("after Stop settled");
});

for (const [name, body, limit] of [
  ["Provider refuses the key (401)", { status: 401 }, 15_000],
  ["Provider rate limit (429)", { status: 429 }, 70_000],
  ["Provider server error (500)", { status: 500 }, 70_000],
  ["Model removed (404)", { status: 404 }, 15_000],
  ["Network down", { reset: true }, 70_000],
]) {
  group(name, async () => {
    await freshSession();
    await fault(body);
    await send(ask().prompt);
    await sleep(1_500);
    await capture("1.5 s after send");
    await problemShown(limit);
    await sleep(1_500);
    await capture("failure shown");
    await fault({});
    await idle(15_000);
    await sleep(1_000);
    await capture("after the provider recovered (nothing pressed)");
  });
}

group("Reply cut off mid-stream", async () => {
  await freshSession();
  await fault({ cutAfter: 5 });
  await send("LONG reply please");
  await problemShown(60_000);
  await sleep(1_500);
  await capture("cut off");
  await fault({});
});

group("Runtime exits", async () => {
  await freshSession();
  const first = ask();
  await send(first.prompt);
  await replyArrives(first.answer);
  await idle();
  await control("/runtime/kill", { which: "all" });
  await sleep(2_000);
  await capture("idle session after its runtime exited");
  const next = ask();
  await send(next.prompt);
  await sleep(1_500);
  await capture("sent after the runtime exited");
  await replyArrives(next.answer, 30_000);
  await sleep(1_000);
  await capture("after reply");
});

group("Runtime keeps crashing", async () => {
  await freshSession();
  const crashing = control("/runtime/kill-loop", { ms: 20_000 });
  await send(ask().prompt);
  await sleep(6_000);
  await capture("while crashing");
  await crashing;
  await sleep(3_000);
  await capture("after crashes stopped");
});

group("Computer asleep (host frozen 20 s)", async () => {
  await freshSession();
  const frozen = control("/freeze", { ms: 20_000 });
  await sleep(10_000);
  await capture("during freeze");
  await frozen;
  await sleep(3_000);
  await capture("after wake");
});

group("Saved sessions", async () => {
  for (const title of ["Session from an older version", "Half written session", "Session with an unknown entry", "Session whose folder was deleted"]) {
    const row = page.getByText(title, { exact: false }).first();
    if (!await row.isVisible().catch(() => false)) { await capture(`${title} not listed`); continue; }
    await row.click();
    await sleep(2_500);
    await capture(`opened: ${title}`);
  }
  const archived = page.getByRole("button", { name: N.archived }).first();
  if (await archived.isVisible().catch(() => false)) { await archived.click(); await sleep(800); await capture("archived shown"); await archived.click().catch(() => {}); }
  await menusIn(`aside${SEL.workspaces}`, "sidebar");
});

group("Panels", async () => {
  await freshSession();
  const artifacts = page.getByRole("button", { name: N.artifacts }).first();
  if (await artifacts.isVisible().catch(() => false)) { await artifacts.click(); await sleep(1_000); await capture("artifacts panel"); await menusIn("main", "panel"); await artifacts.click().catch(() => {}); }
  const split = page.getByRole("button", { name: N.split }).first();
  if (await split.isVisible().catch(() => false)) { await split.click(); await sleep(1_500); await capture("split pane"); await split.click().catch(() => {}); }
});

// ---- Settings ----
group("Settings", async () => {
  const dialog = await openSettings();
  const tabs = await dialog.getByRole("tab").all();
  for (const tab of tabs) {
    const name = (await tab.innerText()).trim();
    await tab.click();
    await sleep(1_500);
    await capture(`tab ${name}`);
  }
  // Providers: the saved provider's page.
  await tabs[0].click();
  await sleep(500);
  const row = dialog.getByRole("button", { name: /^fixture\b/i }).first();
  if (await row.isVisible().catch(() => false)) { await row.click(); await sleep(1_000); await capture("provider fixture opened"); }
  // System: after its own update check settles, then on each channel. Nothing is installed.
  await tabs[tabs.length - 1].click();
  await sleep(10_000);
  await capture("system after check");
  const channel = dialog.getByRole("combobox", { name: N.channel }).first();
  if (await channel.isVisible().catch(() => false)) {
    for (const index of [1, 0]) {
      await channel.click();
      await sleep(300);
      await capture(`channel menu open (choosing ${index ? "QA" : "Stable"})`);
      await page.getByRole("option").nth(index).click();
      await sleep(12_000);
      await capture(`system on channel ${index ? "QA" : "Stable"}`);
    }
  } else await capture("no channel control");
  await page.keyboard.press("Escape");
  await sleep(500);
  await capture("header after settings closed");
}, { langs: ["en", "ja", "zh-Hans", "zh-Hant"] });

group("Settings file cannot be written", async () => {
  const lock = await control("/file", { path: "data/agent/settings.json", readOnly: true });
  try {
    const dialog = await openSettings();
    const row = dialog.getByRole("button", { name: /^fixture\b/i }).first();
    if (await row.isVisible().catch(() => false)) await row.click();
    const model = dialog.getByRole("combobox").filter({ hasText: /Fixture|deterministic/i }).first();
    if (await model.isVisible().catch(() => false)) { await model.click(); await page.getByRole("option", { name: /second/i }).first().click().catch(() => {}); }
    await sleep(4_000);
    await capture(`after a save (lock effective: ${lock.effective})`);
    await page.keyboard.press("Escape");
  } finally {
    await control("/file", { path: "data/agent/settings.json", readOnly: false });
    await control("/file", { path: "data/agent/settings.json", text: JSON.stringify({ defaultProvider: "fixture", defaultModel: "deterministic" }, null, 2) });
  }
}, { langs: ["en"] });

group("No model available", async () => {
  await control("/file", { path: "data/agent/models.json", text: "{\"providers\":{}}" });
  await control("/file", { path: "data/agent/settings.json", text: "{}" });
  await control("/runtime/kill", { which: "all" });
  await sleep(2_000);
  await page.reload();
  await sleep(8_000);
  await capture("after reload without providers");
  if (await newSession().isVisible().catch(() => false)) { await newSession().click(); await sleep(3_000); await capture("new session without providers"); await menusIn(SEL.composer, "composer"); }
}, { langs: ["en", "ja"] });

// ---- Run ----
await page.waitForLoadState("domcontentloaded").catch(() => {});
currentGroup = "Start";
await capture("first frame after connect");
if (await page.evaluate(() => localStorage.getItem("jouzu.ui.language")).catch(() => null) !== lang) {
  await page.evaluate(value => localStorage.setItem("jouzu.ui.language", value), lang);
  await page.reload();
  await sleep(300);
  await capture("first frame after reload in language");
}
await newSession().waitFor({ timeout: 90_000 }).catch(error => result.errors.push(`the app never became usable: ${error.message}`));
await capture("usable");
for (const item of groups) {
  if (!item.langs.includes(lang)) continue;
  if (only && !only.toLowerCase().split("|").some(part => item.name.toLowerCase().includes(part.trim()))) continue;
  currentGroup = item.name;
  const started = now();
  const record = { name: item.name, ok: true, problems: [], notes: [] };
  try { await item.run(); }
  catch (error) { record.notes.push(`could not finish: ${String(error?.message ?? error).split("\n")[0]}`); await capture("tour error"); }
  finally {
    await fault({}).catch(() => {});
    await control("/runtime/delay", { ms: 0 }).catch(() => {});
    await page.keyboard.press("Escape").catch(() => {});
  }
  record.ms = now() - started;
  result.cases.push(record);
  console.error(`DONE ${item.name} (${Math.round(record.ms / 1000)} s)${record.notes.length ? `: ${record.notes.join("; ")}` : ""}`);
}
result.pass = true;
result.finishedAt = new Date().toISOString();
if (process.env.PLAYBOOK_OUT) writeFileSync(process.env.PLAYBOOK_OUT, JSON.stringify(result, null, 2));
else console.log(JSON.stringify(result, null, 2));
await browser.close();
