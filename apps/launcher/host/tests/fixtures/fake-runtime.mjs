// Fake pi RPC runtime for host tests. It speaks the real wire shapes:
// {id,type:"response",...}, extension_ui_request, and agent/message events.
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import readline from "node:readline";

const delay = Number(process.env.FAKE_RUNTIME_DELAY_MS ?? 15);
const startDelay = Number(process.env.FAKE_RUNTIME_START_DELAY_MS ?? 0);
const exitOnStart = Number(process.env.FAKE_RUNTIME_EXIT_ON_START_MS ?? 0);
const crashOnPrompt = process.env.FAKE_RUNTIME_CRASH_ON_PROMPT === "1";
const tool = process.env.FAKE_RUNTIME_TOOL === "1";
// Real runtimes answer "handled" when Flow keeps the input and no run starts.
const handledPrompts = process.env.FAKE_RUNTIME_HANDLED === "1";
const garbage = process.env.FAKE_RUNTIME_GARBAGE === "1";
const uiMethod = process.env.FAKE_RUNTIME_UI ?? "";
const uiTimeout = Number(process.env.FAKE_RUNTIME_UI_TIMEOUT_MS ?? 0);
const out = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const response = (id, command, data) =>
  out({ id, type: "response", command, success: true, data });
const failure = (id, command, error) =>
  out({ id, type: "response", command, success: false, error });

let busy = false;
let interrupted = false;
let timer = null;
let current = null;
let pendingUi = null;
const messages = [];

if (startDelay > 0) {
  await new Promise(resolve => setTimeout(resolve, startDelay));
}

if (garbage) {
  process.stdout.write("this is not json\n");
}

if (exitOnStart > 0) {
  setTimeout(() => process.exit(7), exitOnStart);
}

if (process.env.FAKE_RUNTIME_CHILD_PID_FILE) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  writeFileSync(process.env.FAKE_RUNTIME_CHILD_PID_FILE, String(child.pid));
}

function settled(aborted) {
  busy = false;
  clearTimeout(timer);
  current = null;
  pendingUi = null;
  out({ type: "agent_settled", aborted });
}

function tick() {
  if (!busy || !current) return;
  if (interrupted) {
    settled(true);
    return;
  }
  const { parts, index } = current;
  if (index < parts.length) {
    out({
      type: "message_update",
      usage: {},
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: parts[index],
      },
    });
    current.index += 1;
    timer = setTimeout(tick, delay);
    return;
  }
  out({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: parts.join("") }], model: "fixture-model", provider: "fixture" },
  });
  messages.push({
    role: "assistant",
    content: [{ type: "text", text: parts.join("") }],
    model: "fixture-model",
    provider: "fixture",
  });
  settled(false);
}

function beginTurn(text) {
  current = { parts: Array.from(String(text)), index: 0 };
  tick();
}

function requestUi(text) {
  const id = "ui-1";
  pendingUi = { text };
  const request = { type: "extension_ui_request", id };
  if (uiMethod === "confirm") {
    request.method = "confirm";
    request.title = "Allow test?";
    request.message = "Run the test tool?";
  } else if (uiMethod === "select") {
    request.method = "select";
    request.title = "Pick one";
    request.options = ["A", "B"];
  } else if (uiMethod === "input") {
    request.method = "input";
    request.title = "Name";
    request.placeholder = "type here";
  } else if (uiMethod === "editor") {
    request.method = "editor";
    request.title = "Edit";
    request.prefill = "seed";
  }
  if (uiTimeout > 0) request.timeout = uiTimeout;
  out(request);
}

