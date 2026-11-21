import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { CalendarDays, ChartNoAxesColumn, CircleCheck, CircleDashed, CircleQuestionMark, CircleStop, CircleX, Clock, Code, Hand, LayoutGrid, LoaderCircle, Network, Table2 } from "lucide-react";
import { fill, useChatText, type ChatText } from "./chat-text";
import { layoutGraph, parseView, progressCounts, timelineOrder, timelineWhen, type ProgressGroup, type TaskView, type ViewProblem } from "./task-views-model";

/** A task as a view shows it: its live title and state, and how to open it. */
export interface ViewTask { taskId: string; title?: string; state?: string; sessionPath?: string }

/** What the pane knows about tasks now. Views read it each time they draw. */
export interface TaskLookup { task(taskId: string): ViewTask | undefined; open(sessionPath: string): void }

const TaskLookupContext = createContext<TaskLookup>({ task: () => undefined, open: () => {} });
export const TaskLookupProvider = TaskLookupContext.Provider;

function stateText(state: string | undefined, t: ChatText): string {
  switch (state) {
    case "waiting_to_start": return t.taskWaitingToStart;
    case "starting": return t.taskStarting;
    case "running": return t.taskRunning;
    case "waiting_user": return t.taskWaitingUser;
    case "held": return t.taskHeld;
    case "finished": return t.taskFinished;
    case "failed": return t.taskFailed;
    case "stopped": return t.taskStopped;
    case "unloaded": return t.taskUnloaded;
    default: return t.taskUnknown;
  }
}

function StateIcon({ state }: { state: string | undefined }) {
  const className = "size-3.5 shrink-0";
  switch (state) {
    case "waiting_to_start": return <Clock className={`${className} text-muted-foreground`} aria-hidden="true" />;
    case "starting": case "running": return <LoaderCircle className={`${className} animate-spin text-primary`} aria-hidden="true" />;
    case "waiting_user": case "held": return <Hand className={`${className} text-amber-700 dark:text-amber-300`} aria-hidden="true" />;
    case "finished": return <CircleCheck className={`${className} text-emerald-700 dark:text-emerald-400`} aria-hidden="true" />;
    case "failed": return <CircleX className={`${className} text-destructive`} aria-hidden="true" />;
    case "stopped": return <CircleStop className={`${className} text-muted-foreground`} aria-hidden="true" />;
    case "unloaded": return <CircleDashed className={`${className} text-muted-foreground`} aria-hidden="true" />;
    default: return <CircleQuestionMark className={`${className} text-muted-foreground`} aria-hidden="true" />;
  }
}

/** One task, live: state icon and title; opens its session when it has one. */
function TaskChip({ taskId, label, wide, whole }: { taskId: string; label?: string; wide?: boolean; whole?: boolean }) {
  const t = useChatText();
  const lookup = useContext(TaskLookupContext);
  const task = lookup.task(taskId);
  const state = task ? task.state : undefined;
  const words = stateText(task ? state : "unknown", t);
  const name = label ?? task?.title ?? taskId;
  const path = task?.sessionPath;
  const body = <><StateIcon state={task ? state : "unknown"} /><span className={whole ? "whitespace-nowrap" : "min-w-0 flex-1 truncate"}>{name}</span>{wide && <span className="shrink-0 text-xs text-muted-foreground">{words}</span>}</>;
  const className = "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-sm";
  return path
    ? <button type="button" title={`${name} · ${words}`} data-task-state={state ?? "unknown"} className={`${className} hover:bg-muted`} onClick={() => lookup.open(path)}>{body}</button>
    : <span title={`${name} · ${words}`} data-task-state={task ? state ?? "unknown" : "unknown"} className={className}>{body}</span>;
}

function Board({ view }: { view: Extract<TaskView, { view: "board" }> }) {
  const t = useChatText();
  return <div className="flex gap-3 overflow-x-auto pb-1">
    {view.columns.map((column, index) => <section key={index} aria-label={column.title} className="min-w-52 flex-1 rounded-lg border border-border bg-muted/40 p-2">
      <h3 className="flex items-center justify-between px-2 pb-1 text-xs font-medium text-muted-foreground"><span className="truncate">{column.title}</span><span>{column.taskIds.length}</span></h3>
      {column.taskIds.length ? <ul className="space-y-1">{column.taskIds.map(id => <li key={id} className="rounded-md bg-background"><TaskChip taskId={id} /></li>)}</ul>
        : <p className="px-2 py-1 text-xs text-muted-foreground">{t.viewEmpty}</p>}
    </section>)}
  </div>;
}

