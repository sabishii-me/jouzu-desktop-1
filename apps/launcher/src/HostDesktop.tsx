import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { FolderOpen, Plus, X } from "lucide-react";
import { useApi } from "./api/context";

interface HostWorkspace {
  id: string;
  path: string;
  environment: { kind: string };
}

/** F1 host-served shell: Desktop boot and workspace persistence, no Tauri. */
export function HostDesktop() {
  const api = useApi();
  const [workspaces, setWorkspaces] = useState<HostWorkspace[] | null>(null);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      setWorkspaces((await api.workspaces.list()) as HostWorkspace[]);
      setError(null);
    } catch (failure) {
      setError(String(failure));
      setWorkspaces([]);
    }
  }

  useEffect(() => { void load(); }, []);

  async function add() {
    const value = path.trim();
    if (!value) return;
    setBusy(true); setError(null);
    try {
      setWorkspaces((await api.workspaces.add([value])) as HostWorkspace[]);
      setPath("");
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  }

  async function remove(workspace: HostWorkspace) {
    setBusy(true); setError(null);
    try {
      setWorkspaces((await api.workspaces.forget(workspace.id)) as HostWorkspace[]);
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  }

  return <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 p-8">
    <header className="space-y-2">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Jouzu Desktop</p>
      <h1 className="text-2xl font-semibold">Workspaces</h1>
      <p className="text-sm text-muted-foreground">Open a workspace folder to start a session. This page is served by the host.</p>
    </header>

    <Card className="border-border shadow-none">
      <CardHeader>
        <CardTitle>Add a workspace</CardTitle>
        <CardDescription>Enter an absolute folder path on the host machine.</CardDescription>
      </CardHeader>
      <CardContent className="flex gap-2">
        <Input
          aria-label="Workspace path"
          value={path}
          placeholder="C:\\Users\\you\\Projects"
          onChange={event => setPath(event.target.value)}
          onKeyDown={event => { if (event.key === "Enter") void add(); }}
        />
        <Button disabled={busy || !path.trim()} onClick={() => void add()}><Plus />Add</Button>
      </CardContent>
    </Card>

    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

    <section className="space-y-3" aria-label="Workspaces">
      {!workspaces && <p className="text-sm text-muted-foreground">Loading workspaces…</p>}
      {workspaces && !workspaces.length && <p className="text-sm text-muted-foreground">No workspaces yet. Add one above.</p>}
      {workspaces?.map(workspace => <div key={workspace.id} className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
        <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={workspace.path}>{workspace.path}</p>
          <p className="text-xs text-muted-foreground">{workspace.environment.kind}</p>
        </div>
        <Button variant="ghost" className="size-8 p-0" aria-label={`Remove ${workspace.path}`} onClick={() => void remove(workspace)}><X /></Button>
      </div>)}
    </section>
  </main>;
}
