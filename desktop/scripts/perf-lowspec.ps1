# Low-spec simulation launcher (M6 Task 5, AC-024 模拟档):
#   1. NATSDESKTOP_DISABLE_GPU=1 -> main.go appends WebView2 "--disable-gpu"
#      (software rendering, the low-spec GPU lever);
#   2. processor affinity masked to 2 cores (0x3) -> simulates the 2-CPU tier.
# All numbers produced through this launcher are reported as 「模拟（2 核 + GPU 禁用）」.
$env:NATSDESKTOP_DISABLE_GPU = "1"
$exe = Join-Path $PSScriptRoot "..\bin\nats-desktop.exe"
if (-not (Test-Path $exe)) { Write-Error "not found: $exe"; exit 1 }
Start-Process -FilePath $exe
# Affinity must be set on the live process object; poll briefly so the 2-core
# mask lands as early as possible in the startup path.
$proc = $null
for ($i = 0; $i -lt 20 -and -not $proc; $i++) {
  Start-Sleep -Milliseconds 50
  $proc = Get-Process nats-desktop -ErrorAction SilentlyContinue | Select-Object -First 1
}
if (-not $proc) { Write-Error "nats-desktop process not found after launch"; exit 1 }
$proc.ProcessorAffinity = [IntPtr]0x3
Write-Host ("lowspec launch ok: pid={0} affinity=0x3 disable_gpu=1" -f $proc.Id)
