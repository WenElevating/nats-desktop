# soak.ps1: 24h stability harness (M6 Task 7, AC-025).
#
# Orchestrates the §12.1 typical-load soak against the resident nats-server on
# nats://127.0.0.1:4333 (PID may vary; dataset baseline note below):
#   - launches the app (auto-restores last_active_context = local-test @4333),
#   - starts the flood injector at 1k msg/s on the soak subject for the full
#     duration (cmd/flood flags: -url/-subject/-rate/-size/-dur),
#   - creates ONE realtime subscription session on the flood subject via UIA
#     (M5 smoke method: the session ring-buffer/event pipeline is the
#     easiest subsystem to leave out — the brief explicitly requires it),
#   - cycles the eight sidebar nav entries every -NavIntervalSec (60s) via UIA,
#   - samples the app process tree every cycle with perf-sample.ps1
#     (CSV: timestamp,private_mb,ws_mb,cpu_s,handles,threads),
#   - writes verdict.txt at the end: crash/WER check, 1h-point vs final
#     private growth (<=10%), handles/threads first-vs-last stability,
#     best-effort session-counter liveness evidence.
#
# SERVER BASELINE (do not confuse with the app verdict): the 4333 server
# idles at ~1.16GB private because it carries the M6 Task 6 dataset
# (10k streams / 1M msgs / 100k KV keys). That memory belongs to the SERVER
# process, not the app. The app verdict samples ONLY the app process tree
# (nats-desktop.exe + its WebView2 children) via perf-sample.ps1.
#
# Crash handling: if the app process dies mid-run, the script detects it
# within ~2s, stops flood, KEEPS the CSV, writes CRASH.txt with the
# timestamp, and exits 3. A crash is data, not a harness failure.
#
# Known deviations (documented, m6-perf.md §S2): under a locked desktop,
# WebView2 reports visibilityState=hidden so the monitoring poll loop stays
# gated off (useMonitor lifecycle gate). Nav cycling still visits every page
# per cycle; the "monitoring polling on" third component of §12 typical load
# therefore degrades to "monitoring page mounts + initial fetch per cycle".
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\soak.ps1                # 24h
#   powershell ... -File scripts\soak.ps1 -Hours 0.1                                    # ~6min validation
#   powershell ... -File scripts\soak.ps1 -Hours 0.5 -OutDir D:\somewhere               # 30min validation
# Exit codes: 0 = ran to completion (verdict.txt written); 3 = app crash
# detected (CRASH.txt written, CSV kept — includes app death that surfaces as
# a harness error, re-classified via the liveness probe); 2 = harness/setup
# failure. Flood early-exit is NOT fatal: WARN-logged once and surfaced in the
# verdict as "flood ran full duration: no ..." so a false-PASS cannot hide it.
param(
  [double]$Hours = 24,
  [string]$Subject = "soak.load",
  [int]$Rate = 1000,
  [int]$Size = 1024,
  [int]$NavIntervalSec = 60,
  [string]$OutDir = ""
)
$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# --- paths -------------------------------------------------------------------
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoDir   = Split-Path -Parent $scriptDir          # desktop/
$binDir    = Join-Path $repoDir "bin"
$appExe    = Join-Path $binDir "nats-desktop.exe"
$floodExe  = Join-Path $binDir "flood.exe"
$samplePs1 = Join-Path $scriptDir "perf-sample.ps1"
if (-not $OutDir) { $OutDir = Join-Path $binDir ("soak-" + (Get-Date -Format "yyyyMMdd-HHmmss")) }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$csvPath   = Join-Path $OutDir "samples.csv"
$logPath   = Join-Path $OutDir "soak.log"
$floodLog  = Join-Path $OutDir "flood.out.log"
$floodErr  = Join-Path $OutDir "flood.err.log"
$sampLog   = Join-Path $OutDir "sampler.out.log"
$verdict   = Join-Path $OutDir "verdict.txt"

function Write-Log([string]$msg) {
  $line = "{0} {1}" -f (Get-Date -Format o), $msg
  $line | Out-File $logPath -Append -Encoding utf8
  Write-Host $line
}

Write-Log ("soak.ps1 starting: Hours={0} Subject={1} Rate={2}/s Size={3}B NavInterval={4}s" -f $Hours, $Subject, $Rate, $Size, $NavIntervalSec)
Write-Log ("OutDir={0}" -f $OutDir)
Write-Log ("NOTE server baseline: 4333 idles ~1.16GB private (carries Task 6 dataset 10k streams/1M msgs/100k KV). App verdict below samples the APP TREE ONLY.")

