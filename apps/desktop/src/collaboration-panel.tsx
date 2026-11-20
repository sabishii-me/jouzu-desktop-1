import { useEffect, useState } from "react";
import { useApi } from "./api/context";
import type { McpServerState } from "./api/jouzu-api";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { Switch } from "./components/ui/switch";
import { ErrorLine } from "./session-alerts-view";
import { explain, fill, useChatText } from "./chat-text";
import { copyText } from "./secure-context";

/** The lines the jouzu-attribution extension's hook adds to the agent's commits. */
const COMMIT_LINES = "Co-authored-by: Jouzu Desktop (<model>) <359074535+jouzu-desktop@users.noreply.github.com>\nJouzu-Session: <session id>";

/** Settings > Collaboration: who works with the agent, and how its work shows up. */
export function CollaborationPanel() {
  return <>
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
