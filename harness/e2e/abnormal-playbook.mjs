import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
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
    note(text) { record.notes.push(text); },
    metric(key, value) { record.metrics[key] = Math.round(value); },
  };
}
const cases = [];
const add = (name, why, run, { langs = ["en", "ja", "zh-Hans", "zh-Hant"] } = {}) => cases.push({ name, why, run, langs });

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

/** Provider faults: shown on the reply, in plain words, once; the session keeps working. */
function providerFault(name, why, body, limitMs) {
  add(name, why, async c => {
    await freshSession();
    await fault(body);
    const { prompt } = ask();
    const start = await typeAndSend(prompt);
    const before = await afterOwn(prompt);
    const shown = await firstProblem(start, limitMs);
    if (!shown) {
      c.fail(`nothing shown within ${limitMs / 1000} s (Stop visible: ${await stopButton().isVisible().catch(() => false)})`);
    } else {
      c.metric("sendToProblemMs", shown.ms);
      await sleep(1_500);
      judgeShown(c, await problems(), { scope: ["reply", "composer"], before, after: await layout() });
    }
    if (!(await conversationText()).includes(prompt)) c.fail("the sent message is not in the conversation");
    await page.screenshot({ path: join(shots, `${slug(name)}.png`) });
    await fault({});
    await judgeNoEndlessWait(c);
    await judgeRecovers(c);
  });
}
const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

providerFault("Provider rejects the key while sending", "An expired or revoked key (401) must say so on the reply, not stop the session or show raw provider text.", { status: 401 }, 10_000);
providerFault("Provider rate-limits the request", "429 must end in a readable failure or a reply within the limit, not an endless retry the person cannot see.", { status: 429 }, 60_000);
providerFault("Provider fails with a server error", "A provider outage (500) shows on the reply; the person can try again.", { status: 500 }, 60_000);
providerFault("Provider unreachable (network down)", "No network or a gateway down: the reply says it could not reach the provider.", { reset: true }, 60_000);
providerFault("Model removed by the provider", "A model the provider no longer offers (404) is named as such, once.", { status: 404 }, 10_000);

add("Reply cut off mid-stream", "The provider drops the connection while writing: the written part stays, the reply is marked, the next message works.", async c => {
  await chatSession();
  const before = await layout();
  await fault({ cutAfter: 5 });
  const start = await typeAndSend("LONG reply please");
  const shown = await firstProblem(start, 60_000);
  if (!shown) c.fail("nothing shown within 60 s after the stream was cut");
  else { c.metric("sendToProblemMs", shown.ms); await sleep(1_000); judgeShown(c, await problems(), { scope: ["reply", "composer"], before, after: await layout() }); }
  if (!/line 1\b/.test(await conversationText())) c.fail("the part written before the cut is gone");
  await fault({});
  await judgeNoEndlessWait(c);
  await judgeRecovers(c);
});

add("Provider slow to answer (8 s to first word)", "A slow provider is not an error: own message at once, the turn visibly working, the reply arrives, nothing shown as failed.", async c => {
  await freshSession();
  await fault({ firstByteMs: 8_000 });
  const { prompt, answer } = ask();
  const { start, own } = await sendTimed(prompt);
  c.metric("ownMessageMs", own ?? -1);
  if (own === null || own > 100) c.fail(`own message took ${own === null ? "over 10 s" : `${Math.round(own)} ms`} (limit 100 ms)`);
  const working = await stopButton().waitFor({ timeout: 1_000 }).then(() => now() - start, () => null);
  if (working === null) c.fail("the turn did not visibly work (no Stop) while waiting for the provider");
  if (!await replyArrives(answer, 30_000)) c.fail("the reply never arrived");
  c.metric("sendToReplyMs", now() - start);
  const shown = await problems();
  if (shown.length) c.fail(`a slow provider was shown as a problem: ${shown.map(item => item.text).join(" | ")}`);
  await fault({});
});

add("Nothing moves while a reply runs", "The baseline for every layout check here: starting and ending a normal turn does not move the composer or resize the conversation.", async c => {
  await chatSession();
  const before = await layout();
  await typeAndSend("LONG reply to watch the layout");
  await page.waitForFunction(SEL => /line 3\b/.test(document.querySelector(SEL.conversation)?.textContent ?? ""), SEL, { timeout: 30_000 }).catch(() => c.fail("the reply never started writing"));
  const during = await layout();
  judgeLayout(c, before, during);
  await idle(30_000);
  judgeLayout(c, before, await layout());
}, { langs: ["en"] });

// ---- Stop at every stage ----
async function stopCase(c, prepare, stage) {
  await freshSession();
  await prepare();
  const prompt = stage === "streaming" ? "LONG reply to be stopped" : ask().prompt;
  await typeAndSend(prompt);
  if (stage === "streaming") await page.waitForFunction(SEL => /line 3\b/.test(document.querySelector(SEL.conversation)?.textContent ?? ""), SEL, { timeout: 30_000 }).catch(() => c.fail("the reply never started writing"));
  if (stage === "waiting") await sleep(1_500);
  const start = now();
  await stopButton().click({ timeout: 3_000 }).catch(() => c.fail(`no Stop to press (${stage})`));
  const back = await idle(10_000);
  c.metric("stopToSendMs", now() - start);
  if (!back) c.fail("Send did not come back within 10 s after Stop");
  else if (now() - start > 2_000) c.fail(`Stop took ${now() - start} ms to give Send back (limit 2 s)`);
  await fault({});
  await control("/runtime/delay", { ms: 0 });
  await sleep(1_000);
  const shown = await problems();
  if (shown.length) c.fail(`Stop was shown as a problem: ${shown.map(item => item.text).join(" | ")}`);
  await judgeNoEndlessWait(c, 1_000);
  await judgeRecovers(c);
}
add("Stop right after Send", "Stop before anything is written ends the turn; nothing is left running or shown as failed.", c => stopCase(c, () => fault({ firstByteMs: 4_000 }), "just sent"), { langs: ["en"] });
add("Stop while the provider has not answered", "A provider that hangs must never trap the session: Stop gives Send back.", c => stopCase(c, () => fault({ hang: true }), "waiting"), { langs: ["en"] });
add("Stop while the reply is writing", "Stop during output keeps what was written and gives Send back.", c => stopCase(c, async () => {}, "streaming"), { langs: ["en"] });
add("Stop while a new session's runtime is still starting", "Stop during a slow start leaves a usable session.", c => stopCase(c, async () => { await control("/runtime/delay", { ms: 6_000 }); await control("/runtime/kill", { which: "all" }); await sleep(1_000); }, "starting"), { langs: ["en"] });

