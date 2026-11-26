import { test, expect, type Page } from "@playwright/test";
import { UI_BASE, stubHost, emptyControlState } from "./host-control";

type Provider = { id: string; label: string; usable: boolean; code?: string; reason?: string; models: { id: string; sizes: string[] }[] };

const shisa: Provider = {
  id: "shisa", label: "Shisa.AI", usable: true,
  models: [{ id: "gemini-3-pro-image", sizes: ["1K", "2K", "4K"] }, { id: "gemini-3.1-flash-image", sizes: ["1K", "2K", "4K"] }],
};
// A provider from the runtime's own registry: its image API takes no size.
const openRouter: Provider = {
  id: "openrouter", label: "OpenRouter", usable: true,
  models: [{ id: "black-forest-labs/flux.2-pro", sizes: [] }, { id: "google/gemini-2.5-flash-image", sizes: [] }],
};
// A Shisa.AI free account: the plan has no image models.
const freeShisa: Provider = { id: "shisa", label: "Shisa.AI", usable: false, code: "not-allowed", reason: "This account's plan does not include image generation.", models: [] };

const report = (providers: Provider[]) => {
  const first = providers.find(provider => provider.usable);
  return { usable: !!first, defaults: { provider: first?.id ?? "", model: first?.models[0]?.id ?? "", size: "1K", maxImages: 3 }, providers };
};

/** Settings → Tools against a host whose image report, per configuration generation, is `providers(generation)`. */
async function openTools(page: Page, providers: (generation: number) => Provider[] | null, image: Record<string, unknown> = {}) {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const saves: Record<string, unknown>[] = [];
  const refreshes: number[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname === "/v1/tools" && request.method() === "PATCH") saves.push(request.postDataJSON().image);
    if (url.pathname === "/v1/tools/refresh") refreshes.push(1);
  });
  await page.addInitScript(() => localStorage.setItem("jouzu.ui.language", "en"));
  await stubHost(page, {
    control: () => emptyControlState,
    tools: { image, report: generation => { const list = providers(generation); return list && report(list); } },
  });
  await page.goto(UI_BASE);
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Tools" }).click();
  await expect(dialog.getByText("Image generation", { exact: true })).toBeVisible();
  return { dialog, saves, refreshes, errors };
}

test("with a usable provider, the card edits the image settings field by field", async ({ page }) => {
  const { dialog, saves, errors } = await openTools(page, () => [shisa], { provider: "shisa", model: "gemini-3-pro-image" });
  await expect(dialog.getByLabel("Image provider", { exact: true })).toHaveValue("shisa");
  await expect(dialog.getByLabel("Image model", { exact: true })).toHaveValue("gemini-3-pro-image");
  await expect(dialog.getByText("Reviewed calls: generate_image")).toBeVisible();
  await dialog.getByLabel("Image size", { exact: true }).selectOption("2K");
  // Only the size is sent: provider and model stay as saved.
  await expect.poll(() => saves.at(-1) ?? null).toEqual({ size: "2K" });
  await dialog.getByLabel("Image model", { exact: true }).selectOption("gemini-3.1-flash-image");
  await expect.poll(() => saves.at(-1) ?? null).toEqual({ provider: "shisa", model: "gemini-3.1-flash-image" });
  expect(errors).toEqual([]);
});

// #249: turning the switch off sends only the switch, with or without a provider.
test("turning image generation off sends only the switch", async ({ page }) => {
  const { dialog, saves, errors } = await openTools(page, () => [shisa]);
  await dialog.getByRole("switch", { name: "Enable image generation" }).click();
  await expect.poll(() => saves.at(-1) ?? null).toEqual({ enabled: false });
  await expect(dialog.getByLabel("Image provider", { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("with no provider added, the switch is off and Model providers is offered", async ({ page }) => {
  const { dialog, saves, errors } = await openTools(page, () => []);
  await expect(dialog.getByRole("switch", { name: "Enable image generation" })).toBeDisabled();
  await expect(dialog.getByText("No image provider added.", { exact: false })).toBeVisible();
  await dialog.getByRole("button", { name: "Open Model providers" }).click();
  await expect(dialog.getByRole("tab", { name: "Model providers" })).toHaveAttribute("aria-selected", "true");
  expect(saves).toEqual([]);
  expect(errors).toEqual([]);
});

test("a free account says its plan has no images, and Check again asks once more", async ({ page }) => {
  const { dialog, refreshes, errors } = await openTools(page, () => [freeShisa]);
  await expect(dialog.getByRole("switch", { name: "Enable image generation" })).toBeDisabled();
  await expect(dialog.getByText("Shisa.AI: This account's plan does not include image generation.")).toBeVisible();
  // Providers nobody added are never listed.
  await expect(dialog.getByText("OpenRouter")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Check again" }).click();
  await expect.poll(() => refreshes.length).toBe(1);
  expect(errors).toEqual([]);
});

test("a runtime provider's model takes no size", async ({ page }) => {
  const { dialog, saves, errors } = await openTools(page, () => [shisa, openRouter], { provider: "shisa" });
  const provider = dialog.getByLabel("Image provider", { exact: true });
  await expect(provider.locator("option")).toHaveText(["Shisa.AI", "OpenRouter"]);
  await provider.selectOption("openrouter");
  await expect.poll(() => saves.at(-1) ?? null).toEqual({ provider: "openrouter", model: "black-forest-labs/flux.2-pro" });
  await expect(dialog.getByLabel("Image size", { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

// A sign-in without a restart: the Tools card follows the host's next answer,
// with nothing read again by the page. (The model setup page follows the
// models block the same way: onboarding.spec.ts.)
test("a sign-in updates the Tools card without a restart or a read of its own", async ({ page }) => {
  // Before the sign-in nothing is added; after it (generation 1) Shisa.AI is.
  const { dialog, errors } = await openTools(page, generation => (generation === 0 ? [] : [shisa]));
  await expect(dialog.getByText("No image provider added.", { exact: false })).toBeVisible();
  const reads: string[] = [];
  page.on("request", request => { const path = new URL(request.url()).pathname; if (path === "/v1/tools" || path === "/v1/models") reads.push(path); });
  await page.evaluate(() => fetch("/v1/config/shisa-login", { method: "POST", body: "{}" }));
  await expect(dialog.getByLabel("Image provider", { exact: true })).toHaveValue("shisa");
  await expect(dialog.getByRole("switch", { name: "Enable image generation" })).toBeEnabled();
  // The page read nothing again: the change arrived with app.updated.
  expect(reads).toEqual([]);
  expect(errors).toEqual([]);
});
