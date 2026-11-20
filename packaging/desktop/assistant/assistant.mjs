// The Assistant: Desktop's project coordinator, run by the host as its own
// process. It is not a jouzu session: no jouzu extensions, Flow, TextGuard or
// jouzu system prompt. It uses the Pi SDK's public API from Desktop's own
// pinned copy, and reads jouzu's auth.json and models.json for credentials.
//
// The host owns everything else. It sends the system prompt and the tool
// definitions, runs every tool itself, and decides when a turn happens. This
// process only turns host messages into model turns and tool calls into
// host requests. One JSON object per line on stdin and stdout:
//
//   host -> assistant  {type:"start", sdk, agentDir, sessionDir, authPath, modelsPath, model, systemPrompt, tools}
//                      {type:"turn", turnId, text}
//                      {type:"tool_result", callId, ok, result}
//                      {type:"abort"}
//   assistant -> host  {type:"ready", tools} | {type:"tool", callId, name, arguments}
//                      {type:"reply", turnId, text} | {type:"turn_end", turnId, stopReason, error?}
//                      {type:"fatal", message}
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const fatal = message => { send({ type: "fatal", message }); process.exit(1); };

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const pending = new Map();
let nextCall = 0;
let session;
let turns = Promise.resolve();

function hostTool(name) {
  return async (_toolCallId, params) => {
    const callId = `c${++nextCall}`;
    const answer = await new Promise(resolve => {
      pending.set(callId, resolve);
      send({ type: "tool", callId, name, arguments: params ?? {} });
    });
    const text = typeof answer.result === "string" ? answer.result : JSON.stringify(answer.result);
    // A refusal is a result the model reads; the SDK marks thrown errors isError.
    if (!answer.ok) throw new Error(text);
    return { content: [{ type: "text", text }], details: {} };
  };
}

function lastText(messages) {
  const reply = [...messages].reverse().find(message => message.role === "assistant");
  if (!reply) return { text: "", stopReason: "none" };
  const text = typeof reply.content === "string"
    ? reply.content
    : reply.content.filter(block => block.type === "text").map(block => block.text).join("\n");
  return { text, stopReason: reply.stopReason ?? "stop", error: reply.errorMessage };
}

async function start(request) {
  const sdk = await import(pathToFileURL(join(request.sdk, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js")));
  const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, ModelRuntime } = sdk;
  const cwd = request.agentDir;
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: true }, cacheWarming: { enabled: false }, compaction: { enabled: true } });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir: request.agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
    systemPrompt: request.systemPrompt,
  });
  await resourceLoader.reload();
  const customTools = request.tools.map(tool => ({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    execute: hostTool(tool.name),
  }));
  const names = customTools.map(tool => tool.name);
  const sessionManager = request.sessionDir
    ? SessionManager.continueRecent(cwd, request.sessionDir)
    : SessionManager.inMemory(cwd);
  let modelRuntime;
  let model;
  if (request.faux) {
    // Tests only: a scripted model, no credentials, no network.
    const ai = await import(pathToFileURL(join(request.sdk, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js")));
    const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
    faux.setResponses(request.faux.map(step => ai.fauxAssistantMessage(
      step.tool ? ai.fauxToolCall(step.tool, step.arguments ?? {}) : step.text,
      step.tool ? { stopReason: "toolUse" } : undefined,
    )));
    modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "faux-auth.json"), modelsPath: join(cwd, "faux-models.json"), allowModelNetwork: false, refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    model = faux.getModel();
  } else {
    modelRuntime = await ModelRuntime.create({ authPath: request.authPath, modelsPath: request.modelsPath, allowModelNetwork: false, refreshOnCreate: false });
    model = modelRuntime.getAllModels().find(candidate => candidate.provider === request.model?.provider && candidate.id === request.model?.id);
    if (!model) fatal(`The model ${request.model?.provider}/${request.model?.id} is not available.`);
  }
  ({ session } = await createAgentSession({
    cwd, agentDir: request.agentDir, settingsManager, resourceLoader, sessionManager,
    modelRuntime, model, tools: names, excludeTools: ["mcp__*"], customTools,
  }));
  // Only the host's tools, whatever the SDK offers by default.
  const active = [...session.getActiveToolNames()].sort();
  if (JSON.stringify(active) !== JSON.stringify([...names].sort())) fatal(`Unexpected tools: ${active.join(", ")}`);
  if (resourceLoader.getExtensions().extensions.length) fatal("Unexpected extensions");
  send({ type: "ready", tools: active });
}

async function turn(request) {
  try {
    await session.prompt(request.text, { expandPromptTemplates: false });
    const { text, stopReason, error } = lastText(session.messages);
    if (text) send({ type: "reply", turnId: request.turnId, text });
    send({ type: "turn_end", turnId: request.turnId, stopReason, error });
  } catch (error) {
    send({ type: "turn_end", turnId: request.turnId, stopReason: "error", error: error instanceof Error ? error.message : String(error) });
  }
}

lines.on("line", line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  switch (message.type) {
    case "start":
      start(message).catch(error => fatal(error instanceof Error ? error.message : String(error)));
      break;
    case "turn":
      // One turn at a time; the host never sends a second before turn_end.
      turns = turns.then(() => turn(message));
      break;
    case "tool_result": {
      const resolve = pending.get(message.callId);
      pending.delete(message.callId);
      resolve?.(message);
      break;
    }
    case "abort":
      void session?.abort();
      break;
  }
});
lines.on("close", () => { session?.dispose(); process.exit(0); });
