# Poll the NATS Desktop UIA tree until Chromium's renderer accessibility
# activates NATURALLY (repeated WM_GETOBJECT pings, the M5 method) - no
# --force-renderer-accessibility env needed. Exits 0 when the nav is visible.
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, "NATS Desktop")
for ($i = 0; $i -lt 60; $i++) {
  $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
  if ($win) {
    $tcond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
    $btns = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tcond)
    if ($btns.Count -ge 5) { Write-Host ("tree-active after {0}s (buttons={1})" -f ($i * 2), $btns.Count); exit 0 }
  }
  Start-Sleep -Seconds 2
}
Write-Host "tree did not activate in 120s"
exit 1