function TableView({ view }: { view: Extract<TaskView, { view: "table" }> }) {
  const t = useChatText();
  const lookup = useContext(TaskLookupContext);
  const withState = view.rows.some(row => row.taskId);
  return <div className="overflow-x-auto">
    <table className="!table w-full border-collapse text-sm">
      <thead><tr>{view.columns.map((column, index) => <th key={index} scope="col" className="!border-x-0 !border-t-0 border-b border-border !px-2 py-1 text-left text-xs font-medium text-muted-foreground">{column}</th>)}
        {withState && <th scope="col" className="!border-x-0 !border-t-0 border-b border-border !px-2 py-1 text-left text-xs font-medium text-muted-foreground">{t.viewState}</th>}</tr></thead>
      <tbody>{view.rows.map((row, index) => {
        const task = row.taskId ? lookup.task(row.taskId) : undefined;
        return <tr key={index} className="align-top">
          {view.columns.map((_, cell) => <td key={cell} className="!border-x-0 !border-t-0 border-b border-border !px-2 py-1">{row.cells[cell] ?? ""}</td>)}
          {withState && <td className="!border-x-0 !border-t-0 border-b border-border !px-1 py-0.5">{row.taskId ? <TaskChip taskId={row.taskId} label={stateText(row.taskId && task ? task.state : "unknown", t)} whole /> : null}</td>}
        </tr>;
      })}</tbody>
    </table>
  </div>;
}

const NODE = { width: 176, height: 48, gapX: 48, gapY: 16 };

function Graph({ view }: { view: Extract<TaskView, { view: "graph" }> }) {
  const placed = useMemo(() => layoutGraph(view.nodes, view.edges), [view]);
  const at = (id: string) => {
    const spot = placed.get(id) ?? { layer: 0, row: 0 };
    return { x: spot.layer * (NODE.width + NODE.gapX), y: spot.row * (NODE.height + NODE.gapY) };
  };
  const width = Math.max(...[...placed.values()].map(spot => spot.layer), 0) * (NODE.width + NODE.gapX) + NODE.width;
  const height = Math.max(...[...placed.values()].map(spot => spot.row), 0) * (NODE.height + NODE.gapY) + NODE.height;
  return <div className="overflow-x-auto pb-1">
    <div className="relative" style={{ width, height }}>
      <svg aria-hidden="true" className="absolute inset-0 text-muted-foreground" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <defs><marker id="jouzu-view-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" fill="currentColor" /></marker></defs>
        {view.edges.map((edge, index) => {
          const from = at(edge.from);
          const to = at(edge.to);
          const x1 = from.x + NODE.width;
          const y1 = from.y + NODE.height / 2;
          const x2 = to.x;
          const y2 = to.y + NODE.height / 2;
          const bend = Math.max(24, Math.abs(x2 - x1) / 2);
          // An edge back (a cycle, or within a layer) leaves from the far side.
          const d = x2 > x1 ? `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}` : `M${from.x},${y1} C${from.x - 32},${y1} ${x2 - 32},${y2} ${x2},${y2}`;
          return <path key={index} d={d} fill="none" stroke="currentColor" strokeWidth="1.5" markerEnd="url(#jouzu-view-arrow)" />;
        })}
      </svg>
      {view.nodes.map(node => {
        const spot = at(node.id);
        return <div key={node.id} data-graph-node={node.id} className="absolute flex items-center rounded-lg border border-border bg-card px-1 shadow-sm" style={{ left: spot.x, top: spot.y, width: NODE.width, height: NODE.height }}>
          {node.taskId ? <TaskChip taskId={node.taskId} label={node.label} /> : <span title={node.label} className="min-w-0 truncate px-2 text-sm">{node.label}</span>}
        </div>;
      })}
    </div>
  </div>;
}

