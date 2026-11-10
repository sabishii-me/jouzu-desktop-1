import { expect, test } from "vitest";
import { ChatConnection } from "./chat-connection";
import { ChatPool } from "./chat-pool";

function running(path: string): ChatConnection {
  const client = new ChatConnection(() => {}, () => {});
  client.snapshot = {
    ...client.snapshot,
    connected: true,
    sessionFile: path,
    projection: { ...client.snapshot.projection, running: true },
  };
  return client;
}

test("a remembered running session stays live and is reported by path", () => {
  const pool = new ChatPool(4);
  const client = running("C:/sessions/alpha.jsonl");
  let notifications = 0;
  pool.subscribeStatus(() => { notifications += 1; });

  pool.remember("C:/sessions/alpha.jsonl", client);

  expect(notifications).toBeGreaterThan(0);
  expect(pool.isRunning("C:/sessions/alpha.jsonl")).toBe(true);
  // The list compares paths as the workspace does: separators and case do not matter.
  expect(pool.isRunning("c:/sessions/ALPHA.jsonl")).toBe(true);
  expect(pool.isRunning("C:/sessions/beta.jsonl")).toBe(false);
  // Remembering must not stop the runtime of a session that is still working.
  expect(client.isDisposed()).toBe(false);
});

test("settling a turn clears the running mark without closing the runtime", () => {
  const pool = new ChatPool(4);
  const client = running("C:/sessions/alpha.jsonl");
  const statuses: boolean[] = [];
  pool.subscribeStatus(() => statuses.push(pool.isRunning("C:/sessions/alpha.jsonl")));
  pool.remember("C:/sessions/alpha.jsonl", client);

  client.ingest([{ type: "agent_settled" }]);

  expect(pool.isRunning("C:/sessions/alpha.jsonl")).toBe(false);
  expect(statuses.at(-1)).toBe(false);
  expect(client.isDisposed()).toBe(false);
});

test("one entry per session even when the path case differs", () => {
  const pool = new ChatPool(4);
  const first = running("C:/sessions/alpha.jsonl");
  pool.remember("C:/sessions/alpha.jsonl", first);

  const second = new ChatConnection(() => {}, () => {});
  second.snapshot = { ...second.snapshot, connected: true, sessionFile: "c:/sessions/ALPHA.jsonl" };
  pool.remember("c:/sessions/ALPHA.jsonl", second);

  // A second entry for the same session would be a second runtime for it.
  expect(pool.client("C:/sessions/alpha.jsonl")).toBe(second);
  expect(pool.isRunning("C:/sessions/alpha.jsonl")).toBe(false);
  expect(first.isDisposed()).toBe(true);
  expect(second.isDisposed()).toBe(false);
});
