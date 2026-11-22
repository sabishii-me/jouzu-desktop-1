import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { emptyControlState, stubHost } from "./host-control";

test.use({ channel: process.env.JOUZU_UI_TEST_BROWSER });

test("issue 185: the steering hint yields to TextGuard in a narrow composer", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  await stubHost(page, {
    control: () => ({ ...emptyControlState, modelReady: true }),
    workspaces: [{ id: "windows:C:/Projects/Issue 185", path: "C:/Projects/Issue 185", environment: { kind: "windows" } }],
  });
  await page.addInitScript(() => localStorage.setItem("jouzu.ui.language", "en"));
  const dist = resolve("dist");
  await page.route("http://jouzu-ui.test/**", async route => {
    const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
    if (pathname.startsWith("/v1/")) return route.fallback();
    const file = resolve(dist, pathname === "/" ? "index.html" : `.${pathname}`);
    if (!file.startsWith(dist + sep)) return route.abort();
    const contentType = ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" } as Record<string, string>)[extname(file)] ?? "application/octet-stream";
    try { await route.fulfill({ body: await readFile(file), contentType }); } catch { await route.fulfill({ status: 404, body: "Not found" }); }
  });
  await page.goto("http://jouzu-ui.test/");
  await expect(page.getByRole("button", { name: "Choose workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Choose workspace" }).click();
  await page.getByRole("menuitemradio", { name: /Issue 185/ }).click();
  await expect(page.getByLabel("Message Jouzu")).toBeVisible();

  const footer = page.locator(".composer-footer");
  const hint = page.locator("[data-composer-steering-hint]");
  await expect(footer).toBeVisible();
  await footer.evaluate(element => { (element as HTMLElement).style.width = "60rem"; });
  await expect(hint).toBeVisible();
  await footer.evaluate(element => { (element as HTMLElement).style.width = "38rem"; });
  await expect(hint).toBeHidden();
  await expect(page.getByRole("button", { name: "Add files or run commands" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
});
