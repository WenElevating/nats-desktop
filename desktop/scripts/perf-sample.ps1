param([string]$ProcName = "nats-desktop", [string]$OutCsv, [int]$IntervalSec = 60, [int]$DurationMin = 0, [int]$MaxWaitSec = 180)
# Memory sampler (M6 Task 5, reused by Tasks 6/7). 口径 (M2 acceptance §4.3):
# private working set summed over the MAIN process AND all its WebView2 children
# (msedgewebview2.exe whose CommandLine references this app's WebView2 user-data
# dir). Main-only would read ~60MB of a ~238MB baseline.
#
# Child-matching rule, verified empirically (2026-09-14, build VERSION=1.0.0,
# wails v3.0.0-beta.20): every msedgewebview2.exe child of this app carries
#   --user-data-dir=%APPDATA%\nats-desktop.exe\EBWebView
# plus --webview-exe-name=nats-desktop.exe --webview-exe-version=1.0.0 in its
# CommandLine, e.g.:
#   "C:\Program Files (x86)\Microsoft\EdgeWebView\Application\152.0.4191.66\msedgewebview2.exe"
#   --embedded-browser-webview=1 --webview-exe-name=nats-desktop.exe
#   --user-data-dir="C:\Users\<u>\AppData\Roaming\nats-desktop.exe\EBWebView" ...
# Verified on this machine: 6 children matched (browser main, crashpad-handler,
# gpu-process, network utility, storage utility, renderer) while 26 other
# msedgewebview2.exe processes from OTHER apps (e.g. cc-switch.exe,
# %APPDATA%\com.ccswitch.desktop) did NOT match — the exe-name filter selects
# exactly this app's tree.
# DurationMin 0 = run until the process exits. CSV columns are the single
# source of truth:
#   timestamp,private_mb,ws_mb,cpu_s,handles,threads
if (-not $OutCsv) { $OutCsv = Join-Path $env:TEMP ("perf-" + (Get-Date -Format yyyyMMdd-HHmmss) + ".csv") }
# Culture-invariant numerics (Task 8 fix): "N1" renders group separators under
# regional formats (e.g. zh-CN "1,300.0"), which broke the CSV column layout
# once private_mb crossed 1000. "0.0" has no group separator in any culture.
$deadline = if ($DurationMin -gt 0) { (Get-Date).AddMinutes($DurationMin) } else { $null }
"timestamp,private_mb,ws_mb,cpu_s,handles,threads" | Out-File $OutCsv -Encoding utf8
# soak.ps1 starts this sampler BEFORE the app; the first check would race the
# launch and silently produce a header-only CSV (lost on run B / leg E). Wait
# bounded for the process to appear before the sample loop.
$waitedSec = 0
while ($true) {
  $main = Get-Process -Name $ProcName -ErrorAction SilentlyContinue
  if (-not $main) {
    if ($waitedSec -lt $MaxWaitSec) { Start-Sleep -Seconds 5; $waitedSec += 5; continue }
    break
  }
  # WebView2 children of THIS app: user-data dir keyed on the exe name (wails default).
  $children = Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" |
    Where-Object { $_.CommandLine -match [regex]::Escape($ProcName) }
  $set = @($main) + @($children | ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue })
  $row = "{0},{1:0.0},{2:0.0},{3:0.0},{4},{5}" -f (Get-Date -Format o),
    (($set | Measure-Object PrivateMemorySize64 -Sum).Sum / 1MB),
    (($set | Measure-Object WorkingSet64 -Sum).Sum / 1MB),
    (($set | Measure-Object CPU -Sum).Sum),
    (($set | Measure-Object HandleCount -Sum).Sum),
    (($set | ForEach-Object { $_.Threads.Count } | Measure-Object -Sum).Sum)
  $row | Out-File $OutCsv -Append -Encoding utf8
  if ($deadline -and ((Get-Date) -gt $deadline)) { break }
  Start-Sleep -Seconds $IntervalSec
}
Write-Host "samples -> $OutCsv"
