import { useState } from "react";
import { useApi } from "./api/context";
import { useAppView, type ImageProvider, type ImageSettings, type ToolsView } from "./app-view";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { Label } from "./components/ui/label";
import { Switch } from "./components/ui/switch";
import { ErrorLine } from "./session-alerts-view";
import { fill, useChatText, type ChatText } from "./chat-text";
// The rule for what is in effect is the image tool's own, so the card shows what a call uses.
import { chosen } from "../../../packaging/desktop/extensions/jouzu-image/choice.mjs";

/** Why an added image provider cannot make images, in the interface language. */
function imageWhy(t: ChatText, code: string | undefined): string {
  const key = ({
    "sign-in-refused": "imageWhySignInRefused",
    "not-allowed": "imageWhyNotAllowed",
    "no-credit": "imageWhyNoCredit",
    unreachable: "imageWhyUnreachable",
    busy: "imageWhyBusy",
  } as const)[code ?? ""];
  return key ? t[key] : t.imageWhyOther;
}

/** Switching account or adding credit can fix these; the others need no visit to Model providers. */
const FIXED_IN_PROVIDERS = ["sign-in-refused", "no-credit", "not-allowed"];

const MAX_IMAGES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const select = "mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm";

/** The card's state, decided from the settings and the image tool's report only. */
export type ImageCardState = "checking" | "none-added" | "none-usable" | "usable";

export function imageCardState(tools: ToolsView | undefined): ImageCardState {
  if (!tools || tools.state === "checking" || !tools.report) return "checking";
  if (!tools.report.providers.length) return "none-added";
  return tools.report.usable ? "usable" : "none-usable";
}

function Why({ t, provider }: { t: ChatText; provider: ImageProvider }) {
  return <span>
    {provider.label}: {imageWhy(t, provider.code)}
    {(provider.reason || provider.detail) && <details className="mt-0.5 text-[11px]"><summary className="cursor-pointer">{t.details}</summary>{[provider.reason, provider.detail].filter(Boolean).join("\n")}</details>}
  </span>;
}

/**
 * Settings → Tools, image generation. Everything shown comes from AppView: the
 * saved choices and the image tool's report for the current configuration. The
 * page decides nothing; saving sends only the field that changed.
 */
