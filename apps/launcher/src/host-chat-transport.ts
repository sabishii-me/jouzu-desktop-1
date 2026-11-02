import type { JouzuApi } from "./api/jouzu-api";
import type { ChatPoll, ChatTransport } from "./chat-transport";

/**
 * Host-served chat transport. The host replays raw runtime records as
 * `runtime.event`; ChatConnection's existing projection consumes those records.
 */
export class HostChatTransport implements ChatTransport {
  private unsubscribe?: () => void;
  private queue: unknown[] = [];
  private closed = false;
  private error: string | undefined;

  constructor(private readonly api: JouzuApi, private readonly workspacePath = "") {}

  async releaseGeneration(): Promise<void> {}

  async start(path: string): Promise<string> {
    const handle = await this.api.sessions.attach(path || this.workspacePath);
    this.unsubscribe = this.api.subscribe(
      handle.sessionId,
      "chat-host",
      ["view", "control", "prompts"],
      undefined,
      event => {
        if (event.event === "runtime.event") {
          if (
            event.data.type === "response" &&
            !String(event.data.id ?? "").startsWith("desktop-")
          ) {
            return;
          }
          this.queue.push(event.data);
        }
        if (event.event === "session.status") {
          const status = event.data.status;
          if (status === "stopped" || status === "error") this.closed = true;
        }
      },
      error => {
        this.error = String(error);
        this.closed = true;
      },
    );
    return handle.sessionId;
  }

  async stop(handle: string): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.api.sessions.stop(handle);
  }

  async poll(): Promise<ChatPoll> {
    const records = this.queue.splice(0, this.queue.length);
    return { records, closed: this.closed, ...(this.error ? { error: this.error } : {}) };
  }

  async send(handle: string, request: Record<string, unknown>): Promise<void> {
    const type = String(request.type ?? "");
    if (type === "prompt" || type === "steer") {
      const images = Array.isArray(request.images) ? request.images as Array<{ data: string; mimeType: string }> : [];
      await this.api.sessions.send(handle, {
        clientMessageId: String(request.id),
        text: String(request.message ?? ""),
        ...(images.length
          ? { attachments: images.map(image => ({ name: "image", mimeType: image.mimeType, data: image.data })) }
          : {}),
      });
      return;
    }
    if (type === "abort") {
      await this.api.sessions.interrupt(handle);
      return;
    }
    if (type === "extension_ui_response") {
      if (typeof request.confirmed === "boolean") {
        await this.api.prompts.approve(String(request.id), request.confirmed ? "Approve" : "Deny");
      } else {
        await this.api.prompts.answer(String(request.id), (request.answers ?? {}) as Record<string, string>);
      }
      return;
    }
    await this.api.commands.raw(handle, { ...request, type });
  }
}
