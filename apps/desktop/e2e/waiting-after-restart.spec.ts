import { test, expect, type Browser, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Messages waiting in a session when the host exits come back when the session
 * is opened again, paused, with Continue and Discard (#162). The host is killed,
 * not shut down, so nothing is written on the way out.
 *
 * Runs the built UI (dist/) against a real host and the fake runtime. Build
 * both first: `npm run build` and `cargo build` in host/.
 */
const root = resolve(import.meta.dirname, "..");
const hostBin = process.env.JOUZU_HOST_BIN
  ?? join(root, "host", "target", "debug", process.platform === "win32" ? "jouzu-host.exe" : "jouzu-host");
const dist = join(root, "dist");

test.skip(!existsSync(hostBin) || !existsSync(join(dist, "index.html")), "build the UI and the host first");

const hosts: ChildProcess[] = [];
let scratch = "";
test.afterEach(() => {
  for (const host of hosts) host.kill("SIGKILL");
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

async function startHost(home: string, node: string): Promise<string> {
  const host = spawn(hostBin, ["--dist", dist, "--home", home, "--runtime-home", join(scratch, "runtime")], {
    env: { ...process.env, HOME: scratch, USERPROFILE: scratch, JOUZU_HOST_NODE: node, FAKE_RUNTIME_DELAY_MS: "250" },
    stdio: ["ignore", "pipe", "ignore"],
  });
  hosts.push(host);
  const ready = await new Promise<{ port: number; token: string }>((done, fail) => {
    let text = "";
    const timer = setTimeout(() => fail(new Error("the host did not start")), 20_000);
    host.stdout!.on("data", chunk => {
      text += chunk;
      const end = text.indexOf("\n");
      if (end < 0) return;
      clearTimeout(timer);
      host.stdout!.removeAllListeners("data");
      host.stdout!.resume();
      done(JSON.parse(text.slice(0, end)));
    });
  });
  return JSON.stringify(ready);
}

async function open(browser: Browser, ready: string): Promise<Page> {
  const { port, token } = JSON.parse(ready) as { port: number; token: string };
  const base = `http://127.0.0.1:${port}`;
  const page = await browser.newPage();
  await page.addInitScript(([url, value]) => {
    (window as unknown as { __JOUZU_HOST__?: unknown }).__JOUZU_HOST__ = { baseUrl: url, token: value };
    localStorage.setItem("jouzu.ui.language", "en");
  }, [base, token]);
  await page.goto(base);
  return page;
}

test("messages waiting when the host exits come back paused", async ({ browser }) => {
  test.setTimeout(90_000);
  scratch = mkdtempSync(join(tmpdir(), "jouzu-waiting-restart-"));
  const home = join(scratch, "home");
  const node = join(scratch, "node", "bin", process.platform === "win32" ? "node.exe" : "node");
  mkdirSync(join(scratch, "node", "bin"), { recursive: true });
  symlinkSync(process.execPath, node);
  mkdirSync(join(home, "app"), { recursive: true });
  copyFileSync(join(root, "host", "tests", "fixtures", "fake-runtime.mjs"), join(home, "app", "bootstrap.mjs"));

  let page = await open(browser, await startHost(home, node));
  const composer = page.getByRole("textbox").first();
  await composer.fill("first question");
  await composer.press("Enter");
  // Answered, so the session has its file.
  await expect(page.getByRole("button", { name: /^Stop/ })).toHaveCount(0, { timeout: 20_000 });
  await composer.fill("second question with a long answer");
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: /^Stop/ }).first()).toBeVisible();
  await composer.fill("message that waits");
  await composer.press("Enter");
  const waiting = page.getByRole("region", { name: /waiting|queued/i }).or(page.locator("section").filter({ hasText: "message that waits" })).first();
  await expect(waiting).toContainText("message that waits");
  await page.getByRole("button", { name: /^Stop/ }).first().click();
  await expect(waiting.getByRole("button", { name: "Continue" })).toBeVisible();

  // The host goes away without a word; a new one starts on the same home.
  hosts[0].kill("SIGKILL");
  await page.close();
  // The fake runtime keeps the conversation in memory; the real one writes it to
  // the session file, which is what lists the session. Write what it would.
  const saved = JSON.parse(readFileSync(join(home, "waiting-messages.json"), "utf8")) as Record<string, unknown[]>;
  const file = Object.keys(saved)[0];
  expect(Object.keys(saved)).toHaveLength(1);
  appendFileSync(file, `${JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "first question" }], timestamp: Date.now() } })}\n`);
  page = await open(browser, await startHost(home, node));
  await page.getByText("first question").first().click();
  const back = page.locator("section").filter({ hasText: "message that waits" }).first();
  await expect(back.getByRole("button", { name: "Continue" })).toBeVisible({ timeout: 15_000 });
  await expect(back.getByRole("button", { name: "Discard" })).toBeVisible();
  // Nothing is sent until the user says so.
  await page.waitForTimeout(1500);
  await expect(back.getByRole("button", { name: "Continue" })).toBeVisible();

  await back.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator("section").filter({ hasText: "message that waits" }).getByRole("button", { name: "Continue" })).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText("message that waits")).toHaveCount(1, { timeout: 15_000 });
});
