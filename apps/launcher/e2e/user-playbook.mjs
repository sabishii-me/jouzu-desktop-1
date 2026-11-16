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
/**
 * A timing measured several times is judged by its median and its slowest sample,
 * never by one sample: one slow sample is noise, a slow median is the product.
 * Limits (why each number):
 * - 100 ms: the user sees their own action answered at once (own message, the turn
 *   visibly working). Nothing has to leave the machine for it.
 * - slowest <= 2x the limit: an occasional hiccup is tolerated, a pattern is not.
 */
const assertRepeatedGate = (name, samples, limit) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor((sorted.length - 1) / 2)];
  const slowest = sorted[sorted.length - 1];
  result.metrics[name] = median;
  result.metrics[`${name}Slowest`] = slowest;
  result.gates[name] = { value: median, slowest, samples: sorted, limit, slowestLimit: limit * 2, ok: median <= limit && slowest <= limit * 2 };
};
const record = (name, samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  result.metrics[name] = sorted[Math.floor((sorted.length - 1) / 2)];
  result.metrics[`${name}Slowest`] = sorted[sorted.length - 1];
  result.samples = { ...(result.samples ?? {}), [name]: sorted };
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

/**
 * Image tool with a provider other than Shisa (#65). The provider list comes
 * from the runtime's model catalog, so a provider with a credential in the test
 * data directory must be listed, selectable and able to generate; switching
 * back to Shisa must still work. PLAYBOOK_IMAGE_PROVIDER names the provider as
 * the Tools page labels it (e.g. "OpenRouter"); without it the scenario is
 * recorded as skipped, never as passed.
 */
async function imageProviderScenario() {
  const name = "P1-image other provider (#65)";
  const label = process.env.PLAYBOOK_IMAGE_PROVIDER;
  if (!label) {
    result.scenarios.push({ name, ok: true, skipped: true, detail: "PLAYBOOK_IMAGE_PROVIDER not set" });
    return;
  }
  const openTools = async () => {
    await page.getByRole("button", { name: "Settings", exact: true }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("tab", { name: /tools|ツール/i }).click();
    await dialog.getByText("Image generation", { exact: true }).waitFor({ timeout: 10_000 });
    return dialog;
  };
  const closeSettings = () => page.keyboard.press("Escape");
  let dialog = await openTools();
  const provider = dialog.getByLabel("Image provider");
  const model = dialog.getByLabel("Image model");
  const original = await provider.inputValue();
  const options = await provider.locator("option").allTextContents();
  const listed = options.includes(label);
  if (!listed) {
    scenario(name, false, `"${label}" not offered with a credential; options: ${options.join(", ")}`);
    await closeSettings();
    return;
  }
  await provider.selectOption({ label });
  await page.waitForFunction(element => !element.disabled && element.options.length > 0 && element.value, await model.elementHandle(), { timeout: 20_000 });
  const chosenModel = await model.inputValue();
  await closeSettings();

  // Generate one image through the chat, approving the reviewed call.
  await newSession().click();
  await composer().waitFor({ timeout: 10_000 });
  await composer().fill("Use the generate_image tool once to draw a small red circle on white. Do not ask questions.");
  await send().click();
  await page.getByRole("button", { name: "Approve", exact: true }).first().click({ timeout: 60_000 });
  await conversation().getByText(/Generated 1 image/).first().waitFor({ timeout: 180_000 });
  const generated = await conversation().getByRole("img").count() > 0;
  await page.screenshot({ path: process.env.TEMP + "\\playbook-image-provider.png" });

  // Back to Shisa, and back to whatever was configured before.
  dialog = await openTools();
  await provider.selectOption("shisa");
  await page.waitForFunction(element => !element.disabled && element.value, await model.elementHandle(), { timeout: 20_000 });
  const shisaModel = await model.inputValue();
  if (original !== "shisa") await provider.selectOption(original);
  await closeSettings();
  scenario(name, generated && Boolean(shisaModel), `provider ${label}, model ${chosenModel}; Shisa model ${shisaModel || "none"}`);
}

const settingsDialog = () => page.getByRole("dialog").first();
/**
 * Web access (#91, #106). Measures: with web access on, a browser must pair before
 * it sees anything; a paired browser gets the full UI with no page error; a removed
 * device is sent back to pairing; off closes the port. Why: who may connect was fixed
 * in code and invisible, and plain-http access from another device crashed the UI
 * (crypto.randomUUID is missing outside a secure context). When this machine has a
 * local-network address the same check runs over it, which is a non-secure origin.
 * Web access is set back to Off at the end.
 */
async function webAccessScenario() {
  const visitor = await chromium.launch();
  const openWebAccess = async () => {
    await openSettingsTab("Web access");
    return settingsDialog();
  };
  const choose = async (dialog, option) => {
    await dialog.getByRole("combobox", { name: "Who can connect" }).click();
    await page.getByRole("option", { name: option, exact: true }).click();
  };
  const save = async dialog => {
    const button = dialog.getByRole("button", { name: "Save", exact: true });
    if (await button.count()) await button.click();
  };
  const visit = async url => {
    const context = await visitor.newContext();
    const tab = await context.newPage();
    const errors = [];
    tab.on("pageerror", error => errors.push(String(error)));
    await tab.goto(url);
    await tab.waitForTimeout(3_000);
    return { context, tab, errors };
  };
  try {
    let dialog = await openWebAccess();
    await choose(dialog, "This computer and trusted networks");
    const lan = dialog.getByRole("switch").first();
    const hasNetwork = await lan.count() > 0;
    if (hasNetwork) {
      if ((await lan.getAttribute("aria-checked")) !== "true") await lan.click();
    } else {
      await choose(dialog, "This computer only");
    }
    await save(dialog);
    await dialog.getByText(/Serving at:/).waitFor({ timeout: 15_000 });
    await dialog.getByRole("button", { name: "Pair a device" }).click();
    const links = await dialog.getByRole("textbox").evaluateAll(nodes => nodes.map(node => node.value).filter(value => value.includes("/pair?code=")));
    const local = links.find(url => url.startsWith("http://127.0.0.1:"));
    const network = links.find(url => !url.startsWith("http://127.0.0.1:"));
    const base = new URL(local).origin;

    // Unpaired: pairing page only.
    const stranger = await visit(base + "/");
    scenario("Web access: an unpaired browser only sees the pairing page (#91)", stranger.tab.url().endsWith("/pair"), stranger.tab.url());
    await stranger.context.close();

    // Paired over this computer, then (if present) over the local network.
    const paired = await visit(network ?? local);
    const pairedOk = !paired.tab.url().includes("/pair") && paired.errors.length === 0;
    scenario(
      network ? "Web access: a browser paired over the local network loads the app with no page error (#91, #106)" : "Web access: a paired browser loads the app with no page error (#91)",
      pairedOk,
      `${paired.tab.url()} ${paired.errors.join(" | ")}`,
    );
    await paired.tab.screenshot({ path: process.env.TEMP + "\\playbook-04-web-paired.png" }).catch(() => {});

    // Remove the device on the desktop: the browser is sent back to pairing.
    dialog = settingsDialog();
    await dialog.getByRole("button", { name: /^Remove / }).first().click();
    await dialog.getByText("No device is paired yet.").waitFor({ timeout: 10_000 });
    await paired.tab.reload();
    await paired.tab.waitForTimeout(1_000);
    scenario("Web access: a removed device is sent back to pairing (#91)", paired.tab.url().endsWith("/pair"), paired.tab.url());
    await paired.context.close();

    // Off: the port closes.
    await choose(dialog, "Off");
    await save(dialog);
    await dialog.getByText("Browsers and other devices cannot connect.").waitFor({ timeout: 10_000 });
    const closed = await fetch(base + "/pair").then(() => false, () => true);
    scenario("Web access: turning it off closes the port (#91)", closed, base);
    await page.keyboard.press("Escape");
  } finally {
    await visitor.close();
  }
}

async function openSettingsTab(name) {
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await settingsDialog().getByRole("tab", { name }).click();
}
async function modelMenuItems() {
  await page.getByRole("button", { name: /model/i }).first().click();
  await page.getByRole("menuitemradio").first().waitFor({ timeout: 5_000 });
  const items = await page.getByRole("menuitemradio").allInnerTexts();
  return items.map(item => item.trim());
}

/**
 * Scenario: a Shisa API key saved in Settings works without restarting the app.
 * Measures: after saving SHISA_API_KEY and pressing "Refresh models", the model
 * menu gains the Shisa models and a new session using one gets a reply.
 * Why: the configuration service and the runtimes used to read saved variables
 * from the wrong file, once, at startup, so the refresh did nothing (issue #63).
 * Needs PLAYBOOK_SHISA_API_KEY (a test key, never a personal one) and a home where
 * Shisa.AI was never signed in or signed out; without the key it is reported as
 * not run, not as passed.
 */
async function shisaKeyWithoutRestart() {
  const name = "Shisa key saved in Settings works without restart";
  const key = process.env.PLAYBOOK_SHISA_API_KEY;
  if (!key) {
    result.scenarios.push({ name, ok: true, skipped: true, detail: "not run: PLAYBOOK_SHISA_API_KEY is not set" });
    return;
  }
  await newSession().click();
  await composer().waitFor({ timeout: 10_000 });
  const before = await modelMenuItems();
  await page.keyboard.press("Escape");

  let start = now();
  await openSettingsTab("Environment");
  await settingsDialog().getByRole("button", { name: "Add variable" }).click();
  await settingsDialog().getByRole("textbox", { name: "Name" }).last().fill("SHISA_API_KEY");
  await settingsDialog().getByLabel("Value").last().fill(key);
  const save = settingsDialog().getByRole("button", { name: "Save", exact: true });
  await save.click();
  await save.waitFor({ state: "visible" });
  await settingsDialog().getByRole("tab", { name: "Model providers" }).click();
  // The key alone counts as a Shisa.AI connection, so the refresh control appears.
  const refresh = settingsDialog().getByRole("button", { name: "Refresh models" });
  await refresh.waitFor({ timeout: 15_000 });
  await refresh.click();
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll("button")].find(item => item.textContent?.includes("Refresh models"));
    return button && !button.disabled;
  }, null, { timeout: 30_000 });
  await page.keyboard.press("Escape");

  await newSession().click();
  await composer().waitFor({ timeout: 10_000 });
  const after = await modelMenuItems();
  const added = after.filter(item => !before.includes(item));
  await mark("shisaKeySavedToModelsListed", now() - start);
  if (!added.length) {
    await page.keyboard.press("Escape");
    scenario(name, false, "no new model appeared in the menu after saving the key and refreshing");
    return;
  }
  await page.getByRole("menuitemradio").filter({ hasText: added[0] }).first().click();
  start = now();
  await composer().fill("Reply with only the word OK.");
  await send().click();
  await stop().waitFor({ state: "detached", timeout: 60_000 }).catch(() => {});
  await send().waitFor({ timeout: 60_000 });
  await mark("shisaFirstTurnEnd", now() - start);
  const text = await conversation().innerText();
  scenario(name, /\bok\b/i.test(text.replace("Reply with only the word OK.", "")), `model: ${added[0]}`);
  await page.screenshot({ path: process.env.TEMP + "\\playbook-03-shisa-key.png" });
}

