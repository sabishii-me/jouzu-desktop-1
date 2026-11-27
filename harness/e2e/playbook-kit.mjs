import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Shared kit for the playbooks (abnormal-playbook.mjs, release-playbook.mjs): connection to the app,
 * the world controls, the words the person sees, and the judgements every case shares. Copied
 * unchanged from abnormal-playbook.mjs (harness bc72ff0); a playbook imports it and calls runCases().
 *
 * Abnormal-path playbook: what the person sees when something goes wrong, and whether
 * the app recovers once the cause is gone. Errors are tests too.
 *
 * Each case breaks one thing in the world around the app (the model provider, the
 * runtime process, the computer's sleep, a file in the data folder, the input), then
 * judges only what a person sees, against the error rules of docs/design/ui-layer.md:
 *
 *   never silent      a failure shows within its time limit; nothing just stops
 *   own scope         it shows on the thing that failed (the reply, the control, the
 *                     settings card, the start page), not somewhere else
 *   one at a time     one cause shows once: at most one problem shown per case, and the
 *                     session-level error (composer replaced) at most once
 *   no layout shift   the composer, the conversation and the sidebar do not move or
 *                     resize when a problem appears or clears; nothing widens the page
 *   no endless wait   no spinner or "starting/opening" line stays once the cause is known
 *   plain words       the main sentence is in the interface language and holds no raw
 *                     technical text (status codes, exception names, JSON); originals
 *                     belong under Details
 *   nothing lost      what the person typed is still there or was sent
 *   recovers          once the cause is fixed, the next message gets its reply
 *
 * Timings start at the person's action. Nothing here may be loosened in the same change
 * as the code it judges.
 *
 * Inputs (set by e2e-runtime/abnormal-exam.mjs):
 *   PLAYBOOK_CDP      the app's page over CDP
 *   PLAYBOOK_FIXTURE  the fixture provider (fault control at /__fault)
 *   PLAYBOOK_WORLD    the exam's world control (runtime kill, freeze, slow start, files)
 *   PLAYBOOK_LANG     interface language of this run (en, ja, zh-Hans, zh-Hant)
 *   PLAYBOOK_ONLY     run only cases whose names contain this text (several: separate with |)
 *   PLAYBOOK_OUT, PLAYBOOK_SHOTS  report file and screenshot folder
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
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
}
// PLAYBOOK_LIST=1: print the cases (name and languages) as JSON and exit; nothing is started.
const listOnly = Boolean(process.env.PLAYBOOK_LIST);
const { connected: browser, found: page } = listOnly ? { connected: null, found: null } : await connect(process.env.PLAYBOOK_CDP ?? "http://127.0.0.1:9223");
const result = { startedAt: new Date().toISOString(), lang, cases: [], errors: [] };
const now = () => Date.now();
const sleep = ms => page.waitForTimeout(ms);
page?.on("pageerror", error => result.errors.push(`page error: ${String(error)}`));

// ---- The world ----
const post = (base, path, body = {}) => fetch(base + path, { method: "POST", body: JSON.stringify(body) }).then(response => response.json());
const fault = body => post(fixture, "/__fault", body);
const providerRequests = async () => (await fetch(fixture + "/__fault").then(response => response.json()));
const control = (path, body) => post(world, path, body);