add("Stop with a message waiting in the queue", "The waiting message is kept (Continue or Discard), never lost or sent twice.", async c => {
  await freshSession();
  await typeAndSend("LONG reply with a queued message");
  await page.waitForFunction(SEL => /line 3\b/.test(document.querySelector(SEL.conversation)?.textContent ?? ""), SEL, { timeout: 30_000 }).catch(() => c.fail("the reply never started writing"));
  const waitingText = "Queued while writing: say QUEUED.";
  await textbox().fill(waitingText);
  await sendButton().click();
  await sleep(300);
  const start = now();
  await stopButton().click();
  if (!await idle(10_000)) c.fail("Send did not come back within 10 s");
  c.metric("stopToSendMs", now() - start);
  const text = await conversationText();
  const queued = page.getByRole("region", { name: named("queued") });
  const kept = text.includes(waitingText) || await queued.getByText(waitingText).count() > 0;
  if (!kept) c.fail("the waiting message is gone");
  const resume = queued.getByRole("button", { name: named("continue") });
  if (await resume.count()) { await resume.click(); await idle(30_000); }
  const times = await conversation().getByText(waitingText, { exact: true }).count();
  if (times > 1) c.fail(`the waiting message is shown ${times} times`);
  await judgeRecovers(c);
}, { langs: ["en"] });

// ---- The runtime ----
add("Runtime killed while the session is idle", "A runtime that died between messages must not cost the next message.", async c => {
  await freshSession();
  const first = ask();
  await typeAndSend(first.prompt);
  if (!await replyArrives(first.answer)) c.fail("the first reply never arrived");
  await idle();
  const before = await layout();
  const killed = await control("/runtime/kill", { which: "all" });
  c.note(`killed runtimes ${killed.killed?.join(", ")}`);
  await sleep(1_500);
  const next = ask();
  const start = await typeAndSend(next.prompt);
  if (!await replyArrives(next.answer, 20_000)) c.fail("the message after the runtime died got no reply within 20 s");
  c.metric("sendToReplyAfterKillMs", now() - start);
  if (now() - start > 10_000) c.fail(`recovery took ${now() - start} ms (limit 10 s)`);
  const shown = await problems();
  if (shown.length > 1) c.fail(`shown more than once: ${shown.map(item => item.text).join(" | ")}`);
  judgeLayout(c, before, await layout());
});

add("Runtime killed while the reply is writing", "The interrupted reply is marked once; the session is usable again within 10 s.", async c => {
  await chatSession();
  const before = await layout();
  const start = await typeAndSend("LONG reply that loses its runtime");
  await page.waitForFunction(SEL => /line 3\b/.test(document.querySelector(SEL.conversation)?.textContent ?? ""), SEL, { timeout: 30_000 }).catch(() => c.fail("the reply never started writing"));
  await control("/runtime/kill", { which: "all" });
  const killedAt = now();
  const back = await idle(15_000);
  c.metric("killToSendMs", now() - killedAt);
  if (!back) c.fail("Send did not come back within 15 s after the runtime died");
  else if (now() - killedAt > 10_000) c.fail(`took ${now() - killedAt} ms to be usable (limit 10 s)`);
  const shown = await problems();
  judgeShown(c, shown, { scope: ["reply", "composer"], before, after: await layout() });
  if (!/line 1\b/.test(await conversationText())) c.fail("the part written before the runtime died is gone");
  c.metric("sendToKillMs", killedAt - start);
  await judgeNoEndlessWait(c);
  await judgeRecovers(c);
});

add("Runtime keeps crashing", "A runtime that dies again and again ends in one readable session error with one way out, not an endless spinner; the way out works once the cause is gone.", async c => {
  await chatSession();
  const before = await layout();
  const { prompt } = ask();
  const loop = control("/runtime/kill-loop", { ms: 20_000 });
  await sleep(500);
  const start = await typeAndSend(prompt).catch(() => now());
  // Watch while the crashes go on: the loop answers only when it ends, about 20 s later.
  const [shown] = await Promise.all([firstProblem(start, 25_000), loop]);
  if (!shown) c.fail("20 s of crashes and nothing shown");
  else {
    c.metric("crashShownMs", shown.ms);
    judgeShown(c, await problems(), { scope: ["composer", "reply"], before, after: await layout() });
  }
  await judgeNoEndlessWait(c, 5_000);
  const way = page.getByRole("button", { name: named("restart") });
  if (await way.isVisible().catch(() => false)) { await way.click(); await sleep(3_000); }
  await judgeRecovers(c);
}, { langs: ["en", "ja"] });

add("Runtime slow to start: a new session is sendable at once", "On a slow or busy computer the runtime may take seconds; the person can still type and send at once, and the message is answered when it is ready.", async c => {
  await control("/runtime/delay", { ms: 8_000 });
  // Runtimes already started (the warm pool) would hide the slow start: end them, so the
  // new session's runtime starts now, slowly.
  await control("/runtime/kill", { which: "all" });
  await sleep(1_000);
  await page.keyboard.press("Escape").catch(() => {});
  const click = now();
  await newSession().click();
  await textbox().waitFor({ timeout: 10_000 });
  const composerMs = now() - click;
  c.metric("newSessionToComposerMs", composerMs);
  const { prompt, answer } = ask();
  await textbox().fill(prompt);
  const sendable = await sendButton().isEnabled();
  c.metric("newSessionSendWaitMs", sendable ? 0 : -1);
  if (!sendable) c.fail("Send was not usable when the composer showed (limit 0 s)");
  await sendButton().waitFor({ timeout: 15_000 });
  const { own } = await sendTimed(prompt);
  c.metric("ownMessageMs", own ?? -1);
  if (own === null || own > 100) c.fail(`own message took ${own === null ? "over 10 s" : `${Math.round(own)} ms`} (limit 100 ms)`);
  if (!await replyArrives(answer, 40_000)) c.fail("the message sent during the slow start got no reply within 40 s");
  c.metric("newSessionToReplyMs", now() - click);
  const shown = await problems();
  if (shown.length) c.fail(`a slow start was shown as a problem: ${shown.map(item => item.text).join(" | ")}`);
  await control("/runtime/delay", { ms: 0 });
}, { langs: ["en"] });