function Timeline({ view }: { view: Extract<TaskView, { view: "timeline" }> }) {
  return <ol className="relative ml-2 border-l border-border">
    {timelineOrder(view.items).map((item, index) => <li key={index} className="relative flex min-w-0 items-start gap-3 py-1 pl-4">
      <span aria-hidden="true" className="absolute -left-[5px] top-3 size-2.5 rounded-full border-2 border-background bg-primary" />
      <time className="shrink-0 whitespace-nowrap pt-1 text-xs tabular-nums text-muted-foreground" dateTime={item.at} title={item.at}>{timelineWhen(item.at, document.documentElement.lang || undefined)}</time>
      <div className="min-w-0 flex-1">{item.taskId ? <TaskChip taskId={item.taskId} label={item.label} wide /> : <p className="flex items-center gap-2 px-2 py-1 text-sm"><span aria-hidden="true" className="size-3.5 shrink-0" />{item.label}</p>}</div>
    </li>)}
  </ol>;
}

const GROUP_TONE: Record<ProgressGroup, string> = {
  done: "bg-emerald-600 dark:bg-emerald-500",
  ended: "bg-destructive",
  needsYou: "bg-amber-500",
  underWay: "bg-primary",
  unknown: "bg-muted-foreground/40",
};

function Progress({ view }: { view: Extract<TaskView, { view: "progress" }> }) {
  const t = useChatText();
  const lookup = useContext(TaskLookupContext);
  const counts = progressCounts(view.taskIds.map(id => lookup.task(id)?.state));
  const total = view.taskIds.length;
  const groups = (["done", "ended", "needsYou", "underWay", "unknown"] as const).filter(group => counts[group] > 0);
  const words: Record<ProgressGroup, string> = { done: t.viewDone, ended: t.viewEnded, needsYou: t.viewNeedsYou, underWay: t.viewUnderWay, unknown: t.viewUnknownTasks };
  return <div className="space-y-2">
    <p className="text-sm font-medium" data-progress-done={counts.done} data-progress-total={total}>{fill(t.viewProgress, { done: counts.done, total })}</p>
    <div role="img" aria-label={groups.map(group => `${words[group]} ${counts[group]}`).join(", ")} className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-muted">
      {groups.map(group => <span key={group} className={GROUP_TONE[group]} style={{ width: `${(counts[group] / Math.max(total, 1)) * 100}%` }} />)}
    </div>
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {groups.map(group => <li key={group} className="flex items-center gap-1.5"><span aria-hidden="true" className={`size-2 rounded-full ${GROUP_TONE[group]}`} />{words[group]} {counts[group]}</li>)}
    </ul>
  </div>;
}

const KIND_ICON = { board: LayoutGrid, table: Table2, graph: Network, timeline: CalendarDays, progress: ChartNoAxesColumn } as const;

function problemText(problem: ViewProblem, t: ChatText): string {
  switch (problem.kind) {
    case "json": return fill(t.viewBadJson, { detail: problem.detail });
    case "unknown": return fill(t.viewUnknownKind, { view: problem.view });
    case "field": return fill(t.viewBadField, { field: problem.field });
  }
}

/** A frame around a drawn block: what it is, its title, and its source on request. */
function Frame({ kind, title, source, children }: { kind: string; title?: string; source: string; children: ReactNode }) {
  const t = useChatText();
  const [showSource, setShowSource] = useState(false);
  const Icon = kind in KIND_ICON ? KIND_ICON[kind as keyof typeof KIND_ICON] : Code;
  // The message's markdown styles (list bullets, paragraph margins, cell
  // borders) are for text; a view lays itself out.
  return <figure data-jouzu-view={kind} className="my-3 min-w-0 overflow-hidden rounded-lg border border-border bg-card leading-normal [&_ol]:!list-none [&_ol]:!pl-0 [&_p]:!my-0 [&_ul]:!list-none [&_ul]:!pl-0">
    <figcaption className="flex items-center gap-2 border-b border-border bg-muted px-3 py-1.5 text-xs">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate font-medium">{title ?? ""}</span>
      <button type="button" className="shrink-0 text-muted-foreground hover:text-foreground" aria-expanded={showSource} onClick={() => setShowSource(value => !value)}>{showSource ? t.viewHideSource : t.viewShowSource}</button>
    </figcaption>
    <div className="p-3">{children}</div>
    {showSource && <pre className="max-h-64 overflow-auto border-t border-border bg-background p-3 text-xs">{source}</pre>}
  </figure>;
}

