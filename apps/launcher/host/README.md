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

## Phase 2a: sessions and SSE

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
`<home>/runtime/node/node.exe` and `<home>/app/bootstrap.mjs` exist. For local
tests, pass an explicit command:

```powershell
cargo run --manifest-path host/Cargo.toml -- --dist dist `
  --runtime node --runtime-arg C:\path\to\fake-runtime.mjs
```

The fake runtime (`tests/fixtures/fake-runtime.mjs`) speaks the host's minimal
JSONL subset (`ready`, `prompt`, `delta`, `done`, `interrupt`); adapting the real
pi RPC runtime is a later phase. Replay is bounded by 5,000 events per session;
the 2 MiB byte cap and idle reaping are not implemented yet.
