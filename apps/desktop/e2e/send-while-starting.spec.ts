import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The runtime takes seconds to start (ui-layer §3, decision 0016). The start-up
 * screen waits for the warm runtime, so the first new session is ready at once.
 * A session whose runtime is still starting later takes a message at once, the
 * host holds it, and the session is listed, titled by that message, before the
 * runtime has written its file (#177).
 *
 * Runs the built UI (dist/) against a real host and the fake runtime, which
 * starts 8 s late. Build both first: `npm run build` and `cargo build` in host/.
 */
const root = resolve(import.meta.dirname, "..");
const hostBin = process.env.JOUZU_HOST_BIN
  ?? join(root, "host", "target", "debug", process.platform === "win32" ? "jouzu-host.exe" : "jouzu-host");
const dist = join(root, "dist");
const startDelayMs = 8000;

test.describe("send while starting", () => {
  test.skip(!existsSync(hostBin) || !existsSync(join(dist, "index.html")), "build the UI and the host first");

  let host: ChildProcess | undefined;
  let scratch = "";
  test.afterEach(async () => {
    const child = host;
    host = undefined;
    if (child?.pid && child.exitCode === null) {
      await new Promise<void>(resolve => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        child.once("exit", finish);
        if (process.platform === "win32") {
          execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], finish);
        } else {
          child.kill("SIGTERM");
        }
        setTimeout(finish, 5000);
      });
    }
    if (scratch) {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      scratch = "";
    }
  });

  test("a message sent while the runtime starts is accepted and listed at once", async ({ page }) => {
    test.setTimeout(120_000);
  scratch = mkdtempSync(join(tmpdir(), "jouzu-send-starting-"));
  const home = join(scratch, "home");
  const node = join(scratch, "node", "bin", process.platform === "win32" ? "node.exe" : "node");
  mkdirSync(join(scratch, "node", "bin"), { recursive: true });
  try {
    symlinkSync(process.execPath, node);
  } catch (error) {
    // Windows commonly refuses symlink creation without developer mode or elevation.
    if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    copyFileSync(process.execPath, node);
  }
  mkdirSync(join(home, "app"), { recursive: true });
  copyFileSync(join(root, "host", "tests", "fixtures", "fake-runtime.mjs"), join(home, "app", "bootstrap.mjs"));
  const launched = Date.now();
  host = spawn(hostBin, ["--dist", dist, "--home", home, "--runtime-home", join(scratch, "runtime")], {
    env: { ...process.env, HOME: scratch, USERPROFILE: scratch, JOUZU_HOST_NODE: node, FAKE_RUNTIME_START_DELAY_MS: String(startDelayMs) },
    stdio: ["ignore", "pipe", "ignore"],
  });
  const ready = await new Promise<{ port: number; token: string }>((done, fail) => {
    let text = "";
    const timer = setTimeout(() => fail(new Error("the host did not start")), 20_000);
    host!.stdout!.on("data", chunk => {
      text += chunk;
      const end = text.indexOf("\n");
      if (end < 0) return;
      clearTimeout(timer);
      host!.stdout!.removeAllListeners("data");
      host!.stdout!.resume();
      done(JSON.parse(text.slice(0, end)));
    });
  });
  const base = `http://127.0.0.1:${ready.port}`;
  await page.addInitScript(([url, value]) => {
    (window as unknown as { __JOUZU_HOST__?: unknown }).__JOUZU_HOST__ = { baseUrl: url, token: value };
    localStorage.setItem("jouzu.ui.language", "en");
  }, [base, ready.token]);

  // The start-up screen waits for the folder's warm runtime (0016): the first
  // session's runtime start is paid there, not on its first message.
  // (The host starts that runtime when it starts, before the page is opened.)
  await page.goto(base);
  const composer = page.getByRole("textbox").first();
  const loading = page.getByText(/Starting the Jouzu runtime/i).first();
  await expect(loading).toBeVisible();
  await expect(loading).toBeHidden({ timeout: 2 * startDelayMs + 15_000 });
  expect(Date.now() - launched).toBeGreaterThanOrEqual(startDelayMs);
  await expect(page.getByText(/Starting session/i)).toHaveCount(0);

  // So a New session right after is ready at once: it takes the runtime that is
  // ready, and the pool starts the next one.
  await page.getByRole("button", { name: "New session" }).click();
  await expect(page.getByText(/Starting session/i)).toHaveCount(0);

  // Another New session before the pool's next runtime is up starts its own:
  // it takes a message at once, the host holds it, and the session is listed and
  // titled before the runtime has written its file (#177).
  await page.getByRole("button", { name: "New session" }).click();
  const sent = Date.now();
  await composer.click({ timeout: 2000 });
  await composer.fill("first message while starting");
  await composer.press("Enter");
  const sidebar = page.getByRole("complementary").or(page.locator("aside")).first();
  await expect(sidebar.getByText("first message while starting")).toBeVisible({ timeout: 2000 });
  await expect(page.getByRole("button", { name: /^Send$/ })).toBeVisible({ timeout: 2000 });
  await expect(page.getByRole("button", { name: /^Steer$/ })).toHaveCount(0);
  // Nothing can be steered yet, but the turn can be stopped.
  await expect(page.getByRole("button", { name: /^Stop$/ })).toBeVisible();
  await expect(page.getByText(/Enter to steer/i)).toHaveCount(0);
  await expect(page.getByText(/Starting session/i).first()).toBeVisible();
  expect(Date.now() - sent).toBeLessThan(startDelayMs);
    // The held message is answered once the runtime is up, in the same row.
    await expect(page.getByText(/Starting session/i)).toHaveCount(0, { timeout: startDelayMs + 15_000 });
    await expect(sidebar.getByText("first message while starting")).toHaveCount(1);
  });
});
