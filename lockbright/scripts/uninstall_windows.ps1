<#
  uninstall_windows.ps1 - remove the per-user LockBright installation.

  Pure ASCII on purpose: Windows PowerShell 5.1 decodes BOM-less files as ANSI,
  non-ASCII text could break parsing.

  What it does:
    1. stop scheduled task <TaskName>
    2. unregister scheduled task <TaskName>
    3. kill leftover python/pythonw processes running <AppDir>\run.py
    4. remove <AppDir> (default %LOCALAPPDATA%\LockBright\app)
    5. keep %USERPROFILE%\.lockbright (config/state/log) unless -Purge is given

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall_windows.ps1
    powershell ... -File scripts\uninstall_windows.ps1 -Purge
    powershell ... -File scripts\uninstall_windows.ps1 -AppDir C:\temp\lb-app -TaskName LockBrightTest

  Safe to run when nothing is installed (exit code 0).
#>
[CmdletBinding()]
param(
  # where the program copy lives; default %LOCALAPPDATA%\LockBright\app
  [string]$AppDir = '',
  # scheduled task name; change it for tests so the real task is untouched
  [string]$TaskName = 'LockBright',
  # also delete %USERPROFILE%\.lockbright (config, state, logs, probe images)
  [switch]$Purge,
  # allow a custom AppDir that does not look like <drive>\...\LockBright\app
  # (test/dev only; dangerous-ancestor guards below still apply)
  [switch]$AllowUnsafeAppDir
)
$ErrorActionPreference = 'Stop'

