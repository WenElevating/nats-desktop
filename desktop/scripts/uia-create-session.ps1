# Create one realtime subscription session via UIA (M5 smoke method):
# nav 消息 -> tab 订阅会话 -> subject input -> 订阅 (create). Verifies the
# session chip appears, printing its name.
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function Find-Window {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, "NATS Desktop")
  $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
  if (-not $win) { throw "NATS Desktop window not found" }
  return $win
}

function Find-ByName([System.Windows.Automation.AutomationElement]$win, [string]$name, [string]$type) {
  $conds = @([System.Windows.Automation.Condition]::TrueCondition)
  $tcond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::$type)
  $ncond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $name)
  $and = New-Object System.Windows.Automation.AndCondition($tcond, $ncond)
  return $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $and)
}

function Invoke-El($el) {
  $p = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $p.Invoke()
}

function Set-ValueEl($el, [string]$val) {
  try {
    $p = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $p.SetValue($val)
    return
  } catch {
    # Fallback: focus + clipboard paste (UIA ValuePattern absent on some inputs)
    Set-Clipboard -Value $val
    $el.SetFocus()
    Start-Sleep -Milliseconds 300
    $send = New-Object -ComObject WScript.Shell
    $send.SendKeys("^v")
  }
}

$win = Find-Window
Write-Host ("window ok: handle={0}" -f $win.Current.NativeWindowHandle)

# 1. Nav to Messages (消息)
$msgBtn = Find-ByName $win "消息" "Button"
if (-not $msgBtn) { throw "nav button 消息 not found" }
Invoke-El $msgBtn
Start-Sleep -Milliseconds 1200
Write-Host "nav: 消息 clicked"

# 2. Tab 订阅会话
$tab = Find-ByName $win "订阅会话" "TabItem"
if (-not $tab) { $tab = Find-ByName $win "订阅会话" "Button" }
if (-not $tab) { throw "tab 订阅会话 not found" }
try { ($tab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)).Select() } catch { Invoke-El $tab }
Start-Sleep -Milliseconds 1200
Write-Host "tab: 订阅会话 selected"

# 3. Subject input (AutomationId session-subject)
$idCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, "session-subject")
$subj = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $idCond)
if (-not $subj) { throw "session-subject input not found" }
Set-ValueEl $subj "m6mem.x"
Start-Sleep -Milliseconds 600
$v = $subj.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::ValueProperty)
Write-Host ("subject set: '{0}'" -f $v)

# 4. Create button (订阅) — the last enabled Button named exactly 订阅
$create = Find-ByName $win "订阅" "Button"
if (-not $create) { throw "create button 订阅 not found" }
Invoke-El $create
Start-Sleep -Seconds 2
Write-Host "create: 订阅 clicked"

# 5. Verify: a chip/text containing m6mem.x appears (session chip row shows subject)
$chipCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, "m6mem.x")
$chip = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $chipCond)
if ($chip) { Write-Host ("VERIFY-OK: element named m6mem.x visible ({0})" -f $chip.Current.ControlType.ProgrammaticName) }
else {
  # broader: any element whose name contains m6mem
  $all = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($el in $all) { if ($el.Current.Name -like "*m6mem*") { Write-Host ("VERIFY-OK: '{0}' ({1})" -f $el.Current.Name, $el.Current.ControlType.ProgrammaticName); $chip = $el; break } }
}
if (-not $chip) { Write-Host "VERIFY-FAIL: no m6mem element found"; exit 2 }
Write-Host "SESSION-CREATED"
