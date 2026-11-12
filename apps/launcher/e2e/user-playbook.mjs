import { chromium } from "@playwright/test";

/**
 * Black-box user playbook. It uses accessible actions, visible text and a unique
 * reply sentinel only. It never reads host logs, endpoints, DOM structure or
 * layout. UI changes may require updating only the semantic locators below.
 */
const cdp = process.env.PLAYBOOK_CDP ?? "http://127.0.0.1:9223";
const out = process.env.PLAYBOOK_OUT;
const browser = await chromium.connectOverCDP(cdp);
const page = browser.contexts()[0].pages()[0] ?? await browser.contexts()[0].newPage();
const result = { startedAt: new Date().toISOString(), metrics: {}, gates: {}, scenarios: [], errors: [] };
const mark = async (name, ms) => { result.metrics[name] = Math.round(ms); };
const scenario = (name, ok, detail = "") => result.scenarios.push({ name, ok, detail });
const now = () => Date.now();
const assertGate = (name, value, limit) => {
  result.gates[name] = { value, limit, ok: value <= limit };
};

page.on("pageerror", error => result.errors.push(String(error)));
page.on("console", message => {
  if (message.type() === "error" && !/Failed to load resource/.test(message.text())) result.errors.push(message.text());
});

const newSession = () => page.getByRole("button", { name: /new session/i }).first();
const composer = () => page.getByRole("textbox", { name: /message/i }).first();
const send = () => page.getByRole("button", { name: /^send$/i }).first();
const stop = () => page.getByRole("button", { name: /^stop$/i }).first();
const conversation = () => page.getByRole("region", { name: /conversation/i }).first();

async function waitForConversationText(text, timeout = 30_000) {
  await conversation().getByText(text, { exact: true }).first().waitFor({ timeout });
}

try {
  let start = now();
  await page.reload({ waitUntil: "domcontentloaded" });
  await newSession().waitFor({ timeout: 30_000 });
  await mark("reloadToReady", now() - start);

  // P0-1: new session, own message, model, one turn.
  start = now();
  await newSession().click();
  await composer().waitFor({ timeout: 10_000 });
  await mark("newSessionUsable", now() - start);

  start = now();
  await page.getByRole("button", { name: /model/i }).first().click();
  const model = page.getByRole("menuitemradio").filter({ hasText: /qwen 3\.8 flash next/i }).first();
  await model.waitFor({ timeout: 5_000 });
  await mark("modelMenuVisible", now() - start);
  await model.click();
  await page.getByText(/qwen 3\.8 flash next/i).first().waitFor({ timeout: 5_000 });
  scenario("P0-4 model selection", true);

  const prompt = "What is 17 × 23? Reply with only the number.";
  const reply = "391";
  start = now();
  await composer().fill(prompt);
  await send().click();
  await waitForConversationText(prompt, 5_000);
  const ownMessage = now() - start;
  await mark("ownMessageVisible", ownMessage);
  assertGate("ownMessageVisible", ownMessage, 100);

  await waitForConversationText(reply);
  const firstReadable = now() - start;
  await mark("warmFirstReadable", firstReadable);
  assertGate("warmFirstReadable", firstReadable, 1_000);

  // Turn end = Stop gone and Send enabled; no hint string is used.
  await stop().waitFor({ state: "detached", timeout: 30_000 }).catch(() => {});
  await page.getByRole("button", { name: /^send$/i }).waitFor({ timeout: 30_000 });
  await mark("turnObservedEnd", now() - start);
  scenario("P0-1 fresh turn", (await page.locator("body").innerText()).includes(reply));
  await page.screenshot({ path: process.env.TEMP + "\\playbook-01-chat.png" });

  // P0-2: second new session must not show the previous transcript.
  start = now();
  await newSession().click();
  await composer().waitFor({ timeout: 10_000 });
  await mark("secondNewSessionUsable", now() - start);
  const secondPrompt = "What is 19 × 21? Reply with only the number.";
  const secondReply = "399";
  await composer().fill(secondPrompt);
  await send().click();
  await waitForConversationText(secondReply);
  const secondText = await conversation().innerText();
  scenario("P0-2 second session", secondText.includes(secondReply) && !secondText.includes(prompt));
  await page.screenshot({ path: process.env.TEMP + "\\playbook-02-second.png" });

  // P0-3: reopen the first saved session by its visible prompt.
  start = now();
  await page.getByText(/What is 17 × 23/, { exact: false }).first().click();
  await waitForConversationText(reply);
  await mark("savedSessionSwitch", now() - start);
  assertGate("savedSessionSwitch", now() - start, 2_000);
  scenario("P0-3 reopen saved session", true);
} catch (error) {
  result.errors.push(String(error?.stack ?? error));
  await page.screenshot({ path: process.env.TEMP + "\\playbook-failure.png" }).catch(() => {});
}

result.pass = result.errors.length === 0
  && Object.values(result.gates).every(gate => gate.ok)
  && result.scenarios.every(item => item.ok);
result.finishedAt = new Date().toISOString();
const text = JSON.stringify(result, null, 2);
console.log(text);
if (out) await (await import("node:fs/promises")).writeFile(out, text);
await browser.close();
