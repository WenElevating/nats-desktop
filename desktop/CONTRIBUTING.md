# Contributing to the desktop client

This directory holds the Wails v3 desktop client (`main.go`, `internal/`, `build/`) and its
React frontend (`frontend/`). CI (`.github/workflows/desktop-ci.yml`) runs on every PR/push
touching `desktop/**`:

1. **go** (windows-latest): `go vet ./...`, `go test ./... -race -count=1`
2. **frontend** (ubuntu-latest): `npm ci`, `tsc --noEmit`, `eslint src --max-warnings 0`,
   `vitest run` (includes the i18n completeness gate)
3. **build** (windows-latest): `wails3 build`, upload of `desktop/bin/` as an artifact

## Rules that CI enforces (or that will bite you)

### Bindings are committed — regenerate after changing Go services

CI does **not** run `wails3 generate` (the beta CLI output drifts between versions), so
`frontend/bindings/` is committed to the repository. After changing any Go service
(`desktop/internal/...`):

```bash
wails3 generate bindings -ts -i -clean=true
```

Then commit the regenerated `frontend/bindings/` together with your Go change. A stale
bindings tree means the frontend is calling methods that no longer match the Go side.

### i18n keys must stay in sync on both sides

Every key added to `frontend/src/locales/en.json` must also exist in
`frontend/src/locales/zh-CN.json` (and vice versa), with no empty values. The vitest suite
(`tests/i18n.test.ts`, spec AC-021) fails the CI pipeline on any drift.

### Local pre-flight

Before opening a PR, run the same stages locally:

```bash
cd desktop
go vet ./...
go test ./... -count=1        # add -race if your local toolchain supports cgo
cd frontend
npx tsc --noEmit
npx eslint src --max-warnings 0
npx vitest run
cd ..
wails3 build                  # requires the wails3 CLI: go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.20
```
