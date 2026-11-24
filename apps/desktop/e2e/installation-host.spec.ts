import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * A real host on a home with no runtime installs it on its own (ADR 0026). Here
 * it cannot reach the network: the window shows the installation's failure
 * with the reason and Retry, and Retry asks the host again. It never shows the
 * workspace with "runtime files are missing" (#87).
 *
 * Runs the built UI (dist/) against a real host binary. Build both first:
 * `npm run build` and `cargo build` in host/.
 */
const root = resolve(import.meta.dirname, "..");
const hostBin = process.env.JOUZU_HOST_BIN
  ?? join(root, "host", "target", "debug", process.platform === "win32" ? "jouzu-host.exe" : "jouzu-host");
const dist = join(root, "dist");

test.skip(!existsSync(hostBin) || !existsSync(join(dist, "index.html")), "build the UI and the host first");

let host: ChildProcess | undefined;
let scratch = "";

test.afterEach(() => {
  host?.kill();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

test("an installation that cannot download shows why, and Retry asks the host again", async ({ page }) => {
  scratch = mkdtempSync(join(tmpdir(), "jouzu-installation-"));
  // Every download goes to a port where nothing listens.
  const offline = "http://127.0.0.1:9";
  host = spawn(hostBin, ["--dist", dist, "--home", join(scratch, "home"), "--runtime-home", join(scratch, "runtime")], {
    env: { ...process.env, HOME: scratch, USERPROFILE: scratch, HTTPS_PROXY: offline, https_proxy: offline, HTTP_PROXY: offline, http_proxy: offline, NO_PROXY: "", no_proxy: "" },
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
  const operations: string[] = [];
  page.on("request", request => { const path = new URL(request.url()).pathname; if (path.startsWith("/v1/runtime/") && request.method() === "POST") operations.push(path); });
  await page.goto(base);
  await expect(page.getByText("Installation failed")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/nodejs\.org/)).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  // The host tries again and fails again, for the same reason.
  await expect(page.getByText("Installation failed")).toBeVisible({ timeout: 30_000 });
  expect(operations).toEqual(["/v1/runtime/install"]);
  await expect(page.getByText(/runtime files are missing/i)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New session", exact: true })).toHaveCount(0);
});
