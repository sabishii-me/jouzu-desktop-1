import { useState } from "react";
import { Ban, Check, ChevronDown, CircleAlert, TriangleAlert } from "lucide-react";
import { ActivityStrip, type ActivityItem } from "./tool-renderers/tool-chip";
import { TurnSummary } from "./turn-summary-card";
import type { TurnSummaryData } from "./turn-summary";

export type TurnOutcome = "complete" | "failed" | "stopped" | "interrupted";

const LABELS: Record<TurnOutcome, string> = {
  complete: "Completed",
  failed: "Failed",
  stopped: "Stopped",
  interrupted: "Interrupted",
};

export function formatTurnDuration(ms?: number): string | undefined {
  if (!ms || ms < 1000) return undefined;
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function OutcomeIcon({ outcome }: { outcome: TurnOutcome }) {
  if (outcome === "failed") return <CircleAlert className="size-3.5 shrink-0 text-destructive" aria-hidden="true" />;
  if (outcome === "stopped") return <Ban className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />;
  if (outcome === "interrupted") return <TriangleAlert className="size-3.5 shrink-0 text-amber-600" aria-hidden="true" />;
  return <Check className="size-3.5 shrink-0 text-emerald-600" aria-hidden="true" />;
}

/**
 * One collapsed row per settled turn, matching the DSH turn process: the label
 * carries the outcome and duration, and the body holds the work details. The
 * turn's answer text is never placed here; only the activity and produced files.
 */
export function TurnProcess({ outcome, durationMs, activity, summary, workspace, onOpenArtifacts, defaultOpen = false }: {
  outcome: TurnOutcome;
  durationMs?: number;
  activity: ActivityItem[];
  summary: TurnSummaryData;
  workspace?: string;
  onOpenArtifacts?: () => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const duration = formatTurnDuration(durationMs);
  const toolCalls = activity.filter(item => item.kind === "tool").length;
  const hasBody = activity.length > 0 || summary.artifacts.length > 0 || summary.files.length > 0;
  const label = `${LABELS[outcome]}${duration ? ` in ${duration}` : ""}`;
  return <section aria-label="Turn process" className="border-t border-border/60 pt-1">
    <button
      type="button"
      aria-expanded={open}
      disabled={!hasBody}
      onClick={() => setOpen(value => !value)}
      className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:cursor-default"
    >
      <OutcomeIcon outcome={outcome} />
      <span className="font-medium">{label}</span>
      {toolCalls > 0 && <span aria-hidden="true">· {toolCalls} tool call{toolCalls === 1 ? "" : "s"}</span>}
      {hasBody && <ChevronDown className={`ml-auto size-3.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />}
    </button>
    {open && hasBody && <div className="mt-1 space-y-2 pl-5">
      {activity.length > 0 && <ActivityStrip items={activity} />}
      <TurnSummary data={summary} workspace={workspace} onOpenArtifacts={onOpenArtifacts} detail />
    </div>}
  </section>;
}
