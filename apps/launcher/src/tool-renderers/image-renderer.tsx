import { ArtifactImage } from "./artifact-image";
import { ToolFrame } from "./tool-frame";
import { imageBlocks } from "./tool-output";
import { toolText, record, type ToolRendererProps } from "./types";
import { artifactPathFromText } from "./artifact-path";

/**
 * The image tool gets its own view: the picture is the result, so it stays
 * visible in the collapsed state instead of hiding behind a chevron.
 */
export function ImageRenderer({ tool }: ToolRendererProps) {
  const images = imageBlocks(tool.result);
  const details = record(record(tool.result)?.details);
  const prompt = typeof details?.prompt === "string" ? details.prompt : "";
  const model = typeof details?.model === "string" ? details.model : "";
  const size = typeof details?.size === "string" ? details.size : "";
  const metas = Array.isArray(details?.images) ? details.images : [];
  const fallbackPath = images.length === 1 ? artifactPathFromText(toolText(tool.result)) : undefined;
  const items = images.map((image, index) => {
    const meta = record(metas[index]);
    return {
      ...image,
      alt: prompt || image.alt,
      path: typeof meta?.path === "string" ? meta.path : fallbackPath,
      width: typeof meta?.width === "number" ? meta.width : undefined,
      height: typeof meta?.height === "number" ? meta.height : undefined,
    };
  });
  const state = tool.phase === "running" ? "running" : tool.phase === "error" ? "error" : "done";
  const summary = tool.phase === "running" ? "Generating…" : tool.phase === "error" ? "Failed" : `${items.length} image${items.length === 1 ? "" : "s"}${[model, size].filter(Boolean).length ? ` · ${[model, size].filter(Boolean).join(" · ")}` : ""}`;
  return <ToolFrame title="Generated image" subtitle={summary} state={state} defaultOpen>
    {items.length ? <div className="grid gap-3 sm:grid-cols-2">
      {items.map((image, index) => <ArtifactImage key={index} image={image} caption={image.width && image.height ? `${image.width}×${image.height}` : undefined} />)}
    </div> : <p className="text-xs text-muted-foreground">{tool.phase === "error" ? "The generation failed." : "Generating…"}</p>}
  </ToolFrame>;
}
