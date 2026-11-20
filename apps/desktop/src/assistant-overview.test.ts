import { describe, expect, it } from "vitest";
import { projectItems } from "./assistant-overview";
import type { SessionRow } from "./session-open";

const row = (path: string, title: string, extra: Partial<SessionRow> = {}): SessionRow => ({ path, title, workspace: "C:/w", updated: 1, pinned: false, archived: false, running: false, status: "idle", ...extra });

describe("projectItems", () => {
  it("lists a project's sessions and tasks once each, by what the session list knows now", () => {
    const rows = [row("C:/s/a.jsonl", "Plan the release"), row("C:/s/b.jsonl", "Fix #87", { task: { taskId: "task-1", clientId: "assistant" } })];
    const snapshot = { projects: [], sessions: [{ sessionId: "a", sessionPath: "c:/s/A.jsonl", title: "old title" }, { sessionId: "b", sessionPath: "C:/s/b.jsonl" }] };
    const project = { id: "p", name: "1.1.5", description: "", workspaceIds: [], sessionIds: ["a", "b"], taskIds: ["task-1", "task-2"] };
    const items = projectItems(project, snapshot, rows);
    expect(items.map(item => item.title)).toEqual(["Plan the release", "Fix #87", "task-2"]);
    expect(items[1].row?.task?.taskId).toBe("task-1");
    expect(items[2].path).toBeUndefined();
  });
});
