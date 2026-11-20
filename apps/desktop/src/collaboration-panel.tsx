import { useEffect, useState } from "react";
import { useApi } from "./api/context";
import type { AssistantModel, AssistantRecommendation, AssistantState, McpServerState, Model } from "./api/jouzu-api";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { Switch } from "./components/ui/switch";
import { ErrorLine } from "./session-alerts-view";
import { explain, fill, useChatText } from "./chat-text";
import { copyText } from "./secure-context";

/** The lines the jouzu-attribution extension's hook adds to the agent's commits. */
const COMMIT_LINES = "Co-authored-by: Jouzu Desktop (<model>) <359074535+jouzu-desktop@users.noreply.github.com>\nJouzu-Session: <session id>";

/** Settings > Collaboration: who works with the agent, and how its work shows up. */
export function CollaborationPanel() {
  return <>
    <AssistantCard />
    <AgentAccessCard />
    <CommitMarkCard />
  </>;
}

async function copy(text: string): Promise<boolean> {
  try {
    await copyText(text);
    return true;
  } catch {
    return false;
  }
}

const modelKey = (model: { provider: string; id: string }) => `${model.provider}\n${model.id}`;

/** A recommendation as a model to save: the first provider offering it, with its effort. */
export function offeredModel(entry: AssistantRecommendation): AssistantModel | null {
  const match = entry.offeredBy?.[0];
  return match ? { provider: match.provider, id: match.id, thinking: entry.thinking } : null;
}

/** What the form shows: the saved model, else the user's unsaved pick, else the first recommendation on offer. */
export function shownModel(saved: AssistantModel | null, draft: AssistantModel | null, recommended: AssistantRecommendation[]): AssistantModel | null {
  return saved ?? draft ?? recommended.map(offeredModel).find(Boolean) ?? null;
}

/**
 * The Assistant runs only on the model chosen here. Until one is saved, the
 * recommended model is filled in, and turning the Assistant on saves it.
 */
