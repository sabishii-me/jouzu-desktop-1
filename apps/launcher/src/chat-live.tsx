import { useState } from "react";
import { AlertTriangle, Brain, ChevronDown, LoaderCircle, Square } from "lucide-react";
import { ChatMarkdown } from "./chat-markdown";

/**
 * One turn status line above the composer. It only carries turn state
 * (reasoning / working / interrupted / failed); tools stay in the activity strip.
 */
export function AgentAction({ thinking, label, running, elapsed, settled }: {
  thinking: string;
  label: string;
  running: boolean;
  elapsed?: string;
  settled?: "interrupted" | "failed";
}) {
  const [open, setOpen] = useState(false);
  const text = thinking.trim();
  if (!running && !text && settled) {
    const Icon = settled === "failed" ? AlertTriangle : Square;
    return <div role="status" aria-live="polite" className={`flex min-h-6 items-center gap-2 px-1 py-1 text-[11px] ${settled === "failed" ? "text-destructive" : "text-muted-foreground"}`}>
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="font-medium">{settled === "failed" ? "Failed" : "Interrupted"}</span>
    </div>;
  }
  if (!running && !text) return null;
  if (!text) return <div role="status" aria-live="polite" className="flex min-h-6 items-center gap-2 px-1 py-1 text-[11px] text-muted-foreground">
    <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
    <span>{label}</span>
    {elapsed && <span className="tabular-nums">{elapsed}</span>}
  </div>;
  const last = text.split(/\r?\n/u).filter(line => line.trim()).at(-1) ?? "";
  return <div className="px-1 pb-1">
    <button type="button" className="flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-1 text-left text-[11px] text-muted-foreground hover:bg-muted/40" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <Brain className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="shrink-0 font-medium text-foreground">Reasoning</span>
      <span className="min-w-0 flex-1 truncate">{last}</span>
      <ChevronDown className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
    </button>
    {open && <div className="max-h-40 overflow-auto rounded-md border border-border bg-background px-3 py-2 text-xs"><ChatMarkdown text={text} /></div>}
  </div>;
}
