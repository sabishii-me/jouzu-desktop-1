import { object } from "../chat-projection";
import { ToolFrame, ToolSection } from "./tool-frame";
import { ToolOutput } from "./tool-output";
import { toolText, type ToolRendererProps } from "./types";

/** Every tool gets a card, even when the runtime adds one we do not know yet. */
export function GenericRenderer({ tool }: ToolRendererProps) {
  const text = toolText(tool.result);
  const state = tool.phase === "running" ? "running" : tool.phase === "error" ? "error" : "done";
  const argumentText = tool.args === undefined ? undefined : JSON.stringify(tool.args, null, 2);
  const hasStructuredResult = !!object(tool.result);
  return <ToolFrame title={tool.name} subtitle="Tool call" state={state}>
    {tool.phase === "error" && !text && <p role="alert" className="text-[11px] text-destructive">This tool failed without an error message.</p>}
    {(text || hasStructuredResult) && <ToolOutput tool={tool} />}
    {argumentText && <ToolSection label="Arguments" copyText={argumentText}>
      <pre className="whitespace-pre-wrap break-words font-mono text-[10px] leading-5 text-muted-foreground">{argumentText}</pre>
    </ToolSection>}
    {!argumentText && !text && !hasStructuredResult && <p className="text-[11px] text-muted-foreground">This tool returned no displayable output.</p>}
  </ToolFrame>;
}
