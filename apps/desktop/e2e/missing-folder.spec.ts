import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Issue #174: a saved session whose folder was deleted or moved. It stays in its
 * own folder's group, its history can be read, and the composer says the folder
 * is gone instead of offering to run it. Nothing starts a runtime for it.
 *
 * Runs the built UI (dist/) against a real host and the fake runtime. Build both
 * first: `npm run build` and `cargo build` in host/.
 */
const root = resolve(import.meta.dirname, "..");
const hostBin = process.env.JOUZU_HOST_BIN
  ?? join(root, "host", "target", "debug", process.platform === "win32" ? "jouzu-host.exe" : "jouzu-host");
const dist = join(root, "dist");

test.skip(!existsSync(hostBin) || !existsSync(join(dist, "index.html")), "build the UI and the host first");

let host: ChildProcess | undefined;
let scratch = "";
test.afterEach(() => { host?.kill(); if (scratch) rmSync(scratch, { recursive: true, force: true }); });

async function startHost(home: string, runtimeHome: string, node: string) {
  const child = spawn(hostBin, ["--dist", dist, "--home", home, "--runtime-home", runtimeHome], {
    env: { ...process.env, HOME: scratch, USERPROFILE: scratch, JOUZU_HOST_NODE: node },
    stdio: ["ignore", "pipe", "ignore"],
  });
  const ready = await new Promise<{ port: number; token: string }>((done, fail) => {
    let text = "";
    const timer = setTimeout(() => fail(new Error("the host did not start")), 20_000);
    child.stdout!.on("data", chunk => {
      text += chunk;
      const end = text.indexOf("\n");
      if (end < 0) return;
      clearTimeout(timer);
      child.stdout!.removeAllListeners("data");
      child.stdout!.resume();
      done(JSON.parse(text.slice(0, end)));
    });
  });
  return { child, base: `http://127.0.0.1:${ready.port}`, token: ready.token };
}

test("a session whose folder was deleted", async ({ page }) => {
  scratch = mkdtempSync(join(tmpdir(), "jouzu-missing-folder-"));
  const home = join(scratch, "home");
  const runtimeHome = join(scratch, "runtime");
  const node = join(scratch, "node", "bin", "node");
  mkdirSync(join(scratch, "node", "bin"), { recursive: true });
  symlinkSync(process.execPath, node);
  mkdirSync(join(home, "app"), { recursive: true });
  copyFileSync(join(root, "host", "tests", "fixtures", "fake-runtime.mjs"), join(home, "app", "bootstrap.mjs"));
  const folder = join(scratch, "ui-test");
  mkdirSync(folder);

  let started = await startHost(home, runtimeHome, node);
  host = started.child;
  const call = async (base: string, token: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const created = await call(started.base, started.token, "/v1/sessions", { workspacePath: folder, sessionPath: null, clientId: "setup" });
  const id = created.body.sessionId;
  await call(started.base, started.token, `/v1/sessions/${id}/messages`, { clientMessageId: "m1", text: "remember this", clientId: "setup" });
  let saved: string | null = null;
  for (let i = 0; i < 50 && !saved; i++) {
    await new Promise(r => setTimeout(r, 200));
    const list = await call(started.base, started.token, "/v1/sessions");
    saved = list.body.sessions.find((s: { sessionId: string }) => s.sessionId === id)?.sessionPath ?? null;
  }
  expect(saved).toBeTruthy();
  await new Promise(r => setTimeout(r, 1000));
  appendFileSync(saved!, JSON.stringify({ type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "remember this" }] } }) + "\n"
    + JSON.stringify({ type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }) + "\n");
  host.kill();
  await new Promise(r => setTimeout(r, 500));
  rmSync(folder, { recursive: true, force: true });

  started = await startHost(home, runtimeHome, node);
  host = started.child;
  await page.addInitScript(([url, value]) => {
    (window as unknown as { __JOUZU_HOST__?: unknown }).__JOUZU_HOST__ = { baseUrl: url, token: value };
    localStorage.setItem("jouzu.ui.language", "en");
  }, [started.base, started.token]);
  const opens: string[] = [];
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/v1/sessions") opens.push(request.postData() ?? "");
  });
  await page.goto(started.base);
  const group = page.getByRole("button", { name: /^Collapse ui-test$/ });
  await expect(group).toBeVisible({ timeout: 15_000 });
  await page.getByText("remember this").first().click();

  await expect(page.locator("[data-session-blocked]")).toContainText("This session's folder no longer exists", { timeout: 10_000 });
  await expect(page.locator("[data-session-blocked]")).toContainText("ui-test");
  await expect(page.getByRole("button", { name: /Restart session/ })).toHaveCount(0);
  // Its history is on screen, read from its file.
  await expect(page.getByText("ok", { exact: true }).first()).toBeVisible();
  // Still filed under its own folder; nothing asked the host to run it.
  await page.waitForTimeout(1000);
  await expect(group).toBeVisible();
  expect(opens.filter(body => body.includes(saved!.split(/[\\/]/u).at(-1)!))).toEqual([]);
});
