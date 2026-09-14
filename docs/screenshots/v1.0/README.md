# Screenshots v1.0 (G11 reference set) — PENDING-MANUAL

The 32 baseline captures (8 pages x 2 themes x 2 languages, AC-026) were NOT
generated in M6 Task 8: `desktop/scripts/screenshots.ps1` captures the visible
desktop with Graphics.CopyFromScreen and switches theme/language over real UI
interaction, so it must run in an unlocked interactive desktop session. Per the
brief (review F18) it was not executed in the locked-session window; the shots
stay PENDING-MANUAL for the user.

## How to generate (exact user steps)

1. Unlock the desktop's interactive session (the script aborts on lock-screen
   black/uniform frames by design).
2. Ensure the NATS server is reachable at `nats://127.0.0.1:4333` and the app
   binary exists: `desktop/bin/nats-desktop.exe` (build with
   `wails3 task windows:build VERSION=1.0.0` if missing).
3. From the repo root:
   `powershell -ExecutionPolicy Bypass -File desktop/scripts/screenshots.ps1`
4. The script relaunches the app (with renderer accessibility enabled), walks
   8 pages x 2 themes x 2 languages via UIA, saves each PNG here as
   `{page}-{theme}-{lang}.png`, restores light/zh-CN, and writes a stamped
   README with the build version.

Reference-set caveat: captures reflect the local test server's data state at
generation time; they are visual reference material, not pixel regression
fixtures.