add("Computer asleep for 30 s during a reply", "After sleep the reply finishes or is marked once, nothing is duplicated, and the session works.", async c => {
  await chatSession();
  const before = await layout();
  const prompt = "LONG reply across a sleep";
  await typeAndSend(prompt);
  await page.waitForFunction(SEL => /line 3\b/.test(document.querySelector(SEL.conversation)?.textContent ?? ""), SEL, { timeout: 30_000 }).catch(() => c.fail("the reply never started writing"));
  await control("/freeze", { ms: 30_000 });
  const woke = now();
  const back = await idle(40_000);
  c.metric("wakeToSendMs", now() - woke);
  if (!back) c.fail("not usable within 40 s after waking");
  const text = await conversationText();
  if (await conversation().getByText(prompt, { exact: true }).count() > 1) c.fail("the message is shown twice after waking");
  const shown = await problems();
  if (shown.length > 1) c.fail(`shown more than once: ${shown.map(item => item.text).join(" | ")}`);
  judgeLayout(c, before, await layout());
  await judgeNoEndlessWait(c);
  await judgeRecovers(c);
}, { langs: ["en"] });

// ---- Input ----
add("Very long message (300 KB)", "A huge paste is either sent whole or refused before sending with the text kept; the window does not widen or freeze.", async c => {
  await chatSession();
  const before = await layout();
  const big = `${"lorem ipsum dolor sit amet ".repeat(11_000)} What is 6 × 7? Reply with only the number.`;
  sent.push(big);
  await textbox().fill(big);
  const start = now();
  await sendButton().click({ timeout: 5_000 }).catch(() => c.fail("Send not available for a long message"));
  const shown = await firstProblem(start, 5_000);
  if (shown) {
    judgeShown(c, shown.list, { scope: ["composer"], before, after: await layout() });
    if ((await textbox().inputValue()).length < big.length) c.fail("the refused text was not kept");
  } else {
    if (!await replyArrives("42", 30_000)) c.fail("neither refused nor answered within 30 s");
    judgeLayout(c, before, await layout());
  }
  c.metric("sendToOutcomeMs", now() - start);
  await idle(10_000);
}, { langs: ["en", "ja"] });

add("Long unbroken token in a message", "A pasted path or id thousands of characters long never widens the window or moves the composer.", async c => {
  await chatSession();
  const before = await layout();
  await typeAndSend(`${"x".repeat(3_000)} What is 8 × 9? Reply with only the number.`);
  await replyArrives("72", 20_000);
  judgeLayout(c, before, await layout());
}, { langs: ["en"] });

add("Image the model refuses", "A refused image shows once on the reply with a way out; the session does not stay stuck.", async c => {
  await chatSession();
  const chooser = page.getByLabel(named("chooseImages"));
  if (!await chooser.count()) { c.record.skipped = true; c.note("the model takes no images"); return; }
  const before = await layout();
  await fault({ refuseImages: true });
  await chooser.setInputFiles({ name: "square.png", mimeType: "image/png", buffer: await redSquarePng() });
  await page.getByRole("list", { name: named("attachedImages") }).waitFor({ timeout: 10_000 }).catch(() => c.fail("a valid image was not attached"));
  const start = await typeAndSend("What is in this picture?");
  const shown = await firstProblem(start, 30_000);
  if (!shown) c.fail("a refused image showed nothing within 30 s");
  else { await sleep(1_000); judgeShown(c, await problems(), { scope: ["reply", "composer"], before, after: await layout() }); }
  await judgeNoEndlessWait(c);
  // The provider keeps refusing while the image is in the history: the way out is the
  // session's own (Remove images or a new session). The fault stays on until it is used.
  const removeImages = page.getByRole("button", { name: /remove images|画像を削除|移除图片|移除圖片/i }).first();
  if (!await removeImages.isVisible().catch(() => false)) {
    // Only behind the failed reply's Details?
    await page.locator("[data-reply-failed] summary").last().click().catch(() => {});
    await sleep(300);
    if (await removeImages.isVisible().catch(() => false)) c.fail("the way out (Remove images) is only inside the collapsed details of the failed reply");
  }
  if (await removeImages.isVisible().catch(() => false)) { await removeImages.click(); await sleep(2_000); }
  else c.fail("no way out offered for the refused image");
  await judgeRecovers(c);
  await fault({});
}, { langs: ["en", "ja"] });

add("A file that is not an image, named .png", "A broken attachment is refused at the composer with the text kept, never sent half-way.", async c => {
  await chatSession();
  const chooser = page.getByLabel(named("chooseImages"));
  if (!await chooser.count()) { c.record.skipped = true; c.note("the model takes no images"); return; }
  const before = await layout();
  await textbox().fill("Look at this file");
  await chooser.setInputFiles({ name: "notes.png", mimeType: "image/png", buffer: Buffer.from("this is not an image") });
  await sleep(1_500);
  const shown = await problems();
  const attached = await page.getByRole("list", { name: named("attachedImages") }).isVisible().catch(() => false);
  if (!shown.length && attached) {
    const start = await typeAndSend("Look at this file");
    const later = await firstProblem(start, 20_000);
    if (!later) c.fail("a broken image was accepted and nothing was shown");
    else judgeShown(c, later.list, { scope: ["composer", "reply"], before, after: await layout() });
  } else if (shown.length) {
    judgeShown(c, shown, { scope: ["composer"], before, after: await layout() });
    if (!(await textbox().inputValue()).includes("Look at this file")) c.fail("the typed text was lost");
  } else c.fail("the file was neither attached nor refused visibly");
  await page.keyboard.press("Escape").catch(() => {});
  // Leave nothing for the next case: the typed text and the refused file stay in this composer.
  await textbox().fill("").catch(() => {});
}, { langs: ["en", "ja"] });