function Find-RunPyProcess([string]$runPyPath) {
  try {
    $procs = Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='pythonw.exe'" -ErrorAction SilentlyContinue
  } catch {
    return $null
  }
  foreach ($p in $procs) {
    if ($p.CommandLine -and $p.CommandLine.IndexOf($runPyPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
      return $p
    }
  }
  return $null
}

if (-not $AppDir) {
  if ($env:LOCALAPPDATA) {
    $AppDir = Join-Path $env:LOCALAPPDATA 'LockBright\app'
  } else {
    $AppDir = Join-Path $env:USERPROFILE 'AppData\Local\LockBright\app'
  }
}
$AppDir = [System.IO.Path]::GetFullPath($AppDir)
$appFull = $AppDir.TrimEnd('\')
$homeFull = [System.IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\')
$driveRoot = [System.IO.Path]::GetPathRoot($appFull).TrimEnd('\')
if ($appFull -eq $driveRoot -or $appFull -eq $homeFull -or $appFull.Length -lt 8) {
  Write-Host ('ERROR: refusing dangerous AppDir: ' + $appFull) -ForegroundColor Red
  exit 1
}
if ($homeFull.StartsWith($appFull + '\')) {
  Write-Host ('ERROR: AppDir must not be an ancestor of the user profile: ' + $appFull) -ForegroundColor Red
  exit 1
}
if (-not $appFull.EndsWith('\LockBright\app', [System.StringComparison]::OrdinalIgnoreCase) -and -not $AllowUnsafeAppDir) {
  Write-Host ('ERROR: AppDir should end with \LockBright\app (pass -AllowUnsafeAppDir for test/custom directories): ' + $appFull) -ForegroundColor Red
  exit 1
}
$looksLikeInstall = (Test-Path (Join-Path $AppDir 'run.py')) -and (Test-Path (Join-Path $AppDir 'lb'))
if ((Test-Path $AppDir) -and (-not $looksLikeInstall)) {
  Write-Host ('ERROR: AppDir does not look like a LockBright install (missing run.py/lb); refusing to delete: ' + $AppDir) -ForegroundColor Red
  exit 1
}
$runPy = Join-Path $AppDir 'run.py'
$homeDir = Join-Path $env:USERPROFILE '.lockbright'

$did = @()

# 0) watchdog first: it would otherwise restart LockBright during uninstall
$watchdogTaskName = $TaskName + 'Watchdog'
$watchdogPy = Join-Path $AppDir 'watchdog.py'
$existingWatchdog = Get-ScheduledTask -TaskName $watchdogTaskName -ErrorAction SilentlyContinue
if ($existingWatchdog) {
  try { Stop-ScheduledTask -TaskName $watchdogTaskName -ErrorAction SilentlyContinue } catch { }
  try {
    Unregister-ScheduledTask -TaskName $watchdogTaskName -Confirm:$false -ErrorAction Stop
    $did += ('unregistered watchdog task ' + $watchdogTaskName)
  } catch {
    Write-Host ('WARNING: could not unregister watchdog task ' + $watchdogTaskName + ': ' + $_.Exception.Message) -ForegroundColor Yellow
  }
}

# 1) stop the scheduled task
$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existingTask) {
  try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch { }
  $did += ('stopped scheduled task ' + $TaskName)
}

# 2) unregister it
if ($existingTask) {
  try {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
    $did += ('unregistered scheduled task ' + $TaskName)
  } catch {
    Write-Host ('WARNING: could not unregister task ' + $TaskName + ': ' + $_.Exception.Message) -ForegroundColor Yellow
  }
}

# 3) kill leftover processes (give the task a moment to exit)
Start-Sleep -Milliseconds 500
$killed = 0
foreach ($pattern in @($runPy, $watchdogPy)) {
  for ($i = 0; $i -lt 5; $i++) {
    $p = Find-RunPyProcess $pattern
    if (-not $p) { break }
    try {
      Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
      $killed++
    } catch { }
    Start-Sleep -Milliseconds 400
  }
}
if ($killed -gt 0) {
  $did += ('stopped ' + $killed + ' running process(es)')
}

# 4) remove the program copy (only when it is a verified LockBright install)
if (Test-Path $AppDir) {
  try {
    Remove-Item -LiteralPath $AppDir -Recurse -Force
    $did += ('removed ' + $AppDir)
  } catch {
    Write-Host ('ERROR: cannot remove ' + $AppDir + ': ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
  }
  # remove the parent directory too when it is the default 'LockBright' dir
  # and becomes empty (never touch arbitrary custom parents)
  $parent = Split-Path -Parent $AppDir
  if ($parent -and (Split-Path -Leaf $parent) -eq 'LockBright' -and (Test-Path $parent)) {
    $left = @(Get-ChildItem -LiteralPath $parent -Force -ErrorAction SilentlyContinue)
    if ($left.Count -eq 0) {
      Remove-Item -LiteralPath $parent -Force -ErrorAction SilentlyContinue
      $did += ('removed empty ' + $parent)
    }
  }
}

# 5) user data / config
if ($Purge) {
  $dataLooksValid = (Test-Path (Join-Path $homeDir 'config.json')) -or
    (Test-Path (Join-Path $homeDir 'lockbright.log')) -or
    (Test-Path (Join-Path $homeDir 'state.json'))
  if ((Test-Path $homeDir) -and (-not $dataLooksValid)) {
    Write-Host ('WARNING: ' + $homeDir + ' does not look like LockBright data; refusing to purge it.') -ForegroundColor Yellow
  } elseif (Test-Path $homeDir) {
    try {
      Remove-Item -LiteralPath $homeDir -Recurse -Force
      $did += ('purged ' + $homeDir)
    } catch {
      Write-Host ('WARNING: could not remove ' + $homeDir + ': ' + $_.Exception.Message) -ForegroundColor Yellow
    }
  } else {
    $did += ('nothing to purge at ' + $homeDir)
  }
}

Write-Host ''
if ($did.Count -eq 0) {
  Write-Host 'LockBright was not installed (nothing to do).'
} else {
  Write-Host 'LockBright uninstalled.' -ForegroundColor Green
  foreach ($item in $did) { Write-Host ('  - ' + $item) }
  if (-not $Purge) {
    Write-Host ('  - kept user data at ' + $homeDir + ' (use -Purge to delete it)')
  }
}
exit 0