/** A `jouzu-view` block, drawn; one that cannot be read says why, with its source. */
export function JouzuView({ source }: { source: string }) {
  const t = useChatText();
  const parsed = useMemo(() => parseView(source), [source]);
  if (!parsed.ok) {
    return <figure data-jouzu-view="invalid" role="alert" className="my-3 overflow-hidden rounded-lg border border-destructive/50">
      <figcaption className="border-b border-destructive/30 bg-destructive/5 px-3 py-1.5 text-xs text-destructive">{fill(t.viewInvalid, { reason: problemText(parsed.problem, t) })}</figcaption>
      <pre className="max-h-64 overflow-auto bg-background p-3 text-xs">{source}</pre>
    </figure>;
  }
  const view = parsed.view;
  return <Frame kind={view.view} title={view.title} source={source}>
    {view.view === "board" ? <Board view={view} />
      : view.view === "table" ? <TableView view={view} />
        : view.view === "graph" ? <Graph view={view} />
          : view.view === "timeline" ? <Timeline view={view} />
            : <Progress view={view} />}
  </Frame>;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const DROPPED = new Set(["script", "foreignobject", "iframe", "object", "embed", "image", "audio", "video", "a", "animate", "set", "animatemotion", "animatetransform"]);

/**
 * The Assistant's SVG with what the skill forbids taken out: scripts,
 * foreignObject, event handlers, links and references outside the drawing,
 * images and CSS imports. Fixed width and height go, so it fits its frame.
 * Null when the text is not an SVG drawing.
 */
export function cleanSvg(source: string): string | null {
  if (typeof DOMParser === "undefined") return null;
  const document = new DOMParser().parseFromString(source, "image/svg+xml");
  const root = document.documentElement;
  if (!root || root.namespaceURI !== SVG_NS || root.localName !== "svg" || document.getElementsByTagName("parsererror").length) return null;
  const walk = (element: Element) => {
    for (const child of [...element.children]) {
      if (child.namespaceURI !== SVG_NS || DROPPED.has(child.localName.toLowerCase())) { child.remove(); continue; }
      walk(child);
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      const reference = name === "href" || name.endsWith(":href") || name === "src";
      if (name.startsWith("on") || (reference && !value.startsWith("#")) || /url\(\s*['"]?(?!#)/iu.test(value) || /javascript:/iu.test(value)) element.removeAttribute(attribute.name);
    }
    if (element.localName === "style") element.textContent = (element.textContent ?? "").replace(/@import[^;]*;?/giu, "").replace(/url\(\s*['"]?(?!#)[^)]*\)/giu, "none");
  };
  walk(root);
  // Drawn at its own scale (a viewBox unit is a pixel, as the skill's text
  // sizes assume), narrowed to fit its frame, never stretched past it.
  root.removeAttribute("height");
  const box = (root.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/u).map(Number);
  if (box.length === 4 && box[2] > 0) root.setAttribute("width", String(box[2]));
  else root.setAttribute("width", "100%");
  return new XMLSerializer().serializeToString(root);
}

/** An `svg` block, drawn after cleaning; one that is not an SVG drawing says so. */
export function SvgView({ source }: { source: string }) {
  const t = useChatText();
  const clean = useMemo(() => cleanSvg(source), [source]);
  if (clean === null) {
    return <figure data-jouzu-view="invalid" role="alert" className="my-3 overflow-hidden rounded-lg border border-destructive/50">
      <figcaption className="border-b border-destructive/30 bg-destructive/5 px-3 py-1.5 text-xs text-destructive">{fill(t.viewInvalid, { reason: t.viewBadSvg })}</figcaption>
      <pre className="max-h-64 overflow-auto bg-background p-3 text-xs">{source}</pre>
    </figure>;
  }
  return <Frame kind="svg" source={source}>
    <div data-svg-view className="w-full text-foreground [&>svg]:h-auto [&>svg]:max-w-full" dangerouslySetInnerHTML={{ __html: clean }} />
  </Frame>;
}

/** What the Assistant's pane draws instead of a code block: views and SVG. */
export function renderViewBlock(language: string, source: string): ReactNode | undefined {
  if (language === "jouzu-view") return <JouzuView source={source} />;
  if (language === "svg") return <SvgView source={source} />;
  return undefined;
}
