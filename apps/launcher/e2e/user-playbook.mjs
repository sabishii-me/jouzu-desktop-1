import { chromium } from "@playwright/test";

/**
 * Black-box user playbook. Drives visible labels only; reads no host internals.
 * Usage: PLAYBOOK_CDP=http://127.0.0.1:9223 node e2e/user-playbook.mjs
 */
const cdp = process.env.PLAYBOOK_CDP ?? "http://127.0.0.1:9223";
const out = process.env.PLAYBOOK_OUT;
const browser = await chromium.connectOverCDP(cdp);
const context = browser.contexts()[0];
const page = context.pages()[0] ?? await context.newPage();
const result = { startedAt: new Date().toISOString(), metrics: {}, scenarios: [], errors: [] };
const mark = async (name, ms) => { result.metrics[name] = Math.round(ms); };
const scenario = (name, ok, detail = "") => result.scenarios.push({ name, ok, detail });
const now = () => Date.now();

page.on("pageerror", error => result.errors.push(String(error)));
page.on("console", message => {
  if (message.type() === "error" && !/Failed to load resource/.test(message.text())) result.errors.push(message.text());
});

try {
  let start = now();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "New session" }).first().waitFor({ timeout: 30_000 });
  await mark("reloadToReady", now() - start);

  // P0-1: new session, model, one turn.
  start = now();
  await page.getByRole("button", { name: "New session" }).first().click();
  await page.getByRole("textbox", { name: "Message Jouzu" }).waitFor({ timeout: 10_000 });
  await mark("newSessionReady", now() - start);

  start = now();
  await page.getByRole("button", { name: "Model" }).click();
  await page.getByRole("menu", { name: "Model selection" }).waitFor({ timeout: 5_000 });
  await mark("modelMenuVisible", now() - start);
  const model = page.getByRole("menuitemradio").filter({ hasText: "Qwen 3.8 Flash Next" }).first();
  await model.click();
  await page.getByText("Qwen 3.8 Flash Next").first().waitFor({ timeout: 5_000 });
  scenario("P0-4 model selection", true);

  const before = await page.locator('article[aria-label="assistant message"]').count();
  start = now();
  await page.getByRole("textbox", { name: "Message Jouzu" }).fill("hello，请用一句话确认你收到。");
  await page.getByRole("button", { name: "Send" }).click();
  await page.locator('article[aria-label="assistant message"]').nth(before).waitFor({ timeout: 30_000 });
  await mark("firstReplyVisible", now() - start);
  await page.getByRole("button", { name: "Send" }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByText("Enter to send", { exact: false }).waitFor({ timeout: 30_000 }).catch(() => {});
  await mark("shortTurnComplete", now() - start);
  const text = await page.locator("body").innerText();
  scenario("P0-1 fresh turn", text.includes("收到") && !text.includes("Sending…"), text.slice(-180));
  await page.screenshot({ path: process.env.TEMP + "\\playbook-01-chat.png" });

  // P0-2: second new session must not show the first transcript.
  start = now();
  await page.getByRole("button", { name: "New session" }).first().click();
  await page.getByRole("textbox", { name: "Message Jouzu" }).waitFor({ timeout: 10_000 });
  await mark("secondNewSessionReady", now() - start);
  await page.getByRole("textbox", { name: "Message Jouzu" }).fill("reply with exactly: second-ok");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByText("second-ok", { exact: false }).nth(1).waitFor({ timeout: 30_000 }).catch(() => {});
  const second = await page.locator("body").innerText();
  scenario("P0-2 second session", second.includes("second-ok"), second.slice(-180));
  await page.screenshot({ path: process.env.TEMP + "\\playbook-02-second.png" });

  // P0-3: reopen the first saved session.
  const firstRow = page.getByText("hello，请用一句话确认你收到。", { exact: true }).first();
  if (await firstRow.count()) {
    start = now();
    await firstRow.click();
    await page.locator('article[aria-label="assistant message"]').first().waitFor({ timeout: 10_000 });
    await mark("savedSessionSwitch", now() - start);
    scenario("P0-3 reopen saved session", true);
  } else {
    scenario("P0-3 reopen saved session", false, "row not found");
  }
} catch (error) {
  result.errors.push(String(error?.stack ?? error));
  await page.screenshot({ path: process.env.TEMP + "\\playbook-failure.png" }).catch(() => {});
}

result.finishedAt = new Date().toISOString();
const text = JSON.stringify(result, null, 2);
console.log(text);
if (out) await (await import("node:fs/promises")).writeFile(out, text);
await browser.close();