/**
 * The first new session after the app starts (#99). It was created before the
 * model list was known and showed "Select model", and Send did nothing without
 * a reason. Runs before the reload below, so the host is as freshly started as
 * the user's. Pass: the session shows a model; with no model at all, Send says
 * why above the composer instead of doing nothing.
 */
async function firstSessionHasModel() {
  const name = "First new session after start has a model, or Send says why (#99)";
  await newSession().waitFor({ timeout: 30_000 });
  await newSession().click();
  await composer().waitFor({ timeout: 10_000 });
  const modelButton = page.getByRole("button", { name: "Model", exact: true }).first();
  const shown = async () => !/^\s*select model\s*$/i.test(await modelButton.innerText().catch(() => ""));
  const end = now() + 15_000;
  while (now() < end && !await shown()) await page.waitForTimeout(100);
  if (await shown()) {
    scenario(name, true, `model shown: ${(await modelButton.innerText()).trim()}`);
    return;
  }
  // Nothing to send with: the press must be answered with the reason.
  await composer().fill("model check");
  await send().click();
  const reason = page.getByText(/Choose a model before sending|No model is available/).first();
  const explained = await reason.waitFor({ timeout: 20_000 }).then(() => true, () => false);
  scenario(name, explained, explained ? "no model configured; Send explained why" : "no model shown and Send gave no reason");
  await composer().fill("");
}

