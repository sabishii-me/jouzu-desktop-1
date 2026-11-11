import { invoke } from "@tauri-apps/api/core";
import { ChatConnection } from "./chat-connection";
import type { WireObject } from "./chat-projection";
import { chatTransport as sharedChatTransport, type ChatTransport } from "./chat-transport";

let transportFactory: (() => ChatTransport) | undefined;

export function setChatTransportFactory(factory: (() => ChatTransport) | undefined) {
  transportFactory = factory;
}

function chatTransport(): ChatTransport {
  return transportFactory ? transportFactory() : chatTransport();
}

interface Slot {
  client: ChatConnection;
  scratch: string;
}

interface PoolPoll {
  handle: string;
  records: unknown[];
  closed?: boolean;
  error?: string;
}

/**
 * Warm slots are blank runtimes started in a private scratch directory. They never
 * attach the real workspace's session branch, so they cannot contend with the
 * visible runtime for Flow ownership. Leasing a session runs switch_session, which
 * releases the scratch branch and acquires the target's. New sessions cold-start
 * in the real workspace because a scratch runtime's cwd is its scratch directory.
 *
 * Idle slots are polled by one timer through chat_poll_many. A leased client
 * takes over its own polling, so the view keeps the behavior it always had.
 */
const entryKey = (path: string) => path.replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();

export class ChatPool {
  private slots = new Map<ChatConnection, Slot>();
  private idle = new Set<ChatConnection>();
  private entries = new Map<string, ChatConnection>();
  private watches = new Map<ChatConnection, () => void>();
  private statusListeners = new Set<() => void>();
  private statusSignature = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private warming = false;
  private disposed = false;

  constructor(private readonly target = 4, private readonly maxSessions = 30) {}

  private ensureTimer(): void {
    if (this.timer || this.disposed) return;
    this.timer = setTimeout(this.loop, 10);
  }

  private loop = async (): Promise<void> => {
    this.timer = undefined;
    if (this.disposed) return;
    const clients = [...this.slots.keys()].filter(client => !client.isDisposed() && client.chatHandle);
    const handles = clients.map(client => client.chatHandle!).filter(Boolean);
    const byHandle = new Map(clients.map(client => [client.chatHandle!, client]));
    if (handles.length) {
      try {
        const polls = await invoke<PoolPoll[]>("chat_poll_many", { handles });
        for (const poll of polls ?? []) {
          const client = byHandle.get(poll.handle);
          if (!client) continue;
          client.ingest(poll.records ?? []);
          if (poll.closed) client.failExternal(poll.error ?? "Runtime disconnected.");
          else client.tick();
        }
      } catch {
        // A page reload can race the pool; the next tick retries.
      }
    }
    this.timer = setTimeout(this.loop, 10);
  };

  /** The live client for `sessionPath`, when opening it needs no runtime call. */
  client(sessionPath: string): ChatConnection | undefined {
    const key = entryKey(sessionPath);
    const client = this.entries.get(key);
    if (!client) return undefined;
    if (client.isDisposed()) {
      this.entries.delete(key);
      this.unwatch(client);
      this.emitStatus();
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, client);
    this.watch(client);
    return client;
  }

  /** Whether the pooled runtime for `sessionPath` is streaming a turn. */
  isRunning(sessionPath: string): boolean {
    const client = this.entries.get(entryKey(sessionPath));
    return !!client && client.snapshot.connected && client.snapshot.projection.running;
  }

  /** Notifies only when a session starts or stops running, not on every stream event. */
  subscribeStatus(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => { this.statusListeners.delete(listener); };
  }

  private watch(client: ChatConnection): void {
    if (this.watches.has(client)) return;
    this.watches.set(client, client.subscribe(() => this.emitStatus()));
  }

  private unwatch(client: ChatConnection): void {
    this.watches.get(client)?.();
    this.watches.delete(client);
  }

  private emitStatus(): void {
    const signature = [...this.entries]
      .map(([key, client]) => `${key}:${client.snapshot.connected && client.snapshot.projection.running ? 1 : 0}`)
      .sort()
      .join("|");
    if (signature === this.statusSignature) return;
    this.statusSignature = signature;
    for (const listener of this.statusListeners) listener();
  }

  async warm(): Promise<void> {
    if (this.warming || this.disposed) return;
    this.warming = true;
    try {
      this.ensureTimer();
      const want = Math.max(0, this.target - this.idle.size);
      await Promise.all(Array.from({ length: want }, () => this.startSlot()));
    } finally {
      this.warming = false;
    }
  }