// ---- Settings and files ----
async function openSettings(tab) {
  await page.getByRole("button", { name: named("settings") }).first().click();
  const dialog = page.getByRole("dialog").first();
  if (tab) await dialog.getByRole("tab", { name: tab }).click();
  return dialog;
}
add("Rapid settings changes", "Changing a setting many times quickly never fails with 'another operation is running', ends on the last choice and survives a reload.", async c => {
  const dialog = await openSettings(/^(language|言語|语言|語言)$/i);
  const combo = dialog.getByRole("combobox", { name: /reply language|応答|回复|回覆/i }).first();
  if (!await combo.count()) { c.fail("no reply language control found"); return; }
  const options = ["日本語", "English", "简体中文", "日本語", "English", "繁體中文"];
  const start = now();
  for (const option of options) {
    await combo.click();
    await page.getByRole("option", { name: option, exact: true }).click().catch(() => c.note(`option ${option} not offered`));
  }
  await sleep(3_000);
  c.metric("sixChangesMs", now() - start);
  const shown = (await problems()).filter(item => item.scope === "settings");
  if (shown.length) c.fail(`problems after quick changes: ${shown.map(item => item.text).join(" | ")}`);
  const final = (await combo.innerText()).trim();
  if (!final.includes("繁體中文")) c.fail(`the last choice did not stick: shows "${final}"`);
  await page.keyboard.press("Escape");
  await page.reload();
  await newSession().waitFor({ timeout: 30_000 });
  const again = await openSettings(/^(language|言語|语言|語言)$/i);
  const after = (await again.getByRole("combobox", { name: /reply language|応答|回复|回覆/i }).first().innerText()).trim();
  if (!after.includes("繁體中文")) c.fail(`after reload the setting shows "${after}"`);
  await again.getByRole("combobox", { name: /reply language|応答|回复|回覆/i }).first().click();
  await page.getByRole("option").first().click();
  await page.keyboard.press("Escape");
}, { langs: ["en"] });

add("Settings file cannot be written", "When a setting cannot be saved, that card says so in plain words, nothing moves, and nothing else stops working.", async c => {
  const lock = await control("/file", { path: "data/agent/settings.json", readOnly: true });
  if (!lock.effective) { c.record.skipped = true; c.note("this machine cannot make the file unwritable (running as an administrator)"); await control("/file", { path: "data/agent/settings.json", readOnly: false }); return; }
  try {
    // The default model is the setting saved in settings.json (the language controls are
    // saved in localization.json, and changing them would change the interface language).
    const dialog = await openSettings(named("providers"));
    const before = await layout();
    // Open the saved provider (its row in the provider list, or the service picker).
    const row = dialog.getByRole("button", { name: /^fixture\b/i }).first();
    if (await row.count()) await row.click();
    else {
      await dialog.getByRole("combobox", { name: named("service") }).first().click();
      await page.getByRole("option", { name: /fixture/i }).first().click();
    }
    const model = dialog.getByRole("combobox", { name: named("defaultModel") }).first();
    if (!await model.count()) { c.fail("no default model control found for the provider"); await page.keyboard.press("Escape"); return; }
    await model.click();
    await page.getByRole("option", { name: /second/i }).first().click();
    // Only a problem on the settings card counts: a line left by an earlier case elsewhere
    // (a composer warning) is not this save's answer.
    let shown = null;
    for (const until = now() + 10_000; now() < until && !shown; await sleep(100)) {
      const list = (await problems()).filter(item => item.scope === "settings");
      if (list.length) shown = list;
    }
    if (!shown) {
      await page.screenshot({ path: join(shots, `${slug(c.record.name)}-shown.png`) }).catch(() => {});
      c.fail("a save that cannot be written showed nothing on the settings card");
    } else {
      judgeShown(c, shown, { scope: "settings", before, after: await layout() });
      // #167: Details carry what the system said, not a fixed sentence guessing the cause.
      for (const summary of await dialog.locator("details:not([open]) > summary").all()) await summary.click().catch(() => {});
      const details = await dialog.innerText().catch(() => "");
      if (/Refresh the model list and retry/i.test(details)) c.fail("#167: Details start with a fixed English sentence naming the wrong cause");
    }
    await page.keyboard.press("Escape");
  } finally {
    await control("/file", { path: "data/agent/settings.json", readOnly: false });
    // Leave the home as it was for the cases after this one.
    await control("/file", { path: "data/agent/settings.json", text: JSON.stringify({ defaultProvider: "fixture", defaultModel: "deterministic" }, null, 2) });
  }
  await freshSession();
  const next = ask();
  await typeAndSend(next.prompt);
  if (!await replyArrives(next.answer)) c.fail("chat stopped working after a settings save failed");
}, { langs: ["en", "ja"] });

add("Missing tools.json", "A data folder without tools settings opens the Tools page normally.", async c => {
  await freshSession();
  await control("/file", { path: "data/agent/tools.json", remove: true });
  const dialog = await openSettings(/^(tools|ツール|工具)$/i);
  await sleep(2_000);
  await page.screenshot({ path: join(shots, `${slug(c.record.name)}-shown.png`) }).catch(() => {});
  // Only the Tools page itself: a problem inside another tab of the dialog is not this page's.
  const panel = dialog.getByRole("tabpanel").first();
  const words = (await panel.count()) ? await panel.innerText().catch(() => "") : "";
  const shown = (await problems()).filter(item => item.scope === "settings" && (!words || words.includes(item.text)));
  if (shown.length) c.fail(`the Tools page shows a problem: ${shown.map(item => item.text).join(" | ")}`);
  if (!await dialog.isVisible()) c.fail("the settings window closed");
  await page.keyboard.press("Escape");
}, { langs: ["en"] });

