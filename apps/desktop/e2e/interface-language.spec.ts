import { test, expect } from "@playwright/test";
import { UI_BASE, stubHost, emptyControlState } from "./host-control";

// #100: with the interface set to Japanese, the Tools page is Japanese too.

test("the Tools page follows the interface language", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("jouzu.ui.language", "ja"));
  const shisa = { id: "shisa", label: "Shisa.AI", usable: true, models: [{ id: "gemini-3-pro-image", sizes: ["1K"] }] };
  await stubHost(page, {
    control: () => emptyControlState,
    tools: {
      image: { provider: "shisa", model: "gemini-3-pro-image" },
      report: () => ({ usable: true, defaults: { provider: "shisa", model: "gemini-3-pro-image", size: "1K", maxImages: 3 }, providers: [shisa] }),
    },
  });
  await page.goto(UI_BASE);
  await page.getByRole("button", { name: "設定", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "ツール", exact: true }).click();
  const panel = dialog.getByRole("tabpanel");
  await expect(panel.getByText("画像生成", { exact: true })).toBeVisible();
  await expect(panel.getByLabel("画像プロバイダー", { exact: true })).toHaveValue("shisa");
  await expect(panel.getByText("確認が必要な呼び出し：generate_image")).toBeVisible();
  // Nothing in the panel is English of its own (names and values are not translated).
  const words = (await panel.innerText()).replace(/generate_image|Shisa\.AI|gemini-3-pro-image|\b1K\b/gu, "");
  expect(words).not.toMatch(/[A-Za-z]{3,}/u);
});
