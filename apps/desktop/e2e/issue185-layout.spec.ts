import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { emptyControlState, stubHost } from "./host-control";

test.use({ channel: process.env.JOUZU_UI_TEST_BROWSER });

const sessionSnapshot = {
  sessionId: "s1",
  sessionPath: "C:/sessions/issue-185.jsonl",
  status: "running",
  cursor: 1,
  model: { state: "ready", provider: "fixture", id: "model", name: "Fixture model with an intentionally long label" },
  models: [{ provider: "fixture", id: "model", name: "Fixture model with an intentionally long label" }],
  textguard: { mode: "on", disabled: false },
  activeTurn: { turnId: "t1", phase: "working", step: { n: 1, state: "thinking", tools: [] } },
};

async function installRunningSessionFixture(page: Page) {
  const snapshot = { ...sessionSnapshot, sessionId: "s1", sessionPath: "C:/sessions/issue-185.jsonl", status: "running", cursor: 1 };
  const requests: string[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/v1/")) requests.push(`${request.method()} ${url.pathname}`);
  });
  await page.route("**/v1/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === "/v1/sessions" && request.method() === "POST") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(snapshot) });
    }

    if (path === "/v1/sessions" && request.method() === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sessions: [{ ...sessionSnapshot, workspacePath: "C:/Projects/Issue 185", sessionPath: "C:/sessions/issue-185.jsonl", status: "running", running: true }] }) });
    }
    if (path === "/v1/sessions/persisted" && request.method() === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sessions: [] }) });
    }
    if (path === "/v1/events") {
      const data = `id: 1\nevent: session.updated\ndata: ${JSON.stringify(snapshot)}\n\n`;
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: data });
    }
    if (path === "/v1/sessions/s1/snapshot") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(snapshot) });
    }
    if (path === "/v1/sessions/s1/messages" || path === "/v1/sessions/undefined/messages") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ messages: [], nextBefore: null, turn: 0 }) });
    }
    if ((path === "/v1/sessions/s1/stats" || path === "/v1/sessions/undefined/stats") && request.method() === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ stats: null }) });
    }
    if ((path === "/v1/sessions/s1/events" || path === "/v1/sessions/undefined/events") && request.method() === "GET") {
      const data = `id: 1\nevent: session.updated\ndata: ${JSON.stringify({ seq: 1, sessionId: "s1", event: "session.updated", data: sessionSnapshot })}\n\n`;
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: data });
    }
    if (path === "/v1/sessions/s1/view" && request.method() === "POST") return route.fulfill({ status: 204, body: "" });
    if (path === "/v1/sessions/s1") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(sessionSnapshot) });
    }
    if (path === "/v1/models") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ models: sessionSnapshot.models }) });
    }
    return route.fallback();
  });
  return requests;
}

test("issue 185: running composer keeps essential controls separate from its steering hint", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  await stubHost(page, {
    control: () => ({ ...emptyControlState, modelReady: true }),
    skipSessionDetails: true,
    workspaces: [{ id: "windows:C:/Projects/Issue 185", path: "C:/Projects/Issue 185", environment: { kind: "windows" } }],
  });
  const requests = await installRunningSessionFixture(page);
  await page.addInitScript(() => localStorage.setItem("jouzu.ui.language", "en"));
  const dist = resolve("apps/desktop/dist");
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
  const workspaceButton = page.getByRole("button", { name: "Choose workspace" });
  await workspaceButton.dispatchEvent("click");
  await expect(page.getByRole("menuitemradio", { name: /Issue 185/ })).toBeVisible();
  await page.getByRole("menuitemradio", { name: /Issue 185/ }).click();
  await expect(page.getByLabel("Message Jouzu")).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Steer", exact: true })).toBeVisible();

  const footer = page.locator(".composer-footer");
  const hint = page.locator("[data-composer-steering-hint]");
  const textguard = page.locator('[aria-label^="TextGuard"]');
  const model = page.getByRole("button", { name: "Model", exact: true });
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  const send = page.getByRole("button", { name: "Steer", exact: true });
  await expect(textguard).toBeVisible();
  const rectangles = async () => page.evaluate(() => Object.fromEntries(
    ["textguard", "model", "stop", "send", "hint"].map(name => {
      const element = document.querySelector(name === "textguard" ? '[aria-label^="TextGuard"]' : name === "model" ? '[aria-label="Model"]' : name === "stop" ? 'button:not([disabled])' : name === "send" ? 'button[type="submit"]' : '[data-composer-steering-hint]');
      const rect = element?.getBoundingClientRect();
      return [name, rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height } : null];
    }),
  ));
  const assertNoOverlap = async () => {
    const boxes = await rectangles();
    const essential = [boxes.textguard, boxes.model, boxes.stop, boxes.send];
    expect(essential.every(box => box && box.width > 0 && box.height > 0)).toBe(true);
    for (let i = 0; i < essential.length; i++) for (let j = i + 1; j < essential.length; j++) {
      const a = essential[i]!; const b = essential[j]!;
      expect(Math.min(a.right, b.right) - Math.max(a.left, b.left)).toBeLessThanOrEqual(0);
    }
    const h = boxes.hint;
    if (h && h.width > 0 && h.height > 0) for (const control of essential) {
      const c = control!;
      expect(Math.min(h.right, c.right) - Math.max(h.left, c.left)).toBeLessThanOrEqual(0);
    }
    return boxes;
  };

  for (const width of [60, 38, 30]) {
    await footer.evaluate((element, value) => { (element as HTMLElement).style.width = `${value}rem`; }, width);
    const boxes = await assertNoOverlap();
    if (boxes.hint && boxes.hint.width > 0) await expect(hint).toHaveCSS("overflow", "hidden");
    await expect(textguard).toBeVisible();
    await expect(model).toBeVisible();
    await expect(stop).toBeVisible();
    await expect(send).toBeVisible();
  }

  expect(requests).toEqual(expect.arrayContaining([
    "POST /v1/sessions",
    "GET /v1/sessions/s1/snapshot",
    "GET /v1/sessions/s1/messages",
    "GET /v1/sessions/s1/events",
  ]));
  expect(requests.some(request => request.includes("/v1/sessions/s1/events"))).toBe(true);
});