// ---- Saved sessions ----
add("Old and damaged saved sessions", "Sessions written by earlier versions, half-written or empty, are listed without breaking the list; opening one shows its history or one plain reason, never a spinner; a new session still works.", async c => {
  const titles = ["Session from an older version", "Half written session", "Session with an unknown entry", "Session whose folder was deleted"];
  for (const title of titles) {
    const row = page.getByText(title, { exact: false }).first();
    if (!await row.isVisible().catch(() => false)) { c.fail(`"${title}" is not in the session list`); continue; }
    const before = await layout();
    const start = now();
    await row.click();
    const until = now() + 10_000;
    let opened = false;
    while (now() < until && !opened) {
      opened = (await conversationText()).includes(title) || (await problems()).length > 0;
      if (!opened) await sleep(150);
    }
    c.metric(`open ${title} ms`, now() - start);
    if (!opened) c.fail(`"${title}" showed neither its history nor a reason within 10 s`);
    const shown = await problems();
    if (shown.length) judgeShown(c, shown, { scope: ["composer", "reply", "page"], before, after: await layout() });
    await judgeNoEndlessWait(c, 1_000);
  }
  await freshSession();
  const next = ask();
  await typeAndSend(next.prompt);
  if (!await replyArrives(next.answer)) c.fail("a new session did not work after opening damaged sessions");
}, { langs: ["en", "ja"] });

// ---- Regressions: issues fixed since 1.1.4 and older ones ----
// One case per fixed issue that a person can see. The issue number leads the name so a
// failure names the issue it reopens. A case that needs something only one way of running
// gives (the installed app's own window cannot restart its host here) is skipped with the
// reason, never passed.
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

add("#233 Opening a saved session does not show it as Running", "Opening a saved session only starts its runtime; the list must not say it is running a reply (rc.1 regression of #213).", async c => {
  const title = "Session from an older version";
  await page.getByText(title, { exact: false }).first().click();
  await sleep(4_000);
  const state = await rowState(title);
  c.note(`row state: ${state}`);
  if (state === "missing") c.fail("the opened session is not in the list");
  if (state === "running") c.fail("the opened saved session is shown as running a reply");
}, { langs: ["en", "ja"] });

add("#212 A background session's live state shows in the list", "A session writing a reply while another is open shows as running; once done it shows as finished until opened; a stopped reply shows as a session at rest.", async c => {
  await freshSession();
  const prompt = "LONG reply in the background";
  sent.push(prompt);
  await typeAndSend(prompt);
  await page.waitForFunction(SEL => /line 2\b/.test(document.querySelector(SEL.conversation)?.textContent ?? ""), SEL, { timeout: 30_000 }).catch(() => c.fail("the reply never started writing"));
  await freshSession();
  const running = await waitRowState(prompt, ["running"], 3_000);
  c.note(`while writing: ${running}`);
  if (running !== "running") c.fail(`a session writing in the background shows "${running}", not running`);
  const done = await waitRowState(prompt, ["done"], 25_000);
  c.note(`after the reply: ${done}`);
  if (done !== "done") c.fail(`a finished background reply shows "${done}", not finished`);
  await page.getByText(prompt, { exact: false }).first().click();
  const seen = await waitRowState(prompt, [null], 5_000);
  if (seen !== null) c.fail(`after opening it, the row still shows "${seen}"`);
  // Stop: at rest, never failed.
  const stopped = "LONG reply stopped in the background";
  await freshSession();
  sent.push(stopped);
  await typeAndSend(stopped);
  await page.waitForFunction(SEL => /line 2\b/.test(document.querySelector(SEL.conversation)?.textContent ?? ""), SEL, { timeout: 30_000 }).catch(() => {});
  await stopButton().click().catch(() => c.fail("no Stop"));
  await idle(10_000);
  await freshSession();
  const rest = await waitRowState(stopped, [null], 5_000);
  if (rest !== null) c.fail(`a stopped reply shows "${rest}" in the list, not a session at rest`);
}, { langs: ["en", "ja"] });

add("#214 A finished reply is not shown as Interrupted", "After a normal turn the status line says how it ended from the host, never \"Interrupted\".", async c => {
  await chatSession();
  await sleep(1_000);
  const word = more.interrupted;
  if ((await outsideConversation()).includes(word)) c.fail(`"${word}" is shown after a normal turn`);
  // And after leaving the session and coming back.
  const text = sent.at(-1);
  await freshSession();
  await page.getByText(text, { exact: false }).first().click();
  await sleep(2_000);
  if ((await outsideConversation()).includes(word)) c.fail(`"${word}" is shown after reopening a session whose turn ended normally`);
}, { langs: ["en", "ja"] });

add("#177 #179 Send while a new session's runtime starts", "On a slow start the message is sent at once, the session is listed at once, Stop is offered and Steer is not.", async c => {
  await control("/runtime/delay", { ms: 8_000 });
  await control("/runtime/kill", { which: "all" });
  await sleep(1_000);
  await page.keyboard.press("Escape").catch(() => {});
  await newSession().click();
  await textbox().waitFor({ timeout: 10_000 });
  const { prompt, answer } = ask();
  const start = await typeAndSend(prompt);
  const listed = await sidebar().getByText(prompt, { exact: false }).first().waitFor({ timeout: 2_000 }).then(() => now() - start, () => null);
  c.metric("sendToListedMs", listed ?? -1);
  if (listed === null) c.fail("#177: the session sent while its runtime starts is not in the list within 2 s");
  if (await page.getByRole("button", { name: namedMore("steer") }).count()) c.fail("#179: Steer is offered while the session's runtime starts");
  if (/Enter to steer/i.test(await outsideConversation())) c.fail("#179: the composer says Jouzu reads it at its next step while nothing runs");
  if (!await stopButton().isVisible().catch(() => false)) c.fail("#232: no Stop while the runtime starts");
  if (!await replyArrives(answer, 40_000)) c.fail("the message sent during the slow start got no reply within 40 s");
  const times = await sidebar().getByText(prompt, { exact: false }).count();
  if (times !== 1) c.fail(`#177: the session is listed ${times} times after the reply`);
  await control("/runtime/delay", { ms: 0 });
}, { langs: ["en", "ja"] });