export function ToolsPanel({ onOpenProviders }: { onOpenProviders?: () => void }) {
  const t = useChatText();
  const api = useApi();
  const tools = useAppView()?.tools;
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try { await action(); } catch (failure) { setError(failure); } finally { setBusy(false); }
  }
  const save = (change: Partial<ImageSettings>) => run(() => api.tools.save(change));
  const checkAgain = () => run(() => api.tools.refresh());

  const state = imageCardState(tools);
  const openProviders = onOpenProviders && <Button type="button" variant="outline" className="h-8 px-3 text-xs" onClick={onOpenProviders}>{t.openModelProviders}</Button>;

  let body: React.ReactNode;
  if (state === "checking" || !tools?.report) {
    body = <p role="status" data-image-state="checking" className="text-sm text-muted-foreground">{t.imageChecking}</p>;
  } else if (state === "none-added") {
    body = <div data-image-state="none-added" className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor="image-enabled">{t.enableImageGeneration}</Label>
        <Switch id="image-enabled" aria-label={t.enableImageGeneration} checked={false} disabled />
      </div>
      <p className="text-sm text-muted-foreground">{t.noImageProvider}</p>
      {openProviders}
    </div>;
  } else if (state === "none-usable") {
    body = <div data-image-state="none-usable" className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor="image-enabled">{t.enableImageGeneration}</Label>
        <Switch id="image-enabled" aria-label={t.enableImageGeneration} checked={false} disabled />
      </div>
      <p className="text-sm text-muted-foreground">{t.imageNoneUsable}</p>
      <ul className="space-y-1 text-xs text-muted-foreground">
        {tools.report.providers.map(provider => <li key={provider.id}><Why t={t} provider={provider} /></li>)}
      </ul>
      <div className="flex flex-wrap gap-2">
        {openProviders}
        <Button type="button" variant="outline" className="h-8 px-3 text-xs" disabled={busy} onClick={() => void checkAgain()}>{t.imageCheckAgain}</Button>
      </div>
    </div>;
  } else {
    const image = tools.settings.image;
    const providers = tools.report.providers;
    const { provider, model, size } = chosen(image, tools.report);
    const usable = providers.filter(entry => entry.usable);
    const sizes = model?.sizes ?? [];
    body = <div data-image-state="usable" className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor="image-enabled">{t.enableImageGeneration}</Label>
        <Switch id="image-enabled" aria-label={t.enableImageGeneration} checked={image.enabled} disabled={busy} onCheckedChange={enabled => void save({ enabled })} />
      </div>
      {image.enabled && <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm"><span className="text-muted-foreground">{t.imageProvider}</span>
          <select aria-label={t.imageProvider} className={select} value={provider?.id ?? ""} disabled={busy} onChange={event => {
            const next = usable.find(entry => entry.id === event.target.value);
            if (next) void save({ provider: next.id, model: next.models[0]?.id ?? "" });
          }}>
            {/* The chosen provider stays listed while it cannot make images, so its reason has a place. */}
            {provider && !provider.usable && <option value={provider.id}>{provider.label}</option>}
            {usable.map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          </select>
          {provider && !provider.usable && <span role="alert" className="mt-1 block text-xs text-destructive"><Why t={t} provider={provider} /></span>}
        </label>
        {provider?.usable && <label className="text-sm"><span className="text-muted-foreground">{t.imageModel}</span>
          <select aria-label={t.imageModel} className={select} value={model?.id ?? ""} disabled={busy} onChange={event => {
            const next = provider.models.find(entry => entry.id === event.target.value);
            if (!next) return;
            const size = !next.sizes.length || next.sizes.includes(image.size) ? undefined : next.sizes[0];
            void save({ provider: provider.id, model: next.id, ...(size ? { size } : {}) });
          }}>
            {!model && <option value="">{t.noModels}</option>}
            {provider.models.map(entry => <option key={entry.id} value={entry.id}>{entry.id}</option>)}
          </select>
        </label>}
        {provider?.usable && sizes.length > 0 && <label className="text-sm"><span className="text-muted-foreground">{t.imageSize}</span>
          <select aria-label={t.imageSize} className={select} value={size ?? sizes[0]} disabled={busy} onChange={event => void save({ size: event.target.value })}>
            {sizes.map(size => <option key={size} value={size}>{size}</option>)}
          </select>
        </label>}
        <label className="text-sm"><span className="text-muted-foreground">{t.imagesPerCall}</span>
          <select aria-label={t.imagesPerCall} className={select} value={image.maxImages} disabled={busy} onChange={event => void save({ maxImages: Number(event.target.value) })}>
            {MAX_IMAGES.map(max => <option key={max} value={max}>{max}</option>)}
          </select>
        </label>
      </div>}
      {provider && !provider.usable && FIXED_IN_PROVIDERS.includes(provider.code ?? "") && <div className="flex flex-wrap gap-2">
        {openProviders}
        <Button type="button" variant="outline" className="h-8 px-3 text-xs" disabled={busy} onClick={() => void checkAgain()}>{t.imageCheckAgain}</Button>
      </div>}
    </div>;
  }

  return <Card className="border-border shadow-none">
    <CardHeader>
      <CardTitle>{t.imageGeneration}</CardTitle>
      <CardDescription>{t.imageGenerationHint}</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      {body}
      {error != null && <ErrorLine raw={error} failed={t.toolsChangeFailed} onDismiss={() => setError(null)} />}
      {tools && <div className="border-t border-border pt-3 text-xs text-muted-foreground">
        {fill(t.reviewedCalls, { names: tools.settings.reviewTools.join(", ") })}
      </div>}
    </CardContent>
  </Card>;
}