# --- nav labels (by app language, settings.json appearance.language) ---------
# zh-CN labels are the M5-smoke-verified UIA names (task-14-m5-report.md /
# m5 test report §6: InvokePattern on native <button> nav entries; table rows
# expose TogglePattern instead — handled by Click-El fallback).
$navZh = @(([char]0x603B+[char]0x89C8), ([char]0x6D88+[char]0x606F), ([char]0x6D41), ([char]0x6D88+[char]0x8D39+[char]0x8005), ([char]0x952E+[char]0x503C+[char]0x5B58+[char]0x50A8), ([char]0x5BF9+[char]0x8C61+[char]0x5B58+[char]0x50A8), ([char]0x76D1+[char]0x63A7), ([char]0x8BBE+[char]0x7F6E))
$navEn = @("Dashboard","Messages","Streams","Consumers","KeyValue","Objects","Monitoring","Settings")
$tabZh = [string]([char]0x8BA2+[char]0x9605+[char]0x4F1A+[char]0x8BDD)   # sessions tab
$tabEn = "Sessions"
$btnZh = [string]([char]0x8BA2+[char]0x9605)                              # create button
$btnEn = "Subscribe"

$lang = "zh-CN"
$settingsPath = Join-Path $env:APPDATA "nats-desktop\settings.json"
if (Test-Path $settingsPath) {
  try {
    $raw = Get-Content $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($raw.appearance.language) { $lang = $raw.appearance.language }
  } catch { Write-Log ("WARN settings.json unreadable, defaulting lang zh-CN: {0}" -f $_.Exception.Message) }
}
if ($lang -eq "zh-CN") { $navLabels = $navZh; $tabLabel = $tabZh; $createLabel = $btnZh }
else                   { $navLabels = $navEn; $tabLabel = $tabEn; $createLabel = $btnEn }
if ($navLabels.Count -ne 8) { Write-Log ("FATAL nav label table broken: count={0}" -f $navLabels.Count); exit 2 }
Write-Log ("app language={0} nav labels: {1}" -f $lang, (($navLabels | ForEach-Object { "[$_]" }) -join " "))

# --- UIA helpers (M5 smoke method) --------------------------------------------
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$uiaRoot = [System.Windows.Automation.AutomationElement]::RootElement

function Find-AppWindow {
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, "NATS Desktop")
  return $uiaRoot.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
}

function Find-ByName([System.Windows.Automation.AutomationElement]$win, [string]$name, [string]$type) {
  $tcond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::$type)
  $ncond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $name)
  $and = New-Object System.Windows.Automation.AndCondition($tcond, $ncond)
  return $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $and)
}

function Click-El($el) {
  # nav buttons: InvokePattern (M5 verified); role=button table rows expose
  # TogglePattern instead — try Invoke first, then Toggle.
  try {
    $p = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $p.Invoke(); return "invoke"
  } catch { }
  $p2 = $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
  $p2.Toggle(); return "toggle"
}

function Set-ValueEl($el, [string]$val) {
  try {
    $p = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $p.SetValue($val); return
  } catch {
    Set-Clipboard -Value $val
    $el.SetFocus()
    Start-Sleep -Milliseconds 300
    $send = New-Object -ComObject WScript.Shell
    $send.SendKeys("^v")
  }
}

# Retry-find with window re-discovery: Chromium may deactivate the renderer
# accessibility tree between UIA clients (M5: reactivates naturally under
# repeated WM_GETOBJECT pings, ~seconds). Each attempt re-finds the window.
function Find-ElWithRetry([string]$name, [string]$type, [int]$timeoutSec) {
  $end = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $end) {
    $win = Find-AppWindow
    if ($win) {
      $el = Find-ByName $win $name $type
      if ($el) { return $el }
    }
    Start-Sleep -Seconds 2
  }
  return $null
}

function Wait-UiTree([int]$timeoutSec) {
  $end = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $end) {
    $win = Find-AppWindow
    if ($win) {
      $tcond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
      $btns = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tcond)
      if ($btns.Count -ge 5) { return $win }
    }
    Start-Sleep -Seconds 2
  }
  return $null
}

