// Fake pi RPC runtime for host tests. It speaks the real wire shapes:
// {id,type:"response",...}, extension_ui_request, and agent/message events.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import readline from "node:readline";

const delay = Number(process.env.FAKE_RUNTIME_DELAY_MS ?? 15);
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
    message: { role: "assistant", content: [{ type: "text", text: parts.join("") }] },
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
  busy = true;
  interrupted = false;
  response(id, "prompt", { disposition: "handled" });
  out({ type: "agent_start" });
  out({ type: "turn_start", turnIndex: 0, timestamp: Date.now() });
  out({ type: "message_start", message: { role: "assistant", content: [] } });
  if (uiMethod === "noise") {
    out({ type: "extension_ui_request", id: "noise-1", method: "setWidget", widgetKey: "x" });
    out({ type: "extension_ui_request", id: "noise-2", method: "setStatus", statusKey: "x" });
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
      response(value.id, "get_messages", { messages: [] });
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
