/**
 * Control calls that go to the host.
 *
 * The desktop page loads a local build, so these cannot be same-origin requests and
 * there is no cookie: every call carries the host token through the one client the
 * shell configured. The shell no longer runs control.mjs.
 */
import type { HostClient } from "./host-client";
import { eventRouter } from "../event-router";

export interface ControlDevice {
  /** Set for a provider OAuth device flow; absent for Shisa.AI sign-in. */
  provider?: string;
  url: string;
  code: string;
}

let client: HostClient | undefined;

/** Called once by the app shell with the host-backed client. */
export function configureControlClient(host: HostClient): void {
  client = host;
}

function control(): HostClient {
  if (!client) throw new Error("The control client is not configured.");
  return client;
}

export async function controlRequest(request: Record<string, unknown>): Promise<unknown> {
  return control().control(request);
}

export async function controlCancel(requestId?: string): Promise<void> {
  return control().controlCancel(requestId);
}

/** Device codes from an in-flight sign-in. Returns the unsubscribe function. */
export function subscribeControl(onDevice: (device: ControlDevice) => void): () => void {
  return eventRouter.subscribe(event => {
    if (event.event !== "control.device") return;
    const data = event.data;
    if (typeof data.url !== "string") return;
    onDevice({
      url: data.url,
      code: typeof data.code === "string" ? data.code : "",
      ...(typeof data.provider === "string" ? { provider: data.provider } : {}),
    });
  });
}