Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, "NATS Desktop")
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
if (-not $win) { Write-Error "window not found"; exit 1 }
$all = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
foreach ($el in $all) {
  $n = $el.Current.Name
  if ($n -like "*m6mem*" -or $n -like "*msg/s*" -or $n -like "*total*" -or $n -like "*dropped*") {
    Write-Host ("[{0}] '{1}'" -f $el.Current.ControlType.ProgrammaticName, $n)
  }
}
