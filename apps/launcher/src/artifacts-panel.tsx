import { useEffect, useState } from "react";
import { Eye, FolderOpen, Trash2 } from "lucide-react";
import { useApi } from "./api/context";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { Button } from "./components/ui/button";
import { ImageViewer } from "./components/image-viewer";

interface ArtifactRecord {
  id: string;
  absolutePath?: string;
  prompt?: string;
  mimeType?: string;
  bytes?: number;
  createdAt?: string;
  dimensions?: { width?: number; height?: number };
  source?: { model?: string; provider?: string };
}

const THUMBNAILS = 24;

function Thumb({ id, alt, onOpen }: { id: string; alt: string; onOpen: () => void }) {
  const api = useApi();
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void api.artifacts.read(id)
      .then(value => { if (alive) setSrc(`data:${value.mimeType};base64,${value.data}`); })
      .catch(() => {});
    return () => { alive = false; };
  }, [api, id]);
  return <button type="button" className="aspect-square w-full overflow-hidden rounded-md border border-border bg-muted/40" onClick={onOpen} title={alt}>
    {src ? <img src={src} alt={alt} loading="lazy" className="size-full object-cover" /> : null}
  </button>;
}

/** Everything the artifact store holds, newest first (0072). */
export function ArtifactsPanel({ sessionId }: { sessionId?: string } = {}) {
  const api = useApi();
  const [items, setItems] = useState<ArtifactRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ src: string; title: string } | null>(null);

  async function load() {
    try {
      const artifacts = await api.artifacts.list({ kind: "images", ...(sessionId ? { sessionId } : {}) });
      setItems(artifacts as ArtifactRecord[]);
      setError(null);
    } catch (failure) {
      setError(String(failure));
      setItems([]);
    }
  }

  useEffect(() => { void load(); }, [sessionId]);

  async function view(item: ArtifactRecord) {
    try {
      const result = await api.artifacts.read(item.id);
      setViewing({ src: `data:${result.mimeType};base64,${result.data}`, title: item.prompt?.slice(0, 120) || item.id });
    } catch (failure) {
      setError(String(failure));
    }
  }

  async function remove(item: ArtifactRecord) {
    const okay = await api.native.confirm({ message: "Delete this artifact? The file is removed from disk.", title: "Delete artifact" });
    if (!okay) return;
    try {
      await api.artifacts.delete(item.id);
      await load();
    } catch (failure) {
      setError(String(failure));
    }
  }

  return <Card className="border-border shadow-none">
    <CardHeader>
      <CardTitle>Artifacts</CardTitle>
      <CardDescription>{sessionId ? "Images produced in this session." : "Generated files stored under the agent's artifacts folder, newest first."}</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {!items && !error && <p className="text-sm text-muted-foreground">Loading artifacts…</p>}
      {items && !items.length && <p className="text-sm text-muted-foreground">No artifacts yet. Generated images appear here.</p>}
      {items && items.length > 0 && <>
        <p className="text-xs text-muted-foreground">{items.length} artifact{items.length === 1 ? "" : "s"}</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {items.map((item, index) => <div key={item.id} className="space-y-2">
            {index < THUMBNAILS
              ? <Thumb id={item.id} alt={item.prompt ?? item.id} onOpen={() => void view(item)} />
              : <div className="flex aspect-square items-center justify-center rounded-md border border-border bg-muted/40 text-[10px] text-muted-foreground">{item.mimeType ?? "file"}</div>}
            <p className="line-clamp-2 text-[11px] text-muted-foreground" title={item.prompt}>{item.prompt || item.id}</p>
            <p className="truncate text-[10px] text-muted-foreground">{[item.source?.model, item.dimensions?.width && item.dimensions?.height ? `${item.dimensions.width}×${item.dimensions.height}` : "", item.createdAt ? new Date(item.createdAt).toLocaleString() : ""].filter(Boolean).join(" · ")}</p>
            <div className="flex flex-wrap gap-1">
              <Button variant="ghost" className="h-7 gap-1 px-2 text-[11px]" onClick={() => void view(item)}><Eye className="size-3" />Open</Button>
              {item.absolutePath && <Button variant="ghost" className="h-7 gap-1 px-2 text-[11px]" onClick={() => { void api.native.reveal(item.absolutePath!).catch(() => {}); }}><FolderOpen className="size-3" />Reveal</Button>}
              <Button variant="ghost" className="h-7 gap-1 px-2 text-[11px] text-destructive" onClick={() => void remove(item)}><Trash2 className="size-3" />Delete</Button>
            </div>
          </div>)}
        </div>
      </>}
    </CardContent>
    {viewing && <ImageViewer src={viewing.src} alt={viewing.title} title={viewing.title} onClose={() => setViewing(null)} />}
  </Card>;
}
