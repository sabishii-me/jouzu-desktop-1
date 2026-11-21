import { test, expect, type Page } from "@playwright/test";
import { UI_BASE, stubHost, emptyControlState } from "./host-control";

/** Opens Settings → Collaboration against a host holding `initial`. Returns what the page saved. */
async function openCollaboration(page: Page, initial: { enabled: boolean; author: boolean }, language = "en") {
  const saves: Record<string, unknown>[] = [];
  let state = { ...initial };
  await page.addInitScript(value => localStorage.setItem("jouzu.ui.language", value), language);
  await stubHost(page, { control: () => emptyControlState });
  await page.route("**/v1/attribution", async route => {
    if (route.request().method() === "PUT") {
      const change = route.request().postDataJSON();
      saves.push(change);
      state = { ...state, ...change };
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(state) });
  });
  await page.goto(UI_BASE);
  await page.getByRole("button", { name: language === "en" ? "Settings" : "设置", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: language === "en" ? "Collaboration" : "协作" }).click();
  return { dialog, saves };
}

test("marking is one switch, and author or co-author is chosen only while it is on", async ({ page }) => {
  const { dialog, saves } = await openCollaboration(page, { enabled: false, author: true });
  const mark = dialog.getByRole("switch", { name: "Mark commits made by the agent" });
  await expect(mark).not.toBeChecked();
  await expect(dialog.getByRole("radio")).toHaveCount(0);

  await mark.click();
  await expect(mark).toBeChecked();
  // The choice saved earlier comes back with the switch.
  await expect(dialog.getByRole("radio", { name: /^Author/ })).toBeChecked();
  await dialog.getByRole("radio", { name: /^Co-author/ }).check();
  await expect(dialog.getByRole("radio", { name: /^Co-author/ })).toBeChecked();
  expect(saves).toEqual([{ enabled: true }, { author: false }]);

  await mark.click();
  await expect(dialog.getByRole("radio")).toHaveCount(0);
  expect(saves.at(-1)).toEqual({ enabled: false });
});

test("screenshot: Collaboration in Chinese, on, as author", async ({ page }) => {
  const { dialog } = await openCollaboration(page, { enabled: true, author: true }, "zh-Hans");
  await expect(dialog.getByRole("radio", { name: /^作者/ })).toBeChecked();
  await page.setViewportSize({ width: 1100, height: 760 });
  await dialog.screenshot({ path: process.env.SHOT ?? "test-results/collaboration-zh.png" });
});
