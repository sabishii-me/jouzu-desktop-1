import { object } from "../chat-projection";
import { ToolOutput } from "./tool-output";
import { ToolFrame, ToolSection } from "./tool-frame";
import type { ToolRendererProps } from "./types";

const labeled: Record<string, { title: string; summary: (args: Record<string, unknown>) => string | undefined }> = {
  bash: { title: "Command", summary: args => typeof args.command === "string" ? args.command : undefined },
  read: { title: "Read", summary: args => typeof args.path === "string" ? args.path : undefined },
  grep: { title: "Search", summary: args => [args.pattern, args.path].filter(value => typeof value === "string").join(" · ") || undefined },
  ls: { title: "List", summary: args => typeof args.path === "string" ? args.path : undefined },
  write: { title: "Write", summary: args => typeof args.path === "string" ? args.path : undefined },
  edit: { title: "Edit", summary: args => typeof args.path === "string" ? args.path : undefined },
  apply_patch: { title: "Patch", summary: args => typeof args.patch === "string" ? args.patch.split("\n")[0] : undefined },
  web_fetch: { title: "Fetch", summary: args => typeof args.url === "string" ? args.url : undefined },
  batch_web_fetch: {
    title: "Batch fetch",
    summary: args => {
      const urls = Array.isArray(args.urls) ? args.urls : [];
      return urls.length ? `${urls.length} URL${urls.length === 1 ? "" : "s"}` : undefined;
    },
  },
  "tff-search_web": { title: "Web search", summary: args => typeof args.query === "string" ? args.query : undefined },
  get_goal: { title: "Goal", summary: args => typeof args.status === "string" ? args.status : undefined },
  vcc_recall: { title: "Recall", summary: args => typeof args.query === "string" ? args.query : undefined },
};
export function isSimpleTool(name: string) { return name in labeled; }
export function SimpleToolRenderer({ tool }: ToolRendererProps) {
  const definition = labeled[tool.name]!;
  const args = object(tool.args) ? tool.args : {};
  const state = tool.phase === "running" ? "running" : tool.phase === "error" ? "error" : "done";
  const argumentText = tool.args === undefined ? undefined : JSON.stringify(tool.args, null, 2);
  return <ToolFrame title={definition.title} subtitle={definition.summary(args)} state={state}>
    <ToolOutput tool={tool} />
    {argumentText && <ToolSection label="Arguments" copyText={argumentText}>
      <pre className="whitespace-pre-wrap break-words font-mono text-[10px] leading-5 text-muted-foreground">{argumentText}</pre>
    </ToolSection>}
  </ToolFrame>;
}
