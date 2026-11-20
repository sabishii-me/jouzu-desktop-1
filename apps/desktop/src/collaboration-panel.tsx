import { useEffect, useState } from "react";
import { useApi } from "./api/context";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { Label } from "./components/ui/label";
import { Switch } from "./components/ui/switch";
import { ErrorLine } from "./session-alerts-view";
import { explain, useChatText } from "./chat-text";

/** The lines the jouzu-attribution extension's hook adds to the agent's commits. */
const COMMIT_LINES = "Co-authored-by: Jouzu Desktop (<model>) <359074535+jouzu-desktop@users.noreply.github.com>\nJouzu-Session: <session id>";

/** Settings > Collaboration: how work the agent does shows up to the people it works with. */
export function CollaborationPanel() {
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
