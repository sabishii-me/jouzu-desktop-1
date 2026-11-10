import type { Page } from "@playwright/test";

/** The UI base URL. Playwright must point at this repository''s dev server. */
export const UI_BASE = process.env.JOUZU_UI_BASE ?? "http://localhost:1420";

/**
 * The UI now calls the host for control. These specs run without a host, so the
 * control endpoints are answered at the network boundary; every other request is
 * untouched.
 */
export async function stubHostControl(page: Page, handler: (body: any) => unknown) {
  await page.route("**/v1/control", async route => {
    const body = route.request().postDataJSON();
    const result = await handler(body);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(result),
    });
  });
  await page.route("**/v1/control/cancel", route =>
    route.fulfill({ status: 204, body: "" }),
  );
  await page.route("**/v1/control/events", route =>
    route.fulfill({ status: 200, contentType: "text/event-stream", body: "" }),
  );
}

/** The empty status every spec starts from, matching the control-state parser. */
export const emptyControlState = {
  schemaVersion: 1,
  profile: "core",
  account: { signedIn: false },
  credentials: [],
  customProviders: [],
  providers: [],
  models: [],
};
