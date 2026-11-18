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

test("a session stopped right after a model change reopens on that model", async ({ page }) => {
  await page.addInitScript(([url, value]) => {
    (window as unknown as { __JOUZU_HOST__?: unknown }).__JOUZU_HOST__ = { baseUrl: url, token: value };
    localStorage.setItem("jouzu.ui.language", "en");
  }, [base, token]);
  await page.goto(base);
  const composer = page.getByRole("textbox", { name: /message/i }).first();
  const conversation = page.getByRole("region", { name: /conversation/i }).first();
  await composer.fill("first message");
  await page.getByRole("button", { name: /^send$/i }).first().click();
  await expect(conversation.getByText("first message")).toHaveCount(2, { timeout: 15_000 });
  const { sessions } = await api("/v1/sessions");
  const bound = sessions.find((session: { title?: string }) => session.title === "first message");
  const line = (role: string, text: string) => `${JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }], timestamp: Date.now() } })}\n`;
  appendFileSync(bound.sessionPath, line("user", "first message") + line("assistant", "first message"));
  // A model change, then the host stops the session 1.5 s later.
  await page.getByRole("button", { name: "Model", exact: true }).first().click();
  await page.getByRole("menuitemradio").filter({ hasText: "Fixture Other" }).first().click();
  await page.waitForTimeout(1_500);
  await api(`/v1/sessions/${bound.sessionId}/stop`, "POST");
  await expect.poll(async () => (await api("/v1/sessions")).sessions
    .some((session: { sessionPath?: string; status?: string }) => session.sessionPath === bound.sessionPath && session.status === "idle"),
  { timeout: 5_000 }).toBe(true);
  await composer.fill("second message");
  await page.getByRole("button", { name: /^send$/i }).first().click();
  await expect(conversation.getByText("second message")).toHaveCount(2, { timeout: 15_000 });
});

test("a saved session picked a model from its file view, then stopped, reopens", async ({ page }) => {
  await page.addInitScript(([url, value]) => {
    (window as unknown as { __JOUZU_HOST__?: unknown }).__JOUZU_HOST__ = { baseUrl: url, token: value };
    localStorage.setItem("jouzu.ui.language", "en");
  }, [base, token]);
  await page.goto(base);
  const composer = page.getByRole("textbox", { name: /message/i }).first();
  const conversation = page.getByRole("region", { name: /conversation/i }).first();
  await composer.fill("alpha message");
  await page.getByRole("button", { name: /^send$/i }).first().click();
  await expect(conversation.getByText("alpha message")).toHaveCount(2, { timeout: 15_000 });
  const alpha = (await api("/v1/sessions")).sessions.find((session: { title?: string }) => session.title === "alpha message");
  const line = (role: string, text: string) => `${JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }], timestamp: Date.now() } })}\n`;
  appendFileSync(alpha.sessionPath, line("user", "alpha message") + line("assistant", "alpha message"));
  // Another session, while alpha is stopped (not running when it is clicked again).
  await page.getByRole("button", { name: /new session/i }).first().click();
  await composer.fill("beta message");
  await page.getByRole("button", { name: /^send$/i }).first().click();
  await expect(conversation.getByText("beta message")).toHaveCount(2, { timeout: 15_000 });
  await api(`/v1/sessions/${alpha.sessionId}/stop`, "POST");
  await page.getByText("alpha message").first().click();
  await page.waitForTimeout(2_500);
  await page.getByRole("button", { name: "Model", exact: true }).first().click();
  await page.getByRole("menuitemradio").filter({ hasText: "Fixture Other" }).first().click();
  await page.waitForTimeout(1_500);
  const opened = (await api("/v1/sessions")).sessions.find((session: { sessionPath?: string; status?: string }) => session.sessionPath === alpha.sessionPath && session.status !== "stopped");
  console.log("opened", JSON.stringify(opened));
  await api(`/v1/sessions/${opened.sessionId}/stop`, "POST");
  await page.waitForTimeout(3_000);
  console.log("after stop", JSON.stringify((await api("/v1/sessions")).sessions.filter((session: { sessionPath?: string }) => session.sessionPath === alpha.sessionPath)));
  await composer.fill("gamma message");
  await page.getByRole("button", { name: /^send$/i }).first().click();
  await expect(conversation.getByText("gamma message")).toHaveCount(2, { timeout: 15_000 });
});
