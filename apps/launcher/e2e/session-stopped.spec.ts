import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Issue #111: the host stops the session the window shows (its idle reaper, first
 * tick after the machine resumes from sleep). The window must reopen that
 * conversation by itself, with its transcript, and the next message must go
 * through; it must never stay on "Starting session…".
 *
 * Runs the built UI (dist/) against a real host binary with the fixture runtime,
 * on a throwaway home. Build both first: `npm run build` and `cargo build` in host/.
 * JOUZU_HOST_BIN overrides the host binary.
 */
const root = resolve(import.meta.dirname, "..");
const hostBin = process.env.JOUZU_HOST_BIN
  ?? join(root, "host", "target", "debug", process.platform === "win32" ? "jouzu-host.exe" : "jouzu-host");
const dist = join(root, "dist");
const fixture = join(root, "host", "tests", "fixtures", "fake-runtime.mjs");

test.skip(!existsSync(hostBin) || !existsSync(join(dist, "index.html")), "build the UI and the host first");

let host: ChildProcess | undefined;
let base = "";
let token = "";
let scratch = "";

test.beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "jouzu-session-stopped-"));
  const home = join(scratch, "home");
  host = spawn(hostBin, [
    "--dist", dist, "--home", home, "--runtime-home", join(scratch, "runtime"),
    "--runtime", process.execPath, "--runtime-arg", fixture,
  ], { env: { ...process.env, HOME: scratch, USERPROFILE: scratch }, stdio: "ignore" });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const info = JSON.parse(readFileSync(join(home, "host.json"), "utf8"));
      base = `http://127.0.0.1:${info.port}`;
      token = info.token;
      break;
    } catch { await new Promise(done => setTimeout(done, 100)); }
  }
  expect(token, "the host wrote host.json").not.toBe("");
});

test.afterEach(() => {
  host?.kill();
  rmSync(scratch, { recursive: true, force: true });
});

const api = async (path: string, method = "GET") => {
  const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}` } });
  return response.json();
};

test("the window reopens the session it shows after the host stopped it", async ({ page }) => {
  // The fixture runtime has no model catalog; offer its one model.
  await page.route("**/v1/models", route => route.fulfill({ json: { models: [{ id: "model", name: "fixture-model", provider: "fixture", available: true }] } }));
  await page.addInitScript(([url, value]) => {
    (window as unknown as { __JOUZU_HOST__?: unknown }).__JOUZU_HOST__ = { baseUrl: url, token: value };
    localStorage.setItem("jouzu.ui.language", "en");
  }, [base, token]);
  await page.goto(base);
  const composer = page.getByRole("textbox", { name: /message/i }).first();
  const conversation = page.getByRole("region", { name: /conversation/i }).first();
  await page.getByRole("button", { name: /model/i }).first().click({ timeout: 20_000 });
  await page.getByText("fixture-model").last().click();
  await composer.fill("first message");
  await page.getByRole("button", { name: /^send$/i }).first().click();
  // The fixture answers with the prompt: the user row and the reply.
  await expect(conversation.getByText("first message")).toHaveCount(2, { timeout: 15_000 });

  const { sessions } = await api("/v1/sessions");
  const bound = sessions.find((session: { title?: string }) => session.title === "first message");
  // The fixture runtime does not write its transcript; write it as the real runtime does.
  const line = (role: string, text: string) => `${JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }], timestamp: Date.now() } })}\n`;
  appendFileSync(bound.sessionPath, line("user", "first message") + line("assistant", "first message"));

  // What the idle reaper does to it.
  await api(`/v1/sessions/${bound.sessionId}/stop`, "POST");

  await expect(page.getByText("Starting session…")).toHaveCount(0, { timeout: 5_000 });
  await expect(conversation.getByText("first message").first()).toBeVisible({ timeout: 5_000 });
  await expect.poll(async () => (await api("/v1/sessions")).sessions
    .some((session: { sessionPath?: string; status?: string }) => session.sessionPath === bound.sessionPath && session.status === "idle"),
  { timeout: 5_000 }).toBe(true);

  await composer.fill("second message");
  await page.getByRole("button", { name: /^send$/i }).first().click();
  await expect(conversation.getByText("second message")).toHaveCount(2, { timeout: 15_000 });
  await expect(conversation.getByText("first message").first()).toBeVisible();
});
