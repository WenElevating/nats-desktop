#Requires -Version 5.1
<#
.SYNOPSIS
    Release packaging line (M6 Task 9): version/size gates, portable zip,
    SHA256SUMS.txt. Outputs land in bin/dist/.

.DESCRIPTION
    Inputs (built by
        wails3 task windows:package INSTALL_SCOPE=user VERSION=x.y.z
    which rebuilds the exe with the same VERSION and then runs makensis):

        bin\nats-desktop.exe                  production app exe
        bin\nats-desktop-amd64-installer.exe  NSIS installer (user scope)

    Gates (all hard-fail with exit code 1):

      version  The exe's embedded version metadata is checked with the
               Win32 VerQueryValue API (P/Invoke), NOT with
               [Diagnostics.FileVersionInfo] - the latter reads EMPTY on
               wails-built exes (reproduced twice during M6 Task 9).
               Both artifacts must report:
                 - fixed FileVersion starting with -Version ("1.0.0.0")
                 - string-table ProductVersion equal to -Version
               The NSIS metadata source build\windows\nsis\wails_tools.nsh
               must also define INFO_PRODUCTVERSION equal to -Version
               (that define is what stamps the installer + the
               Add/Remove Programs DisplayVersion entry).

      size     Installer AND portable zip must each be <= -MaxArtifactMB.

    Outputs (bin\dist\, wiped and recreated on every run):

        nats-desktop-<version>-windows-amd64-portable.zip  (exe + README)
        SHA256SUMS.txt                                     (installer + zip)

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\make-release.ps1 -Version 1.0.0
#>
param(
    # Release version; must match the VERSION used for windows:build/windows:package.
    [string]$Version = "1.0.0",

    # Per-artifact size ceiling in MB (installer AND zip are both checked).
    [int]$MaxArtifactMB = 30
)

$ErrorActionPreference = 'Stop'
$Root       = Split-Path -Parent $PSScriptRoot          # desktop\
$BinDir     = Join-Path $Root 'bin'
$DistDir    = Join-Path $BinDir 'dist'
$AppExe     = Join-Path $BinDir 'nats-desktop.exe'
$Installer  = Join-Path $BinDir 'nats-desktop-amd64-installer.exe'
$ToolsNsh   = Join-Path $Root 'build\windows\nsis\wails_tools.nsh'