add("#162 Waiting messages come back paused after a restart", "A message waiting in the queue is kept across a restart of the app, paused, with Continue and Discard; Continue sends it once.", async c => {
  if (!await browserMode()) { c.record.skipped = true; c.note("the installed app's window cannot be restarted by this exam; run it with ABN_INSTALL"); return; }
  await freshSession();
  await fault({ hang: true });
  const first = ask();
  await typeAndSend(first.prompt);
  await sleep(1_500);
  const waitingMsg = ask();
  sent.push(waitingMsg.prompt);
  await textbox().fill(waitingMsg.prompt);
  await sendButton().click();
  await sleep(1_000);
  const queued = () => page.locator("section, [role='region']").filter({ hasText: waitingMsg.prompt });
  if (!await queued().count()) c.note("the second message did not show as waiting before the restart");
  const restarted = await control("/host/restart", {});
  if (!restarted.url) { c.fail(`the host did not restart: ${JSON.stringify(restarted)}`); return; }
  await fault({});
  await page.goto(restarted.url);
  await page.evaluate(value => localStorage.setItem("jouzu.ui.language", value), lang);
  await page.reload();
  await newSession().waitFor({ timeout: 60_000 });
  await sidebar().getByText(first.prompt, { exact: false }).first().click().catch(() => c.fail("the session is not in the list after the restart"));
  const back = queued().first();
  const shown = await back.getByRole("button", { name: named("continue") }).waitFor({ timeout: 15_000 }).then(() => true, () => false);
  if (!shown) { c.fail("the waiting message is gone or not paused with Continue after the restart"); await page.screenshot({ path: join(shots, `${slug(c.record.name)}-after.png`) }).catch(() => {}); return; }
  if (!await back.getByRole("button", { name: namedMore("discard") }).count()) c.fail("no Discard for the waiting message");
  await back.getByRole("button", { name: named("continue") }).click();
  const unanswered = await page.locator("[data-no-reply]").count();
  c.note(`the message in flight at the restart is marked No reply: ${unanswered > 0}`);
  if (!await replyArrives(waitingMsg.answer, 15_000)) {
    // Flow may hold it after the runtime was lost (#145, open): the person releases it.
    const release = page.locator("[data-flow-hold]").getByRole("button", { name: /^(Release|解除|释放|釋放)$/ }).first();
    if (await release.isVisible().catch(() => false)) {
      c.note("#145: Flow held the continued message; released it");
      await page.screenshot({ path: join(shots, `${slug(c.record.name)}-flow-hold.png`) }).catch(() => {});
      await release.click();
    }
    if (!await replyArrives(waitingMsg.answer, 30_000)) c.fail("Continue did not get the waiting message answered");
  }
  await sleep(1_000);
  const times = await conversation().getByText(waitingMsg.prompt, { exact: false }).count();
  if (times > 1) c.fail(`the waiting message is in the conversation ${times} times`);
}, { langs: ["en"] });

add("#173 An environment change reaches the open session", "A variable changed in Settings > Environment is used by the session already open, without restarting the app.", async c => {
  // Runs on every platform (product owner, 2026-11-26): a system where the save is refused
  // fails this case like any other.
  await chatSession();
  await fault({ requireKey: "rotated-secret" });
  const before = ask();
  const start = await typeAndSend(before.prompt);
  if (!await firstProblem(start, 30_000)) c.note("the old key was not refused (fixture)");
  await idle(15_000);
  const dialog = await openSettings(namedMore("environment"));
  await dialog.getByRole("button", { name: namedMore("addVariable") }).click();
  await dialog.getByRole("textbox", { name: namedMore("variableName") }).last().fill("FIXTURE_SECRET");
  await dialog.getByLabel(namedMore("variableValue")).last().fill("rotated-secret");
  await dialog.getByRole("button", { name: namedMore("save") }).last().click();
  await sleep(3_000);
  const settingsProblems = (await problems()).filter(item => item.scope === "settings");
  if (settingsProblems.length) {
    c.fail(`saving the environment showed: ${settingsProblems.map(item => item.text).join(" | ")}`);
    for (const summary of await dialog.locator("details:not([open]) > summary").all()) await summary.click().catch(() => {});
    c.note(`details: ${(await dialog.innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 600)}`);
    await page.screenshot({ path: join(shots, `${slug(c.record.name)}-settings.png`) }).catch(() => {});
  }
  await page.keyboard.press("Escape");
  const next = ask();
  await idle(15_000);
  await textbox().fill(next.prompt);
  sent.push(next.prompt);
  const at = now();
  await sendButton().click({ timeout: 5_000 }).catch(() => c.fail("Send not available after the environment change"));
  if (!await replyArrives(next.answer, 40_000)) c.fail("the open session still uses the old environment: no reply with the new key");
  c.metric("sendToReplyMs", now() - at);
  // Leave the world as it was.
  await fault({});
  const again = await openSettings(namedMore("environment"));
  const remove = again.getByRole("button", { name: /remove entry|項目を削除|移除条目|移除項目/i });
  for (let n = await remove.count(); n > 0; n -= 1) await remove.last().click();
  await again.getByRole("button", { name: namedMore("save") }).last().click();
  await sleep(2_000);
  await page.keyboard.press("Escape");
}, { langs: ["en"] });

add("#171 A custom connection can be removed", "Remove connection deletes the provider and its key; it leaves the list at once.", async c => {
  const dialog = await openSettings(named("providers"));
  const row = dialog.getByRole("button", { name: /^extra\b/i }).first();
  if (!await row.count()) { c.fail("the custom connection \"extra\" is not listed"); await page.keyboard.press("Escape"); return; }
  await row.click();
  const remove = dialog.getByRole("button", { name: namedMore("removeConnection") });
  if (!await remove.count()) { c.fail("no Remove connection for a custom connection"); await page.keyboard.press("Escape"); return; }
  // The question comes from the desktop shell's own dialog. In a test browser there is no
  // shell: answer it as a person would (yes), and say so.
  const shell = !await browserMode();
  if (shell) { c.record.skipped = true; c.note("the installed app asks with a native dialog this exam cannot answer"); await page.keyboard.press("Escape"); return; }
  await page.evaluate(() => { window.__examDialog = true; window.__TAURI_INTERNALS__ = { invoke: async command => command === "plugin:dialog|message" ? "Ok" : undefined, transformCallback: () => 0 }; });
  await remove.click();
  await sleep(2_000);
  await page.evaluate(() => { if (window.__examDialog) { delete window.__TAURI_INTERNALS__; delete window.__examDialog; } });
  const shown = (await problems()).filter(item => item.scope === "settings");
  await page.screenshot({ path: join(shots, `${slug(c.record.name)}-after-remove.png`) }).catch(() => {});
  if (shown.length) {
    c.fail(`removing showed: ${shown.map(item => item.text).join(" | ")}`);
    for (const summary of await dialog.locator("details:not([open]) > summary").all()) await summary.click().catch(() => {});
    c.note(`details: ${(await dialog.innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 600)}`);
  }
  await page.keyboard.press("Escape");
  const reopened = await openSettings(named("providers"));
  if (await reopened.getByRole("button", { name: /^extra\b/i }).count()) c.fail("the removed connection is still listed");
  const file = await fetch(`${world}/file?path=${encodeURIComponent("data/agent/models.json")}`).then(response => response.json());
  if (/"extra"/.test(file.text ?? "")) { c.fail("the removed provider is still in models.json"); c.note(`models.json: ${(file.text ?? "").replace(/\s+/g, " ").slice(0, 400)}`); }
  await page.keyboard.press("Escape");
}, { langs: ["en"] });

