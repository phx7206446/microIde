param(
  [ValidateSet('full', 'ui-smoke')]
  [string]$InstallProfile = 'full',
  [switch]$NoPlaywrightDownload,
  [switch]$ForceStopExisting
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$codeOssRoot = Join-Path $repoRoot 'code-oss'
$nodeDir = Join-Path $repoRoot '.tools\node-v24.15.0-win-x64'
$vsInstall = 'D:\tools\visual studio\visual software'
$npmCache = Join-Path $repoRoot '.npm-cache'
$tempDir = Join-Path $repoRoot '.tmp'
$playwrightBrowsers = Join-Path $repoRoot '.playwright-browsers'
$logDir = Join-Path $repoRoot 'build\logs'

function Get-ProcessDescendants {
  param(
    [Parameter(Mandatory = $true)]
    [uint32]$ProcessId,
    [Parameter(Mandatory = $true)]
    $AllProcesses
  )

  foreach ($child in ($AllProcesses | Where-Object { $_.ParentProcessId -eq $ProcessId })) {
    Get-ProcessDescendants -ProcessId $child.ProcessId -AllProcesses $AllProcesses
    $child
  }
}

if (!(Test-Path -LiteralPath (Join-Path $nodeDir 'node.exe'))) {
  throw "Portable Node 24.15.0 was not found at $nodeDir"
}

if (!(Test-Path -LiteralPath $vsInstall)) {
  throw "Visual Studio 2022 install was not found at $vsInstall"
}

New-Item -ItemType Directory -Force -Path $npmCache, $tempDir, $playwrightBrowsers, $logDir | Out-Null

$activeInstallProcesses = Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -in @('node.exe', 'cmd.exe', 'MSBuild.exe', 'cl.exe', 'link.exe', 'python.exe') -and
    $_.CommandLine -and (
      $_.CommandLine -like "*$repoRoot*" -or
      $_.CommandLine -like '*build/npm/postinstall.ts*' -or
      $_.CommandLine -like '*extensions\copilot*' -or
      $_.CommandLine -like '*node-gyp*'
    )
  }

if ($activeInstallProcesses) {
  if (!$ForceStopExisting) {
    $activeInstallProcesses | Select-Object ProcessId, ParentProcessId, CommandLine | Format-List
    throw 'Existing microIDE Code-OSS npm install processes are still running. Re-run with -ForceStopExisting to stop them first.'
  }

  $allProcesses = Get-CimInstance Win32_Process
  $processesToStop = foreach ($process in $activeInstallProcesses) {
    Get-ProcessDescendants -ProcessId $process.ProcessId -AllProcesses $allProcesses
    $process
  }

  foreach ($process in ($processesToStop | Sort-Object ProcessId -Unique | Sort-Object ParentProcessId -Descending)) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2
}

$env:Path = "$nodeDir;$env:Path"
$env:NODE_OPTIONS = '--experimental-strip-types'
$env:vs2022_install = $vsInstall
$env:npm_config_cache = $npmCache
$env:TEMP = $tempDir
$env:TMP = $tempDir
$env:MICROIDE_NPM_INSTALL_PROFILE = $InstallProfile
$env:PLAYWRIGHT_BROWSERS_PATH = $playwrightBrowsers

if ($NoPlaywrightDownload) {
  $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
  $env:npm_config_playwright_skip_browser_download = '1'
  $env:npm_package_config_playwright_skip_browser_download = '1'
}

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logPath = Join-Path $logDir "code-oss-npm-ci-$timestamp.log"

Write-Host "Node: $(& node -v)"
Write-Host "npm:  $(& npm -v)"
Write-Host "VS:   $env:vs2022_install"
Write-Host "Profile: $env:MICROIDE_NPM_INSTALL_PROFILE"
Write-Host "Playwright skip browser download: $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD"
Write-Host "Log:  $logPath"

Push-Location $codeOssRoot
try {
  cmd /d /s /c "npm ci --cache `"$npmCache`" 2>&1" | Tee-Object -FilePath $logPath
  if ($LASTEXITCODE -ne 0) {
    throw "npm ci failed with exit code $LASTEXITCODE. See $logPath"
  }
} finally {
  Pop-Location
}
