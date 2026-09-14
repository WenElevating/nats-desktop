#Requires -Version 5.1
<#
.SYNOPSIS
  AC-030 security sweep for nats-desktop (M6 Task 10).

.DESCRIPTION
  Three legs:
    1) Source scan: credential-shaped identifiers (password/passwd/pass/pwd/token/creds/
       credential/jwt/private_key/-----BEGIN) appearing on the same line as a log call
       (logger/slog methods, fmt.Print*, log.Fatal...) in desktop/internal/*.go (non-test)
       and desktop/main.go.
    2) Log sample scan: %APPDATA%\nats-desktop\logs\*.log grepped case-insensitively for
       'password|token|-----BEGIN'. Zero credential plaintext expected.
    3) Settings mask re-check: UIA assertion that credential-shaped edit fields on the
       Connections form report IsPassword=true. OPT-IN via -UiaMaskCheck because it needs
       the running app; POSTPONED while the 24h soak occupies the app (single-instance lock).

  Exit codes: 0 = clean/skipped-as-configured, 1 = findings, 2 = environment error.
  Note: *_test.go files are excluded (log-cleanliness TESTS legitimately contain these
  words next to log assertions); hits elsewhere are triaged by hand in the task report.
#>
param(
    [switch]$UiaMaskCheck,
    [string]$RepoRoot = (Join-Path $PSScriptRoot ".."),
    [string]$LogDir = (Join-Path $env:APPDATA "nats-desktop\logs")
)

$ErrorActionPreference = "Stop"
$findings = 0

Write-Host "=== AC-030 security sweep (nats-desktop) ==="
Write-Host ("RepoRoot : {0}" -f $RepoRoot)
Write-Host ("LogDir   : {0}" -f $LogDir)
Write-Host ""

# ---------- Leg 1: source scan ----------
Write-Host "--- Leg 1: source scan (credential word adjacent to a log call, non-test .go) ---"

$credWord = '(?i)(password|passwd|\bpass\b|\bpwd\b|\btokens?\b|\bcreds?\b|credential|jwt|private[_-]?key|-----BEGIN)'
$logCall   = '(\.\s*(Debug|Info|Warn|Error|Fatal)(f)?\s*\(|fmt\.Print|log\.Print|log\.Fatal)'

$goFiles = @()
$internal = Join-Path $RepoRoot "internal"
if (Test-Path $internal) {
    $goFiles += Get-ChildItem -Path $internal -Recurse -Filter *.go -File |
        Where-Object { $_.Name -notlike "*_test.go" }
}
$mainGo = Join-Path $RepoRoot "main.go"
if (Test-Path $mainGo) { $goFiles += Get-Item $mainGo }

if ($goFiles.Count -eq 0) {
    Write-Host "ERROR: no .go files found under $internal (and main.go missing)."
    exit 2
}
Write-Host ("Scanned files: {0}" -f $goFiles.Count)

$srcHits = New-Object System.Collections.Generic.List[string]
foreach ($f in $goFiles) {
    $lines = [System.IO.File]::ReadAllLines($f.FullName)
    for ($i = 0; $i -lt $lines.Length; $i++) {
        if ($lines[$i] -match $credWord -and $lines[$i] -match $logCall) {
            $srcHits.Add(("{0}:{1}: {2}" -f $f.FullName.Substring($RepoRoot.Length + 1), ($i + 1), $lines[$i].Trim()))
        }
    }
}

if ($srcHits.Count -eq 0) {
    Write-Host "PASS: 0 hits."
} else {
    $findings += $srcHits.Count
    Write-Host ("HITS: {0} (triage required)" -f $srcHits.Count)
    $srcHits | ForEach-Object { Write-Host ("  " + $_) }
}
Write-Host ""

# ---------- Leg 2: log sample scan ----------
Write-Host "--- Leg 2: log sample scan (%APPDATA%\nats-desktop\logs\*.log) ---"

if (-not (Test-Path $LogDir)) {
    Write-Host ("WARN: log dir not found ({0}); leg skipped as environment-missing." -f $LogDir)
    $logHits = @(); $logFiles = 0
} else {
    $logs = Get-ChildItem -Path $LogDir -Filter *.log -File
    $logFiles = $logs.Count
    $logHits = New-Object System.Collections.Generic.List[string]
    foreach ($lf in $logs) {
        try {
            $m = Select-String -Path $lf.FullName -Pattern 'password|token|-----BEGIN' -AllMatches -ErrorAction SilentlyContinue
            foreach ($hit in $m) {
                $logHits.Add(("{0}:{1}: {2}" -f $lf.Name, $hit.LineNumber, $hit.Line.Trim()))
            }
        } catch {
            Write-Host ("  WARN: could not read {0}: {1}" -f $lf.Name, $_.Exception.Message)
        }
    }
    Write-Host ("Scanned files: {0}" -f $logFiles)
    if ($logHits.Count -eq 0) {
        Write-Host "PASS: 0 credential-shaped strings in file logs."
    } else {
        $findings += $logHits.Count
        Write-Host ("HITS: {0} (triage required)" -f $logHits.Count)
        $logHits | Select-Object -First 40 | ForEach-Object { Write-Host ("  " + $_) }
        if ($logHits.Count -gt 40) { Write-Host ("  ... and {0} more" -f ($logHits.Count - 40)) }
    }
}
Write-Host ""

# ---------- Leg 3: settings mask re-check (opt-in) ----------
Write-Host "--- Leg 3: settings mask re-check (UIA, IsPassword on credential edit fields) ---"

if (-not $UiaMaskCheck) {
    Write-Host "SKIPPED (postponed): the 24h soak currently occupies the app (single-instance lock);"
    Write-Host "run with -UiaMaskCheck after the soak, when the Connections form is reachable:"
    Write-Host "  expect every credential-shaped edit (token/creds/JWT/password) to report IsPassword=True."
} else {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $auto = [System.Windows.Automation.AutomationElement]
    $root = $auto::RootElement
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, 0)
    $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    $appWin = $null
    foreach ($w in $windows) {
        try {
            $pid2 = $w.Current.ProcessId
            $proc = Get-Process -Id $pid2 -ErrorAction SilentlyContinue
            if ($proc -and $proc.ProcessName -like "nats-desktop*") { $appWin = $w; break }
        } catch { continue }
    }
    if (-not $appWin) {
        Write-Host "ERROR: nats-desktop window not found; start the app first."
        exit 2
    }
    $editCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Edit)
    $edits = $appWin.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCond)
    Write-Host ("Edit fields found: {0}" -f $edits.Count)
    $maskHits = 0
    foreach ($e in $edits) {
        $c = $e.Current
        $isPwd = $false
        try { $isPwd = $e.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::IsPasswordProperty) } catch {}
        $shape = $c.Name -match '(?i)(password|token|creds|credential|jwt|seed|private)' -or $c.AutomationId -match '(?i)(password|token|creds|credential|jwt|seed|private)'
        if ($shape) {
            $status = "MASKED"; if (-not $isPwd) { $status = "PLAINTEXT"; $maskHits++ }
            Write-Host ("  [{0}] name='{1}' automationId='{2}' IsPassword={3}" -f $status, $c.Name, $c.AutomationId, $isPwd)
        }
    }
    if ($maskHits -gt 0) { $findings += $maskHits }
}
Write-Host ""

# ---------- Summary ----------
Write-Host "=== Summary ==="
Write-Host ("Source hits            : {0}" -f $srcHits.Count)
Write-Host ("Log sample hits        : {0} (files scanned: {1})" -f $logHits.Count, $logFiles)
if ($UiaMaskCheck) { Write-Host ("Mask re-check findings : {0}" -f $maskHits) } else { Write-Host ("Mask re-check          : SKIPPED (postponed, app busy with soak)") }
Write-Host ("Total findings         : {0}" -f $findings)
if ($findings -gt 0) { exit 1 } else { exit 0 }
