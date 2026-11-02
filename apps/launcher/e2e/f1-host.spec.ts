import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const hostBinary = resolve("host", "target", "debug", process.platform === "win32" ? "jouzu-host.exe" : "jouzu-host");
const dist = resolve("dist");

async function waitForHost(home: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const value = JSON.parse(await readFile(join(home, "host.json"), "utf8"));
      if (typeof value.port === "number" && typeof value.token === "string") return value;
    } catch {
      // The host writes host.json after it is listening.
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error("host.json did not appear");
}

test("F1: host-served Desktop boots and workspace add persists across reload", async ({ page }) => {
  const home = await mkdtemp(join(tmpdir(), "jouzu-f1-"));
  let child: ChildProcess | undefined;
  try {
    child = spawn(hostBinary, [
      "--dist", dist,
      "--home", home,
      "--runtime-home", join(home, "data"),
    ], { stdio: "ignore", windowsHide: true });
    const info = await waitForHost(home);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${info.port}/?token=${info.token}`);
    await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible();
    await expect(page.getByText("Jouzu Desktop")).toBeVisible();

    const workspace = resolve(".");
    await page.getByLabel("Workspace path").fill(workspace);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText(workspace, { exact: true })).toBeVisible();

    await page.reload();
    await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible();
    await expect(page.getByText(workspace, { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    child?.kill();
    await rm(home, { recursive: true, force: true });
  }
});