# --- preflight ----------------------------------------------------------------
function Test-Port4333 {
  try {
    $c = New-Object Net.Sockets.TcpClient
    $c.Connect("127.0.0.1", 4333)
    $c.Close(); return $true
  } catch { return $false }
}

if (-not (Test-Path $appExe))  { Write-Log "FATAL app exe missing: $appExe";  exit 2 }
if (-not (Test-Port4333))      { Write-Log "FATAL nats-server not listening on 127.0.0.1:4333"; exit 2 }
Write-Log "preflight: app exe present, 4333 listening"

foreach ($stray in @("nats-desktop", "flood")) {
  $p = Get-Process -Name $stray -ErrorAction SilentlyContinue
  if ($p) {
    Write-Log ("preflight: stopping stray {0} process(es): {1}" -f $stray, (($p | ForEach-Object Id) -join ","))
    $p | Stop-Process -Force
    Start-Sleep -Seconds 2
  }
}

function Get-WerCount([datetime]$since) {
  $n = 0
  foreach ($d in @((Join-Path $env:ProgramData "Microsoft\Windows\WER\ReportArchive"), (Join-Path $env:ProgramData "Microsoft\Windows\WER\ReportQueue"))) {
    if (Test-Path $d) {
      $n += @(Get-ChildItem $d -ErrorAction SilentlyContinue |
        Where-Object { ($_.Name -like "*nats-desktop*") -and ($_.LastWriteTime -ge $since) }).Count
    }
  }
  return $n
}
$runStart = Get-Date
$werBefore = Get-WerCount $runStart.AddMinutes(-1)
Write-Log ("WER baseline: {0} pre-existing nats-desktop reports (window = last 1min before start)" -f $werBefore)

# --- build flood (brief step 0: explicit build + explicit flags) --------------
Push-Location $repoDir
try {
  $buildOut = & go build -o "bin\flood.exe" ".\cmd\flood" 2>&1
  if ($LASTEXITCODE -ne 0) { Write-Log ("FATAL go build flood failed: {0}" -f ($buildOut -join " ")); exit 2 }
} finally { Pop-Location }
Write-Log ("flood built: {0}" -f $floodExe)

# --- launch sampler (perf-sample.ps1, app tree only) --------------------------
$sampler = Start-Process -FilePath "powershell.exe" -ArgumentList @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $samplePs1,
    "-ProcName", "nats-desktop", "-OutCsv", $csvPath, "-IntervalSec", $NavIntervalSec
  ) -NoNewWindow -PassThru -RedirectStandardOutput $sampLog
Write-Log ("sampler started pid={0} csv={1}" -f $sampler.Id, $csvPath)

# --- launch flood ---------------------------------------------------------------
$totalMin = [math]::Max(1, [int][math]::Round($Hours * 60))
$durArg = "{0}m" -f $totalMin
$flood = Start-Process -FilePath $floodExe -ArgumentList @(
    "-url", "nats://127.0.0.1:4333", "-subject", $Subject,
    "-rate", "$Rate", "-size", "$Size", "-dur", $durArg
  ) -NoNewWindow -PassThru -RedirectStandardOutput $floodLog -RedirectStandardError $floodErr
try { $flood.PriorityClass = "AboveNormal" } catch { Write-Log "WARN: could not raise flood priority (running at normal)" }
Write-Log ("flood started pid={0} dur={1} -> {2}" -f $flood.Id, $durArg, $floodLog)

# --- launch app (auto-restores last_active_context -> local-test @4333) ------
$app = Start-Process -FilePath $appExe -WorkingDirectory $binDir -PassThru
$appPid = $app.Id
Write-Log ("app started pid={0} (auto-connect local-test@4333 expected)" -f $appPid)

# PID files so an operator can clean up after an interrupted run
Set-Content -Path (Join-Path $OutDir "app.pid")     -Value $appPid
Set-Content -Path (Join-Path $OutDir "flood.pid")   -Value $flood.Id
Set-Content -Path (Join-Path $OutDir "sampler.pid") -Value $sampler.Id

