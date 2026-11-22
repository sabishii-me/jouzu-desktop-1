# Jouzu Desktop

Standalone desktop product repository.

```text
apps/launcher/      Tauri desktop shell and React UI
packaging/launcher/ Windows packaging and update tooling
scripts/            Repository test runner used by CI
```

## Development

```bash
cd apps/launcher
npm ci
npm test
npm run build

cd src-tauri
cargo test --locked --bins
cargo build --locked --release --bins
```

The desktop release carries the shell only; runtime provisioning and the Jouzu
runtime release process are not part of this repository.

Planning, task tracking and ADRs live in the private
`sabishii-me/jouzu-desktop-project` repository.
