import { useEffect, useState } from "react";
import { useApi } from "./api/context";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { Label } from "./components/ui/label";
import { Switch } from "./components/ui/switch";
import { ErrorLine } from "./session-alerts-view";
import { explain, useChatText } from "./chat-text";
import type { AttributionSettings } from "./api/jouzu-api";

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
    const before = saved;
    setBusy(true);
    setError(null);
    // Shown at once; what the host saved replaces it, a failure takes it back.
    if (before) setSaved({ ...before, ...change });
    try {
      setSaved(await api.settings.attribution.save(change));
    } catch (failure) {
      setSaved(before);
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  const on = saved?.enabled === true;
  return <Card className="border-border shadow-none">
    <CardHeader>
      <div className="flex items-center justify-between gap-4">
        <CardTitle><Label htmlFor="commit-mark">{t.commitMark}</Label></CardTitle>
        <Switch id="commit-mark" aria-label={t.commitMark} checked={on} disabled={busy || saved === null} onCheckedChange={next => void save({ enabled: next })} />
      </div>
      <CardDescription>{t.commitMarkHint}</CardDescription>
    </CardHeader>
    {(on || error != null) && <CardContent className="space-y-3">
      {/* Second level: only a choice while marking is on; the saved choice is kept while off. */}
      {on && <fieldset className="space-y-2" disabled={busy}>
        <legend className="sr-only">{t.commitMarkAs}</legend>
        {([[false, t.commitAsCoauthor, t.commitAsCoauthorHint], [true, t.commitAsAuthor, t.commitAsAuthorHint]] as const).map(([author, label, hint]) =>
          <label key={String(author)} className="flex cursor-pointer items-start gap-3 rounded-md border border-border px-3 py-2 has-[:checked]:border-primary">
            <input type="radio" name="commit-mark-as" className="mt-1 accent-primary" checked={saved.author === author} onChange={() => void save({ author })} />
            <span><span className="block text-sm font-medium">{label}</span><span className="block text-sm text-muted-foreground">{hint}</span></span>
          </label>)}
      </fieldset>}
      {error != null && saved === null && <p className="text-sm text-muted-foreground">{explain(t, error, t.commitMarkFailed).text}</p>}
      {error != null && saved !== null && <ErrorLine raw={error} failed={t.commitMarkFailed} onDismiss={() => setError(null)} />}
    </CardContent>}
  </Card>;
}
