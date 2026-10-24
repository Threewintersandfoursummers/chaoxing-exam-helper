# 一键下载 Android platform-tools（含 adb）
# 用法：右键 -> 使用 PowerShell 运行
# 或者：powershell -ExecutionPolicy Bypass -File install-adb.ps1

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$binDir = Join-Path $root 'bin'
$zipPath = Join-Path $env:TEMP 'platform-tools.zip'
$url = 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip'

Write-Host ''
Write-Host '  Android platform-tools 安装器' -ForegroundColor Cyan
Write-Host '  --------------------------------' -ForegroundColor DarkGray
Write-Host ''

if (Test-Path (Join-Path $binDir 'adb.exe')) {
    Write-Host '  adb 已存在，跳过下载。' -ForegroundColor Green
    & (Join-Path $binDir 'adb.exe') version | Select-Object -First 1
    Write-Host ''
    Write-Host '  直接运行： node src/main.mjs' -ForegroundColor Gray
    exit 0
}

if (-not (Test-Path $binDir)) {
    New-Item -ItemType Directory -Path $binDir -Force | Out-Null
}

Write-Host '  正在下载 platform-tools（约 12MB）...' -ForegroundColor Yellow
try {
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing -TimeoutSec 180
} catch {
    Write-Host ''
    Write-Host '  下载失败：' -ForegroundColor Red
    Write-Host "  $($_.Exception.Message)" -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '  手动方案：' -ForegroundColor Yellow
    Write-Host "  1. 浏览器打开 $url" -ForegroundColor Gray
    Write-Host "  2. 解压后把 adb.exe / AdbWinApi.dll / AdbWinUsbApi.dll 三个文件" -ForegroundColor Gray
    Write-Host "     放进 $binDir" -ForegroundColor Gray
    exit 1
}

Write-Host '  解压中...' -ForegroundColor Yellow
$extractDir = Join-Path $env:TEMP 'platform-tools-extract'
if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force }
Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force

$inner = Join-Path $extractDir 'platform-tools'
foreach ($f in @('adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll', 'fastboot.exe')) {
    $src = Join-Path $inner $f
    if (Test-Path $src) { Copy-Item $src -Destination $binDir -Force }
}

Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
Remove-Item $extractDir -Recurse -Force -ErrorAction SilentlyContinue
Write-Host '  ✓ 安装完成' -ForegroundColor Green
Write-Host ''

$adbExe = Join-Path $binDir 'adb.exe'
& $adbExe version | Select-Object -First 1

Write-Host ''
Write-Host '  接下来：' -ForegroundColor Cyan
Write-Host '  1. 手机用数据线连电脑' -ForegroundColor Gray
Write-Host '  2. 手机设置 → 关于手机 → 连点「版本号」7 次' -ForegroundColor Gray
Write-Host '  3. 开发者选项 → 打开「USB 调试」' -ForegroundColor Gray
Write-Host '  4. 手机上弹窗点「允许」' -ForegroundColor Gray
Write-Host '  5. 运行： node src/main.mjs' -ForegroundColor Gray
Write-Host ''
