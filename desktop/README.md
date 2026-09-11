# NATS Desktop Client

A Wails v3 desktop client for NATS: Go backend, React + TypeScript frontend.
M1 milestone scope: connection management (natscli-compatible contexts),
app shell with sidebar navigation, settings, update check, system tray, and
single-instance behavior on Windows.

## Prerequisites

- Go 1.26
- Node.js 22
- Wails3 CLI, pinned to `v3.0.0-beta.20` (must match the Go module version):

  ```
  go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.20
  ```

## Commands

Run from this directory (`desktop/`):

- `wails3 dev` — run the app in development mode with hot reload
- `wails3 build` — production build; output lands in `bin/`
- `go test ./...` — Go unit tests
- `npm test` — frontend tests, run from `frontend/` (includes the i18n
  completeness gate)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the rules CI enforces, notably:
bindings under `frontend/bindings/` are committed and must be regenerated with
`wails3 generate bindings -ts -clean=true` after changing Go services, and
i18n keys must stay in sync between `frontend/src/locales/en.json` and
`frontend/src/locales/zh-CN.json`.
