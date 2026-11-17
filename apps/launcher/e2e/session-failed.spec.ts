import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Issue #95: the host gives up on the session the window shows (here: its
 * runtime died and the replacement refuses to open the session file, as Flow
 * does with storage it cannot own). The window must not keep a turn waiting:
 * it shows why, offers "Restart session", and after a restart the next
 * message goes through.
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
// Lists one model, fixture-model, through the real control adapter.
const fakeApp = join(root, "host", "tests", "fixtures", "fake-app");

test.skip(!existsSync(hostBin) || !existsSync(join(dist, "index.html")), "build the UI and the host first");

let host: ChildProcess | undefined;
let base = "";
let token = "";
let scratch = "";
let refusal = "";

test.beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "jouzu-session-failed-"));
  const home = join(scratch, "home");
  refusal = join(scratch, "refuse-switch.txt");
  host = spawn(hostBin, [
    "--dist", dist, "--home", home, "--runtime-home", join(scratch, "runtime"), "--install", fakeApp,
    "--runtime", process.execPath, "--runtime-arg", fixture,
  ], { env: { ...process.env, HOME: scratch, USERPROFILE: scratch, FAKE_RUNTIME_SWITCH_ERROR_FILE: refusal }, stdio: "ignore" });
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

test("a failed session ends its turn, says why and restarts on request", async ({ page }) => {
  await page.addInitScript(([url, value]) => {
    (window as unknown as { __JOUZU_HOST__?: unknown }).__JOUZU_HOST__ = { baseUrl: url, token: value };
    localStorage.setItem("jouzu.ui.language", "en");
  }, [base, token]);
  await page.goto(base);
  const composer = page.getByRole("textbox", { name: /message/i }).first();
  const conversation = page.getByRole("region", { name: /conversation/i }).first();
  // A new session has no model until one is picked from the host's list.
  const model = page.getByRole("button", { name: "Model", exact: true });
  await expect(model).toHaveText(/select model/i, { timeout: 20_000 });
  await model.click();
  await page.getByRole("menuitemradio", { name: /fixture-model/ }).click();
  await expect(model).toHaveText(/fixture-model/, { timeout: 20_000 });
  await composer.fill("first message");
  await page.getByRole("button", { name: /^send$/i }).first().click();
  await expect(conversation.getByText("first message")).toHaveCount(2, { timeout: 15_000 });

  const { sessions } = await api("/v1/sessions");
  const bound = sessions.find((session: { title?: string }) => session.title === "first message");
  const line = (role: string, text: string) => `${JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }], timestamp: Date.now() } })}\n`;
  // The runtime records the picked model in the file, as the real one does.
  const picked = `${JSON.stringify({ type: "model_change", id: "m1", parentId: null, timestamp: new Date().toISOString(), provider: "fixture", modelId: "model" })}\n`;
  appendFileSync(bound.sessionPath, picked + line("user", "first message") + line("assistant", "first message"));

  // The runtime dies; every replacement refuses the session file.
  writeFileSync(refusal, "Flow session metadata is missing or inconsistent.");
  const info = await api(`/v1/sessions/${bound.sessionId}`);
  process.kill(info.runtimePid);

  const alert = page.getByText("This session stopped and needs a restart.");
  await expect(alert).toBeVisible({ timeout: 10_000 });
  // Nothing is left waiting: no timer, no Stop.
  await expect(page.getByRole("button", { name: /^stop/i })).toHaveCount(0);
  await expect(page.getByText(/waiting for model/i)).toHaveCount(0);
  const status = (await api("/v1/sessions")).sessions.find((session: { sessionPath?: string }) => session.sessionPath === bound.sessionPath);
  expect(status.status).toBe("error");
  expect(status.activeTurn ?? null).toBeNull();

  // The cause is gone: restart, and the conversation carries on.
  rmSync(refusal);
  await page.getByRole("button", { name: "Restart session" }).click();
  await expect(alert).toHaveCount(0, { timeout: 10_000 });
  await expect(conversation.getByText("first message").first()).toBeVisible();
  await composer.fill("second message");
  await page.getByRole("button", { name: /^send$/i }).first().click();
  await expect(conversation.getByText("second message")).toHaveCount(2, { timeout: 15_000 });
});
