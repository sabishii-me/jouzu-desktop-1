import type { SessionSummary, UnseenRun } from "./api/jouzu-api";
import type { ActiveTurn } from "./chat-types";

/**
 * A session the host is working on, or holds something for, must be opened
 * live, through the host: its partial reply, its approval or question, its Stop,
 * the messages it holds (waiting, or returned by Stop) and a failed message to
 * retry exist only there. Reading the saved file instead would show none of them
 * and leave the user with nothing to answer. Sessions at rest open from the file.
 */
const ACTIVE = new Set(["starting", "running", "waiting_approval", "waiting_question", "recovering"]);

export function opensLive(summary: Pick<SessionSummary, "status" | "running" | "queued" | "hasFailedTurn"> | undefined): boolean {
  return !!summary && (summary.running || ACTIVE.has(summary.status) || (summary.queued ?? 0) > 0 || summary.hasFailedTurn === true);
}

/** A session as the session list shows it, with what decides how it opens. */
export interface SessionRow {
  path: string;
  title: string;
  workspace: string;
  updated: number;
  pinned: boolean;
  archived: boolean;
  running: boolean;
  status: string;
  queued?: number;
  hasFailedTurn?: boolean;
  /** What the running turn is doing now, as the host reports it. */
  activeTurn?: ActiveTurn | null;
  /** An approval or a question waits for the person. */
  waiting?: "approval" | "answer";
  /** A run that ended while no client showed it, until one does (#212). */
  unseenRun?: UnseenRun | null;
}

/** The list row for a host session entry, or null for one that is not listed. */
export function sessionRow(value: SessionSummary): SessionRow | null {
  if (!value.sessionPath) return null;
  const title = value.title?.trim() ?? "";
  const fileId = value.sessionPath.split(/[\\/]/u).at(-1)?.replace(/\.jsonl$/u, "") ?? "";
  // Empty page-load sessions can come back from the persisted index with the
  // file id as a title. That is not a user-facing title.
  if (!title || title === fileId) return null;
  const parsed = value.updatedAt ? Date.parse(value.updatedAt) : NaN;
  const updated = Number.isFinite(parsed) && parsed > 0 ? parsed / 1000 : Date.now() / 1000;
  return {
    path: value.sessionPath,
    title,
    workspace: value.workspacePath,
    updated,
    pinned: value.pinned,
    archived: value.archived,
    running: value.running,
    status: value.status,
    queued: value.queued,
    hasFailedTurn: value.hasFailedTurn,
    activeTurn: value.activeTurn ?? null,
    waiting: (value.pendingApprovalCount ?? 0) > 0 || value.status === "waiting_approval" ? "approval"
      : (value.pendingQuestionCount ?? 0) > 0 || value.status === "waiting_question" ? "answer" : undefined,
    unseenRun: value.unseenRun ?? null,
  };
}

/**
 * What a session-list row says about its session (#212), from the host's record:
 * what it is doing now, or how a run ended that nobody has looked at since.
 * `null` for a session at rest, which shows its age only.
 */
export type RowState =
  | { kind: "running"; turn: ActiveTurn | null }
  | { kind: "waiting"; on: "approval" | "answer" }
  | { kind: "failed" | "done" | "stopped" };

export function rowState(row: Pick<SessionRow, "running" | "status" | "activeTurn" | "waiting" | "unseenRun">): RowState | null {
  if (row.waiting) return { kind: "waiting", on: row.waiting };
  if (row.running || row.status === "running" || row.status === "starting" || row.status === "recovering") return { kind: "running", turn: row.activeTurn ?? null };
  if (row.status === "error") return { kind: "failed" };
  if (row.unseenRun) return { kind: row.unseenRun.outcome };
  return null;
}
