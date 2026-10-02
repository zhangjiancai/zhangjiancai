<#
  Launch the WeChat <-> DeepSeek Harness bridge and append its output to .state/logs/bridge.log.
  Called by the scheduled task DSH-WeChat-Bridge; safe to run by hand as well.
#>[CmdletBinding()]
param(
  [int]$MaxLogBytes = 5MB
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$logDir = Join-Path $root '.state\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir 'bridge.log'

$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) {
  foreach ($candidate in @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe")) {
    if (Test-Path -LiteralPath $candidate) { $node = $candidate; break }
  }
}
if (-not $node) { throw 'node.exe not found. Install Node.js 22+ or add it to PATH.' }

# Decode the child's UTF-8 output as UTF-8; otherwise Chinese log lines become mojibake.
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

if ((Test-Path -LiteralPath $logFile) -and ((Get-Item -LiteralPath $logFile).Length -gt $MaxLogBytes)) {
  Move-Item -LiteralPath $logFile -Destination "$logFile.1" -Force
}
Add-Content -LiteralPath $logFile -Value ('===== start ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' =====') -Encoding utf8

Push-Location $root
try {
  & $node 'bridge.mjs' *>> $logFile
  $code = $LASTEXITCODE
} finally {
  Pop-Location
}
Add-Content -LiteralPath $logFile -Value ('===== exit ' + $code + ' at ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' =====') -Encoding utf8
exit $code
