import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

// The sidebar's grouping, order and filter are the user's choice (0026): the
// header controls open the full set of choices, the choice is kept, and no
// workspace is pinned. Runs against the built UI with the host's API stubbed.

const demo = "C:/Projects/demo";
const alpha = "C:/Projects/demo/packages/alpha";
const other = "C:/Projects/other";
const now = Date.now();
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
const row = (name: string, workspacePath: string, extra: Record<string, unknown> = {}) => ({
  sessionId: null, sessionPath: `${workspacePath}/${name}.jsonl`, workspacePath, title: `${name} session`,
  status: "stopped", updatedAt: at(60), running: false, pinned: false, archived: false, ...extra,
});
const saved = [
  row("demo-old", demo, { updatedAt: at(5) }),
  row("demo-new", demo, { updatedAt: at(1) }),
  row("alpha", alpha, { updatedAt: at(3) }),
  row("other", other, { updatedAt: at(2), archived: true }),
];

async function setup(page: Page, language = "en") {
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.addInitScript(language => {
    localStorage.setItem("jouzu.ui.language", language);
    (window as any).__JOUZU_HOST__ = { baseUrl: "http://jouzu-ui.test", token: "t" };
  }, language);
  await page.route("http://jouzu-ui.test/v1/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/v1/capabilities") return json({ host: true, native: false, features: [], scopes: ["*"] });
    if (path === "/v1/status") return json({ hostVersion: "x", runtimeHome: "C:/h", node: true, app: true, bash: true, git: true, terminal: false });
    if (path === "/v1/workspaces") return json({ workspaces: [demo, alpha, other].map((workspacePath, index) => ({ id: `w${index}`, path: workspacePath, environment: { kind: "windows" } })) });
    if (path === "/v1/sessions" && request.method() === "GET") return json({ sessions: [] });
    if (path === "/v1/sessions/persisted") return json({ sessions: saved });
    if (path === "/v1/runtime/warm") return json({ state: "ready", workspace: demo });
    if (path === "/v1/events" || path.endsWith("/events")) return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": hi\n\n" });
    if (path === "/v1/control") return json({ schemaVersion: 1, modelReady: true, profile: "core", account: { signedIn: false }, credentials: [], customProviders: [], providers: [], models: [] });
    if (path === "/v1/models") return json({ models: [{ provider: "f", id: "d", name: "Fixture model" }] });
    if (path === "/v1/artifacts/counts") return json({ counts: {} });
    if (path === "/v1/sessions/history") return json({ messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }, { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] }] });
    return json({});
  });
  const dist = resolve("dist");
  await page.route(url => !new URL(url).pathname.startsWith("/v1/"), async route => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    const file = resolve(dist, path === "/" ? "index.html" : `.${path}`);
    if (!file.startsWith(dist + sep)) return route.abort();
    const type = ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" } as Record<string, string>)[extname(file)] ?? "application/octet-stream";
    try { await route.fulfill({ body: await readFile(file), contentType: type }); } catch { await route.fulfill({ status: 404, body: "" }); }
  });
  await page.goto("http://jouzu-ui.test/");
  await expect(page.locator("[data-sidebar-mode]")).toBeVisible();
}

const arrange = (page: Page, label = "Arrange sessions") => page.getByRole("button", { name: label, exact: true });
const choose = async (page: Page, option: string, label = "Arrange sessions") => {
  await arrange(page, label).click();
  await page.getByRole("menuitemradio", { name: option, exact: true }).click();
};
const groups = (page: Page) => page.locator("[data-sidebar-group]");
const rows = (page: Page) => page.locator("[data-session-key]");
const titles = async (page: Page) => page.locator("[data-session-title]").allInnerTexts();

test("the sidebar starts grouped by workspace, newest first, archived hidden", async ({ page }) => {
  await setup(page);
  await expect(groups(page)).toHaveCount(3);
  expect(await groups(page).evaluateAll(nodes => nodes.map(node => node.getAttribute("data-sidebar-group"))))
    .toEqual(["c:/projects/demo", "c:/projects/demo/packages/alpha", "c:/projects/other"]);
  expect(await titles(page)).toEqual(["demo-new session", "demo-old session", "alpha session"]);
});

