import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { emptyControlState, stubHost, type Workspace } from "./host-control";

// The Default workspace stays visible below the independently scrolling regular
// workspace list, even when the sidebar has many regular workspaces (#19).
test("pins the Default workspace below the scrolling sidebar list", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 700 });
  const workspaces: Workspace[] = [
    ...Array.from({ length: 50 }, (_, index) => {
      const path = `C:/Projects/Workspace ${String(index).padStart(2, "0")}`;
      return { id: `windows:${path}`, path, environment: { kind: "windows" } };
    }),
    { id: "windows:C:/Projects/default-workspace", path: "C:/Projects/default-workspace", environment: { kind: "windows" } },
  ];
  await stubHost(page, { control: () => ({ ...emptyControlState, modelReady: true }), workspaces });
  await page.addInitScript(() => {
    localStorage.setItem("jouzu.ui.language", "en");
    if (!crypto.randomUUID) Object.defineProperty(crypto, "randomUUID", { value: () => `test-${Math.random().toString(16).slice(2)}` });
  });
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
  await expect(page.getByText("What would you like to build?")).toBeVisible();
  const sidebar = page.getByRole("complementary", { name: "Workspaces" });
  await expect(sidebar).toBeVisible();
  await expect(sidebar.getByText("Default workspace", { exact: true })).toHaveCount(1);
  const layout = await sidebar.evaluate(element => {
    const list = element.querySelector("[data-sidebar-workspace-list]") as HTMLElement;
    const fixed = element.querySelector("[data-sidebar-default-workspace]") as HTMLElement;
    const defaultRow = [...fixed.querySelectorAll("section")].find(section => section.textContent?.includes("Default workspace"));
    const bounds = defaultRow?.getBoundingClientRect();
    const sidebarBounds = element.getBoundingClientRect();
    return { listText: list.textContent ?? "", listScrolls: list.scrollHeight > list.clientHeight, defaultTop: bounds?.top ?? -1, defaultBottom: bounds?.bottom ?? -1, sidebarTop: sidebarBounds.top, sidebarBottom: sidebarBounds.bottom };
  });
  expect(layout.listScrolls).toBe(true);
  expect(layout.listText).not.toContain("Default workspace");
  expect(layout.defaultTop).toBeGreaterThanOrEqual(layout.sidebarTop);
  expect(layout.defaultBottom).toBeLessThanOrEqual(layout.sidebarBottom);
});
