/**
 * Chat wire transport. The connection owns projection/state; this boundary owns
 * how records reach the runtime.
 *
 * The host owns the session. This transport attaches through it, drains the events
 * the host publishes (including the runtime records it relays), and routes command
 * requests to the host session instead of a local process.
 */

import { HostChatSession } from "./api/chat-session";
import type { ApiEvent, JouzuApi } from "./api/jouzu-api";

export interface ChatPoll {
  records: unknown[];
  closed: boolean;
  error?: string;
}

export interface ChatTransport {
  releaseGeneration(generation: string): Promise<void>;
  start(path: string, generation: string, key: string): Promise<string>;
  stop(handle: string): Promise<void>;
  poll(handle: string): Promise<ChatPoll>;
  send(handle: string, request: Record<string, unknown>): Promise<void>;
}

/** Host events that carry a runtime record the projection already understands. */
function recordOf(event: ApiEvent): unknown | undefined {
  if (event.event !== "runtime.event") return undefined;
  const data = event.data as Record<string, unknown>;
  return data.event ?? data.record ?? data;
}

export class HostChatTransport implements ChatTransport {
  private readonly sessions = new Map<string, HostChatSession>();
  private readonly queues = new Map<string, unknown[]>();
  private readonly closed = new Map<string, string | undefined>();

  constructor(private readonly api: JouzuApi) {}

  async releaseGeneration(): Promise<void> {
    // Handles belong to the host session; nothing to release per page.
  }

  async start(path: string, _generation: string, _key: string): Promise<string> {
    const session = await HostChatSession.open(this.api, path);
    this.sessions.set(session.id, session);
    this.queues.set(session.id, []);
    session.follow(
      event => {
        const record = recordOf(event);
        if (record !== undefined) this.queues.get(session.id)?.push(record);
      },
      error => this.closed.set(session.id, String(error)),
    );
    return session.id;
  }

  async stop(handle: string): Promise<void> {
    const session = this.sessions.get(handle);
    this.sessions.delete(handle);
    this.queues.delete(handle);
    this.closed.delete(handle);
    await session?.stop();
  }

  async poll(handle: string): Promise<ChatPoll> {
    const error = this.closed.get(handle);
    if (error !== undefined) {
      this.closed.delete(handle);
      return { records: this.queues.get(handle)?.splice(0) ?? [], closed: true, error };
    }
    return { records: this.queues.get(handle)?.splice(0) ?? [], closed: false };
  }

  async send(handle: string, request: Record<string, unknown>): Promise<void> {
    const queue = this.queues.get(handle);
    if (!this.sessions.has(handle) || !queue) throw new Error("The session is not attached.");

    // The connection speaks the runtime's request shape: { type, id, ...fields }.
    const command = typeof request.type === "string" ? request.type : undefined;
    if (command) {
      // The runtime answers the command itself and the host relays that record, so a
      // successful call adds nothing here. Only a rejected call needs an answer the
      // connection can correlate.
      try {
        await this.api.commands.raw(handle, request);
      } catch (error) {
        queue.push({
          type: "response",
          id: request.id,
          command,
          success: false,
          error: String(error),
        });
      }
      return;
    }

    const text = typeof request.message === "string" ? request.message : "";
    const clientMessageId =
      typeof request.clientMessageId === "string" ? request.clientMessageId : crypto.randomUUID();
    await this.sessions.get(handle)!.send({ clientMessageId, text });
  }
}

let shared: ChatTransport | undefined;

/** Called once by the app shell with the host-backed api. */
export function configureChatTransport(api: JouzuApi): void {
  shared = new HostChatTransport(api);
}

/** The one transport the UI uses; configuration happens before any session opens. */
export function chatTransport(): ChatTransport {
  if (!shared) throw new Error("Chat transport is not configured.");
  return shared;
}