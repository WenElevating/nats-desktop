# Keep the WebView2 accessibility tree active by querying it every 2s
# (Chromium enables a11y while an assistive client polls; deactivates after).
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, "NATS Desktop")
$end = (Get-Date).AddMinutes(10)
while ((Get-Date) -lt $end) {
  $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
  if ($win) {
    $null = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  }
  Start-Sleep -Seconds 2
}
