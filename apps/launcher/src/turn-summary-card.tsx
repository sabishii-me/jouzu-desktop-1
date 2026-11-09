import { useState } from "react";
import { Image as ImageIcon, PencilLine } from "lucide-react";
import { ImageViewer } from "./components/image-viewer";
import { Button } from "./components/ui/button";
import { FilePreview } from "./file-preview";
import type { TurnArtifact, TurnSummaryData } from "./turn-summary";

/**
 * What a turn produced: image previews and edited-file chips.
 *
 * `detail` renders the same content inside an expanded turn process row,
 * without a second card or a second "N files edited" header.
 */
export function TurnSummary({ data, workspace, onOpenArtifacts, detail = false }: { data: TurnSummaryData; workspace?: string; onOpenArtifacts?: () => void; detail?: boolean }) {
  const [open, setOpen] = useState<TurnArtifact | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  if (!data.artifacts.length && !data.files.length) return null;
  const body = <>
    {data.artifacts.length > 0 && <div className="flex flex-wrap gap-2">
      {data.artifacts.map(artifact => artifact.data
        ? <button key={artifact.id} type="button" className="overflow-hidden rounded-md border border-border" title={artifact.prompt ?? artifact.path ?? "Generated image"} aria-label={artifact.prompt ?? "Generated image"} onClick={() => setOpen(artifact)}>
          <img src={`data:${artifact.mime};base64,${artifact.data}`} alt={artifact.prompt ?? "Generated image"} className="size-20 object-cover" />
        </button>
        : <span key={artifact.id} className="max-w-48 truncate rounded-md border border-border px-2 py-1 font-mono text-[10px] text-muted-foreground">{artifact.path ?? "image"}</span>)}
    </div>}
    {data.files.length > 0 && <ul aria-label="Edited files" className="flex flex-wrap gap-1">{data.files.map(file => <li key={file}><Button variant="outline" className="h-6 max-w-64 gap-1 px-2 font-mono text-[10px]" title={file} onClick={() => setPreview(file)}><span className="truncate">{file.split(/[\\/]/u).pop() ?? file}</span></Button></li>)}</ul>}
    {data.artifacts.length > 0 && onOpenArtifacts && <div><Button variant="ghost" className="h-6 px-2 text-[11px]" onClick={onOpenArtifacts}>View in artifacts</Button></div>}
  </>;
  return <>
    {detail
      ? <div className="space-y-2">{body}</div>
      : <section aria-label="Turn summary" className="mt-3 rounded-xl border border-border bg-muted/30 p-3">
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          {data.artifacts.length > 0 && <span className="flex items-center gap-1.5"><ImageIcon className="size-3.5" aria-hidden="true" />{data.artifacts.length} image{data.artifacts.length === 1 ? "" : "s"}</span>}
          {data.files.length > 0 && <span className="flex items-center gap-1.5"><PencilLine className="size-3.5" aria-hidden="true" />{data.files.length} file{data.files.length === 1 ? "" : "s"} edited</span>}
          {data.artifacts.length > 0 && onOpenArtifacts && <Button variant="ghost" className="ml-auto h-6 px-2 text-[11px]" onClick={onOpenArtifacts}>View in artifacts</Button>}
        </div>
        <div className="mt-2 space-y-2">{body}</div>
      </section>}
    {open && <ImageViewer src={`data:${open.mime};base64,${open.data}`} alt={open.prompt ?? ""} title={open.path?.split(/[\\/]/u).pop() ?? "Image"} onClose={() => setOpen(null)} />}
    {preview && <FilePreview path={preview} workspace={workspace} onClose={() => setPreview(null)} />}
  </>;
}
