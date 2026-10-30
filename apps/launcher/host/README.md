# jouzu-host (phase 1)

A standalone host beside the Tauri app. It serves the built SPA and the first
`/v1` slice (`health`, `sessions`) with a loopback listener and a per-run token.
It owns no chat session yet.

Run from `apps/launcher` (the built UI is `apps/launcher/dist`):

```powershell
cargo run --manifest-path host/Cargo.toml -- --dist dist
```

The host prints a URL, writes `host.json` under
`%LOCALAPPDATA%\Shisa.ai\JouzuDesktop`, and logs to `logs/host.log`.

```powershell
$hostInfo = Get-Content "$env:LOCALAPPDATA\Shisa.ai\JouzuDesktop\host.json" | ConvertFrom-Json
Invoke-RestMethod "http://127.0.0.1:$($hostInfo.port)/v1/health" -Headers @{ Authorization = "Bearer $($hostInfo.token)" }
```

Open `http://127.0.0.1:<port>/?token=<token>` once to exchange the token for the
`HttpOnly` cookie; after that `/v1/...` accepts the cookie.

Tests:

```powershell
cargo test --manifest-path host/Cargo.toml
```

Phase 1 intentionally does not include session ownership, SSE, prompts, remote
pairing, packaging or the Tauri shell switch. The contract is
`docs/contracts/host-ui-v1.md` in the docs repository.

## Single instance

A per-home exclusive lock (`host.lock`) is acquired before the listener binds.
A second start exits 1 with the live pid/port and leaves `host.json` untouched;
a stale lock from a dead process is reused. Clean exit removes both files.

On Windows the lock is an exclusive file handle (no read/write sharing,
FILE_SHARE_DELETE for self-removal); on non-Windows the lock is not enforced yet.

## Phase 2a: sessions and SSE (pi RPC)

Endpoints (all under `/v1`, bearer/cookie auth):

```text
POST /sessions                 { workspacePath, sessionPath?, key? } -> 202 + Location
GET  /sessions                 -> { sessions: [...] }
GET  /sessions/{id}            -> session info
POST /sessions/{id}/messages   { clientMessageId, text } -> 202 { messageId, receipt }
POST /sessions/{id}/interrupt
POST /sessions/{id}/stop
GET  /sessions/{id}/events?clientId=...   SSE, Last-Event-ID resume
```

The host owns one runtime process per session and kills its Windows job tree on
stop or host exit. Detaching an SSE stream never stops a session.

Runtime selection: the provisioned runtime is used when
`<home>/runtime/node/node.exe` and `<home>/app/bootstrap.mjs` exist (the default is
derived from `--runtime-home`). The host speaks pi RPC (`bootstrap.mjs --mode
rpc`): `get_messages` handshake, `prompt`, `abort`, `switch_session`, and the
`agent_*`/`message_*`/`tool_execution_*` events.

Real runtime (host metadata in a temp home, runtime data from managed):

```powershell
cargo run --manifest-path host/Cargo.toml -- --dist dist --home $env:TEMP\jouzu-host `
  --runtime-home "$env:LOCALAPPDATA\Shisa.ai\JouzuDesktop\data"
```

`--runtime-home` sets `JOUZU_HOME` (credentials/session state); `--bash` overrides
Git Bash discovery. Tests use `tests/fixtures/fake-runtime.mjs`, which speaks the
same pi RPC wire shapes (`{id,type:"response"}` plus `agent_*`/`message_*` events),
not a private protocol.

Replay is bounded by 5,000 events per session; the 2 MiB byte cap and idle
reaping are not implemented yet.