$deadline = $runStart.AddHours($Hours)
$script:cleanupDone = $false
$script:skipCleanup = $false   # set true on the NORMAL end path: evidence read + verdict still need live processes; explicit Stop-SoakChildren runs after
function Stop-SoakChildren {
  if ($script:cleanupDone) { return }
  $script:cleanupDone = $true
  try {
    if ($flood -and -not $flood.HasExited) { Stop-Process -Id $flood.Id -Force -ErrorAction SilentlyContinue; Write-Log "cleanup: flood stopped" }
  } catch { }
  try {
    $a = Get-Process -Id $appPid -ErrorAction SilentlyContinue
    if ($a) {
      $null = $a.CloseMainWindow()
      Start-Sleep -Seconds 8
      if (Get-Process -Id $appPid -ErrorAction SilentlyContinue) { Stop-Process -Id $appPid -Force -ErrorAction SilentlyContinue }
      Write-Log "cleanup: app closed"
    }
  } catch { }
  try {
    $s = Get-Process -Id $sampler.Id -ErrorAction SilentlyContinue
    if ($s) {
      # perf-sample self-exits once the app process is gone; grace then kill.
      $waitEnd = (Get-Date).AddSeconds($NavIntervalSec + 30)
      while ((Get-Date) -lt $waitEnd -and (Get-Process -Id $sampler.Id -ErrorAction SilentlyContinue)) { Start-Sleep -Seconds 5 }
      if (Get-Process -Id $sampler.Id -ErrorAction SilentlyContinue) { Stop-Process -Id $sampler.Id -Force -ErrorAction SilentlyContinue; Write-Log "cleanup: sampler killed after grace" }
      else { Write-Log "cleanup: sampler self-exited" }
    }
  } catch { }
}

function Test-AppAlive { return [bool](Get-Process -Id $appPid -ErrorAction SilentlyContinue) }

# CRASH path (shared by the main-loop detector and the catch-block classifier):
# keep the CSV, write the marker (timestamp, last sample, WER delta), exit 3.
# A crash is data, not a harness failure.
function Write-CrashExit([string]$reason) {
  Write-Log ("CRASH detected: {0}" -f $reason)
  $lastRow = ""
  if (Test-Path $csvPath) {
    $rows = @(Import-Csv $csvPath)
    if ($rows.Count -gt 0) {
      $lr = $rows[$rows.Count - 1]
      $lastRow = "{0} private={1} handles={2} threads={3}" -f $lr.timestamp, $lr.private_mb, $lr.handles, $lr.threads
    }
  }
  $werNow = Get-WerCount $runStart
  $marker = @(
    "CRASH: $($reason)",
    "detected_at: $((Get-Date).ToString("o"))",
    "run_start: $($runStart.ToString("o"))",
    "elapsed_min: $([math]::Round(((Get-Date) - $runStart).TotalMinutes, 1))",
    "last_sample: $lastRow",
    "new_wer_reports_since_start: $werNow",
    "samples_csv: $csvPath",
    "flood_log: $floodLog",
    "soak_log: $logPath"
  )
  $marker | Out-File (Join-Path $OutDir "CRASH.txt") -Encoding utf8
  Write-Log ("CRASH.txt written; samples kept at {0}" -f $csvPath)
  exit 3
}