add("#174 A session whose folder was deleted", "It stays in the list and in its workspace, says its folder is gone, offers no Restart session and starts no runtime.", async c => {
  const title = "Session whose folder was deleted";
  const before = (await control("/state")).runtimes.length;
  await page.getByText(title, { exact: false }).first().click();
  const blocked = page.locator("[data-session-blocked]").first();
  const said = await blocked.waitFor({ timeout: 10_000 }).then(() => true, () => false);
  if (!said) c.fail("opening it shows no session-level reason");
  else {
    const text = await blocked.innerText();
    c.note(`shown: ${text.replace(/\s+/g, " ").slice(0, 160)}`);
    if (lang === "en" && !/folder/i.test(text)) c.fail(`the reason does not name the folder: "${text.slice(0, 120)}"`);
    if (/runtime/i.test(text)) c.fail("it says the runtime failed");
  }
  if (await page.getByRole("button", { name: named("restart") }).count()) c.fail("Restart session is offered for a missing folder");
  await sleep(3_000);
  const after = (await control("/state")).runtimes.length;
  if (after > before) c.note(`runtimes ${before} -> ${after} (the warm pool may refill)`);
  if (!await sidebar().getByText(title, { exact: false }).count()) c.fail("the session left the list");
}, { langs: ["en", "ja"] });

add("#178 A provider server error is not called no network", "A 500 from the provider and an unreachable provider are told apart in the words the person reads.", async c => {
  const shownFor = async body => {
    await freshSession();
    await fault(body);
    const start = await typeAndSend(ask().prompt);
    const found = await firstProblem(start, 60_000);
    await fault({});
    await idle(15_000);
    return found?.list.map(item => item.text).join(" | ") ?? null;
  };
  const server = await shownFor({ status: 500 });
  const network = await shownFor({ reset: true });
  c.note(`500: ${server} || network: ${network}`);
  if (!server || !network) c.fail("one of the two failures showed nothing");
  else if (server === network) c.fail(`both say the same: "${server}"`);
}, { langs: ["en", "ja"] });

add("#205 #168 Settings show no dirty build and no launcher", "Settings > System shows a clean build, and no page of Settings speaks of a launcher.", async c => {
  const dialog = await openSettings();
  const tabs = dialog.getByRole("tab");
  const count = await tabs.count();
  for (let index = 0; index < count; index += 1) {
    const tab = tabs.nth(index);
    const name = (await tab.innerText()).trim();
    await tab.click();
    await sleep(600);
    const text = await dialog.innerText();
    if (/launcher|ランチャー|启动器|啟動器/i.test(text)) c.fail(`#168: the ${name} page speaks of a launcher`);
    if (namedMore("system").test(name) && /dirty/i.test(text)) c.fail("#205: Settings > System shows the build as dirty");
  }
  await page.keyboard.press("Escape");
  if (/launcher|ランチャー|启动器|啟動器/i.test(await outsideConversation())) c.fail("#168: the main window speaks of a launcher");
}, { langs: ["en", "ja"] });

add("#208 Commit marking can be switched on and kept", "Settings > Collaboration: the switch turns commit marking on, the author choice shows and is kept after reopening, and it turns off again.", async c => {
  let dialog = await openSettings(namedMore("collaboration"));
  const mark = dialog.getByRole("switch").first();
  if (!await mark.count()) { c.fail("no commit marking switch"); await page.keyboard.press("Escape"); return; }
  const was = await mark.isChecked();
  if (!was) await mark.click();
  await sleep(1_500);
  const radios = dialog.getByRole("radio");
  if (await radios.count() < 2) c.fail("no author / co-author choice once switched on");
  else await radios.last().check().catch(() => c.fail("the choice cannot be picked"));
  await sleep(1_500);
  const chosen = await radios.last().isChecked().catch(() => false);
  await page.keyboard.press("Escape");
  dialog = await openSettings(namedMore("collaboration"));
  if (!await dialog.getByRole("switch").first().isChecked()) c.fail("the switch was not kept");
  if (chosen && !await dialog.getByRole("radio").last().isChecked()) c.fail("the author choice was not kept");
  const shown = (await problems()).filter(item => item.scope === "settings");
  if (shown.length) c.fail(`problems: ${shown.map(item => item.text).join(" | ")}`);
  if (!was) await dialog.getByRole("switch").first().click();
  await sleep(1_000);
  await page.keyboard.press("Escape");
}, { langs: ["en"] });

add("#130 The host token is in no file", "The host gives its API token only to the app that started it; the agent's tools cannot read it from a file.", async c => {
  const file = await fetch(`${world}/file?path=host.json`).then(response => response.json());
  if (file.exists && /token/i.test(file.text ?? "")) c.fail("host.json holds the API token");
}, { langs: ["en"] });

add("#33 A draft stays in its own session", "Text typed but not sent in one session never shows in another session's composer.", async c => {
  await chatSession();
  const draft = "Draft that belongs to the first session";
  await textbox().fill(draft);
  await freshSession();
  // Right after the click the old session can still be on screen with its own draft; only a
  // draft that is still there once the new session is shown counts (seen on macOS).
  let other = await textbox().inputValue();
  for (const until = now() + 3_000; other.includes(draft) && now() < until; other = await textbox().inputValue()) await sleep(100);
  if (other.includes(draft)) c.fail("the draft from another session is in the new session's composer");
  await textbox().fill("");
}, { langs: ["en"] });

