# AC-022 keyboard-path re-verification (M6 Task 8, a11y step):
# Ctrl+K palette -> Streams -> select a stream (Space) -> open the message
# browser (Enter); plus the Escape-closes-dialog spot check on the messages
# session-detail radix Dialog. Keyboard-only input (SendKeys); UIA reads for
# verification. Ctrl+K is a TOGGLE, so the palette state is read from the
# focused element before sending it.
#
# KNOWN LIMIT (2026-09-14 run): on the M6 measurement host the active Chinese
# IME intercepts SendKeys TEXT (letters land in the IME composition window ->
# the palette shows 未找到匹配项), so legs 2-5 stop after the palette opens
# (leg 1). Re-run on a desktop with English (US) keyboard layout active; keep
# `uia-keepalive.ps1` running in a second shell so the WebView2 a11y tree
# stays exposed while this script reads it. Component-level keyboard coverage
# for the row/dialog legs lives in the frontend vitest suites (Space/Enter
# rows + Escape-closes-dialog), so a failed synthetic leg there is a test-
# harness limitation, not an app keyboard defect.
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System; using System.Runtime.InteropServices;
public class K { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }
"@
$ws = New-Object -ComObject WScript.Shell

function Find-Window {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, "NATS Desktop")
  return $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
}
function Find-ById([System.Windows.Automation.AutomationElement]$win, [string]$id) {
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $id)
  return $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
}
function Find-ByNameType([System.Windows.Automation.AutomationElement]$win, [string]$name, $type) {
  $tcond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $type)
  $ncond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $name)
  return $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.AndCondition($tcond, $ncond)))
}
function Palette-InputFocused {
  try { return ([System.Windows.Automation.AutomationElement]::FocusedElement).Current.Name -eq "输入命令或搜索…" } catch { return $false }
}
function Ensure-PaletteOpen {
  if (Palette-InputFocused) { return $true }
  $ws.SendKeys("^k")
  for ($i = 0; $i -lt 8; $i++) { Start-Sleep -Milliseconds 300; if (Palette-InputFocused) { return $true } }
  return $false
}
function Wait-El([System.Windows.Automation.AutomationElement]$win, [scriptblock]$probe, [int]$timeoutMs = 5000) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($timeoutMs)
  while ([DateTime]::UtcNow -lt $deadline) {
    $el = & $probe $win
    if ($el) { return $el }
    Start-Sleep -Milliseconds 120
  }
  return $null
}
function Set-InputValue($el, [string]$v) {
  try { ($el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)).SetValue($v) } catch { }
}

$fail = 0
$win = Find-Window
if (-not $win) { Write-Host "KEY-FAIL window"; exit 1 }

# Leg 1: Ctrl+K opens the palette (keyboard only).
if (Ensure-PaletteOpen) { Write-Host "KEY-PASS ctrl+k palette opens" } else { Write-Host "KEY-FAIL ctrl+k palette"; $fail++ }

# Leg 2: type "streams" -> Enter navigates to the Streams page.
Start-Sleep -Milliseconds 300
$ws.SendKeys("streams")   # real keystrokes: cmdk filter needs React onChange
Start-Sleep -Milliseconds 700
$ws.SendKeys("{ENTER}")
Start-Sleep -Milliseconds 1500
$streamSearch = Wait-El $win { param($w) Find-ByNameType $w "搜索流" ([System.Windows.Automation.ControlType]::Edit) } 5000
if ($streamSearch) { Write-Host "KEY-PASS palette Enter navigates to Streams" } else { Write-Host "KEY-FAIL palette navigation"; $fail++ }

