import { useState } from "react";
import { ChevronDown, ChevronUp, ShieldAlert } from "lucide-react";
import { Button } from "./components/ui/button";
import { ChatMarkdown } from "./chat-markdown";

export const TEXTGUARD_NOTICE = "JOUZU_TEXTGUARD ";

export type TextGuardItem = {
  id: string;
  withheld: boolean;
  ticket: string;
  source: string;
  digest: string;
  severity: string;
  review: {
    source: string;
    digest: string;
    scanner: string;
    status: string;
    severity?: Record<string, number>;
    reason?: string;
    findings?: Array<{ kind?: string; offset?: number }>;
  };
  snapshot?: { source?: string; body?: string };
};
export type TextGuardData = { ok: true; action: "inspect"; sessionId?: string; mode: string; items: TextGuardItem[] };

export function parseTextGuardNotice(message: string): TextGuardData | null {
  if (!message.startsWith(TEXTGUARD_NOTICE)) return null;
  try {
    const value = JSON.parse(message.slice(TEXTGUARD_NOTICE.length));
    return value?.ok === true && value.action === "inspect" && Array.isArray(value.items) ? value : null;
  } catch { return null; }
}
export function parseTextGuardResult(message: string): { ok: boolean; error?: string } | null {
  if (!message.startsWith(TEXTGUARD_NOTICE)) return null;
  try { return JSON.parse(message.slice(TEXTGUARD_NOTICE.length)); } catch { return null; }
}
export function textGuardMode(mode: string | undefined): "on" | "strict" | "off" {
  return mode === "strict" ? "strict" : mode === "off" ? "off" : "on";
}

