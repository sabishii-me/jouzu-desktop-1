import type React from "react";
import { CircleCheck, CircleStop, CircleX, Hand, LoaderCircle } from "lucide-react";
import { turnLabel } from "./chat-live";
import type { ChatText } from "./chat-text";
import type { RowState } from "./session-open";

const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

/**
 * The mark beside a session-list row's title (#212): what the session is doing,
 * or how its last run ended while nobody looked. Only an icon; its words (the
 * same as the status line of the session in view) are its label and tooltip.
 */
export function SessionRowStatus({ state, now, t }: { state: RowState; now: number; t: ChatText }) {
  const mark = (kind: string, text: string, tone: string, icon: React.ReactNode, extra?: Record<string, unknown>) =>
    <span role="img" aria-label={text} title={text} data-session-state={kind} {...extra} className={`flex shrink-0 items-center ${tone}`}>{icon}</span>;
  const size = "size-3.5";
  switch (state.kind) {
    case "running": {
      const turn = state.turn;
      const elapsed = turn?.startedAt ? ` · ${clock(Math.max(0, now - turn.startedAt))}` : "";
      const text = `${turn ? turnLabel(turn, now, t) : t.running}${elapsed}`;
      return mark("running", text, "text-primary", <LoaderCircle className={`${size} animate-spin`} aria-hidden="true" />, { "data-session-running": "" });
    }
    case "waiting":
      return mark("waiting", state.on === "approval" ? t.sessionWaitingApproval : t.sessionWaitingAnswer, "text-amber-700 dark:text-amber-300", <Hand className={size} aria-hidden="true" />);
    case "failed":
      return mark("failed", t.sessionFailed, "text-destructive", <CircleX className={size} aria-hidden="true" />);
    case "stopped":
      return mark("stopped", t.sessionStopped, "text-muted-foreground", <CircleStop className={size} aria-hidden="true" />);
    case "done":
      return mark("done", t.sessionFinished, "text-emerald-700 dark:text-emerald-400", <CircleCheck className={size} aria-hidden="true" />);
  }
}
