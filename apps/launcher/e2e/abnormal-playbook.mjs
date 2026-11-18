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
 *   PLAYBOOK_ONLY     run only cases whose names contain this text
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
const { connected: browser, found: page } = await connect(process.env.PLAYBOOK_CDP ?? "http://127.0.0.1:9223");
const result = { startedAt: new Date().toISOString(), lang, cases: [], errors: [] };
const now = () => Date.now();
const sleep = ms => page.waitForTimeout(ms);
page.on("pageerror", error => result.errors.push(`page error: ${String(error)}`));

// ---- The world ----
const post = (base, path, body = {}) => fetch(base + path, { method: "POST", body: JSON.stringify(body) }).then(response => response.json());
const fault = body => post(fixture, "/__fault", body);
const providerRequests = async () => (await fetch(fixture + "/__fault").then(response => response.json()));
const control = (path, body) => post(world, path, body);

// ---- Words the person sees, per interface language (from src/chat-text.ts, src/i18n.ts) ----
const allWords = {
  en: { newSession: "New session", retry: "Retry", settings: "Settings", restart: "Restart session", continue: "Continue", discard: "Discard" },
  ja: { newSession: "新しいセッション", retry: "再試行", settings: "設定", restart: "セッションを再起動", continue: "続ける", discard: "破棄" },
  "zh-Hans": { newSession: "新会话", retry: "重试", settings: "设置", restart: "重启会话", continue: "继续", discard: "丢弃" },
  "zh-Hant": { newSession: "新工作階段", retry: "重試", settings: "設定", restart: "重新啟動工作階段", continue: "繼續", discard: "捨棄" },
};
const words = allWords[lang];
const english = allWords.en;
/**
 * A control's accessible name: the interface language's word, or the English one while that
 * control is not localized yet (the English-only words are reported by the i18n judgement of
 * the problems shown, not by failing to find the control).
 */
const named = key => new RegExp(`^(${words[key]}|${english[key]})$`);
const newSession = () => page.getByRole("button", { name: named("newSession") }).first();
const textbox = () => page.getByRole("textbox", { name: /message/i }).first();
const sendButton = () => page.locator('[aria-label="Message composer"] button[type="submit"]').first();
const stopButton = () => page.locator('[aria-label="Message composer"]').getByRole("button", { name: /^(stop|停止)$/i }).first();
const conversation = () => page.getByRole("region", { name: /conversation/i }).first();
const conversationText = async () => (await conversation().textContent().catch(() => "")) ?? "";