test("one list shows every workspace's sessions in one list, each row naming its workspace", async ({ page }) => {
  await setup(page);
  await choose(page, "In one list");
  await expect(page.locator("[data-sidebar-mode]")).toHaveAttribute("data-sidebar-mode", "list");
  await expect(groups(page)).toHaveCount(0);
  expect(await titles(page)).toEqual(["demo-new session", "alpha session", "demo-old session"]);
  // The workspace is named on the row, since the group header is gone.
  await expect(rows(page).first()).toContainText("demo");
  await page.locator("aside").screenshot({ path: "test-results/sidebar-arrangement-one-list.png" });
});

test("the tree nests a workspace under the workspace whose folder holds it", async ({ page }) => {
  await setup(page);
  await choose(page, "Workspace tree");
  const depth = await groups(page).evaluateAll(nodes => nodes.map(node => [node.getAttribute("data-sidebar-group"), node.getAttribute("data-group-depth")]));
  expect(depth).toEqual([["c:/projects/demo", "0"], ["c:/projects/demo/packages/alpha", "1"], ["c:/projects/other", "0"]]);
  await page.locator("aside").screenshot({ path: "test-results/sidebar-arrangement-tree.png" });
});

test("the filter shows archived sessions and only archived sessions", async ({ page }) => {
  await setup(page);
  await choose(page, "All conversations");
  expect(await titles(page)).toContain("other session");
  await choose(page, "Archived only");
  expect(await titles(page)).toEqual(["other session"]);
  await choose(page, "Hide archived");
  expect(await titles(page)).not.toContain("other session");
});

test("a manual order is kept across a reload, for groups and for sessions", async ({ page }) => {
  await setup(page);
  await choose(page, "Manual");
  // Moving the older session up reorders its own group only.
  await rows(page).filter({ hasText: "demo-old session" }).locator("button").first().focus();
  await page.keyboard.press("Alt+ArrowUp");
  expect(await titles(page)).toEqual(["demo-old session", "demo-new session", "alpha session"]);
  // The group header moves the whole group.
  await groups(page).filter({ hasText: "other" }).locator("button").first().focus();
  await page.keyboard.press("Alt+ArrowUp");
  expect(await groups(page).evaluateAll(nodes => nodes.map(node => node.getAttribute("data-sidebar-group"))))
    .toEqual(["c:/projects/demo", "c:/projects/other", "c:/projects/demo/packages/alpha"]);

  await page.reload();
  await expect(page.locator("[data-sidebar-mode]")).toBeVisible();
  expect(await titles(page)).toEqual(["demo-old session", "demo-new session", "alpha session"]);
  expect(await groups(page).evaluateAll(nodes => nodes.map(node => node.getAttribute("data-sidebar-group"))))
    .toEqual(["c:/projects/demo", "c:/projects/other", "c:/projects/demo/packages/alpha"]);
});

test("the choice is remembered and the menu marks the active one", async ({ page }) => {
  await setup(page);
  await choose(page, "In one list");
  await arrange(page).click();
  await expect(page.getByRole("menuitemradio", { name: "In one list", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("menuitemradio", { name: "Workspace", exact: true })).toHaveAttribute("aria-checked", "false");
  await page.screenshot({ path: "test-results/sidebar-arrangement-menu.png" });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitemradio", { name: "In one list", exact: true })).toHaveCount(0);

  await page.reload();
  await expect(page.locator("[data-sidebar-mode]")).toHaveAttribute("data-sidebar-mode", "list");
});

test("the arrangement speaks the interface language", async ({ page }) => {
  await setup(page, "ja");
  await arrange(page, "セッションの並べ方").click();
  await expect(page.getByRole("menuitemradio", { name: "ワークスペースツリー", exact: true })).toBeVisible();
  await page.getByRole("menuitemradio", { name: "ワークスペースツリー", exact: true }).click();
  await expect(page.locator("[data-sidebar-mode]")).toHaveAttribute("data-sidebar-mode", "groups");
});