# --- session creation via UIA (brief step 4; M5 method) ----------------------
# Throws on failure -> harness failure (exit 2): the session leg is mandatory.
function New-SoakSession {
  # 1) nav to Messages
  $msgBtn = Find-ElWithRetry $navLabels[1] "Button" 60
  if (-not $msgBtn) { throw "nav button '$($navLabels[1])' not found" }
  [void](Click-El $msgBtn)
  Start-Sleep -Milliseconds 1200
  Write-Log ("session: nav '{0}' ok" -f $navLabels[1])

  # 2) select the sessions tab (TabItem, Button fallback)
  $tab = $null
  $end = (Get-Date).AddSeconds(30)
  while (-not $tab -and (Get-Date) -lt $end) {
    $win = Find-AppWindow
    if ($win) { $tab = Find-ByName $win $tabLabel "TabItem"; if (-not $tab) { $tab = Find-ByName $win $tabLabel "Button" } }
    if (-not $tab) { Start-Sleep -Seconds 2 }
  }
  if (-not $tab) { throw "tab '$tabLabel' not found" }
  $sel = $false
  try { ($tab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)).Select(); $sel = $true } catch { }
  if (-not $sel) { [void](Click-El $tab) }
  Start-Sleep -Milliseconds 1200
  Write-Log ("session: tab '{0}' selected" -f $tabLabel)

  # 3) subject input (AutomationId is locale-independent)
  $subj = $null
  $end = (Get-Date).AddSeconds(30)
  while (-not $subj -and (Get-Date) -lt $end) {
    $win = Find-AppWindow
    if ($win) {
      $idCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, "session-subject")
      $subj = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $idCond)
    }
    if (-not $subj) { Start-Sleep -Seconds 2 }
  }
  if (-not $subj) { throw "session-subject input not found" }
  Set-ValueEl $subj $Subject
  Start-Sleep -Milliseconds 600
  $v = ""
  try { $v = $subj.GetCurrentPropertyValue([System.Windows.Automation.ValuePattern]::ValueProperty) } catch { }
  Write-Log ("session: subject set '{0}'" -f $v)
  if ($v -ne $Subject) { Set-ValueEl $subj $Subject; Start-Sleep -Milliseconds 600 }

  # 4) create button — wait until enabled (gated on live connection; this is
  #    also our implicit proof the app connected to 4333)
  $create = $null
  $end = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $end) {
    $win = Find-AppWindow
    if ($win) {
      $create = Find-ByName $win $createLabel "Button"
      if ($create -and $create.Current.IsEnabled) { break }
      $create = $null
    }
    Start-Sleep -Seconds 2
  }
  if (-not $create) { throw "create button '$createLabel' not found/enabled (app connected?)" }
  [void](Click-El $create)
  Write-Log ("session: '{0}' clicked" -f $createLabel)

  # 5) verify the session chip (named by subject) appears
  $chip = Find-ElWithRetry $Subject "Text" 20
  if (-not $chip) {
    $win = Find-AppWindow
    if ($win) {
      $all = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
      foreach ($el in $all) { if ($el.Current.Name -like "*$Subject*") { $chip = $el; break } }
    }
  }
  if (-not $chip) { throw "session chip '$Subject' not visible after create" }
  Write-Log ("SESSION-CREATED chip='{0}' ({1})" -f $chip.Current.Name, $chip.Current.ControlType.ProgrammaticName)
}

# --- end-of-run session liveness evidence (best-effort; brief step 6) --------
# Navigates back to the session and scrapes chip/status names; the Go-side
# session keeps receiving while the nav cycles visit other pages, so a
# non-zero counter late in the run = pipeline stayed alive.
function Read-SessionEvidence {
  try {
    $msgBtn = Find-ElWithRetry $navLabels[1] "Button" 30
    if (-not $msgBtn) { return "nav-miss" }
    [void](Click-El $msgBtn)
    Start-Sleep -Milliseconds 1200
    $win = Find-AppWindow
    if (-not $win) { return "window-gone" }
    $tab = Find-ByName $win $tabLabel "TabItem"
    if (-not $tab) { $tab = Find-ByName $win $tabLabel "Button" }
    if ($tab) {
      try { ($tab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)).Select() } catch { [void](Click-El $tab) }
      Start-Sleep -Seconds 2
    }
    $names = @()
    $all = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($el in $all) {
      $n = $el.Current.Name
      if ($n -and ($n -like "*$Subject*" -or $n -like "*msg/s*")) { $names += $n }
      if ($names.Count -ge 6) { break }
    }
    if ($names.Count -eq 0) { return "no-elements" }
    return ($names -join " || ")
  } catch { return "error: $($_.Exception.Message)" }
}