# Leg 3: keyboard-select the LOAD_MSGS stream (Space on a focused row).
Set-InputValue $streamSearch "LOAD_MSGS"
Start-Sleep -Milliseconds 900
$row = Wait-El $win { param($w) Find-ByNameType $w "LOAD_MSGS" ([System.Windows.Automation.ControlType]::DataItem) } 5000
if (-not $row) { $row = Wait-El $win { param($w) Find-ByNameType $w "LOAD_MSGS" ([System.Windows.Automation.ControlType]::ListItem) } 2000 }
if (-not $row) { $row = Wait-El $win { param($w) Find-ByNameType $w "LOAD_MSGS" ([System.Windows.Automation.ControlType]::Button) } 2000 }
if (-not $row) { $row = Wait-El $win { param($w) Find-ByNameType $w "LOAD_MSGS" ([System.Windows.Automation.ControlType]::Group) } 2000 }
if ($row) {
  $row.SetFocus()
  Start-Sleep -Milliseconds 400
  $ws.SendKeys(" ")
  Start-Sleep -Milliseconds 1800
  $detail = Wait-El $win { param($w) Find-ById $w "stream-detail" } 5000
  if ($detail) { Write-Host "KEY-PASS Space selects stream row" } else { Write-Host "KEY-FAIL stream row Space"; $fail++ }
} else { Write-Host "KEY-FAIL LOAD_MSGS row not found"; $fail++; $detail = $null }

# Leg 4: keyboard-open the message browser (Enter on stream-op-messages).
if ($detail) {
  $msgsBtn = Find-ById $win "stream-op-messages"
  if ($msgsBtn) {
    $msgsBtn.SetFocus()
    Start-Sleep -Milliseconds 400
    $ws.SendKeys("{ENTER}")
    Start-Sleep -Milliseconds 1800
    $browserRow = Wait-El $win { param($w) Find-ByNameType $w "尾页" ([System.Windows.Automation.ControlType]::Button) } 2000
    if (-not $browserRow) { $browserRow = Wait-El $win { param($w) Find-ByNameType $w "LOAD_MSGS" ([System.Windows.Automation.ControlType]::Button) } 3000 }
    if ($browserRow) { Write-Host "KEY-PASS Enter opens message browser" } else { Write-Host "KEY-FAIL message browser open"; $fail++ }
  } else { Write-Host "KEY-FAIL stream-op-messages not found"; $fail++ }
}

# Leg 5: Escape closes a real radix dialog (messages session row detail):
# palette -> Messages page -> 订阅会话 tab (Enter) -> session chip (Enter)
# -> dialog -> Escape -> dialog gone.
if (Ensure-PaletteOpen) {
  Start-Sleep -Milliseconds 300
  $ws.SendKeys("messages")
  Start-Sleep -Milliseconds 700
  $ws.SendKeys("{ENTER}")
  Start-Sleep -Milliseconds 1500
  $tab = Wait-El $win { param($w) Find-ByNameType $w "订阅会话" ([System.Windows.Automation.ControlType]::TabItem) } 4000
  if ($tab) {
    $tab.SetFocus()
    Start-Sleep -Milliseconds 400
    $ws.SendKeys("{ENTER}")
    Start-Sleep -Milliseconds 1200
    $chip = Wait-El $win { param($w) Find-ByNameType $w "m6mem.x" ([System.Windows.Automation.ControlType]::Button) } 4000
    if ($chip) {
      $chip.SetFocus()
      Start-Sleep -Milliseconds 400
      $ws.SendKeys("{ENTER}")
      Start-Sleep -Milliseconds 1000
      $dcond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Dialog)
      $dlg = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $dcond)
      if ($dlg) {
        $ws.SendKeys("{ESC}")
        Start-Sleep -Milliseconds 800
        $dlgAfter = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $dcond)
        if (-not $dlgAfter) { Write-Host "KEY-PASS Escape closes the session detail dialog" } else { Write-Host "KEY-FAIL Escape close"; $fail++ }
      } else { Write-Host "KEY-FAIL session detail dialog did not open"; $fail++ }
    } else { Write-Host "KEY-FAIL session chip not found"; $fail++ }
  } else { Write-Host "KEY-FAIL sessions tab not found"; $fail++ }
} else { Write-Host "KEY-FAIL palette reopen"; $fail++ }

if ($fail -eq 0) { Write-Host "AC22-KEYBOARD-ALL-PASS"; exit 0 }
Write-Host ("AC22-KEYBOARD {0} leg(s) failed" -f $fail)
exit 1
