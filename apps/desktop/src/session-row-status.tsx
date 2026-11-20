import type React from "react";
import { CircleCheck, CircleStop, CircleX, Hand, LoaderCircle } from "lucide-react";
import { turnLabel } from "./chat-live";
import type { ChatText } from "./chat-text";
import type { RowState } from "./session-open";

const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

/** The words for a row's state: the same as the status line of the session in view. */
export function rowStateText(state: RowState, now: number, t: ChatText): string {
  switch (state.kind) {
    case "running": {
      const turn = state.turn;
      const elapsed = turn?.startedAt ? ` · ${clock(Math.max(0, now - turn.startedAt))}` : "";
      return `${turn ? turnLabel(turn, now, t) : t.running}${elapsed}`;
    }
    case "waiting": return state.on === "approval" ? t.sessionWaitingApproval : t.sessionWaitingAnswer;
    case "failed": return t.sessionFailed;
    case "stopped": return t.sessionStopped;
    case "done": return t.sessionFinished;
  }
}

const ICONS: Record<RowState["kind"], { tone: string; icon: (className: string) => React.ReactNode }> = {
  running: { tone: "text-primary", icon: className => <LoaderCircle className={`${className} animate-spin`} aria-hidden="true" /> },
  waiting: { tone: "text-amber-700 dark:text-amber-300", icon: className => <Hand className={className} aria-hidden="true" /> },
  failed: { tone: "text-destructive", icon: className => <CircleX className={className} aria-hidden="true" /> },
  stopped: { tone: "text-muted-foreground", icon: className => <CircleStop className={className} aria-hidden="true" /> },
  done: { tone: "text-emerald-700 dark:text-emerald-400", icon: className => <CircleCheck className={className} aria-hidden="true" /> },
};

/**
 * The icon at the start of a session-list row (#212), in place of the plain
 * conversation icon: what the session is doing, or how its last run ended while
 * nobody looked. Its words are its tooltip; screen readers get them after the
 * title (`rowStateText`), so the row's name still starts with the title.
 */
export function SessionRowStatus({ state, now, t }: { state: RowState; now: number; t: ChatText }) {
  const { tone, icon } = ICONS[state.kind];
  return <span title={rowStateText(state, now, t)} data-session-state={state.kind} data-session-running={state.kind === "running" ? "" : undefined} className={`flex shrink-0 items-center ${tone}`}>{icon("size-3.5")}</span>;
}