# --- main soak loop ------------------------------------------------------------
$crashReason = ""
$cycle = 0
$navIdx = 0
$navMisses = 0
$consecMiss = 0
$lastCycleAt = Get-Date
$evDone = $false
$evidence1 = "(not taken)"
$floodDied = $false
$floodDiedAt = ""
try {
  $win = Wait-UiTree 120
  if (-not $win) { throw "UIA tree did not activate within 120s" }
  Write-Log "UIA tree active"
  New-SoakSession

  Write-Log ("nav loop: every {0}s through {1} pages until {2}" -f $NavIntervalSec, $navLabels.Count, $deadline.ToString("o"))
  while ($true) {
    $now = Get-Date
    if (-not (Test-AppAlive)) {
      $crashReason = "app process pid=$appPid gone at $now"
      break
    }
    if ($now -ge $deadline) { break }

    # flood liveness (T7 review fix-first #1): flood runs nats.NoReconnect and
    # exits on its first publish/connection error, so a 4333 hiccup silently
    # kills the load leg while the rest of the soak keeps going. Checked once
    # per iteration; only the FIRST detection is logged (never spammy) and it
    # is surfaced in the verdict as "flood ran full duration: no".
    if (-not $floodDied) {
      try {
        if ($flood.HasExited) {
          $floodDied = $true
          $floodDiedAt = $now.ToString("o")
          Write-Log ("WARN flood injector exited early at {0} (pid={1}); continuing soak without injected load" -f $floodDiedAt, $flood.Id)
        }
      } catch { }
    }

    # evidence t0 just before the deadline, while flood is still publishing:
    # the t0/t1 counter pair then spans live flood time (t1 taken after the
    # loop), making the counter-growth check meaningful.
    if ((-not $evDone) -and (($deadline - $now).TotalSeconds -le 40)) {
      $evDone = $true
      $evidence1 = Read-SessionEvidence
      Write-Log ("session evidence t0 (pre-deadline): {0}" -f $evidence1)
    }

    if (($now - $lastCycleAt).TotalSeconds -ge $NavIntervalSec) {
      $cycle++
      $target = $navLabels[$navIdx]
      $clicked = $false
      # retry up to ~30s per cycle for tree reactivation; a miss is logged,
      # never fatal (UIA flakiness must not kill a 24h soak)
      $end = (Get-Date).AddSeconds(30)
      while ((Get-Date) -lt $end) {
        if (-not (Test-AppAlive)) { $crashReason = "app process pid=$appPid gone at $(Get-Date -Format o)"; break }
        $w = Find-AppWindow
        if ($w) {
          $btn = Find-ByName $w $target "Button"
          if ($btn -and $btn.Current.IsEnabled) { [void](Click-El $btn); $clicked = $true; break }
        }
        Start-Sleep -Seconds 2
      }
      if ($crashReason) { break }
      if ($clicked) {
        $consecMiss = 0
        Write-Log ("nav cycle {0}: -> '{1}' ok" -f $cycle, $target)
      } else {
        $navMisses++; $consecMiss++
        Write-Log ("nav cycle {0}: MISS '{1}' (consecutive={2}, total={3})" -f $cycle, $target, $consecMiss, $navMisses)
      }
      $navIdx = ($navIdx + 1) % $navLabels.Count
      $lastCycleAt = Get-Date
    }
    Start-Sleep -Seconds 2
  }

  if ($crashReason) {
    # ---- CRASH PATH: keep the CSV, write the marker, exit 3 -----------------
    Write-CrashExit $crashReason
  }
  # normal completion: keep processes alive for the evidence read below;
  # Stop-SoakChildren runs explicitly after it (finally only cleans on
  # crash/abort paths where exit was already called from inside the try).
  $script:skipCleanup = $true
} catch {
  Write-Log ("FATAL harness error: {0}" -f $_.Exception.Message)
  Write-Log ($_ | Out-String)
  # T7 review fix-first #2: classify early app death. If the app process is
  # already gone, the harness error is a SYMPTOM of an app crash (e.g. the
  # UIA tree vanished because the app died) — record it as crash data
  # (CRASH.txt with WER delta, exit 3), not as a harness fault (exit 2).
  if (-not (Test-AppAlive)) {
    Write-CrashExit ("app process pid={0} gone when harness error surfaced at {1}; original harness error: {2}" -f $appPid, (Get-Date -Format o), $_.Exception.Message)
  }
  exit 2
} finally {
  if (-not $script:skipCleanup) { Stop-SoakChildren }
}

# --- normal end: session evidence (t0 was taken pre-deadline if possible) -----
Write-Log "run complete; reading session evidence"
if (-not $evDone) { $evidence1 = Read-SessionEvidence }
Start-Sleep -Seconds 6
$evidence2 = Read-SessionEvidence
Write-Log ("session evidence t0: {0}" -f $evidence1)
Write-Log ("session evidence t1: {0}" -f $evidence2)

# explicit cleanup on the normal path (finally was skipped for this reason)
Stop-SoakChildren

# app log tail for the record (G5: aggregate lines only, no payload/creds)
$appLog = Join-Path $env:APPDATA "nats-desktop\logs\nats-desktop.log"
if (Test-Path $appLog) {
  try {
    $tail = Get-Content $appLog -Tail 200 -Encoding UTF8
    $tail | Out-File (Join-Path $OutDir "applog-tail.log") -Encoding utf8
  } catch { }
}

