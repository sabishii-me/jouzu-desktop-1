/**
 * Chat wire transport. The connection owns projection/state; this boundary owns
 * how records reach the runtime. Desktop uses Tauri, host-served UI will use the
 * host transport.
 */

import { invoke } from "@tauri-apps/api/core";

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

export class TauriChatTransport implements ChatTransport {
  async releaseGeneration(generation: string): Promise<void> {
    await invoke("chat_release_generation", { generation });
  }

  start(path: string, generation: string, key: string): Promise<string> {
    return invoke<string>("chat_start", { path, generation, key });
  }

  async stop(handle: string): Promise<void> {
    await invoke("chat_stop", { handle });
  }

  poll(handle: string): Promise<ChatPoll> {
    return invoke<ChatPoll>("chat_poll", { handle });
  }

  async send(handle: string, request: Record<string, unknown>): Promise<void> {
    await invoke("chat_send", { handle, request });
  }
}

export const defaultChatTransport: ChatTransport = new TauriChatTransport();
