import { test, expect } from "@playwright/test";

/**
 * Product-level smoke against a REAL host: real dist, real control adapter, real Node,
 * real runtime home. Set JOUZU_HOST_URL and JOUZU_HOST_TOKEN from the host's host.json.
 *
 * Not part of the default suite: without a host there is nothing to talk to, and a stub
 * would defeat the purpose.
 */
const base = process.env.JOUZU_HOST_URL ?? "";
const token = process.env.JOUZU_HOST_TOKEN ?? "";

test.skip(!base || !token, "needs JOUZU_HOST_URL and JOUZU_HOST_TOKEN from a running host");

test("settings works through the real host", async ({ page }) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));

  await page.addInitScript(() => localStorage.setItem("jouzu.ui.language", "en"));
  await page.goto(`${base}/?token=${token}`);

  const settings = page.getByRole("button", { name: "Settings", exact: true });
  await expect(settings).toBeVisible({ timeout: 30_000 });
  await settings.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("tab", { name: "Model providers", exact: true })).toBeVisible();

  // Control status arrives from the host on open; the Shisa.AI card proves it parsed.
  await expect(dialog.getByText("Shisa.AI", { exact: true }).first()).toBeVisible();

  // The same control endpoint the UI uses. The UI may still hold the single control
  // slot while it reads status on open, so a 409 is expected and retried, not a failure.
  let status = { code: 0, body: "" };
  await expect
    .poll(async () => {
      status = await page.evaluate(async () => {
        const response = await fetch("/v1/control", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "status" }),
        });
        return { code: response.status, body: await response.text() };
      });
      return status.code;
    }, { timeout: 30_000 })
    .toBe(200);
  expect(status.body).toContain('"schemaVersion"');

  // Switching tabs keeps the dialog alive and shows host-backed environment data.
  await dialog.getByRole("tab", { name: "Environment", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Add variable", exact: true })).toBeVisible();

  const controlErrors = pageErrors.filter(message => !/tauri|invoke|__TAURI/iu.test(message));
  expect(controlErrors, `page errors: ${pageErrors.join(" | ")}`).toEqual([]);
});