# --- verdict -------------------------------------------------------------------
$runEnd = Get-Date
$werNew = Get-WerCount $runStart
$lines = @()
$lines += "SOAK VERDICT (AC-025)"
$lines += ("run: start={0} end={1} requested={2}h actual={3}h" -f $runStart.ToString("o"), $runEnd.ToString("o"), $Hours, [math]::Round(($runEnd - $runStart).TotalHours, 3))
$lines += ("load: subject={0} rate={1}/s size={2}B nav_interval={3}s" -f $Subject, $Rate, $Size, $NavIntervalSec)
$lines += ("NOTE: 4333 server idles ~1.16GB private (Task 6 dataset); app verdict uses the APP TREE ONLY (perf-sample scope).")
$lines += ""
$lines += ("[1] crash: app alive across full run: YES (normal end); new WER reports since start: {0}" -f $werNew)
$c1 = "PASS"
if ($werNew -gt 0) { $c1 = "FAIL (new WER records)" }
$lines += ("    -> {0}" -f $c1)
$lines += ""

if (-not (Test-Path $csvPath)) {
  $lines += "[2][3][4] FATAL: no samples CSV at $csvPath"
} else {
  $rows = @(Import-Csv $csvPath)
  $inv = [System.Globalization.CultureInfo]::InvariantCulture
  $pts = foreach ($r in $rows) {
    $ts = [datetime]::Parse($r.timestamp, $inv, [System.Globalization.DateTimeStyles]::RoundtripKind)
    [pscustomobject]@{
      ts      = $ts
      privMb  = [double]::Parse($r.private_mb, $inv)
      handles = [double]::Parse($r.handles, $inv)
      threads = [double]::Parse($r.threads, $inv)
    }
  }
  if ($pts.Count -lt 2) {
    $lines += ("[2][3][4] INSUFFICIENT SAMPLES: {0} row(s) in {1}" -f $pts.Count, $csvPath)
  } else {
    $first = $pts[0]; $last = $pts[$pts.Count - 1]
    $durH = ($last.ts - $first.ts).TotalHours
    # CSV freshness guard (T7 review): a stalled sampler would make the
    # end-state gates read stale data — annotate BEFORE they are computed.
    $staleSec = ($runEnd - $last.ts).TotalSeconds
    if ($staleSec -gt (3 * $NavIntervalSec)) {
      $lines += ("    NOTE csv-freshness: last sample is {0}s old at verdict time (> 3x interval {1}s) - sampler may have stalled; judge end-state numbers accordingly" -f [math]::Round($staleSec, 0), $NavIntervalSec)
    }
    # 1h point: sample nearest t0+1h (criterion needs a run >= 1h)
    $h1Target = $first.ts.AddHours(1)
    $h1 = $pts | Sort-Object { [math]::Abs(($_.ts - $h1Target).TotalSeconds) } | Select-Object -First 1
    $hasH1 = $durH -ge 0.9
    $h1Note = ""
    if (-not $hasH1) {
      # validation runs (<1h): use the midpoint as a reference-only proxy
      $midTarget = $first.ts.AddHours($durH / 2)
      $h1 = $pts | Sort-Object { [math]::Abs(($_.ts - $midTarget).TotalSeconds) } | Select-Object -First 1
      $h1Note = " (run <1h: MIDPOINT used as reference-only; the <=10% criterion needs the full 24h run)"
    }
    $growth = 0.0
    if ($h1.privMb -gt 0) { $growth = ($last.privMb - $h1.privMb) / $h1.privMb * 100.0 }
    $c2 = "PASS"
    if ($hasH1 -and $growth -gt 10.0) { $c2 = "FAIL (growth > 10%)" }
    $lines += ("[2] memory (private, app tree): first={0}MB  ref(1h)={1}MB @ {2}  final={3}MB  growth={4}%{5}" -f `
      [math]::Round($first.privMb, 1), [math]::Round($h1.privMb, 1), $h1.ts.ToString("HH:mm:ss"), [math]::Round($last.privMb, 1), [math]::Round($growth, 2), $h1Note)
    $lines += ("    -> {0}   [abs 300MB gate already adjudicated FAIL in m6-perf.md §7; §12.1 growth-rate criterion only]" -f $c2)
    $lines += ""

    $critNo = 3
    foreach ($col in @("handles", "threads")) {
      $vals = @($pts | ForEach-Object { $_.$col })
      $max = ($vals | Measure-Object -Maximum).Maximum
      $min = ($vals | Measure-Object -Minimum).Minimum
      $mean = ($vals | Measure-Object -Average).Average
      # linear regression slope per hour over all samples
      $sx = 0.0; $sy = 0.0; $sxy = 0.0; $sxx = 0.0; $n = $vals.Count
      for ($i = 0; $i -lt $n; $i++) {
        $x = ($pts[$i].ts - $first.ts).TotalHours; $y = $vals[$i]
        $sx += $x; $sy += $y; $sxy += $x * $y; $sxx += $x * $x
      }
      $denom = $n * $sxx - $sx * $sx
      $slope = 0.0
      if ($denom -ne 0) { $slope = ($n * $sxy - $sx * $sy) / $denom }
      $rel = 0.0
      if ([math]::Max($first.$col, 1) -gt 0) { $rel = ($last.$col - $first.$col) / [math]::Max($first.$col, 1) * 100.0 }
      $stable = "STABLE"
      if ([math]::Abs($rel) -gt 20.0) { $stable = "REVIEW (relative change > 20%)" }
      $lines += ("[{0}] {1}: first={2} min={3} mean={4} max={5} last={6} slope={7}/h relchange={8}% -> {9}" -f `
        $critNo, $col, $first.$col, $min, [math]::Round($mean, 1), $max, $last.$col, [math]::Round($slope, 1), [math]::Round($rel, 2), $stable)
      # ref-point (the 1h sample on a full run; midpoint on validation runs):
      # startup ramp (WebView2 children spawning) biases first-sample reads,
      # so the operator should judge persistence against the ref point.
      $relRef = ($last.$col - $h1.$col) / [math]::Max($h1.$col, 1) * 100.0
      $lines += ("    {0} ref-point(1h)={1} -> last={2} (rel {3}%)" -f `
        $col, $h1.$col, $last.$col, [math]::Round($relRef, 2))
      $critNo++
    }
    $lines += ""
  }
}
$lines += ("[5] session pipeline evidence (Go-side session kept receiving across nav cycles):")
$lines += ("    t0 (pre-deadline): {0}" -f $evidence1)
$lines += ("    t1 (after loop):   {0}" -f $evidence2)
$evGrowth = "UNKNOWN (no counter parsed)"
$t0c = $null; $t1c = $null
if ($evidence1 -match "(\d{4,})") { $t0c = [long]$Matches[1] }
if ($evidence2 -match "(\d{4,})") { $t1c = [long]$Matches[1] }
if ($null -ne $t0c -and $null -ne $t1c) {
  if ($t1c -gt $t0c) { $evGrowth = "GROWING ({0} -> {1}, +{2}) = pipeline alive" -f $t0c, $t1c, ($t1c - $t0c) }
  elseif ($t1c -eq $t0c) { $evGrowth = "FLAT ({0} -> {1})" -f $t0c, $t1c }
  else { $evGrowth = "DECREASED ({0} -> {1}) - investigate" -f $t0c, $t1c }
}
$lines += ("    counter growth: {0}" -f $evGrowth)
$lines += ""
# flood liveness verdict line (T7 review fix-first #1): guards against a
# silent false-PASS when a 4333 hiccup killed the injector mid-run.
if ($floodDied) {
  $lines += ("flood ran full duration: no (injector exited early, first detected {0} - flood uses nats.NoReconnect so a 4333 hiccup kills the load; judge load-dependent evidence accordingly)" -f $floodDiedAt)
} else {
  $lines += "flood ran full duration: yes"
}
$lines += ("nav cycles={0} nav_misses_total={1} navmiss_streak_end={2}" -f $cycle, $navMisses, $consecMiss)
$lines += ("files: csv={0}" -f $csvPath)
$lines += ("       log={0} flood={1} applog_tail={2}" -f $logPath, $floodLog, (Join-Path $OutDir "applog-tail.log"))
$lines += ("flood tail: {0}" -f ((Get-Content $floodLog -Tail 3 -ErrorAction SilentlyContinue) -join " | "))

$lines | Out-File $verdict -Encoding utf8
Write-Log ("verdict written: {0}" -f $verdict)
$lines | ForEach-Object { Write-Host $_ }
exit 0
