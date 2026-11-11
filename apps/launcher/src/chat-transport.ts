/**
 * Chat wire transport. The connection owns projection/state; this boundary owns
 * how records reach the runtime.
 *
 * Phase C: the host owns the session. This transport attaches through the host,
 * buffers the normalized events the host publishes, and never touches Tauri.
 */

import { HostChatSession } from "./api/chat-session";
import type { ApiEvent, JouzuApi, OutgoingMessage } from "./api/jouzu-api";

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

/** Events the host publishes are already normalized; the connection projects them. */
export class HostChatTransport implements ChatTransport {
  private readonly sessions = new Map<string, HostChatSession>();
  private readonly queues = new Map<string, ApiEvent[]>();
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
      event => this.queues.get(session.id)?.push(event),
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
      const records = this.queues.get(handle)?.splice(0) ?? [];
      return { records, closed: true, error };
    }
    return { records: this.queues.get(handle)?.splice(0) ?? [], closed: false };
  }

  async send(handle: string, request: Record<string, unknown>): Promise<void> {
    const session = this.sessions.get(handle);
    if (!session) throw new Error("The session is not attached.");
    const text = typeof request.message === "string" ? request.message : "";
    const clientMessageId =
      typeof request.clientMessageId === "string" ? request.clientMessageId : crypto.randomUUID();
    await session.send({ clientMessageId, text } as OutgoingMessage);
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
