import { useEffect, useState } from "react";
import { useApi } from "./api/context";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { Label } from "./components/ui/label";
import { Switch } from "./components/ui/switch";
import { ErrorLine } from "./session-alerts-view";
import { explain, useChatText } from "./chat-text";
import type { AttributionSettings } from "./api/jouzu-api";

const JOUZU = "Jouzu Desktop <359074535+jouzu-desktop@users.noreply.github.com>";

/** What the jouzu-attribution extension makes of the agent's new commits. */
function commitLines(author: boolean) {
  const lines = [
    "Co-authored-by: Jouzu Desktop (<model>) <359074535+jouzu-desktop@users.noreply.github.com>",
    "Jouzu-Session: <session id>",
  ];
  return author
    ? [`Author: ${JOUZU}`, "Committer: <your git user.name> <your git user.email>", "", ...lines, "Co-authored-by: <your git user.name> <your git user.email>"].join("\n")
    : lines.join("\n");
}

/** Settings > Collaboration: how work the agent does shows up to the people it works with. */
export function CollaborationPanel() {
  const api = useApi();
  const t = useChatText();
  const [saved, setSaved] = useState<AttributionSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    void api.settings.attribution.read().then(setSaved, setError);
  }, []);

  async function save(change: Partial<AttributionSettings>) {
    setBusy(true);
    setError(null);
    try {
      setSaved(await api.settings.attribution.save(change));
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
        <Switch id="commit-mark" aria-label={t.commitMark} checked={saved?.enabled === true} disabled={busy || saved === null} onCheckedChange={next => void save({ enabled: next })} />
      </div>
      <CardDescription>{t.commitMarkHint}</CardDescription>
    </CardHeader>
    <CardContent className="space-y-3">
      {/* Only a choice while marking is on; its saved value is kept while off. */}
      {saved?.enabled === true && <div className="space-y-1 border-l-2 border-border pl-3">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="commit-author">{t.commitAuthor}</Label>
          <Switch id="commit-author" aria-label={t.commitAuthor} checked={saved.author} disabled={busy} onCheckedChange={next => void save({ author: next })} />
        </div>
        <p className="text-sm text-muted-foreground">{t.commitAuthorHint}</p>
      </div>}
      <code className="block whitespace-pre-wrap break-all rounded-md bg-muted px-3 py-2 text-xs">{commitLines(saved?.enabled === true && saved.author)}</code>
      {error != null && saved === null && <p className="text-sm text-muted-foreground">{explain(t, error, t.commitMarkFailed).text}</p>}
      {error != null && saved !== null && <ErrorLine raw={error} failed={t.commitMarkFailed} onDismiss={() => setError(null)} />}
    </CardContent>
  </Card>;
}