// ---- Words the person sees, per interface language (from src/chat-text.ts, src/i18n.ts) ----
const allWords = {
  en: { newSession: "New session", retry: "Retry", settings: "Settings", restart: "Restart session", continue: "Continue", discard: "Discard",
    composer: "Message composer", conversation: "Conversation", workspaces: "Workspaces", message: "Message Jouzu", chooseImages: "Choose images", attachedImages: "Attached images", queued: "Queued messages", stop: "Stop",
    providers: "Model providers", service: "Service", defaultModel: "Default model" },
  ja: { newSession: "新しいセッション", retry: "再試行", settings: "設定", restart: "セッションを再起動", continue: "続ける", discard: "破棄",
    composer: "メッセージ入力", conversation: "会話", workspaces: "ワークスペース", message: "Jouzu へのメッセージ", chooseImages: "画像を選択", attachedImages: "添付画像", queued: "待機中のメッセージ", stop: "停止",
    providers: "モデルプロバイダー", service: "サービス", defaultModel: "既定のモデル" },
  "zh-Hans": { newSession: "新会话", retry: "重试", settings: "设置", restart: "重启会话", continue: "继续", discard: "丢弃",
    composer: "消息输入框", conversation: "对话", workspaces: "工作区", message: "给 Jouzu 发消息", chooseImages: "选择图片", attachedImages: "已添加的图片", queued: "排队中的消息", stop: "停止",
    providers: "模型提供商", service: "服务", defaultModel: "默认模型" },
  "zh-Hant": { newSession: "新工作階段", retry: "重試", settings: "設定", restart: "重新啟動工作階段", continue: "繼續", discard: "捨棄",
    composer: "訊息輸入框", conversation: "對話", workspaces: "工作區", message: "傳訊息給 Jouzu", chooseImages: "選擇圖片", attachedImages: "已加入的圖片", queued: "排隊中的訊息", stop: "停止",
    providers: "模型供應商", service: "服務", defaultModel: "預設模型" },
};
const words = allWords[lang];
const english = allWords.en;
/**
 * A control's accessible name: the interface language's word, or the English one while that
 * control is not localized yet (the English-only words are reported by the i18n judgement of
 * the problems shown, not by failing to find the control).
 */
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const named = key => new RegExp(`^(${escape(words[key])}|${escape(english[key])})$`);
/** CSS for an element labelled in the interface language or in English (labels localized in 1.1.4, #100). */
const labelled = key => `:is(${[...new Set([words[key], english[key]])].map(text => `[aria-label="${text}"]`).join(", ")})`;
const SEL = { composer: labelled("composer"), conversation: labelled("conversation"), workspaces: labelled("workspaces") };
const newSession = () => page.getByRole("button", { name: named("newSession") }).first();
const textbox = () => page.getByRole("textbox", { name: new RegExp(`message|${escape(words.message)}`, "i") }).first();
const sendButton = () => page.locator(`${SEL.composer} button[type="submit"]`).first();
const stopButton = () => page.locator(SEL.composer).getByRole("button", { name: named("stop") }).first();
const conversation = () => page.locator(SEL.conversation).first();
const conversationText = async () => (await conversation().textContent().catch(() => "")) ?? "";