try {
  await firstSessionHasModel();
  let start = now();
  await page.reload({ waitUntil: "domcontentloaded" });
  await newSession().waitFor({ timeout: 30_000 });
  await mark("reloadToReady", now() - start);

  // PLAYBOOK_SCENARIO=shisa-key runs only the Shisa key scenario. It needs a home where
  // Shisa.AI was never connected, while the main flow needs a working model, so the
  // stable release exam runs it on a home of its own (#86).
  if (process.env.PLAYBOOK_SCENARIO === "shisa-key") {
    await shisaKeyWithoutRestart();
    throw Object.assign(new Error("done"), { done: true });
  }

  // P0-1: new session, own message, model, one turn.
  start = now();
  await newSession().click();
  await composer().waitFor({ timeout: 10_000 });
  await mark("newSessionUsable", now() - start);

  start = now();
  await page.getByRole("button", { name: /model/i }).first().click();
  // PLAYBOOK_MODEL names another model (e.g. "Deterministic" on the fixture provider).
  const modelName = new RegExp(process.env.PLAYBOOK_MODEL ?? "qwen 3\\.8 flash next", "i");
  const model = page.getByRole("menuitemradio").filter({ hasText: modelName }).first();
  await model.waitFor({ timeout: 5_000 });
  await mark("modelMenuVisible", now() - start);
  await model.click();
  await page.getByText(modelName).first().waitFor({ timeout: 5_000 });
  scenario("P0-4 model selection", true);

  // The first turn of a new session, PLAYBOOK_REPEAT times (default 5), each in a
  // session of its own on the selected model.
  // Gated (the app's own work): own message visible, the turn visibly working (Stop).
  // Recorded only: the answer itself. It waits for the provider and the model's
  // reasoning (0.5-7 s measured for one prompt, #97), which no app change can bound;
  // the host's part of it is gated from host.log in the report (send to model request).
  const prompt = "What is 17 × 23? Reply with only the number.";
  const reply = "391";
  const repeat = Math.max(1, Number(process.env.PLAYBOOK_REPEAT ?? 5));
  const own = [], working = [], readable = [], ended = [];
  let freshOk = true;
  for (let i = 0; i < repeat; i++) {
    if (i > 0) {
      await newSession().click();
      await composer().waitFor({ timeout: 10_000 });
    }
    start = now();
    await composer().fill(prompt);
    await send().click();
    const ownSeen = waitForConversationText(prompt, 5_000).then(() => now() - start);
    const stopSeen = stop().waitFor({ timeout: 5_000 }).then(() => now() - start, () => null);
    own.push(await ownSeen);
    const stopMs = await stopSeen;
    await waitForConversationText(reply, 60_000);
    readable.push(now() - start);
    // Turn end = Stop gone and Send enabled; no hint string is used.
    await stop().waitFor({ state: "detached", timeout: 30_000 }).catch(() => {});
    await page.getByRole("button", { name: /^send$/i }).waitFor({ timeout: 30_000 });
    ended.push(now() - start);
    // A reply faster than Stop could be seen shows the turn as done instead.
    working.push(stopMs ?? readable[readable.length - 1]);
    freshOk &&= (await conversation().innerText()).includes(reply);
  }
  assertRepeatedGate("ownMessageVisible", own, 100);
  assertRepeatedGate("workingVisible", working, 100);
  record("warmFirstReadable", readable);
  record("turnObservedEnd", ended);
  scenario("P0-1 fresh turn", freshOk, `${repeat} new sessions`);
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

  // Image tool settings (#64, #67). Holds whatever the account can do: a
  // provider is offered only when it lists image models, otherwise the page says
  // why; the tab renders whether or not tools settings were ever saved.
  await page.getByRole("button", { name: /^settings$/i }).first().click();
  const settings = page.getByRole("dialog");
  await settings.getByRole("tab", { name: /^tools$/i }).click();
  await settings.getByText("Image generation", { exact: true }).waitFor({ timeout: 10_000 });
  scenario("Tools tab opens without saved tools settings (#67)", true);
  const provider = settings.getByLabel("Image provider", { exact: true });
  await page.waitForFunction(() => !document.querySelector('select[aria-label="Image provider"]')?.textContent?.includes("Loading"), null, { timeout: 25_000 });
  const offered = await provider.isEnabled();
  const modelText = await settings.getByLabel("Image model", { exact: true }).inputValue();
  const reasons = settings.getByRole("list", { name: "Unavailable image providers" });
  const failedChange = await settings.getByText("This tools change did not complete.").count();
  const usableProviderOk = offered
    ? modelText !== ""
    : (await provider.inputValue()) === "" && await reasons.isVisible();
  scenario(
    "Image provider offered only when usable, otherwise reason shown (#64)",
    usableProviderOk && failedChange === 0,
    offered ? `provider ${await provider.inputValue()}, model ${modelText}` : await reasons.innerText().catch(() => "no reason shown"),
  );
  await page.screenshot({ path: process.env.TEMP + "\\playbook-03-tools.png" });
  await page.keyboard.press("Escape");
  await shisaKeyWithoutRestart();
  await imageProviderScenario();

  // Reply language set in desktop Settings reaches the next new session.
  // Measures: the reply of a session opened after the change is written in the chosen
  // language. Why: the setting is Jouzu's own (shared with Jouzu in a terminal); the
  // desktop once had no way to see or change it. The previous value is restored after.
  const openLanguageSettings = async () => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Language", exact: true }).click();
    return page.getByRole("combobox", { name: /reply language/i });
  };
  let replyLanguage = await openLanguageSettings();
  const previousReplyLanguage = (await replyLanguage.innerText()).trim();
  await replyLanguage.click();
  await page.getByRole("option", { name: "日本語", exact: true }).click();
  await page.getByRole("combobox", { name: /reply language/i }).filter({ hasText: "日本語" }).waitFor({ timeout: 15_000 });
  await page.keyboard.press("Escape");
  await newSession().click();
  await composer().waitFor({ timeout: 10_000 });
  const languagePrompt = "Name one primary color, in one short sentence.";
  await composer().fill(languagePrompt);
  await send().click();
  await waitForConversationText(languagePrompt, 5_000);
  await stop().waitFor({ state: "detached", timeout: 60_000 }).catch(() => {});
  await page.getByRole("button", { name: /^send$/i }).waitFor({ timeout: 60_000 });
  const languageReply = (await conversation().innerText()).replace(languagePrompt, "");
  scenario("Reply language set in Settings applies to the next new session", /[\u3040-\u30ff]/.test(languageReply), languageReply.slice(0, 200));
  await page.screenshot({ path: process.env.TEMP + "\\playbook-03-reply-language.png" });
  replyLanguage = await openLanguageSettings();
  await replyLanguage.click();
  await page.getByRole("option", { name: previousReplyLanguage, exact: true }).click();
  await page.keyboard.press("Escape");

  await webAccessScenario();
} catch (error) {
  // The single-scenario mode ends the flow early on purpose; that is not a failure.
  if (!error?.done) {
    result.errors.push(String(error?.stack ?? error));
    await page.screenshot({ path: process.env.TEMP + "\\playbook-failure.png" }).catch(() => {});
  }
}

result.pass = result.errors.length === 0
  && Object.values(result.gates).every(gate => gate.ok)
  && result.scenarios.every(item => item.ok);
result.finishedAt = new Date().toISOString();
const text = JSON.stringify(result, null, 2);
console.log(text);
if (out) await (await import("node:fs/promises")).writeFile(out, text);
await browser.close();
