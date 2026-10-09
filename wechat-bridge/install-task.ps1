<#
  Register / update / remove the DSH-WeChat-Bridge scheduled task (runs in the current user's logon session).

  pwsh -File install-task.ps1              # register (or update) and restart
  pwsh -File install-task.ps1 -NoStart     # register without starting
  pwsh -File install-task.ps1 -Status      # show task state and bridge process
  pwsh -File install-task.ps1 -Stop        # stop the running bridge
  pwsh -File install-task.ps1 -Uninstall   # stop and delete the task
  pwsh -File install-task.ps1 -Log         # tail .state/logs/bridge.log (launcher + bridge)

  The task runs a copy of run-bridge-hidden.vbs kept in %LOCALAPPDATA%\DSH\wechat-bridge,
  so git operations in this repository can never leave the task pointing at a missing file.
  That copy receives this repository root as its argument; the launcher and run-bridge.ps1
  append every outcome (start, missing files, errors, exit code) to .state/logs/bridge.log.
#>[CmdletBinding()]
param(
  [switch]$Uninstall,
  [switch]$Status,
  [switch]$Log,
  [switch]$Stop,
  [switch]$NoStart,
  [switch]$Elevated
)

$ErrorActionPreference = 'Stop'
$TaskName = 'DSH-WeChat-Bridge'
$root = $PSScriptRoot
$launcher = Join-Path $root 'run-bridge.ps1'
$bridgePattern = 'node\.exe"?\s+bridge\.mjs\s*$'

function Get-BridgeProcess {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match $bridgePattern }
}

function Show-TaskStatus {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $task) { Write-Output "task '$TaskName' is not registered"; return }
  $info = Get-ScheduledTaskInfo -TaskName $TaskName
  Write-Output "task      : $($task.TaskName)"
  Write-Output "state     : $($task.State)"
  Write-Output "last run  : $($info.LastRunTime)  result=$($info.LastTaskResult)"
  Write-Output "next run  : $($info.NextRunTime)"
  Write-Output "launcher  : $($task.Actions[0].Arguments)"
  Write-Output "log       : $root\.state\logs\bridge.log"
  $running = @(Get-BridgeProcess)
  if ($running.Count -gt 0) {
    Write-Output ("bridge    : " + (($running | ForEach-Object { "pid=$($_.ProcessId) since=$($_.CreationDate)" }) -join '; '))
  } else {
    Write-Output 'bridge    : (no bridge process)'
  }
}

if ($Status) { Show-TaskStatus; return }

if ($Log) {
  $logFile = Join-Path $root '.state\logs\bridge.log'
  if (Test-Path -LiteralPath $logFile) {
    Get-Content -LiteralPath $logFile -Tail 40
  } else {
    Write-Output "no log yet: $logFile"
  }
  return
}

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Output "removed scheduled task '$TaskName'"
  } else {
    Write-Output "task '$TaskName' is not registered"
  }
  $left = @(Get-BridgeProcess)
  foreach ($p in $left) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  if ($left.Count -gt 0) { Write-Output "stopped $($left.Count) leftover bridge process(es)" }
  return
}

if ($Stop) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  $left = @(Get-BridgeProcess)
  foreach ($p in $left) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  Write-Output "stopped scheduled task '$TaskName'"
  return
}

if (-not (Test-Path -LiteralPath $launcher)) { throw "launcher not found: $launcher" }

# wscript (a GUI-subsystem host) runs the launcher with SW_HIDE, so Windows never shows a
# console window. Starting pwsh directly cannot achieve that: with Windows Terminal as the
# default terminal, the delegated console window ignores -WindowStyle Hidden and closing it
# kills the bridge.
$vbs = Join-Path $root 'run-bridge-hidden.vbs'
if (-not (Test-Path -LiteralPath $vbs)) { throw "hidden launcher not found: $vbs" }
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
if (-not (Test-Path -LiteralPath $wscript)) { throw "wscript.exe not found: $wscript" }

# The task must not point at a file inside the git worktree: on 2026-10-08 a `git stash -u`
# swept wechat-bridge\run-bridge-hidden.vbs away, so after the next reboot wscript had
# nothing to run and the bridge never came back. Keep a copy outside the repository and
# register the task against that copy; it takes the repository root as its argument.
$stableDir = Join-Path $env:LOCALAPPDATA 'DSH\wechat-bridge'
New-Item -ItemType Directory -Force -Path $stableDir | Out-Null
$stableVbs = Join-Path $stableDir 'run-bridge-hidden.vbs'
Copy-Item -LiteralPath $vbs -Destination $stableVbs -Force

$userId = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute $wscript `
  -Argument ('//B //nologo "{0}" "{1}"' -f $stableVbs, $root) `
  -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
# watchdog: ask again every 30 minutes; MultipleInstances=IgnoreNew keeps it single
$watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
# -Elevated runs the whole bridge (and every agent command it spawns) with administrator rights;
# registering that variant needs an elevated PowerShell, so it is opt-in.
$runLevel = if ($Elevated) { 'Highest' } else { 'Limited' }
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel $runLevel

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger, $watchdog -Settings $settings -Principal $principal `
  -Description 'WeChat (iLink ClawBot) <-> DeepSeek Harness bridge. Logs: wechat-bridge/.state/logs/bridge.log' -Force | Out-Null
Write-Output "registered scheduled task '$TaskName' for $userId (at logon, hidden window, runLevel=$runLevel)"
if ($Elevated) { Write-Output 'elevated variant: if registration was rejected, re-run this script from an administrator PowerShell.' }

if (-not $NoStart) {
  # restart so the newest launcher/script content is what actually runs
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  foreach ($p in @(Get-BridgeProcess)) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 4
}
Show-TaskStatus