/** Some reviews snapshot a serialized message envelope. Show the text it carries, not the JSON. */
export function readableTextGuardSnapshot(body: string | undefined): string {
  if (!body) return "";
  let value: unknown;
  try { value = JSON.parse(body); } catch { return body; }
  for (let depth = 0; depth < 2; depth += 1) {
    if (typeof value === "string") { try { value = JSON.parse(value); continue; } catch { return String(value); } }
    if (value && typeof value === "object") {
      const record = value as { content?: unknown; text?: unknown };
      if (Array.isArray(record.content)) {
        const text = record.content
          .flatMap(block => block && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string" ? [(block as { text: string }).text] : [])
          .join("\n\n");
        if (text) return text;
      }
      if (typeof record.text === "string") return record.text;
    }
    return body;
  }
  return body;
}

/** Sits directly above the composer; it never opens a dialog. */
export function TextGuardBar({ data, open, busy, running, error, historical = false, onToggle, onStop, onAction }: {
  data: TextGuardData | null;
  open: boolean;
  busy: boolean;
  running: boolean;
  error: string | null;
  historical?: boolean;
  onToggle: () => void;
  onStop: () => void;
  onAction: (action: "approve" | "dismiss" | "mode", item: TextGuardItem | null, extra?: Record<string, unknown>) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const items = data?.items ?? [];
  const item = selected ? items.find(entry => entry.id === selected) : undefined;
  const withheld = items.filter(entry => entry.withheld).length;
  const clear = !!data && items.length === 0;
  const accent = clear
    ? { border: "rgba(34, 197, 94, 0.72)", background: "rgba(34, 197, 94, 0.10)", icon: "#22c55e" }
    : { border: "rgba(245, 158, 11, 0.72)", background: "rgba(245, 158, 11, 0.11)", icon: "#f59e0b" };
  const mode = textGuardMode(data?.mode);
  const pending = items.length;
  const reviewable = pending > 0 || (!data && !(historical && error));
  const modeButtons = (["on", "strict", "off"] as const).map(value => <Button key={value} variant={mode === value ? "default" : "ghost"} className="h-7 px-2 text-xs" aria-pressed={mode === value} disabled={busy} onClick={() => onAction("mode", null, { mode: value })}>{value === "on" ? "On" : value === "strict" ? "Strict" : "Off"}</Button>);
  const label = data
    ? withheld
      ? `TextGuard withheld ${withheld} item${withheld === 1 ? "" : "s"} from the model`
      : items.length
        ? `TextGuard has ${items.length} finding${items.length === 1 ? "" : "s"} to review`
        : "TextGuard completed for this session"
    : historical
      ? "TextGuard withheld content in this session"
      : "TextGuard withheld content from the model";
  const subtitle = !data
    ? running
      ? "The turn is still running. Review this content when it settles."
      : historical
      ? error
        ? "The content is still withheld. Re-run the request to create a new review."
        : "The transcript shows withheld content. Click Review to inspect this session."
      : "Click Review to inspect the current session."
    : items.length === 0
      ? "No items are waiting for a decision. You can still change the scanning mode."
      : "The content was not injected into the model. Review it before retrying.";
  return <section aria-label="TextGuard" aria-live="polite" className="mb-2 w-full rounded-xl border" style={{ borderColor: accent.border, backgroundColor: accent.background }}>
    <div className="flex items-center gap-2 px-3 py-2">
      <ShieldAlert className="size-4 shrink-0" style={{ color: accent.icon }} />
      <div className="min-w-0 flex-1"><p className="truncate text-xs font-medium">{label}</p><p className="truncate text-[11px] text-muted-foreground">{subtitle}</p></div>
      {running && pending > 0 && <Button variant="outline" className="h-7 shrink-0 px-2 text-xs" style={{ color: "#ef4444", borderColor: "rgba(239, 68, 68, 0.55)" }} onClick={onStop}>Stop turn</Button>}
      {reviewable && <Button variant="outline" className="h-7 shrink-0 px-2 text-xs" disabled={busy && !!data} onClick={onToggle}>{open ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}{open ? "Hide" : "Review"}</Button>}
    </div>
    {data && pending === 0 && <div className="flex items-center gap-1.5 border-t border-border px-3 py-1.5">
      <span className="mr-auto text-[10px] uppercase tracking-wide text-muted-foreground">Scanning mode</span>
      {modeButtons}
    </div>}
    {error && <p role="alert" className="border-t border-amber-500/20 px-3 py-1.5 text-xs text-destructive">{error}</p>}
    {open && data && pending > 0 && <div className="max-h-[38vh] overflow-y-auto border-t border-amber-500/20 px-3 py-2">
      {!item ? <>
        <div className="space-y-1.5">{items.map(entry => <div key={entry.id} className="rounded-md border border-border p-2">
          <div className="flex items-center gap-2"><ShieldAlert className={`size-3.5 shrink-0 ${entry.withheld ? "text-destructive" : "text-muted-foreground"}`} /><p className="min-w-0 flex-1 truncate text-xs font-medium" title={entry.source}>{entry.source}</p><span className="text-[10px] uppercase text-muted-foreground">{entry.withheld ? "withheld" : "report"}</span></div>
          <p className="mt-1 text-[11px] text-muted-foreground">{entry.severity} · {entry.digest.slice(0, 12)}…</p>
          <Button variant="outline" className="mt-1.5 h-7 px-2 text-xs" disabled={busy} onClick={() => setSelected(entry.id)}>Review</Button>
        </div>)}</div>
        <div className="mt-2 flex items-center gap-1.5 border-t border-border pt-2">
          <span className="mr-auto text-[10px] uppercase tracking-wide text-muted-foreground">Scanning mode</span>
          {modeButtons}
        </div>
      </> : <>
        <div className="mb-2 flex items-center gap-2"><Button variant="ghost" className="h-7 px-2 text-xs" onClick={() => setSelected(null)}>Back</Button><span className="ml-auto text-[10px] uppercase text-muted-foreground">{item.withheld ? "withheld" : "report"}</span></div>
        <dl className="grid grid-cols-[5.5rem_1fr] gap-x-2 gap-y-1 text-[11px]">
          <dt className="text-muted-foreground">Source</dt><dd className="break-all">{item.review.source}</dd>
          <dt className="text-muted-foreground">SHA-256</dt><dd className="break-all font-mono">{item.review.digest}</dd>
          <dt className="text-muted-foreground">Findings</dt><dd>{item.review.severity?.error ?? 0} error · {item.review.severity?.warn ?? 0} warning · {item.review.severity?.info ?? 0} info{item.review.reason ? ` · ${item.review.reason}` : ""}</dd>
        </dl>
        {!!item.review.findings?.length && <ul className="mt-2 space-y-1 text-xs">{item.review.findings.map((finding, index) => <li key={index} className="rounded border border-border px-2 py-1">{finding.kind ?? "finding"}{typeof finding.offset === "number" ? ` · character ${finding.offset}` : ""}</li>)}</ul>}
        {item.snapshot?.body !== undefined && <div className="mt-2 max-h-40 overflow-auto rounded border border-border bg-background p-2"><ChatMarkdown text={readableTextGuardSnapshot(item.snapshot.body)} /></div>}
        <div className="mt-2 flex flex-wrap justify-end gap-2">
          {item.withheld ? <>
            <Button variant="outline" disabled={busy} onClick={() => onAction("approve", item, { persist: false })}>Allow for this session</Button>
            <Button disabled={busy} onClick={() => onAction("approve", item, { persist: true })}>Always allow this content</Button>
          </> : <Button variant="outline" disabled={busy} onClick={() => onAction("dismiss", item)}>Dismiss report</Button>}
        </div>
      </>}
    </div>}
  </section>;
}