  private async startSlot(): Promise<void> {
    if (this.disposed) return;
    const scratch = await invoke<string>("chat_scratch_dir");
    const client = new ChatConnection(() => {}, () => {}, chatTransport());
    this.slots.set(client, { client, scratch });
    try {
      await client.start(scratch, true, `slot:${crypto.randomUUID()}`, true);
      if (this.disposed) { void client.close(); return; }
      this.idle.add(client);
    } catch {
      this.slots.delete(client);
      void client.close();
    }
  }

  /** Take a warm runtime for `path`; a session target switches it across cwd. */
  async lease(path: string, sessionPath?: string, dialog?: (request: WireObject, client: ChatConnection) => void, fresh = true): Promise<ChatConnection> {
    let client: ChatConnection | undefined;
    if (sessionPath) {
      for (const candidate of this.idle) { client = candidate; break; }
    }
    if (client) {
      this.idle.delete(client);
      this.slots.delete(client);
      if (dialog) client.setDialogHandler(dialog);
      client.attachView();
      await client.resumeSession(sessionPath!);
    } else {
      client = new ChatConnection(() => {}, dialog ?? (() => {}), chatTransport());
      await client.start(path, fresh && !sessionPath, `slot:${crypto.randomUUID()}`);
      if (sessionPath) await client.resumeSession(sessionPath);
    }
    void this.warm().catch(() => {});
    return client;
  }

  /** A live session client kept across view switches; LRU-bounded by maxSessions. */
  async enter(path: string, sessionPath: string, dialog?: (request: WireObject, client: ChatConnection) => void): Promise<ChatConnection> {
    // One entry per session: paths that differ only in case or separators are the
    // same session, and a second entry would mean a second runtime for it.
    const key = entryKey(sessionPath);
    const cached = this.entries.get(key);
    if (cached && !cached.isDisposed()) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      this.watch(cached);
      return cached;
    }
    if (cached) this.entries.delete(key);
    const sessionKey = `session:${key}`;
    await invoke("chat_stop_session", { sessionKey }).catch(() => {});
    let client: ChatConnection;
    try { client = await this.lease(path, sessionPath, dialog, false); }
    catch (error) {
      // An external process owns the branch. Only a cached client of ours can be
      // stopped; then retry once, because stealing another process lock is not allowed.
      if (!/already owned|busy/iu.test(String(error))) throw error;
      const cached = this.entries.get(key);
      if (!cached) throw error;
      await cached.close();
      this.entries.delete(key);
      client = await this.lease(path, sessionPath, dialog, false);
    }
    await invoke("chat_claim", { handle: client.chatHandle, sessionKey });
    this.entries.set(key, client);
    this.watch(client);
    this.emitStatus();
    while (this.entries.size > this.maxSessions) {
      const oldest = this.entries.keys().next().value as string;
      const evicted = this.entries.get(oldest);
      this.entries.delete(oldest);
      if (evicted) this.unwatch(evicted);
      void evicted?.close();
      this.emitStatus();
    }
    return client;
  }

  /** Drop a dead entry after the native owner was force-stopped. */
  forget(sessionPath: string): void {
    const key = entryKey(sessionPath);
    const client = this.entries.get(key);
    this.entries.delete(key);
    if (client) { this.unwatch(client); void client.close(); }
    this.emitStatus();
  }

  /** Keep an existing client under its session path so switching back is instant. */
  remember(sessionPath: string, client: ChatConnection): void {
    const key = entryKey(sessionPath);
    const previous = this.entries.get(key);
    if (previous && previous !== client) {
      this.unwatch(previous);
      void previous.close();
    }
    this.entries.set(key, client);
    this.watch(client);
    this.emitStatus();
    while (this.entries.size > this.maxSessions) {
      const oldest = this.entries.keys().next().value as string;
      const evicted = this.entries.get(oldest);
      this.entries.delete(oldest);
      if (evicted && evicted !== client) { this.unwatch(evicted); void evicted.close(); }
      this.emitStatus();
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const client of this.slots.keys()) void client.close();
    this.slots.clear();
    this.idle.clear();
    for (const client of this.entries.values()) this.unwatch(client);
    this.entries.clear();
    this.statusListeners.clear();
  }
}

/** One pool per window: the workspace view leases a runtime from it. */
export const chatPool = new ChatPool(4);


