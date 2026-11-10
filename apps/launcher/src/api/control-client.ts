/**
 * Control calls that go to the host.
 *
 * The UI is served by the host, so these are same-origin requests and the host's
 * HttpOnly cookie authenticates them. The shell no longer runs control.mjs; App.tsx
 * must not call the old Tauri commands.
 */
export interface ControlDevice {
  /** Set for a provider OAuth device flow; absent for Shisa.AI sign-in. */
  provider?: string;
  url: string;
  code: string;
}

interface ErrorBody {
  message?: unknown;
}

async function failure(response: Response): Promise<Error> {
  let message = "The configuration service is unavailable.";
  try {
    const body = (await response.json()) as ErrorBody;
    if (typeof body.message === "string" && body.message.trim()) message = body.message;
  } catch {
    /* Keep the generic sentence when the body is not JSON. */
  }
  return new Error(message);
}

export async function controlRequest(request: Record<string, unknown>): Promise<unknown> {
  const response = await fetch("/v1/control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw await failure(response);
  return response.json();
}

export async function controlCancel(requestId?: string): Promise<void> {
  const response = await fetch("/v1/control/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestId ? { requestId } : {}),
  });
  if (!response.ok) throw await failure(response);
}

/** Device codes from an in-flight sign-in. Returns the unsubscribe function. */
export function subscribeControl(onDevice: (device: ControlDevice) => void): () => void {
  const source = new EventSource("/v1/control/events");
  source.addEventListener("control.device", event => {
    try {
      const data = JSON.parse((event as MessageEvent<string>).data) as Partial<ControlDevice>;
      if (typeof data.url === "string") {
        onDevice({
          url: data.url,
          code: typeof data.code === "string" ? data.code : "",
          ...(typeof data.provider === "string" ? { provider: data.provider } : {}),
        });
      }
    } catch {
      /* A malformed frame is not a device code. */
    }
  });
  return () => source.close();
}
