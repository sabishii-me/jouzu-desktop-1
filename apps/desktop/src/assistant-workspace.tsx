import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUp, LoaderCircle, Sparkles } from "lucide-react";
import { useApi } from "./api/context";
import type { AssistantMessage, AssistantState, AssistantTask } from "./api/jouzu-api";
import { Button } from "./components/ui/button";
import { ChatMarkdown } from "./chat-markdown";
import { eventRouter } from "./event-router";
import { ErrorLine } from "./session-alerts-view";
import { fill, useChatText } from "./chat-text";
import type { SessionRow } from "./session-open";
import { renderViewBlock, TaskLookupProvider, type TaskLookup } from "./task-views";

/**
 * The Assistant's tasks as the host derives them, read again whenever a task
 * changes; a task's title is its session's, as the session list has it.
 */
function useTaskLookup(rows: SessionRow[], onOpen: (path: string) => void): TaskLookup {
  const api = useApi();
  const [tasks, setTasks] = useState<AssistantTask[]>([]);
  useEffect(() => {
    let current = true;
    const load = () => void api.settings.assistant.tasks().then(value => { if (current) setTasks(Array.isArray(value.tasks) ? value.tasks : []); }, () => {});
    load();
    const stop = eventRouter.subscribe(event => { if (event.event === "task.changed") load(); });
    return () => { current = false; stop(); };
  }, [api]);
  return useMemo(() => {
    const byTask = new Map(tasks.map(task => [task.taskId, task]));
    const byPath = new Map(rows.map(row => [row.path.toLowerCase(), row]));
    return {
      task(taskId) {
        const task = byTask.get(taskId);
        if (!task) return undefined;
        const row = task.sessionPath ? byPath.get(task.sessionPath.toLowerCase()) : rows.find(candidate => candidate.task?.taskId === taskId);
        return { taskId, state: task.state, title: row?.title ?? task.title ?? undefined, sessionPath: row?.path ?? task.sessionPath ?? undefined, model: task.model ?? null };
      },
      open: onOpen,
    };
  }, [tasks, rows, onOpen]);
}

/**
 * The Assistant's conversation. The host owns the Assistant, its model and its
 * transcript; this pane shows them and sends the user's messages.
 */
export function AssistantWorkspace({ overview, rows = [], onOpen = () => {} }: { overview?: ReactNode; rows?: SessionRow[]; onOpen?: (path: string) => void }) {
  const api = useApi();
  const t = useChatText();
  const lookup = useTaskLookup(rows, onOpen);
  const [state, setState] = useState<AssistantState | null>(null);
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current = true;
    const load = () => {
      void api.settings.assistant.read().then(value => { if (current) setState(value); }, value => { if (current) setError(value); });
      void api.settings.assistant.messages().then(value => { if (current) setMessages(value); }, () => {});
    };
    load();
    const stop = eventRouter.subscribe(event => { if (event.event === "assistant.changed") load(); });
    return () => { current = false; stop(); };
  }, [api]);
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }); }, [messages.length]);

  async function send() {
    const text = draft.trim();
    if (!text || sending || !state?.enabled) return;
    setSending(true);
    setError(null);
    try {
      setState(await api.settings.assistant.send(text));
      setDraft(value => value.trim() === text ? "" : value);
    } catch (failure) {
      setError(failure);
    } finally {
      setSending(false);
    }
  }

  const working = state?.phase === "running" || state?.phase === "starting";
  return <div className="flex min-h-0 flex-1 flex-col">
    {overview}
    {messages.length ? <TaskLookupProvider value={lookup}><div className="min-h-0 flex-1 overflow-y-auto px-4 py-5"><div className="mx-auto max-w-3xl space-y-5">
      {messages.map((message, index) => message.kind === "user"
        ? <article key={index} aria-label="user message" className="rounded-xl bg-muted p-4"><ChatMarkdown text={message.text} /></article>
        : message.kind === "assistant"
          ? <article key={index} aria-label="assistant message" className="min-w-0 px-1"><ChatMarkdown text={message.text} renderBlock={renderViewBlock} /></article>
          : message.kind === "error"
            ? <p key={index} role="alert" className="px-1 text-sm text-destructive">{message.text}</p>
            : <p key={index} className="px-1 text-xs text-muted-foreground">{fill(t.assistantWoken, { text: message.text })}</p>)}
      <div ref={end} />
    </div></div></TaskLookupProvider> : <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-y-auto px-4 py-8 text-center">
      <span className="flex size-12 items-center justify-center rounded-2xl border border-border bg-card"><Sparkles className="size-6 text-primary" aria-hidden="true" /></span>
      <h1 className="text-2xl font-semibold tracking-tight">{t.assistant}</h1>
      <p className="max-w-md text-sm text-muted-foreground">{t.assistantEmpty}</p>
    </div>}
    <div className="mx-auto w-full max-w-3xl px-4 pb-5">
      {state && !state.enabled && <p className="mb-3 text-sm text-muted-foreground">{t.assistantOffHint}</p>}
      {state?.error && <p role="alert" className="mb-3 text-sm text-destructive">{state.error}</p>}
      {error != null && <div className="mb-3"><ErrorLine raw={error} failed={t.assistantSendFailed} onDismiss={() => setError(null)} /></div>}
      <form aria-label={t.assistant} onSubmit={event => { event.preventDefault(); void send(); }} className="rounded-2xl border border-border bg-card p-3">
        <textarea aria-label={t.assistantPlaceholder} placeholder={t.assistantPlaceholder} rows={3} value={draft} disabled={!state?.enabled} onChange={event => setDraft(event.target.value)} onKeyDown={event => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
        }} className="w-full resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
        <div className="flex items-center justify-between gap-2">
          <span role="status" className="text-xs text-muted-foreground">{state?.enabled ? fill(t.assistantPhase, { phase: state.phase }) : ""}</span>
          <Button type="submit" className="size-8 p-0" aria-label={t.assistantSend} disabled={sending || !state?.enabled || !draft.trim()}>{sending || working ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}</Button>
        </div>
      </form>
    </div>
  </div>;
}
