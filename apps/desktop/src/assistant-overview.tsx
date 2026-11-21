import { MessageSquare } from "lucide-react";
import { useChatText } from "./chat-text";
import type { RowState, SessionRow } from "./session-open";
import { SessionRowStatus, SessionTaskMark, startedBy } from "./session-row-status";

/** A session as the overview lists it: what it is and how to open it. */
export interface OverviewItem { key: string; title: string; path?: string; row?: SessionRow }

function Item({ item, state, now, onOpen }: { item: OverviewItem; state?: RowState; now: number; onOpen: (path: string) => void }) {
  const t = useChatText();
  const by = startedBy(item.row?.task, t);
  const icon = state ? <SessionRowStatus state={state} now={now} t={t} by={by} /> : by ? <SessionTaskMark by={by} /> : <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />;
  return <li>
    <button type="button" disabled={!item.path} onClick={() => item.path && onOpen(item.path)} className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent">
      {icon}<span className="min-w-0 flex-1 truncate">{item.title}</span>
    </button>
  </li>;
}

/**
 * The top of the Assistant's pane: the tasks waiting for the person. Projects
 * are not shown here for now; what to show is decided later.
 */
export function AssistantOverview({ rows, states, now, onOpen }: { rows: SessionRow[]; states: Map<string, RowState>; now: number; onOpen: (path: string) => void }) {
  const t = useChatText();
  const waiting = rows.filter(row => startedBy(row.task, t) && states.get(row.path)?.kind === "waiting");
  if (!waiting.length) return null;
  return <div className="mx-auto w-full max-w-3xl shrink-0 space-y-3 overflow-y-auto px-4 pt-3" style={{ maxHeight: "40%" }}>
    <section aria-label={t.assistantNeedsYou} className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-2">
      <h2 className="px-2 pb-1 text-xs font-medium text-amber-800 dark:text-amber-300">{t.assistantNeedsYou}</h2>
      <ul>{waiting.map(row => <Item key={row.path} item={{ key: row.path, title: row.title, path: row.path, row }} state={states.get(row.path)} now={now} onOpen={onOpen} />)}</ul>
    </section>
  </div>;
}
