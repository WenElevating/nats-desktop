# Screenshot baseline generator (M6 Task 8, AC-026) — 8 pages x 2 themes x
# 2 languages = 32 PNGs -> docs/screenshots/v1.0/{page}-{theme}-{lang}.png.
#
# Method (per brief Step 3): the app's own Settings page switches theme/lang
# over UIA (HTML <select> ValuePattern), pages switch via the nav buttons
# (InvokePattern, M5 smoke method), and pixels are captured with
# Graphics.CopyFromScreen (GDI+) of the window rect.
#
# EXECUTION GATE (review F18): CopyFromScreen reads the VISIBLE desktop. On a
# locked desktop it captures the lock screen / a black frame, and theme+lang
# switching needs real UI interaction. The script therefore self-checks every
# capture for uniform-color / black frames and ABORTS with a clear message
# instead of writing a bad baseline. Run it in an unlocked interactive session
# only (coordinate an unlock window with the user); if no unlock is possible
# the 32 shots stay PENDING-MANUAL.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts/screenshots.ps1
#         [-ExePath desktop\bin\nats-desktop.exe] [-OutDir docs\screenshots\v1.0]

param(
  [string]$ExePath = (Join-Path $PSScriptRoot "..\bin\nats-desktop.exe"),
  [string]$OutDir = (Join-Path $PSScriptRoot "..\..\docs\screenshots\v1.0"),
  [int]$SettleMs = 1500
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Native {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@

[Native]::SetProcessDPIAware() | Out-Null

if (-not (Test-Path $ExePath)) { Write-Error "app exe not found: $ExePath"; exit 1 }
$version = ([System.Diagnostics.FileVersionInfo]::GetVersionInfo((Resolve-Path $ExePath)).FileVersion)
if (-not $version) { $version = "unknown" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# --- page map: nav label per language -> filename slug -------------------------
$pages = @(
  @{ slug = "dashboard";  zh = "总览";     en = "Dashboard" },
  @{ slug = "messages";   zh = "消息";     en = "Messages" },
  @{ slug = "streams";    zh = "流";       en = "Streams" },
  @{ slug = "consumers";  zh = "消费者";   en = "Consumers" },
  @{ slug = "kv";         zh = "键值存储"; en = "KeyValue" },
  @{ slug = "objects";    zh = "对象存储"; en = "Objects" },
  @{ slug = "monitoring"; zh = "监控";     en = "Monitoring" },
  @{ slug = "settings";   zh = "设置";     en = "Settings" }
)
$langs = @("zh-CN", "en")
$themes = @("light", "dark")

# --- UIA helpers (M5 smoke method) ---------------------------------------------
function Find-AppWindow {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty, "NATS Desktop")
  $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
  if (-not $win) { throw "NATS Desktop window not found (is the app running?)" }
  return $win
}

function Find-ById([System.Windows.Automation.AutomationElement]$win, [string]$id) {
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty, $id)
  return $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
}

function Find-ByNameType([System.Windows.Automation.AutomationElement]$win, [string]$name, $type) {
  $tcond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $type)
  $ncond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty, $name)
  $and = New-Object System.Windows.Automation.AndCondition($tcond, $ncond)
  return $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $and)
}

function Invoke-El($el) {
  ($el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke()
}

# Set an HTML <select> (ComboBox in the UIA tree) by option VALUE via
# ValuePattern; falls back to ExpandCollapse + option SelectionItemPattern.
function Set-Select([System.Windows.Automation.AutomationElement]$win, [string]$selectId, [string]$value) {
  $el = Find-ById $win $selectId
  if (-not $el) { throw "select #$selectId not found" }
  try {
    $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $vp.SetValue($value)
    return
  } catch { }
  $ep = $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
  $ep.Expand(); Start-Sleep -Milliseconds 400
  $opt = Find-ByNameType $win $value ([System.Windows.Automation.ControlType]::ListItem)
  if (-not $opt) { $ep.Collapse(); throw "option '$value' of #$selectId not found" }
  ($opt.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)).Select()
}

# Navigate to a page by its nav-button label in the CURRENT ui language.
function Navigate([System.Windows.Automation.AutomationElement]$win, [string]$label) {
  $btn = Find-ByNameType $win $label ([System.Windows.Automation.ControlType]::Button)
  if (-not $btn) { throw "nav button '$label' not found" }
  Invoke-El $btn
  Start-Sleep -Milliseconds $SettleMs
}