/** Everything shown as a problem, where it is, and the words of its main sentence. */
async function problems() {
  return page.evaluate(() => {
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
      : element.closest('[aria-label="Conversation"]') ? "reply"
      : element.closest('[aria-label="Message composer"]') || element.matches("[data-flow-hold], [data-session-blocked], [data-no-reply]") ? "composer"
      : element.closest('[aria-label="Workspaces"]') ? "sidebar"
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
  });
}
/** Where the parts the person works with are, and whether anything widens the page. */
async function layout() {
  return page.evaluate(() => {
    const box = selector => { const element = document.querySelector(selector); if (!element) return null; const rect = element.getBoundingClientRect(); return [rect.x, rect.y, rect.width, rect.height].map(Math.round); };
    return {
      composer: box('[aria-label="Message composer"]'),
      conversation: box('[aria-label="Conversation"]'),
      sidebar: box('aside[aria-label="Workspaces"]'),
      overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
    };
  });
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
const ownWords = text => sent.reduce((rest, item) => rest.split(item).join(" "), text).replace(/\s+/g, " ").trim();
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
  const enabled = () => page.waitForFunction(() => !document.querySelector('[aria-label="Message composer"] button[type="submit"]')?.disabled, null, { timeout: 250 }).then(() => true, () => false);
  if (!await enabled()) {
    await page.waitForFunction(() => !document.querySelector('[aria-label="Message composer"] button[type="submit"]')?.disabled, null, { timeout: wait }).catch(() => {});
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
  await page.evaluate(prompt => {
    window.__ownMessage = new Promise(resolve => {
      const button = document.querySelector('[aria-label="Message composer"] button[type="submit"]');
      const seen = () => [...document.querySelectorAll('[aria-label="Conversation"] *')].some(node => node.childElementCount === 0 && node.textContent === prompt);
      button.addEventListener("click", () => {
        const start = performance.now();
        if (seen()) { resolve(0); return; }
        const observer = new MutationObserver(() => { if (seen()) { observer.disconnect(); resolve(performance.now() - start); } });
        observer.observe(document.body, { subtree: true, childList: true, characterData: true });
        setTimeout(() => { observer.disconnect(); resolve(null); }, 10_000);
      }, { once: true, capture: true });
    });
  }, text);
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
  await page.waitForFunction(() => /line 3\b/.test(document.querySelector('[aria-label="Conversation"]')?.textContent ?? ""), null, { timeout: 30_000 }).catch(() => c.fail("the reply never started writing"));
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
  if (stage === "streaming") await page.waitForFunction(() => /line 3\b/.test(document.querySelector('[aria-label="Conversation"]')?.textContent ?? ""), null, { timeout: 30_000 }).catch(() => c.fail("the reply never started writing"));
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
  await page.waitForFunction(() => /line 3\b/.test(document.querySelector('[aria-label="Conversation"]')?.textContent ?? ""), null, { timeout: 30_000 }).catch(() => c.fail("the reply never started writing"));
  const waitingText = "Queued while writing: say QUEUED.";
  await textbox().fill(waitingText);
  await sendButton().click();
  await sleep(300);
  const start = now();
  await stopButton().click();
  if (!await idle(10_000)) c.fail("Send did not come back within 10 s");
  c.metric("stopToSendMs", now() - start);
  const text = await conversationText();
  const queued = page.getByRole("region", { name: "Queued messages" });
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
  await page.waitForFunction(() => /line 3\b/.test(document.querySelector('[aria-label="Conversation"]')?.textContent ?? ""), null, { timeout: 30_000 }).catch(() => c.fail("the reply never started writing"));
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
  await loop;
  const shown = await firstProblem(start, 20_000);
  if (!shown) c.fail("20 s of crashes and nothing shown");
  else judgeShown(c, await problems(), { scope: ["composer", "reply"], before, after: await layout() });
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
  await page.waitForFunction(() => /line 3\b/.test(document.querySelector('[aria-label="Conversation"]')?.textContent ?? ""), null, { timeout: 30_000 }).catch(() => c.fail("the reply never started writing"));
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
  const chooser = page.getByLabel("Choose images", { exact: true });
  if (!await chooser.count()) { c.record.skipped = true; c.note("the model takes no images"); return; }
  const before = await layout();
  await fault({ refuseImages: true });
  await chooser.setInputFiles({ name: "square.png", mimeType: "image/png", buffer: await redSquarePng() });
  await page.getByRole("list", { name: "Attached images" }).waitFor({ timeout: 10_000 }).catch(() => c.fail("a valid image was not attached"));
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
  const chooser = page.getByLabel("Choose images", { exact: true });
  if (!await chooser.count()) { c.record.skipped = true; c.note("the model takes no images"); return; }
  const before = await layout();
  await textbox().fill("Look at this file");
  await chooser.setInputFiles({ name: "notes.png", mimeType: "image/png", buffer: Buffer.from("this is not an image") });
  await sleep(1_500);
  const shown = await problems();
  const attached = await page.getByRole("list", { name: "Attached images" }).isVisible().catch(() => false);
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
    const dialog = await openSettings(/^(language|言語|语言|語言)$/i);
    const before = await layout();
    const combo = dialog.getByRole("combobox").first();
    await combo.click();
    await page.getByRole("option").nth(2).click();
    const shown = await firstProblem(now(), 10_000);
    if (!shown) c.fail("a save that cannot be written showed nothing");
    else judgeShown(c, shown.list.filter(item => item.scope === "settings"), { scope: "settings", before, after: await layout() });
    await page.keyboard.press("Escape");
  } finally {
    await control("/file", { path: "data/agent/settings.json", readOnly: false });
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
  const shown = (await problems()).filter(item => item.scope === "settings");
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
  if (only && !item.name.toLowerCase().includes(only.toLowerCase())) continue;
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
