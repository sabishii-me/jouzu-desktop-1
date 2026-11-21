// Jouzu Desktop Assistant: its tools, as a jouzu extension.
//
// The Assistant is a jouzu session that the desktop host starts with its own
// configuration (its prompt, its skills, only these tools and read-only ones).
// The host passes this extension by path (`-e`) to that runtime only; it is
// never installed where other sessions would discover it.
//
// The tools themselves live in the host. This file only bridges: it registers
// the tools the host listed (JOUZU_ASSISTANT_TOOLS, a JSON file) and sends each
// call to the host (JOUZU_ASSISTANT_URL) with the token the host made for this
// runtime (JOUZU_ASSISTANT_TOKEN). Without those three it registers nothing.
import { readFileSync } from "node:fs";

/** The tools the host listed, or none when this runtime was not started as the Assistant. */
export function hostTools(env = process.env) {
  if (!env.JOUZU_ASSISTANT_TOOLS || !env.JOUZU_ASSISTANT_URL || !env.JOUZU_ASSISTANT_TOKEN) return [];
  const tools = JSON.parse(readFileSync(env.JOUZU_ASSISTANT_TOOLS, "utf8"));
  return Array.isArray(tools) ? tools : [];
}

/** One call to the host. The host's answer is the result, refusals included: the model reads them. */
export async function callHost(name, args, signal, env = process.env) {
  const response = await fetch(env.JOUZU_ASSISTANT_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.JOUZU_ASSISTANT_TOKEN}` },
    body: JSON.stringify({ name, arguments: args ?? {} }),
    signal,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`The desktop refused the call (${response.status}): ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

export default function jouzuAssistant(pi) {
  for (const tool of hostTools()) {
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description ?? "",
      parameters: tool.inputSchema ?? { type: "object", properties: {} },
      async execute(_toolCallId, params, signal) {
        const answer = await callHost(tool.name, params, signal);
        const text = JSON.stringify(answer.ok ? answer.result : { error: answer.error });
        return { content: [{ type: "text", text }], details: { ok: answer.ok === true }, isError: answer.ok !== true };
      },
    });
  }
}