function prompt(id, text) {
  if (handledPrompts || String(text).startsWith("/flow ")) {
    if (process.env.FAKE_RUNTIME_PROMPT_LOG) appendFileSync(process.env.FAKE_RUNTIME_PROMPT_LOG, `${text}\n`);
    response(id, "prompt", { disposition: "handled" });
    return;
  }
  if (process.env.FAKE_RUNTIME_PROMPT_LOG) appendFileSync(process.env.FAKE_RUNTIME_PROMPT_LOG, `${text}\n`);
  busy = true;
  interrupted = false;
  messages.push({ role: "user", content: [{ type: "text", text: String(text) }] });
  response(id, "prompt", { disposition: "started" });
  if (crashOnPrompt) {
    setTimeout(() => process.exit(8), 10);
  }
  if (tool) {
    out({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "thinking" } });
    out({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "echo hi" } });
    out({ type: "tool_execution_end", toolCallId: "call-1", isError: false, result: { output: "hi" } });
  }
  out({ type: "agent_start" });
  out({ type: "turn_start", turnIndex: 0, timestamp: Date.now() });
  out({ type: "message_start", message: { role: "assistant", content: [] } });
  out({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  if (uiMethod === "noise") {
    out({ type: "extension_ui_request", id: "noise-1", method: "setWidget", widgetKey: "x" });
    out({ type: "extension_ui_request", id: "noise-2", method: "setStatus", statusKey: "x" });
    beginTurn(text);
    return;
  }
  if (uiMethod === "notices") {
    out({ type: "extension_ui_request", id: "n-1", method: "notify", message: "Flow control is holding your message: test.", notifyType: "warning" });
    out({ type: "extension_ui_request", id: "n-2", method: "setStatus", statusKey: "flow", statusText: "held 1" });
    out({ type: "extension_ui_request", id: "n-3", method: "setWidget", widgetKey: "flow", widgetLines: ["line a", "line b"] });
    beginTurn(text);
    return;
  }
  if (uiMethod) {
    requestUi(text);
    return;
  }
  beginTurn(text);
}

const lines = readline.createInterface({ input: process.stdin });
if (process.env.FAKE_RUNTIME_IGNORE_STDIN === "1") {
  lines.pause();
  process.stdin.pause();
}
lines.on("line", line => {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return;
  }
  if (value.type === "extension_ui_response") {
    if (!pendingUi) return;
    const pending = pendingUi;
    pendingUi = null;
    let label = "cancelled";
    if (value.cancelled) label = "cancelled";
    else if ("confirmed" in value) label = value.confirmed ? "approved" : "denied";
    else if ("value" in value) label = String(value.value ?? "");
    beginTurn(label);
    return;
  }
  switch (value.type) {
    case "get_messages":
      response(value.id, "get_messages", { messages });
      break;
    case "get_state":
      response(value.id, "get_state", { sessionId: "fixture", isStreaming: busy, model: { name: "fixture-model", provider: "fixture", id: "model" }, thinkingLevel: "off", sessionFile: null });
      break;
    case "get_available_models":
      response(value.id, "get_available_models", { models: [] });
      break;
    case "get_available_thinking_levels":
      response(value.id, "get_available_thinking_levels", { levels: ["off"] });
      break;
    case "set_model":
      if (typeof value.modelId !== "string") {
        failure(value.id, "set_model", "set_model requires modelId");
        break;
      }
      if (value.modelId === "missing") {
        failure(value.id, "set_model", "Model not found: missing");
        break;
      }
      response(value.id, "set_model", { model: { name: "fixture-model", provider: String(value.provider ?? "fixture"), id: value.modelId } });
      break;
    case "set_thinking_level":
      response(value.id, "set_thinking_level", { level: String(value.level ?? "off") });
      break;
    case "switch_session":
      response(value.id, "switch_session", { cancelled: false });
      break;
    case "prompt":
      if (busy) {
        failure(value.id, "prompt", "prompt while busy");
        break;
      }
      prompt(value.id, String(value.message ?? ""));
      break;
    case "abort":
      response(value.id, "abort", {});
      if (busy) {
        interrupted = true;
        if (current) clearTimeout(timer);
        settled(true);
      }
      break;
    default:
      failure(value.id, String(value.type ?? "unknown"), "unsupported command");
      break;
  }
});
lines.on("close", () => process.exit(0));
