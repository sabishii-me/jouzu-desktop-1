import { describe, expect, it } from "vitest";
import { opensLive, rowState, sessionRow } from "./session-open";

describe("opensLive", () => {
  it("opens a session waiting for an approval or an answer live", () => {
    expect(opensLive({ status: "waiting_approval", running: false })).toBe(true);
    expect(opensLive({ status: "waiting_question", running: false })).toBe(true);
  });

  it("opens running, starting and recovering sessions live", () => {
    expect(opensLive({ status: "running", running: true })).toBe(true);
    expect(opensLive({ status: "starting", running: false })).toBe(true);
    expect(opensLive({ status: "recovering", running: false })).toBe(true);
  });

  it("opens an idle session live when the host holds messages or a failed message for it", () => {
    expect(opensLive({ status: "idle", running: false, queued: 1 })).toBe(true);
    expect(opensLive({ status: "idle", running: false, hasFailedTurn: true })).toBe(true);
    expect(opensLive({ status: "idle", running: false, queued: 0, hasFailedTurn: false })).toBe(false);
  });

  it("opens sessions at rest from the saved file", () => {
    expect(opensLive({ status: "idle", running: false })).toBe(false);
    expect(opensLive({ status: "stopped", running: false })).toBe(false);
    expect(opensLive(undefined)).toBe(false);
  });
});

describe("sessionRow", () => {
  it("keeps what the host holds, so the row opens live", () => {
    const row = sessionRow({ sessionId: "s-1", sessionPath: "C:/w/a.jsonl", workspacePath: "C:/w", title: "Count", status: "idle", running: false, pinned: false, archived: false, queued: 1 });
    expect(row).toMatchObject({ path: "C:/w/a.jsonl", queued: 1 });
    expect(opensLive(row ?? undefined)).toBe(true);
  });
});

describe("rowState (#212)", () => {
  const base = { sessionId: "s", sessionPath: "C:/s/a.jsonl", workspacePath: "C:/w", title: "A", pinned: false, archived: false };
  const row = (extra: Record<string, unknown>) => sessionRow({ ...base, status: "idle", running: false, ...extra } as never)!;

  it("says what a running session is doing, from the host's active turn", () => {
    const turn = { turnId: "t", phase: "running", startedAt: "2026-11-21T00:00:00.000Z", step: { n: 1, state: "tools", since: "2026-11-21T00:00:01.000Z", tools: [{ id: "1", name: "bash" }] } };
    const state = rowState(row({ status: "running", running: true, activeTurn: turn }));
    expect(state).toMatchObject({ kind: "running", turn: { turnId: "t", startedAt: Date.parse("2026-11-21T00:00:00.000Z"), step: { state: "tools", since: Date.parse("2026-11-21T00:00:01.000Z"), tools: [{ id: "1", name: "bash" }] } } });
  });

  it("puts a waiting approval or question before the run", () => {
    expect(rowState(row({ status: "waiting_approval", running: true, pendingApprovalCount: 1 }))).toEqual({ kind: "waiting", on: "approval" });
    expect(rowState(row({ status: "waiting_question", running: true, pendingQuestionCount: 1 }))).toEqual({ kind: "waiting", on: "answer" });
  });

  it("shows how a run ended unseen, and nothing for a session at rest", () => {
    expect(rowState(row({ unseenRun: { outcome: "done", endedAt: "t" } }))).toEqual({ kind: "done" });
    expect(rowState(row({ unseenRun: { outcome: "failed", endedAt: "t" } }))).toEqual({ kind: "failed" });
    expect(rowState(row({}))).toBeNull();
    // A saved session the host does not hold is "stopped" in the list: at rest.
    expect(rowState(row({ status: "stopped" }))).toBeNull();
  });
});