function AssistantCard() {
  const api = useApi();
  const t = useChatText();
  const [state, setState] = useState<AssistantState | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [recommended, setRecommended] = useState<AssistantRecommendation[]>([]);
  const [draft, setDraft] = useState<AssistantModel | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    void api.settings.assistant.read().then(setState, setError);
    void api.models.list("").then(setModels, () => setModels([]));
    void api.settings.assistant.recommended().then(value => setRecommended(value.models), () => setRecommended([]));
  }, [api]);

  const shown = shownModel(state?.model ?? null, draft, recommended);

  async function save(change: { enabled?: boolean; model?: AssistantModel | null }) {
    setBusy(true);
    setError(null);
    try {
      setState(await api.settings.assistant.update(change));
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  function choose(model: AssistantModel) {
    if (state?.model) void save({ model });
    else setDraft(model);
  }

  const listed = shown && !models.some(model => modelKey(model) === modelKey(shown)) ? [...models, { ...shown, name: shown.id } as Model] : models;
  return <Card className="border-border shadow-none">
    <CardHeader>
      <div className="flex items-center justify-between gap-4">
        <CardTitle><Label htmlFor="assistant-on">{t.assistant}</Label></CardTitle>
        <Switch id="assistant-on" aria-label={t.assistant} checked={state?.enabled === true} disabled={busy || state === null || (!state.enabled && !shown)}
          onCheckedChange={enabled => void save(enabled ? { enabled, model: shown } : { enabled })} />
      </div>
      <CardDescription>{t.assistantHint}</CardDescription>
    </CardHeader>
    {state && <CardContent className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-[1fr_10rem]">
        <div className="min-w-0 space-y-1">
          <Label>{t.assistantModel}</Label>
          <Select value={shown ? modelKey(shown) : ""} disabled={busy} onValueChange={value => {
            const model = listed.find(candidate => modelKey(candidate) === value);
            if (model) choose({ provider: model.provider, id: model.id, thinking: shown?.thinking });
          }}>
            <SelectTrigger className="w-full" aria-label={t.assistantModel}><SelectValue placeholder={t.assistantChooseModel} /></SelectTrigger>
            <SelectContent>{listed.map(model => <SelectItem key={modelKey(model)} value={modelKey(model)}>{model.name} · {model.provider}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>{t.assistantThinking}</Label>
          <Select value={shown?.thinking ?? "default"} disabled={busy || !shown} onValueChange={value => shown && choose({ ...shown, thinking: value === "default" ? undefined : value })}>
            <SelectTrigger className="w-full" aria-label={t.assistantThinking}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="default">{t.assistantThinkingDefault}</SelectItem>
              {state.thinkingLevels.map(level => <SelectItem key={level} value={level}>{level}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>
      {recommended.length > 0 && <ul className="space-y-2">
        {recommended.map(entry => {
          const model = offeredModel(entry);
          const current = !!model && !!shown && modelKey(model) === modelKey(shown) && model.thinking === shown.thinking;
          return <li key={entry.id} className="rounded-lg border border-border p-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{entry.label === "default" ? t.assistantRecommended : t.assistantStronger}: {entry.id} · {entry.thinking}</span>
              {model && !current && <Button variant="outline" disabled={busy} onClick={() => choose(model)}>{t.assistantUse}</Button>}
            </div>
            <p className="text-muted-foreground">{entry.evidence}</p>
            {entry.offeredBy && entry.offeredBy.length === 0 && <p className="text-muted-foreground">{t.assistantNotOffered}</p>}
          </li>;
        })}
      </ul>}
      {state.enabled && <p className="text-sm text-muted-foreground">{fill(t.assistantPhase, { phase: state.phase })}</p>}
      {state.error && <p className="text-sm text-destructive">{state.error}</p>}
      {error != null && <ErrorLine raw={error} failed={t.assistantFailed} onDismiss={() => setError(null)} />}
    </CardContent>}
    {!state && error != null && <CardContent><p className="text-sm text-muted-foreground">{explain(t, error, t.assistantFailed).text}</p></CardContent>}
  </Card>;
}

/** Other agents hand tasks to Desktop over MCP. Off until turned on here. */
function AgentAccessCard() {
  const api = useApi();
  const t = useChatText();
  const [state, setState] = useState<McpServerState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [name, setName] = useState("");
  const [port, setPort] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void api.settings.mcp.read().then(value => { setState(value); setPort(String(value.port)); }, setError);
  }, []);

  async function run(action: () => Promise<McpServerState | void>) {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      if (next) { setState(next); setPort(String(next.port)); }
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  const portNumber = Number(port);
  const portChanged = state != null && port !== String(state.port) && Number.isInteger(portNumber) && portNumber >= 1024 && portNumber <= 65535;

  return <Card className="border-border shadow-none">
    <CardHeader>
      <div className="flex items-center justify-between gap-4">
        <CardTitle><Label htmlFor="agent-access">{t.agentAccess}</Label></CardTitle>
        <Switch id="agent-access" aria-label={t.agentAccess} checked={state?.enabled === true} disabled={busy || state === null} onCheckedChange={enabled => void run(() => api.settings.mcp.update({ enabled }))} />
      </div>
      <CardDescription>{t.agentAccessHint}</CardDescription>
    </CardHeader>
    {state && <CardContent className="space-y-3">
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <Label>{t.agentAccessAddress}</Label>
          <code className="block truncate rounded-md bg-muted px-3 py-2 text-xs">{state.url}</code>
        </div>
        <div className="w-28 space-y-1">
          <Label htmlFor="agent-access-port">{t.agentAccessPort}</Label>
          <Input id="agent-access-port" inputMode="numeric" value={port} disabled={busy} onChange={event => setPort(event.target.value.replace(/[^0-9]/g, ""))} />
        </div>
        {portChanged && <Button variant="outline" disabled={busy} onClick={() => void run(() => api.settings.mcp.update({ port: portNumber }))}>{t.agentAccessSave}</Button>}
      </div>
      {state.enabled && !state.serving && state.error && <p className="text-sm text-destructive">{fill(t.agentAccessPortBusy, { port: state.port })}</p>}
      <div className="space-y-2">
        <Label>{t.agentAccessAgents}</Label>
        {state.agents.length === 0 && <p className="text-sm text-muted-foreground">{t.agentAccessNone}</p>}
        {state.agents.map(agent => <div key={agent.id} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-sm" title={agent.name}>{agent.name}</span>
          <Button variant="ghost" disabled={busy} onClick={() => void run(async () => { await api.settings.mcp.removeAgent(agent.id); return api.settings.mcp.read(); })}>{t.agentAccessRemove}</Button>
        </div>)}
        <form className="flex gap-2" onSubmit={event => {
          event.preventDefault();
          const trimmed = name.trim();
          if (!trimmed) return;
          void run(async () => {
            const created = await api.settings.mcp.addAgent(trimmed);
            setToken(created.token);
            setCopied(false);
            setName("");
            return api.settings.mcp.read();
          });
        }}>
          <Input aria-label={t.agentAccessName} placeholder={t.agentAccessName} value={name} maxLength={80} disabled={busy} onChange={event => setName(event.target.value)} />
          <Button type="submit" variant="outline" disabled={busy || !name.trim()}>{t.agentAccessAdd}</Button>
        </form>
        {token && <div className="space-y-2 rounded-lg border border-border p-3">
          <p className="text-sm">{t.agentAccessToken}</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-md bg-muted px-3 py-2 text-xs">{token}</code>
            <Button variant="outline" onClick={() => void copy(token).then(setCopied)}>{copied ? t.agentAccessCopied : t.agentAccessCopy}</Button>
          </div>
        </div>}
      </div>
      {error != null && <ErrorLine raw={error} failed={t.agentAccessFailed} onDismiss={() => setError(null)} />}
    </CardContent>}
    {!state && error != null && <CardContent><p className="text-sm text-muted-foreground">{explain(t, error, t.agentAccessFailed).text}</p></CardContent>}
  </Card>;
}

/** How work the agent does shows up to the people it works with. */
function CommitMarkCard() {
  const api = useApi();
  const t = useChatText();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    void api.settings.attribution.read().then(value => setEnabled(value.enabled), setError);
  }, []);

  async function save(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      setEnabled((await api.settings.attribution.save(next)).enabled);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  return <Card className="border-border shadow-none">
    <CardHeader>
      <div className="flex items-center justify-between gap-4">
        <CardTitle><Label htmlFor="commit-mark">{t.commitMark}</Label></CardTitle>
        <Switch id="commit-mark" aria-label={t.commitMark} checked={enabled === true} disabled={busy || enabled === null} onCheckedChange={next => void save(next)} />
      </div>
      <CardDescription>{t.commitMarkHint}</CardDescription>
    </CardHeader>
    <CardContent className="space-y-3">
      <code className="block whitespace-pre-wrap break-all rounded-md bg-muted px-3 py-2 text-xs">{COMMIT_LINES}</code>
      {error != null && enabled === null && <p className="text-sm text-muted-foreground">{explain(t, error, t.commitMarkFailed).text}</p>}
      {error != null && enabled !== null && <ErrorLine raw={error} failed={t.commitMarkFailed} onDismiss={() => setError(null)} />}
    </CardContent>
  </Card>;
}
