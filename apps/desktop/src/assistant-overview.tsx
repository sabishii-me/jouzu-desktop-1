import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, FolderKanban, MessageSquare } from "lucide-react";
import { useApi } from "./api/context";
import type { Project, ProjectsSnapshot } from "./api/jouzu-api";
import { useChatText } from "./chat-text";
import { eventRouter } from "./event-router";
import type { RowState, SessionRow } from "./session-open";
import { SessionRowStatus, SessionTaskMark, startedBy } from "./session-row-status";

/** A session as the overview lists it: what it is and how to open it. */
export interface OverviewItem { key: string; title: string; path?: string; row?: SessionRow }

/**
 * The project's sessions and tasks, as the session list knows them now. A
 * session is linked by its file id; a task by its id, through the session it
 * runs in. A task that has no session yet is listed by its id.
 */
export function projectItems(project: Project, snapshot: ProjectsSnapshot, rows: SessionRow[]): OverviewItem[] {
  const byPath = new Map(rows.map(row => [row.path.toLowerCase(), row]));
  const items: OverviewItem[] = [];
  const seen = new Set<string>();
  for (const id of project.sessionIds) {
    const known = snapshot.sessions.find(session => session.sessionId === id);
    const row = known?.sessionPath ? byPath.get(known.sessionPath.toLowerCase()) : undefined;
    const key = (row?.path ?? known?.sessionPath ?? id).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ key, title: row?.title ?? known?.title ?? id, path: row?.path ?? known?.sessionPath, row });
  }
  for (const id of project.taskIds) {
    const row = rows.find(candidate => candidate.task?.taskId === id);
    const key = (row?.path ?? id).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ key, title: row?.title ?? id, path: row?.path, row });
  }
  return items;
}

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
 * The top of the Assistant's pane: the tasks waiting for the person, then the
 * person's projects with their sessions and tasks. Everything is the host's
 * state as it stands; it is read again whenever the host says it changed.
 */
export function AssistantOverview({ rows, states, now, onOpen }: { rows: SessionRow[]; states: Map<string, RowState>; now: number; onOpen: (path: string) => void }) {
  const api = useApi();
  const t = useChatText();
  const [snapshot, setSnapshot] = useState<ProjectsSnapshot | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    const load = () => void api.settings.assistant.projects().then(value => { if (current) setSnapshot(value); }, () => {});
    load();
    const stop = eventRouter.subscribe(event => { if (event.event === "project.changed" || event.event === "task.changed") load(); });
    return () => { current = false; stop(); };
  }, [api]);

  const waiting = rows.filter(row => startedBy(row.task, t) && states.get(row.path)?.kind === "waiting");
  const projects = snapshot?.projects ?? [];
  if (!waiting.length && !projects.length) return null;
  return <div className="mx-auto w-full max-w-3xl shrink-0 space-y-3 overflow-y-auto px-4 pt-3" style={{ maxHeight: "40%" }}>
    {waiting.length > 0 && <section aria-label={t.assistantNeedsYou} className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-2">
      <h2 className="px-2 pb-1 text-xs font-medium text-amber-800 dark:text-amber-300">{t.assistantNeedsYou}</h2>
      <ul>{waiting.map(row => <Item key={row.path} item={{ key: row.path, title: row.title, path: row.path, row }} state={states.get(row.path)} now={now} onOpen={onOpen} />)}</ul>
    </section>}
    {projects.length > 0 && <section aria-label={t.assistantProjects}>
      <h2 className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t.assistantProjects}</h2>
      <ul className="space-y-0.5">{projects.map(project => {
        const expanded = open === project.id;
        const items = expanded && snapshot ? projectItems(project, snapshot, rows) : [];
        return <li key={project.id}>
          <button type="button" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : project.id)} className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-muted">
            {expanded ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
            <FolderKanban className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="shrink-0 font-medium">{project.name}</span>
            {project.description && <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{project.description.split("\n")[0]}</span>}
          </button>
          {expanded && <div className="ml-6 border-l border-border pl-1.5">
            {items.length ? <ul>{items.map(item => <Item key={item.key} item={item} state={item.path ? states.get(item.path) : undefined} now={now} onOpen={onOpen} />)}</ul>
              : <p className="px-2 py-1 text-xs text-muted-foreground">{t.assistantProjectEmpty}</p>}
          </div>}
        </li>;
      })}</ul>
    </section>}
  </div>;
}