# --- capture with uniform-color / black-frame abort ----------------------------
$script:uniformWarned = 0
function Capture-Window([System.Windows.Automation.AutomationElement]$win, [string]$file) {
  $rect = $win.Current.BoundingRectangle
  if ($rect.Width -le 0 -or $rect.Height -le 0) { throw "window has no size" }
  $x = [int]$rect.X; $y = [int]$rect.Y
  $w = [int]$rect.Width; $h = [int]$rect.Height
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
  $g.Dispose()

  # Sample a 48x48 grid; a locked desktop yields a uniform or black capture.
  $total = 0; $black = 0
  $hist = @{}
  for ($iy = 0; $iy -lt 48; $iy++) {
    for ($ix = 0; $ix -lt 48; $ix++) {
      $px = $bmp.GetPixel([int]($ix * ($w - 1) / 47), [int]($iy * ($h - 1) / 47))
      $key = "{0},{1},{2}" -f $px.R, $px.G, $px.B
      $hist[$key] = [int]$hist[$key] + 1
      if ($px.R -lt 10 -and $px.G -lt 10 -and $px.B -lt 10) { $black++ }
      $total++
    }
  }
  $topColor = ($hist.Values | Measure-Object -Maximum).Maximum
  $uniformPct = $topColor * 100.0 / $total
  $blackPct = $black * 100.0 / $total
  if ($uniformPct -ge 99.0) {
    $bmp.Dispose()
    throw ("ABORT: '{0}' is a uniform-color capture ({1:N1}% one color). The desktop is most likely LOCKED — " + `
           "CopyFromScreen cannot see the app. Unlock the interactive desktop and re-run (review F18).") -f $file, $uniformPct
  }
  if ($blackPct -ge 98.0) {
    $bmp.Dispose()
    throw ("ABORT: '{0}' is a black frame ({1:N1}% black pixels). The desktop is most likely LOCKED or the " + `
           "window is occluded/minimized. Unlock the desktop, bring the window to front, and re-run.") -f $file, $blackPct
  }
  if ($uniformPct -ge 90.0 -and $script:uniformWarned -lt 3) {
    Write-Host ("WARN: '{0}' is {1:N1}% one color — verify the page actually rendered." -f $file, $uniformPct)
    $script:uniformWarned++
  }
  $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

# --- main ----------------------------------------------------------------------
Write-Host ("nats-desktop screenshots — build version {0}" -f $version)
Write-Host ("output: {0}" -f (Resolve-Path $OutDir))

# Fresh app instance with the renderer accessibility tree force-enabled
# (WebView2 exposes the full UIA tree only with a11y active).
Stop-Process -Name nats-desktop -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--force-renderer-accessibility"
Start-Process -FilePath (Resolve-Path $ExePath) -WorkingDirectory (Split-Path (Resolve-Path $ExePath))
Start-Sleep -Seconds 8
$win = Find-AppWindow
[Native]::SetForegroundWindow([IntPtr]$win.Current.NativeWindowHandle) | Out-Null
Start-Sleep -Milliseconds 800

$shots = @()
foreach ($lang in $langs) {
  # Settings page first (zh labels exist in both languages pre-switch).
  $settingsLabel = if ($lang -eq "zh-CN") { "设置" } else { "Settings" }
  Navigate $win $settingsLabel
  Set-Select $win "settings-language" $lang
  Start-Sleep -Milliseconds $SettleMs   # i18n re-render
  foreach ($theme in $themes) {
    Navigate $win $settingsLabel        # settings page in the new language
    Set-Select $win "settings-theme" $theme
    Start-Sleep -Milliseconds $SettleMs # theme re-render
    foreach ($p in $pages) {
      $label = if ($lang -eq "zh-CN") { $p.zh } else { $p.en }
      Navigate $win $label
      $file = Join-Path $OutDir ("{0}-{1}-{2}.png" -f $p.slug, $theme, $lang)
      Capture-Window $win $file
      $shots += $file
      Write-Host ("  saved {0}" -f $file)
    }
  }
}

# Restore the reference defaults (light / zh-CN) so the baseline state matches
# a fresh install.
Navigate $win $settingsLabel
Set-Select $win "settings-language" "zh-CN"
Start-Sleep -Milliseconds $SettleMs
Set-Select $win "settings-theme" "light"

# Reference-set README (build version stamp + nature of the set).
$readme = Join-Path $OutDir "README.md"
$lines = @(
  "# Screenshots v1.0 (G11 reference set)",
  "",
  "- Build version: **$version**",
  ("- Generated: {0}" -f (Get-Date -Format "yyyy-MM-dd HH:mm")),
  "- Scope: 8 pages x 2 themes x 2 languages = 32 captures (AC-026).",
  "- Reference set only: rendered against the local test server state at",
  "  generation time; NOT pixel-perfect regression fixtures.",
  "- Naming: {page}-{theme}-{lang}.png",
  "",
  "| File | Page | Theme | Lang |",
  "|------|------|-------|------|"
)
foreach ($f in $shots) {
  $stem = [System.IO.Path]::GetFileNameWithoutExtension($f)
  $parts = $stem -split "-"
  $lines += ("| {0} | {1} | {2} | {3} |" -f ($parts -join "-"), $parts[0], $parts[1], ($parts[2..3] -join "-"))
}
$lines -join "`r`n" | Out-File $readme -Encoding utf8

Write-Host ("DONE: {0} screenshots + {1}" -f $shots.Count, $readme)
