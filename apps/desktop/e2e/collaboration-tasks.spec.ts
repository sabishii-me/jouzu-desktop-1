import { expect, test, type Page } from "@playwright/test";
import { UI_BASE, emptyControlState, stubHostControl } from "./host-control";

// Settings > Collaboration: how many tasks may run at once is the user's
// choice, empty meaning no limit; Desktop sets no number of its own and
// recommends no model of its own. The host's /v1 API is answered at the
// network boundary.

async function open(page: Page, language: string, puts: unknown[]) {
  await stubHostControl(page, () => emptyControlState);
  let maxRunning: number | null = null;
  await page.route("**/v1/collaboration/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/v1/collaboration/tasks") {
      if (request.method() === "PUT") {
        const body = request.postDataJSON();
        puts.push(body);
        maxRunning = body.maxRunning;
      }
      return json({ maxRunning });
    }
    return json({ enabled: false, port: 47615, serving: false, url: "http://127.0.0.1:47615/mcp", clients: [] });
  });
  await page.route("**/v1/assistant", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enabled: false, model: null, thinkingLevels: ["low", "high"], phase: "off", error: null, unseen: false }) }));
  await page.route("**/v1/attribution", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enabled: false }) }));
  await page.addInitScript(language => localStorage.setItem("jouzu.ui.language", language), language);
  await page.goto(UI_BASE);
}

for (const [language, words] of [
  ["en", { settings: "Settings", tab: "Collaboration", tasks: "Tasks running at once", noLimit: "No limit", save: "Save" }],
  ["ja", { settings: "設定", tab: "コラボレーション", tasks: "同時に実行するタスク", noLimit: "上限なし", save: "保存" }],
] as const) {
  test(`the user sets how many tasks run at once, empty for no limit (${language})`, async ({ page }, info) => {
    const puts: unknown[] = [];
    await open(page, language, puts);
    await page.getByRole("button", { name: words.settings, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("tab", { name: words.tab }).click();
    const field = dialog.getByLabel(words.tasks);
    await expect(field).toHaveValue("");
    await expect(field).toHaveAttribute("placeholder", words.noLimit);
    await dialog.screenshot({ path: info.outputPath(`collaboration-${language}.png`) });
    await field.fill("2");
    await dialog.getByRole("button", { name: words.save, exact: true }).click();
    await expect.poll(() => puts).toEqual([{ maxRunning: 2 }]);
    await field.fill("");
    await dialog.getByRole("button", { name: words.save, exact: true }).click();
    await expect.poll(() => puts).toEqual([{ maxRunning: 2 }, { maxRunning: null }]);
  });
}
