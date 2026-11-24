import { expect, test, type Page } from "@playwright/test";
import { UI_BASE, emptyControlState, stubHost } from "./host-control";

// #186 asks for an interaction regression test: drag the divider and assert the
// pane actually changes width, not just that a separator is present. The host is
// answered at the network boundary so the drag runs against the real component.
const WORKSPACE = "C:/Projects/Example";
const SESSION_ID = "pane-resize";
const SESSION_PATH = "C:/sessions/pane-resize.jsonl";

const handle = {
  sessionId: SESSION_ID,
  workspacePath: WORKSPACE,
  sessionPath: SESSION_PATH,
  title: "Pane resize",
  status: "idle",
  running: false,
  pinned: false,
  archived: false,
  cursor: 0,
  model: { provider: "fixture", id: "model", name: "Fixture model", state: "ready" },
};

async function openChat(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("jouzu.ui.language", "en");
    if (!crypto.randomUUID) {
      Object.defineProperty(crypto, "randomUUID", { value: () => `test-${Math.random().toString(16).slice(2)}` });
    }
  });
  await stubHost(page, {
    control: () => ({ ...emptyControlState, modelReady: true }),
    workspaces: [{ id: WORKSPACE, path: WORKSPACE, environment: { kind: "windows" } }],
  });
  await page.route("**/v1/sessions", async route => {
    const request = route.request();
    if (request.method() === "POST") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(handle) });
      return;
    }
    await route.fallback();
  });
  await page.route("**/v1/sessions/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (path === `/v1/sessions/${SESSION_ID}/messages`) {
      if (request.method() === "POST") return json({ messageId: "m-1", receipt: "queued" });
      return json({ messages: [], nextBefore: null });
    }
    if (path === `/v1/sessions/${SESSION_ID}/events`) {
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
    }
    if (path === `/v1/sessions/${SESSION_ID}/snapshot`) return json(handle);
    if (path === `/v1/sessions/${SESSION_ID}/stats`) return json({ stats: {} });
    if (path === `/v1/sessions/${SESSION_ID}/view`) return json({});
    if (path === "/v1/sessions/timing") return json({ timing: { modelMs: 0, toolMs: 0, turns: 0, steps: 0, outputTokens: 0 } });
    if (path === "/v1/sessions/flow") return json({ reports: [] });
    await route.fallback();
  });
  await page.goto(UI_BASE);
  const composer = page.getByLabel("Message Jouzu");
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill("start pane resize");
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "Toggle artifacts panel" })).toBeVisible();
  // The workspace rail plus the conversation's 520px floor can push the pane's
  // own header off a default viewport. Collapse the rail so adjacent controls
  // stay on screen while the drag is exercised.
  await page.getByRole("button", { name: "Hide workspaces" }).click();
}

async function paneWidth(page: Page, index: number) {
  const box = await page.locator(`aside[data-pane="${index}"]`).boundingBox();
  if (!box) throw new Error(`pane ${index} has no box`);
  return box.width;
}

async function drag(page: Page, index: number, deltaX: number) {
  const separator = page.getByRole("separator", { name: "Resize pane" }).nth(index);
  const box = await separator.boundingBox();
  if (!box) throw new Error(`separator ${index} has no box`);
  const x = box.x + box.width / 2;
  const y = box.y + Math.min(40, box.height / 2);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + deltaX, y, { steps: 10 });
  await page.mouse.up();
  return { x, y };
}

test("the divider resizes both ways and releases cleanly", async ({ page }) => {
  await openChat(page);
  await page.getByRole("button", { name: "Toggle artifacts panel" }).click();
  const separator = page.getByRole("separator", { name: "Resize pane" });
  await expect(separator).toHaveCount(1);
  await expect(separator).toHaveAttribute("aria-orientation", "vertical");
  const pane = page.locator('aside[data-pane="0"]');

  const initial = await paneWidth(page, 0);
  const left = await drag(page, 0, -80);
  const wider = await paneWidth(page, 0);
  expect(wider).toBeGreaterThan(initial + 50);

  // A move after release must not keep resizing: the drag really ended.
  await page.mouse.move(left.x - 260, left.y);
  expect(await paneWidth(page, 0)).toBeCloseTo(wider, 0);

  const right = await drag(page, 0, 80);
  const narrower = await paneWidth(page, 0);
  expect(narrower).toBeLessThan(wider - 50);
  await page.mouse.move(right.x + 200, right.y);
  expect(await paneWidth(page, 0)).toBeCloseTo(narrower, 0);

  // Start, Files and Artifacts all remain usable after the resize.
  await expect(pane.getByRole("tab", { name: "Start" })).toBeVisible();
  await pane.getByRole("button", { name: /^Workspace files/ }).click();
  await expect(pane.getByRole("tab", { name: "Files" })).toBeVisible();
  // Opening a view replaces Start; the add-tab control brings it back.
  await pane.getByRole("button", { name: "Add panel tab" }).click();
  await expect(pane.getByRole("tab", { name: "Start" })).toBeVisible();
  await pane.getByRole("button", { name: /^Artifacts/ }).click();
  await expect(pane.getByRole("tab", { name: "Artifacts" })).toBeVisible();
});

test("the second panel has its own divider and adjacent controls stay clickable", async ({ page }) => {
  await openChat(page);
  await page.getByRole("button", { name: "Toggle artifacts panel" }).click();
  // "Split pane" sits next to the divider; clicking it after a drag proves the
  // enlarged hit area did not swallow neighbouring controls. Narrow the pane
  // here so its header stays inside the default viewport.
  await drag(page, 0, 60);
  await page.getByRole("button", { name: "Split pane" }).click();
  await expect(page.getByRole("separator", { name: "Resize pane" })).toHaveCount(2);

  const firstBefore = await paneWidth(page, 0);
  const secondBefore = await paneWidth(page, 1);
  await drag(page, 1, -70);
  expect(await paneWidth(page, 1)).toBeGreaterThan(secondBefore + 40);
  expect(await paneWidth(page, 0)).toBeCloseTo(firstBefore, 0);
});

test("the divider still resizes in a narrow window", async ({ page }) => {
  await openChat(page);
  await page.setViewportSize({ width: 900, height: 600 });
  await page.getByRole("button", { name: "Toggle artifacts panel" }).click();
  const before = await paneWidth(page, 0);
  await drag(page, 0, -60);
  expect(await paneWidth(page, 0)).toBeGreaterThan(before + 40);
});

test.describe("with display scaling", () => {
  test.use({ deviceScaleFactor: 1.5 });

  test("the divider still resizes", async ({ page }) => {
    await openChat(page);
    await page.getByRole("button", { name: "Toggle artifacts panel" }).click();
    const before = await paneWidth(page, 0);
    await drag(page, 0, -80);
    expect(await paneWidth(page, 0)).toBeGreaterThan(before + 50);
  });
});
