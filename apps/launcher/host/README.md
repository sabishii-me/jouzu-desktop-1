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