function Fail([string]$Msg) {
    Write-Host "GATE FAILED: $Msg" -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------------------
# Version metadata via VerQueryValue (version.dll P/Invoke).
# FileVersionInfo is unusable here: it returns empty strings for wails-built
# exes (M6 Task 9, reproduced twice). Never replace this with .VersionInfo.
# ---------------------------------------------------------------------------
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class VerQuery {
    [DllImport("version.dll", CharSet = CharSet.Unicode)]
    public static extern uint GetFileVersionInfoSize(string path, out uint handle);
    [DllImport("version.dll", CharSet = CharSet.Unicode)]
    public static extern bool GetFileVersionInfo(string path, uint handle, uint size, byte[] data);
    [DllImport("version.dll", CharSet = CharSet.Unicode)]
    public static extern bool VerQueryValue(byte[] data, string subBlock, out IntPtr buffer, out uint len);
}
'@

function Get-ExeVersionInfo([string]$Path) {
    $size = [VerQuery]::GetFileVersionInfoSize($Path, [ref]([uint32]0))
    if ($size -eq 0) { return $null }
    $data = New-Object byte[] $size
    if (-not [VerQuery]::GetFileVersionInfo($Path, [uint32]0, $size, $data)) { return $null }

    # Fixed info: VS_FIXEDFILEINFO dwFileVersionMS/LS at offsets 8/12.
    $ptr = [IntPtr]::Zero; $len = [uint32]0
    if (-not [VerQuery]::VerQueryValue($data, '\', [ref]$ptr, [ref]$len)) { return $null }
    $ms = [Runtime.InteropServices.Marshal]::ReadInt32($ptr, 8)
    $ls = [Runtime.InteropServices.Marshal]::ReadInt32($ptr, 12)
    $fixed = '{0}.{1}.{2}.{3}' -f (($ms -shr 16) -band 0xFFFF), ($ms -band 0xFFFF),
                                 (($ls -shr 16) -band 0xFFFF), ($ls -band 0xFFFF)

    # String table: resolve language/codepage from \VarFileInfo\Translation
    # (low word = language id, high word = codepage).
    $strProduct = $null
    $ptr = [IntPtr]::Zero; $len = [uint32]0
    if ([VerQuery]::VerQueryValue($data, '\VarFileInfo\Translation', [ref]$ptr, [ref]$len) -and $len -ge 4) {
        $t  = [Runtime.InteropServices.Marshal]::ReadInt32($ptr)
        $cp = '{0:X4}{1:X4}' -f ($t -band 0xFFFF), (($t -shr 16) -band 0xFFFF)
        $p2 = [IntPtr]::Zero; $l2 = [uint32]0
        $sub = "\StringFileInfo\$cp\ProductVersion"
        if ([VerQuery]::VerQueryValue($data, $sub, [ref]$p2, [ref]$l2)) {
            $strProduct = [Runtime.InteropServices.Marshal]::PtrToStringUni($p2)
        }
    }
    [pscustomobject]@{ FixedFileVersion = $fixed; ProductVersion = $strProduct }
}

# ---------------------------------------------------------------------------
# Portable README (generated so it always lands inside the zip).
# ---------------------------------------------------------------------------
function New-PortableReadmeText([string]$Ver) {
    return @"
NATS Desktop $Ver - Portable (免安装版)
========================================

使用说明
--------
1. 将本压缩包解压到任意可写目录（无需管理员权限）。
2. 双击 nats-desktop.exe 运行。
3. 首次运行时 Windows Defender SmartScreen 可能提示"已保护你的电脑"：
   本程序当前未做代码签名（TODO-002），请点击"更多信息" -> "仍要运行"。
   也可以先右键 nats-desktop.exe -> 属性 -> 勾选"解除锁定"，再运行。

系统要求
--------
- Windows 10 (x64) 或更高版本。
- Microsoft WebView2 Runtime（Win10/11 通常已内置）。便携版不会自动
  安装它；若缺失，请从 https://developer.microsoft.com/microsoft-edge/webview2/
  下载安装（安装版 nats-desktop-*-installer.exe 会自动处理）。

数据存放位置（与安装版一致，卸载/删除不会丢失设置）
--------------------------------------------------
- 应用设置与日志：%APPDATA%\nats-desktop\
- 连接上下文（natscli 兼容）：%USERPROFILE%\.config\nats\context\
  （或 XDG_CONFIG_HOME 所指目录）。
  注意：上下文文件中的用户名 / 密码 / 凭证以明文保存（与 nats CLI
  行为一致），请在可信机器上使用，勿共享该文件。

校验文件完整性（SHA256）
------------------------
  Get-FileHash .\nats-desktop.exe -Algorithm SHA256
或
  certutil -hashfile nats-desktop.exe SHA256

应用内设置
----------
- 语言切换：设置 -> 外观 -> 语言（en / zh-CN）。
- 检查更新：设置 -> 隐私 -> 检查更新（默认开启，可关闭，仅查询 GitHub
  Release 元数据，不上传任何数据）。
"@
}

# ---------------------------------------------------------------------------
# 0. Inputs exist.
# ---------------------------------------------------------------------------
if (-not (Test-Path $AppExe))    { Fail "app exe not found: $AppExe (run: wails3 task windows:build VERSION=$Version)" }
if (-not (Test-Path $Installer)) { Fail "installer not found: $Installer (run: wails3 task windows:package INSTALL_SCOPE=user VERSION=$Version)" }

# ---------------------------------------------------------------------------
# 1. Version gates.
# ---------------------------------------------------------------------------
$nsh = Get-Content $ToolsNsh -ErrorAction Stop
$defLine = $nsh | Where-Object { $_ -match '^\s*!define\s+INFO_PRODUCTVERSION\s+"(.+)"' } | Select-Object -First 1
$nshVersion = if ($defLine) { $Matches[1] } else { $null }
if ($nshVersion -ne $Version) {
    Fail "wails_tools.nsh INFO_PRODUCTVERSION='$nshVersion' != expected '$Version' (installer/ARP version source)"
}

foreach ($artifact in @(@{ N = 'app'; P = $AppExe }, @{ N = 'installer'; P = $Installer })) {
    $vi = Get-ExeVersionInfo $artifact.P
    if ($null -eq $vi) { Fail "$($artifact.N): no VS_VERSION_INFO readable via VerQueryValue ($($artifact.P))" }
    if (-not $vi.FixedFileVersion.StartsWith("$Version.")) {
        Fail "$($artifact.N): FileVersion '$($vi.FixedFileVersion)' does not start with '$Version.'"
    }
    if ($vi.ProductVersion -ne $Version) {
        Fail "$($artifact.N): string-table ProductVersion '$($vi.ProductVersion)' != '$Version'"
    }
    Write-Host ("[gate] version OK  {0,-9} FileVersion={1} ProductVersion={2}" -f $artifact.N, $vi.FixedFileVersion, $vi.ProductVersion)
}

# ---------------------------------------------------------------------------
# 2. Size gate (installer).
# ---------------------------------------------------------------------------
$maxBytes = $MaxArtifactMB * 1MB
$installerSize = (Get-Item $Installer).Length
if ($installerSize -gt $maxBytes) {
    Fail ("installer size {0:N0} bytes > {1} MB limit" -f $installerSize, $MaxArtifactMB)
}
Write-Host ("[gate] size OK    installer {0:N2} MB <= {1} MB" -f ($installerSize / 1MB), $MaxArtifactMB)

# ---------------------------------------------------------------------------
# 3. Portable zip: app exe + generated README-portable.txt.
# ---------------------------------------------------------------------------
if (Test-Path $DistDir) { Remove-Item $DistDir -Recurse -Force }
New-Item -ItemType Directory -Path $DistDir | Out-Null

$zipPath    = Join-Path $DistDir "nats-desktop-$Version-windows-amd64-portable.zip"
$stage      = Join-Path $DistDir '_stage'
New-Item -ItemType Directory -Path $stage | Out-Null
try {
    Copy-Item $AppExe (Join-Path $stage 'nats-desktop.exe')
    $readmePath = Join-Path $stage 'README-portable.txt'
    # UTF-8 with BOM so Windows Notepad renders the Chinese text correctly.
    [IO.File]::WriteAllText($readmePath, (New-PortableReadmeText $Version), (New-Object Text.UTF8Encoding($true)))
    Compress-Archive -Path (Join-Path $stage 'nats-desktop.exe'), (Join-Path $stage 'README-portable.txt') `
        -DestinationPath $zipPath -CompressionLevel Optimal
} finally {
    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
# 4. Size gate (zip).
# ---------------------------------------------------------------------------
$zipSize = (Get-Item $zipPath).Length
if ($zipSize -gt $maxBytes) {
    Fail ("zip size {0:N0} bytes > {1} MB limit" -f $zipSize, $MaxArtifactMB)
}
Write-Host ("[gate] size OK    zip      {0:N2} MB <= {1} MB" -f ($zipSize / 1MB), $MaxArtifactMB)

# ---------------------------------------------------------------------------
# 5. Bundle installer into dist + SHA256SUMS.txt (installer + zip).
# ---------------------------------------------------------------------------
Copy-Item $Installer $DistDir -Force
$distInstaller = Join-Path $DistDir (Split-Path -Leaf $Installer)
$sumsPath = Join-Path $DistDir 'SHA256SUMS.txt'
$lines = @()
foreach ($f in @($distInstaller, $zipPath)) {
    $hash = (Get-FileHash -Path $f -Algorithm SHA256).Hash.ToLowerInvariant()
    $lines += "$hash  $(Split-Path -Leaf $f)"
}
# LF line endings so `sha256sum -c SHA256SUMS.txt` (cross-platform) parses it.
[IO.File]::WriteAllText($sumsPath, (($lines -join "`n") + "`n"), (New-Object Text.UTF8Encoding($false)))

# ---------------------------------------------------------------------------
# Summary.
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "=== Release artifacts in $DistDir ===" -ForegroundColor Green
foreach ($f in @($Installer, $zipPath, $sumsPath)) {
    $item = Get-Item $f
    Write-Host ("{0,-50} {1,12:N0} bytes" -f $item.Name, $item.Length)
}
Get-Content $sumsPath | ForEach-Object { Write-Host "  $_" }
Write-Host "All gates passed (version=$Version, size<=$MaxArtifactMB MB)." -ForegroundColor Green