/** Everything shown as a problem, where it is, and the words of its main sentence. */
async function problems() {
  return page.evaluate(SEL => {
    const selector = '[role="alert"], [data-result="failed"], [data-reply-failed], [data-send-failed], [data-no-reply], [data-flow-hold], [data-session-blocked], [data-reconnecting]';
    const visible = element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden"; };
    const main = element => {
      // The main sentence: Details, code and preformatted originals are not part of it.
      if (element.matches("details")) return element.querySelector("summary")?.innerText ?? "";
      if (element.matches('[data-result="failed"]')) return element.getAttribute("aria-label") ?? "";
      const copy = element.cloneNode(true);
      copy.querySelectorAll("pre, code, details > :not(summary), [data-details], button").forEach(node => node.remove());
      return copy.innerText ?? copy.textContent ?? "";
    };
    const scope = element => element.closest('[role="dialog"]') ? "settings"
      : element.closest(SEL.conversation) ? "reply"
      : element.closest(SEL.composer) || element.matches("[data-flow-hold], [data-session-blocked], [data-no-reply]") ? "composer"
      : element.closest(SEL.workspaces) ? "sidebar"
      : element.closest("header") || element.matches("[data-reconnecting]") ? "header" : "page";
    const seen = new Set();
    return [...document.querySelectorAll(selector)].filter(visible).filter(element => {
      // One problem is counted once, even when nested markers describe it.
      for (const other of seen) if (other.contains(element) || element.contains(other)) return false;
      seen.add(element);
      return true;
    }).map(element => {
      const style = getComputedStyle(element);
      return { text: main(element).trim().replace(/\s+/g, " "), scope: scope(element), floating: style.position === "fixed" && !element.closest('[role="dialog"]'), blocked: element.matches("[data-session-blocked]") };
    });
  }, SEL);
}
/** Where the parts the person works with are, and whether anything widens the page. */
async function layout() {
  return page.evaluate(SEL => {
    const box = selector => { const element = document.querySelector(selector); if (!element) return null; const rect = element.getBoundingClientRect(); return [rect.x, rect.y, rect.width, rect.height].map(Math.round); };
    return {
      composer: box(SEL.composer),
      conversation: box(SEL.conversation),
      sidebar: box(`aside${SEL.workspaces}`),
      overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
    };
  }, SEL);
}
/** Busy indicators still on screen: spinners and in-progress lines ("Starting…", "Opening…"). */
async function waiting() {
  return page.evaluate(() => {
    const visible = element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; };
    const spinners = [...document.querySelectorAll(".animate-spin")].filter(visible).map(element => (element.closest('[role="status"], button')?.textContent ?? "spinner").trim().slice(0, 80) || "spinner");
    const lines = [...document.querySelectorAll('[role="status"]')].filter(visible)
      .filter(element => !element.matches("[data-flow-hold], [data-reconnecting]"))
      .map(element => (element.textContent ?? "").trim())
      .filter(text => /…|\.\.\./.test(text) && text.length < 120);
    return [...new Set([...spinners, ...lines])];
  });
}
const technical = /\b[45]\d\d\b|Exception|ECONN|ETIMEDOUT|EPIPE|socket|stack|\{"|[A-Za-z]+Error\b|Error:|undefined|null\b/;
/** In a non-English interface the main sentence has no English phrase of three words or more. */
const englishPhrase = /\b[A-Za-z]{2,}(?:[\s,'’-]+[A-Za-z]{2,}){2,}\b/;

// ---- Cases ----
function caseRecorder(name, why) {
  const record = { name, why, ok: true, problems: [], notes: [], metrics: {} };
  return {
    record,
    fail(text) { record.ok = false; record.problems.push(text); },
    /** No verdict: this machine cannot give the case what it needs (the runner records ERROR unless the plan declares the skip). */
    skip(text) { record.skipped = true; record.notes.push(text); },
    note(text) { record.notes.push(text); },
    metric(key, value) { record.metrics[key] = Math.round(value); },
  };
}
const cases = [];
const add = (name, why, run, { langs = ["en", "ja", "zh-Hans", "zh-Hant"], scenario = null, world = null } = {}) => cases.push({ name, why, run, langs, scenario, world });

/** A fresh session, with the composer ready to type. */
async function freshSession() {
  await page.keyboard.press("Escape").catch(() => {});
  await newSession().click();
  await textbox().waitFor({ timeout: 10_000 });
}
let current = null;
/** What the person sent: a problem line may quote it, and a quote is not the app's own words. */
const sent = [];
// A folder path the app names (the session's own folder) is the person's data, not the app's words.
const paths = /(?:[A-Za-z]:\\|\/)[^\s"'「」]+/g;
const ownWords = text => sent.reduce((rest, item) => rest.split(item).join(" "), text).replace(paths, " ").replace(/\s+/g, " ").trim();
/**
 * Type and press Send. Send must be usable when the person has typed (the host holds a
 * message until the session is ready); if it is not, the case fails with how long the
 * person was kept waiting, unless the session shows it has ended (then Send is not offered).
 */
async function typeAndSend(text, { wait = 20_000 } = {}) {
  sent.push(text);
  await textbox().fill(text);
  const typed = now();
  // One render for the typed text to reach the button; a wait longer than that is the app's.
  const enabled = () => page.waitForFunction(SEL => !document.querySelector(`${SEL.composer} button[type="submit"]`)?.disabled, SEL, { timeout: 250 }).then(() => true, () => false);
  if (!await enabled()) {
    await page.waitForFunction(SEL => !document.querySelector(`${SEL.composer} button[type="submit"]`)?.disabled, SEL, { timeout: wait }).catch(() => {});
    const blockedMs = now() - typed;
    const ended = (await problems()).some(item => item.blocked);
    if (current && !ended) {
      current.metric("sendBlockedMs", blockedMs);
      current.fail(`Send was not usable for ${(blockedMs / 1000).toFixed(1)} s after typing (limit 0 s)`);
      await page.screenshot({ path: join(shots, `${slug(current.record.name)}-send-blocked.png`) }).catch(() => {});
    }
  }
  const start = now();
  await sendButton().click({ timeout: 5_000 });
  return start;
}
/**
 * Send `text` and time, inside the page, from the click to the person's own message in the
 * conversation (a mutation observer, so the test's polling adds nothing).
 */
async function sendTimed(text) {
  sent.push(text);
  await textbox().fill(text);
  await page.evaluate(({ prompt, SEL }) => {
    window.__ownMessage = new Promise(resolve => {
      const button = document.querySelector(`${SEL.composer} button[type="submit"]`);
      const seen = () => [...document.querySelectorAll(`${SEL.conversation} *`)].some(node => node.childElementCount === 0 && node.textContent === prompt);
      button.addEventListener("click", () => {
        const start = performance.now();
        if (seen()) { resolve(0); return; }
        const observer = new MutationObserver(() => { if (seen()) { observer.disconnect(); resolve(performance.now() - start); } });
        observer.observe(document.body, { subtree: true, childList: true, characterData: true });
        setTimeout(() => { observer.disconnect(); resolve(null); }, 10_000);
      }, { once: true, capture: true });
    });
  }, { prompt: text, SEL });
  const start = now();
  await sendButton().click({ timeout: 5_000 });
  const own = await page.evaluate(() => window.__ownMessage);
  return { start, own };
}
/** The conversation layout once the person's own message shows: the baseline for "nothing moved". */
async function afterOwn(prompt) {
  await conversation().getByText(prompt, { exact: true }).first().waitFor({ timeout: 5_000 }).catch(() => {});
  return layout();
}
/** A session that already has one answered turn, so its layout is the conversation's. */
async function chatSession() {
  await freshSession();
  const first = ask();
  await typeAndSend(first.prompt);
  await replyArrives(first.answer, 30_000);
  await idle(10_000);
}
/** Wait until any problem is shown; returns how long it took, or null. */
async function firstProblem(start, timeout) {
  const until = start + timeout;
  while (now() < until) {
    const list = await problems();
    if (list.length) return { ms: now() - start, list };
    await sleep(100);
  }
  return null;
}
/** The reply to `prompt` arrived: the fixture's product answer for "What is A × B?". */
async function replyArrives(answer, timeout = 30_000) {
  const until = now() + timeout;
  while (now() < until) {
    const text = await conversationText();
    if (new RegExp(`(^|\\D)${answer}(\\D|$)`).test(text.replace(/What is \d+ × \d+\? Reply with only the number\./g, ""))) return true;
    await sleep(150);
  }
  return false;
}
async function idle(timeout = 10_000) {
  const until = now() + timeout;
  while (now() < until) {
    if (!await stopButton().isVisible().catch(() => false) && await sendButton().isVisible().catch(() => false)) return true;
    await sleep(100);
  }
  return false;
}
let question = 10;
/** A fresh arithmetic question; the fixture answers with the product. */
function ask() { question += 1; return { prompt: `What is ${question} × 7? Reply with only the number.`, answer: String(question * 7) }; }

/** The judgement every case shares: one problem, in its scope, in plain words, nothing moved. */
function judgeShown(c, list, { scope, before, after }) {
  page.screenshot({ path: join(shots, `${slug(c.record.name)}-shown.png`) }).catch(() => {});
  if (!list.length) { c.fail("nothing was shown: the failure was silent"); return; }
  const texts = list.map(item => `${item.scope}: ${item.text || "(no words)"}`);
  c.note(`shown: ${texts.join(" | ")}`);
  if (list.length > 1) c.fail(`one cause was shown ${list.length} times: ${texts.join(" | ")}`);
  if (scope && !list.some(item => [scope].flat().includes(item.scope))) c.fail(`not shown where it happened (expected ${[scope].flat().join(" or ")}): ${texts.join(" | ")}`);
  if (list.filter(item => item.blocked).length > 1) c.fail("more than one session-level error");
  if (list.some(item => item.floating)) c.fail("shown as a floating message");
  for (const item of list) {
    const words = ownWords(item.text);
    if (!words) c.fail(`a problem has no words (${item.scope})`);
    if (technical.test(words)) c.fail(`raw technical text in the main sentence: "${words}"`);
    if (lang !== "en" && englishPhrase.test(words)) c.fail(`not in the interface language (${lang}): "${words}"`);
  }
  if (before && after) judgeLayout(c, before, after);
}
function judgeLayout(c, before, after) {
  for (const part of ["composer", "conversation", "sidebar"]) {
    if (before[part] && after[part] && before[part].some((value, index) => Math.abs(value - after[part][index]) > 1)) c.fail(`the ${part} moved or resized: ${before[part]} -> ${after[part]}`);
  }
  if (after.overflow > 0) c.fail(`the page became ${after.overflow} px wider than the window`);
}
async function judgeNoEndlessWait(c, settleMs = 3_000) {
  await sleep(settleMs);
  const busy = (await waiting()).filter(text => !/reconnect|再接続|重新连接|重新連線/i.test(text));
  const running = await stopButton().isVisible().catch(() => false);
  if (busy.length && !running) c.fail(`still shows waiting after the cause was known: ${busy.join(" | ")}`);
}
/** After the cause is gone: the next message (or Retry when offered) gets its reply. */
async function judgeRecovers(c, { preferRetry = false } = {}) {
  const retry = page.getByRole("button", { name: named("retry") }).last();
  const offered = await retry.isVisible().catch(() => false);
  c.note(`Retry offered: ${offered}`);
  await idle(15_000);
  const next = ask();
  const start = now();
  if (preferRetry && offered) {
    await retry.click();
  } else {
    await textbox().fill(next.prompt);
    await sendButton().click({ timeout: 5_000 }).catch(() => c.fail("Send was not available after the cause was fixed"));
  }
  const ok = preferRetry && offered ? await idle(30_000) : await replyArrives(next.answer, 30_000);
  c.metric("recoveredReplyMs", now() - start);
  if (!ok) c.fail("after the cause was fixed, the next message got no reply within 30 s");
  await idle(10_000);
  const left = (await problems()).filter(item => item.scope !== "reply");
  if (left.length) c.fail(`problems still shown outside the old reply after recovery: ${left.map(item => item.text).join(" | ")}`);
}

const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

async function openSettings(tab) {
  await page.getByRole("button", { name: named("settings") }).first().click();
  const dialog = page.getByRole("dialog").first();
  if (tab) await dialog.getByRole("tab", { name: tab }).click();
  return dialog;
}

const allWordsMore = {
  en: { steer: "Steer", interrupted: "Interrupted", environment: "Environment", addVariable: "Add variable", variableName: "Name", variableValue: "Value", save: "Save", system: "System", collaboration: "Collaboration", removeConnection: "Remove connection", discard: "Discard" },
  ja: { steer: "割り込み", interrupted: "中断", environment: "環境変数", addVariable: "変数を追加", variableName: "名前", variableValue: "値", save: "保存", system: "システム", collaboration: "コラボレーション", removeConnection: "接続を削除", discard: "破棄" },
  "zh-Hans": { steer: "插话", interrupted: "已中断", environment: "环境变量", addVariable: "添加变量", variableName: "变量名", variableValue: "值", save: "保存", system: "系统", collaboration: "协作", removeConnection: "移除连接", discard: "丢弃" },
  "zh-Hant": { steer: "插話", interrupted: "已中斷", environment: "環境變數", addVariable: "新增變數", variableName: "變數名稱", variableValue: "值", save: "儲存", system: "系統", collaboration: "協作", removeConnection: "移除連線", discard: "捨棄" },
};
const more = allWordsMore[lang] ?? allWordsMore.en;
const namedMore = key => new RegExp(`^(${escape(more[key])}|${escape(allWordsMore.en[key])})$`);
const sidebar = () => page.locator(`aside${SEL.workspaces}`).first();
/** The live state icon on a session's row (#212), or null when the row shows none. */
async function rowState(text) {
  return page.evaluate(text => {
    const rows = [...document.querySelectorAll("aside [data-session-selected], aside div.group\\/session, aside li, aside [role='listitem']")].filter(row => (row.textContent ?? "").includes(text));
    const row = rows.sort((a, b) => (a.textContent ?? "").length - (b.textContent ?? "").length)[0];
    if (!row) return "missing";
    return row.querySelector("[data-session-state]")?.getAttribute("data-session-state") ?? null;
  }, text);
}
async function waitRowState(text, wanted, timeout) {
  const until = now() + timeout;
  let state = await rowState(text);
  while (now() < until && !wanted.includes(state)) { await sleep(200); state = await rowState(text); }
  return state;
}
/** Words shown on the page outside the conversation (status line, sidebar, composer). */
const outsideConversation = () => page.evaluate(SEL => {
  const copy = document.body.cloneNode(true);
  copy.querySelectorAll(SEL.conversation).forEach(node => node.remove());
  document.body.append(copy); copy.style.position = "absolute"; copy.style.left = "-99999px";
  const text = copy.innerText; copy.remove(); return text;
}, SEL);
const browserMode = async () => !(await control("/state")).shell;

/** A 32×32 solid red PNG, built here so the playbook needs no fixture file. */
async function redSquarePng() {
  const { deflateSync } = await import("node:zlib");
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = bytes => {
    let c = 0xffffffff;
    for (const byte of bytes) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const size = 32;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4);
  header[8] = 8; header[9] = 2; // 8-bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, Buffer.from([255, 0, 0]))]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: size }, () => row)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", pixels), chunk("IEND", Buffer.alloc(0))]);
}

/** A 4×4 PNG: providers refuse images with a side of 10 px or less (the fixture too). */
function tinyPng() {
  return Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGP4z8AARAwMDAA/wQP9tOD5RgAAAABJRU5ErkJggg==", "base64");
}


/** Run every case of the importing playbook, or list them (PLAYBOOK_LIST). */
export async function runCases() {
  if (listOnly) {
    console.log(JSON.stringify(cases.map(item => ({ name: item.name, why: item.why, langs: item.langs, scenario: item.scenario, world: item.world }))));
    process.exit(0);
  }
  // The installed app's window cannot be given a language before it loads: set it as the app
  // keeps it and load again.
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  if (await page.evaluate(() => localStorage.getItem("jouzu.ui.language")).catch(() => null) !== lang) {
    await page.evaluate(value => localStorage.setItem("jouzu.ui.language", value), lang);
    await page.reload();
  }
  // A new user's world (ABN_WORLD=new-user) starts on the first-run pages; its case waits itself.
  if (!process.env.ABN_WORLD) await newSession().waitFor({ timeout: 60_000 }).catch(error => result.errors.push(`the app never became usable: ${error.message}`));
  for (const item of cases) {
    if (!item.langs.includes(lang)) continue;
    if (only && !only.toLowerCase().split("|").some(part => item.name.toLowerCase().includes(part.trim()))) continue;
    const c = caseRecorder(item.name, item.why);
    current = c;
    const started = now();
    try {
      await item.run(c);
    } catch (error) {
      c.fail(`the case could not finish: ${String(error?.message ?? error).split("\n")[0]}`);
      await page.screenshot({ path: join(shots, `${slug(item.name)}-error.png`) }).catch(() => {});
    } finally {
      await fault({}).catch(() => {});
      await control("/runtime/delay", { ms: 0 }).catch(() => {});
      await page.keyboard.press("Escape").catch(() => {});
    }
    await page.screenshot({ path: join(shots, `${slug(item.name)}-end.png`) }).catch(() => {});
    c.record.ms = now() - started;
    result.cases.push(c.record);
    console.error(`${c.record.skipped ? "SKIP" : c.record.ok ? "PASS" : "FAIL"} ${item.name}${c.record.problems.length ? `: ${c.record.problems.join("; ")}` : ""}`);
  }
  result.pass = result.errors.length === 0 && result.cases.every(item => item.ok);
  result.finishedAt = new Date().toISOString();
  if (process.env.PLAYBOOK_OUT) writeFileSync(process.env.PLAYBOOK_OUT, JSON.stringify(result, null, 2));
  else console.log(JSON.stringify(result, null, 2));
  await browser.close();
  process.exitCode = result.pass ? 0 : 1;

}

export {
  SEL, add, afterOwn, allWords, ask, browserMode, caseRecorder, chatSession, control, conversation, conversationText,
  english, escape, fault, firstProblem, fixture, freshSession, idle, judgeLayout, judgeNoEndlessWait, judgeRecovers,
  judgeShown, labelled, lang, layout, listOnly, more, named, namedMore, newSession, now, openSettings,
  outsideConversation, page, post, problems, providerRequests, redSquarePng, replyArrives, result, rowState, sendButton,
  sendTimed, sent, shots, sidebar, sleep, slug, stopButton, technical, textbox, tinyPng, typeAndSend, waitRowState,
  waiting, world, browser,
};
