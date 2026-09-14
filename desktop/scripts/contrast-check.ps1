# WCAG contrast check for src/styles/tokens.css (M6 Task 8, a11y step).
# Parses the :root (light) and .dark (dark) token blocks and computes WCAG 2.x
# contrast ratios for the app's key foreground/background pairs:
#   fg / panel, fg-muted / panel, danger / panel, accent / panel
# Gate: >= 4.5:1 for normal text (>= 3.0:1 qualifies only for large text,
# reported separately so an exemption can be recorded with evidence).
#
# Usage:  powershell -File scripts/contrast-check.ps1 [path\to\tokens.css]
# Exit 0 = all pairs >= 4.5 (or only large-text pairs in 3.0..4.5); 1 = a
# normal-text pair below 3.0; 2 = a large-text-qualifying pair (3.0..4.5).

param([string]$TokensPath = (Join-Path $PSScriptRoot "..\frontend\src\styles\tokens.css"))

function ConvertFrom-Hex([string]$hex) {
  $hex = $hex.TrimStart('#')
  if ($hex.Length -eq 3) { $hex = ($hex[0], $hex[0], $hex[1], $hex[1], $hex[2], $hex[2]) -join '' }
  return [pscustomobject]@{
    R = [Convert]::ToInt32($hex.Substring(0, 2), 16)
    G = [Convert]::ToInt32($hex.Substring(2, 2), 16)
    B = [Convert]::ToInt32($hex.Substring(4, 2), 16)
  }
}

# Linearize an sRGB channel per WCAG 2.x.
function Get-Channel([double]$c) {
  $c = $c / 255.0
  if ($c -le 0.04045) { return $c / 12.92 }
  return [math]::Pow(($c + 0.055) / 1.055, 2.4)
}

function Get-Luminance($c) {
  return (0.2126 * (Get-Channel $c.R)) + (0.7152 * (Get-Channel $c.G)) + (0.0722 * (Get-Channel $c.B))
}

function Get-Ratio($a, $b) {
  $l1 = Get-Luminance $a; $l2 = Get-Luminance $b
  $hi = [math]::Max($l1, $l2); $lo = [math]::Min($l1, $l2)
  return ($hi + 0.05) / ($lo + 0.05)
}

# Parse one CSS block's custom properties into a hashtable of #rrggbb strings.
function Get-TokenBlock([string[]]$lines, [string]$selector) {
  $map = @{}
  $inside = $false
  foreach ($line in $lines) {
    $t = $line.Trim()
    if (-not $inside -and $t.StartsWith("$selector {")) { $inside = $true; continue }
    if ($inside) {
      if ($t -eq '}') { break }
      # Multiple custom properties can share one line (--ok: ..; --ok-soft: ..;).
      $ms = [regex]::Matches($t, '--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})')
      foreach ($m in $ms) { $map[$m.Groups[1].Value] = $m.Groups[2].Value }
    }
  }
  return $map
}

if (-not (Test-Path $TokensPath)) { Write-Error "tokens.css not found: $TokensPath"; exit 1 }
$lines = Get-Content $TokensPath
$light = Get-TokenBlock $lines ':root'
$dark = Get-TokenBlock $lines '.dark'

$pairs = @(
  @{ Fg = 'fg'; Bg = 'panel' },
  @{ Fg = 'fg-muted'; Bg = 'panel' },
  @{ Fg = 'danger'; Bg = 'panel' },
  @{ Fg = 'accent'; Bg = 'panel' }
)

$worst = 99.0
$exit = 0
foreach ($theme in @(@('light', $light), @('dark', $dark))) {
  $themeName = $theme[0]; $tokens = $theme[1]
  Write-Host ("== theme: {0} ==" -f $themeName)
  foreach ($p in $pairs) {
    $fgHex = $tokens[$p.Fg]; $bgHex = $tokens[$p.Bg]
    if (-not $fgHex -or -not $bgHex) { Write-Host ("  MISSING token: {0}/{1}" -f $p.Fg, $p.Bg); $exit = 1; continue }
    $ratio = [math]::Round((Get-Ratio (ConvertFrom-Hex $fgHex) (ConvertFrom-Hex $bgHex)), 2)
    $gate = if ($ratio -ge 4.5) { 'PASS(4.5)' } elseif ($ratio -ge 3.0) { 'LARGE-TEXT-ONLY(3.0)' } else { 'FAIL' }
    if ($ratio -lt $worst) { $worst = $ratio }
    if ($ratio -lt 3.0 -and $exit -lt 1) { $exit = 1 }
    if (($ratio -ge 3.0) -and ($ratio -lt 4.5) -and $exit -lt 2 -and $exit -lt 1) { $exit = 2 }
    Write-Host ("  --{0} on --{1}: {2}:1  [{3}]  ({4} / {5})" -f $p.Fg, $p.Bg, $ratio, $gate, $fgHex, $bgHex)
  }
}
Write-Host ("worst ratio: {0}:1" -f $worst)
exit $exit