add("#26 Settings stay open when clicking beside them", "A click outside the Settings window does not close it and lose what was being edited.", async c => {
  const dialog = await openSettings();
  await page.mouse.click(5, 5);
  await sleep(800);
  if (!await dialog.isVisible().catch(() => false)) c.fail("Settings closed on a click outside");
  await page.keyboard.press("Escape");
}, { langs: ["en"] });

add("#119 An image in a sent message stays after switching sessions", "The image a person sent is still shown in the message after opening another session and coming back.", async c => {
  await freshSession();
  const chooser = page.getByLabel(named("chooseImages"));
  if (!await chooser.count()) { c.record.skipped = true; c.note("the model takes no images"); return; }
  await chooser.setInputFiles({ name: "square.png", mimeType: "image/png", buffer: await redSquarePng() });
  await page.getByRole("list", { name: named("attachedImages") }).waitFor({ timeout: 10_000 }).catch(() => c.fail("the image was not attached"));
  const prompt = `Picture check ${now()}`;
  await typeAndSend(prompt);
  await idle(30_000);
  const images = () => conversation().locator("img").count();
  const before = await images();
  if (!before) c.fail("the sent image is not shown in the message");
  await freshSession();
  await sidebar().getByText(prompt, { exact: false }).first().click();
  await conversation().getByText(prompt, { exact: false }).first().waitFor({ timeout: 10_000 }).catch(() => {});
  await sleep(1_500);
  const after = await images();
  if (after < before) c.fail(`the image is gone after switching sessions (${before} -> ${after})`);
}, { langs: ["en"] });

// Expected behaviour from decision 0029 and host-layer.md §7: the host checks the installation
// when it starts and installs it on its own; the prepare screen shows it; the person is not asked
// to repair anything, and a session then answers.
const PREPARING = {
  en: ["Preparing Jouzu…", "Downloading Node…", "Installing packages…"],
  ja: ["Jouzu を準備しています…", "Node をダウンロードしています…", "パッケージをインストールしています…"],
};
const INSTALL_FAILED = { en: "Installation failed", ja: "インストールに失敗しました" };
const ASKED_TO_INSTALL = { en: "Runtime files are missing. Install them to continue.", ja: "ランタイムがありません。続行するにはインストールしてください。" };
add("#87 Runtime files missing at start are installed again", "The runtime's files are missing when the app starts: within 60 s the window says it is preparing the runtime (not an endless Connecting, not a request to install), the host installs them on its own, and a session then answers.", async c => {
  if (!await browserMode()) { c.record.skipped = true; c.note("the installed app's window cannot be restarted by this exam; run it with ABN_INSTALL"); return; }
  const reopen = async body => {
    const restarted = await control("/host/restart", body);
    if (!restarted.url) throw new Error(`the host did not restart: ${JSON.stringify(restarted)}`);
    await page.goto(restarted.url);
    await page.evaluate(value => localStorage.setItem("jouzu.ui.language", value), lang);
    await page.reload();
  };
  const words = PREPARING[lang] ?? PREPARING.en;
  const bodyText = () => page.locator("body").innerText().catch(() => "");
  try {
    const start = now();
    await reopen({ runtime: "missing" });
    let seen = null;
    for (const end = now() + 60_000; !seen && now() < end; await sleep(500)) { const text = await bodyText(); seen = words.find(word => text.includes(word)) ?? null; }
    await page.screenshot({ path: join(shots, `${slug(c.record.name)}-start.png`) }).catch(() => {});
    if (!seen) {
      const text = (await bodyText()).replace(/\s+/g, " ");
      if (text.includes(ASKED_TO_INSTALL[lang] ?? ASKED_TO_INSTALL.en)) c.fail("the window asks the person to install the runtime's files instead of installing them on its own");
      else c.fail(`within 60 s of starting without the runtime's files the window never said it was preparing the runtime (it shows: "${text.slice(0, 200)}")`);
      return;
    }
    c.metric("startToPrepareMs", now() - start);
    // Ready when the composer shows; a shown installation failure ends the wait at once with its words.
    let ready = false, failed = null;
    for (const end = now() + 9 * 60_000; !ready && !failed && now() < end; await sleep(1_000)) {
      ready = await textbox().isVisible().catch(() => false);
      const text = await bodyText();
      const word = INSTALL_FAILED[lang] ?? INSTALL_FAILED.en;
      if (!ready && text.includes(word)) failed = text.slice(text.indexOf(word)).replace(/\s+/g, " ").slice(0, 300);
    }
    c.metric("startToReadyMs", now() - start);
    if (failed) { c.fail(`the installation the host started on its own failed: "${failed}"`); await page.screenshot({ path: join(shots, `${slug(c.record.name)}-failed.png`) }).catch(() => {}); return; }
    if (!ready) { c.fail("the runtime was not installed again within 9 min"); await page.screenshot({ path: join(shots, `${slug(c.record.name)}-not-ready.png`) }).catch(() => {}); return; }
    const next = ask();
    await typeAndSend(next.prompt);
    if (!await replyArrives(next.answer, 40_000)) c.fail("after the runtime was installed again, the session did not answer");
  } finally {
    await reopen({ runtime: "normal" }).catch(error => c.note(`could not restore the normal host: ${error.message}`));
    await newSession().waitFor({ timeout: 60_000 }).catch(() => {});
  }
}, { langs: ["en", "ja"] });

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

// ---- Run ----
if (listOnly) {
  console.log(JSON.stringify(cases.map(item => ({ name: item.name, why: item.why, langs: item.langs }))));
  process.exit(0);
}
// The installed app's window cannot be given a language before it loads: set it as the app
// keeps it and load again.
await page.waitForLoadState("domcontentloaded").catch(() => {});
if (await page.evaluate(() => localStorage.getItem("jouzu.ui.language")).catch(() => null) !== lang) {
  await page.evaluate(value => localStorage.setItem("jouzu.ui.language", value), lang);
  await page.reload();
}
await newSession().waitFor({ timeout: 60_000 }).catch(error => result.errors.push(`the app never became usable: ${error.message}`));
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
