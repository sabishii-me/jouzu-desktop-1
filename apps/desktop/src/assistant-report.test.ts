import { describe, expect, it } from "vitest";
import { reportText } from "./assistant-workspace";
import { chatTexts } from "./chat-text";

describe("engine reports in the Assistant pane", () => {
  const at = "2026-11-22T00:00:00.000Z";
  it("words the engine's facts in the user's language", () => {
    const waiting = { at, kind: "report", text: "Run run-1 (issue-loop) waits for you at approve-plan: Approve?", report: { type: "waiting" as const, runId: "run-1", graphId: "issue-loop", node: "approve-plan", ask: "Approve?" } };
    expect(reportText(chatTexts.en, waiting)).toBe("Run issue-loop waits for you at approve-plan: Approve?");
    expect(reportText(chatTexts.ja, waiting)).toBe("実行 issue-loop が approve-plan で待っています: Approve?");
    const step = { at, kind: "report", text: "x", report: { type: "step" as const, runId: "run-1", graphId: "g", node: "fix", result: "undelivered", n: 2 } };
    expect(reportText(chatTexts["zh-Hans"], step)).toBe("运行 g：fix 没有交付（第 2 次）");
    const ended = { at, kind: "report", text: "x", report: { type: "ended" as const, runId: "run-1", graphId: "g", state: "stopped" } };
    expect(reportText(chatTexts.en, ended)).toBe("Run g: stopped");
  });
  it("keeps the host's words for facts it does not know", () => {
    const unknown = { at, kind: "report", text: "Run run-1 (g) interrupted.", report: { type: "step" as const, runId: "run-1", graphId: "g", node: "test", result: "interrupted", n: 1 } };
    expect(reportText(chatTexts.en, unknown)).toBe("Run run-1 (g) interrupted.");
    expect(reportText(chatTexts.en, { at, kind: "report", text: "plain" })).toBe("plain");
  });
});
