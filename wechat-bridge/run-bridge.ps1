<#
  Launch the WeChat <-> DeepSeek Harness bridge and append its output to .state/logs/bridge.log.
  Called by the scheduled task DSH-WeChat-Bridge; safe to run by hand as well.
  Every failure path writes into that same log, so a failed scheduled-task run can be traced
  without the Windows event log.
#>[CmdletBinding()]
param(
  [int]$MaxLogBytes = 5MB
)

$root = $PSScriptRoot
$logDir = Join-Path $root '.state\logs'
$logFile = Join-Path $logDir 'bridge.log'

function Write-BridgeLog([string]$Message) {
  Add-Content -LiteralPath $logFile -Value $Message -Encoding utf8
}

try {
  $ErrorActionPreference = 'Stop'
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null

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
  Write-BridgeLog ('===== start ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' =====')
  Write-BridgeLog ('launcher: node=' + $node + ' version=' + (& $node --version) + ' pwshPid=' + $PID)

  Push-Location $root
  try {
    & $node 'bridge.mjs' *>> $logFile
    $code = $LASTEXITCODE
  }
  finally {
    Pop-Location
  }
  Write-BridgeLog ('===== exit ' + $code + ' at ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' =====')
  exit $code
}
catch {
  Write-BridgeLog ('===== ERROR ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' =====')
  Write-BridgeLog ($_.Exception.GetType().Name + ': ' + $_.Exception.Message)
  if ($_.ScriptStackTrace) { Write-BridgeLog ('stack: ' + $_.ScriptStackTrace) }
  exit 1
}
