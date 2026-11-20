import { CircleCheck, CircleStop, CircleX, Hand, LoaderCircle } from "lucide-react";
import { turnLabel } from "./chat-live";
import type { ChatText } from "./chat-text";
import type { RowState } from "./session-open";

const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

/**
 * The line under a session-list row's title (#212): what the session is doing,
 * in the same words as the status line of the session in view, or how its last
 * run ended while nobody looked. One line, never wrapped.
 */
export function SessionRowStatus({ state, now, t }: { state: RowState; now: number; t: ChatText }) {
  const line = "flex min-w-0 items-center gap-1 text-[11px] leading-4";
  switch (state.kind) {
    case "running": {
      const turn = state.turn;
      const elapsed = turn?.startedAt ? ` · ${clock(Math.max(0, now - turn.startedAt))}` : "";
      const text = `${turn ? turnLabel(turn, now, t) : t.running}${elapsed}`;
      return <span data-session-state="running" data-session-running className={`${line} text-primary`} title={text}>
        <LoaderCircle className="size-3 shrink-0 animate-spin" aria-hidden="true" /><span className="truncate tabular-nums">{text}</span>
      </span>;
    }
    case "waiting": {
      const text = state.on === "approval" ? t.sessionWaitingApproval : t.sessionWaitingAnswer;
      return <span data-session-state="waiting" className={`${line} text-amber-700 dark:text-amber-300`} title={text}>
        <Hand className="size-3 shrink-0" aria-hidden="true" /><span className="truncate">{text}</span>
      </span>;
    }
    case "failed":
      return <span data-session-state="failed" className={`${line} text-destructive`}>
        <CircleX className="size-3 shrink-0" aria-hidden="true" /><span className="truncate">{t.sessionFailed}</span>
      </span>;
    case "stopped":
      return <span data-session-state="stopped" className={`${line} text-muted-foreground`}>
        <CircleStop className="size-3 shrink-0" aria-hidden="true" /><span className="truncate">{t.sessionStopped}</span>
      </span>;
    case "done":
      return <span data-session-state="done" className={`${line} text-emerald-700 dark:text-emerald-400`}>
        <CircleCheck className="size-3 shrink-0" aria-hidden="true" /><span className="truncate">{t.sessionFinished}</span>
      </span>;
  }
}
