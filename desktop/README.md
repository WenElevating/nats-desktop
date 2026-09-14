# NATS Desktop

NATS Desktop is a Wails v3 desktop client for NATS: Go backend, React +
TypeScript frontend.
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
- `go run ./cmd/testcluster` — **test tool, not product surface**: starts a
  3-node JetStream cluster (SYS/APP accounts) for manual / UIA smoke runs
  against the monitoring and cluster-danger-ops pages; Ctrl-C exits. It is
  never shipped with the app.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the rules CI enforces, notably:
bindings under `frontend/bindings/` are committed and must be regenerated with
`wails3 generate bindings -ts -clean=true` after changing Go services, and
i18n keys must stay in sync between `frontend/src/locales/en.json` and
`frontend/src/locales/zh-CN.json`.

## Release / 发布

Two artifacts per release, produced under `bin/dist/` by
`scripts/make-release.ps1` (see below):

- `nats-desktop-amd64-installer.exe` — NSIS installer, per-user scope:
  installs to `%LOCALAPPDATA%\Programs\nats-desktop`, no admin prompt, and
  auto-installs the WebView2 Runtime if missing.
- `nats-desktop-<version>-windows-amd64-portable.zip` — portable: unzip
  anywhere and run `nats-desktop.exe`; see the bundled `README-portable.txt`
  (免安装说明 / 使用提示).

System requirements: Windows 10 or later (x64), Microsoft WebView2 Runtime
(preinstalled on up-to-date Win10/11; the portable build does not install it
for you).

### SmartScreen warning (unsigned build, TODO-002)

The binaries are not code-signed yet, so SmartScreen shows
"Windows protected your PC". Choose `More info` → `Run anyway`, or unblock
the file first via file `Properties` → `Unblock`. Always verify the download
against `SHA256SUMS.txt` first:

```
certutil -hashfile nats-desktop-amd64-installer.exe SHA256
```

(compare with the hash published alongside the release; `sha256sum -c
SHA256SUMS.txt` also works).

### Security & settings notes

- Connection contexts are natscli-compatible files under
  `%USERPROFILE%\.config\nats\context\` (or `%XDG_CONFIG_HOME%`); they store
  usernames, passwords, and credential files **in plaintext**, same as the
  nats CLI. Only use trusted machines.
- Language switch: Settings → Appearance → Language (`en` / `zh-CN`).
- Update check: Settings → Privacy → "Check for updates" (on by default,
  opt-out; it only queries GitHub release metadata).

### Building a release

Requires [NSIS](https://nsis.sourceforge.io) (`makensis`) on PATH. From
`desktop/`:

```
wails3 task windows:package INSTALL_SCOPE=user VERSION=1.0.0
powershell -ExecutionPolicy Bypass -File scripts/make-release.ps1 -Version 1.0.0
```

The script hard-fails unless both artifacts report version `1.0.0` (via the
Win32 `VerQueryValue` API — `FileVersionInfo` reads empty on wails-built exes)
and each stays under 30 MB, then emits the portable zip + `SHA256SUMS.txt`
into `bin/dist/`.

