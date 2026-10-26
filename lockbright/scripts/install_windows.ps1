<#
  install_windows.ps1 - install LockBright for the current user on Windows.

  This script and every string it prints are pure ASCII on purpose: Windows
  PowerShell 5.1 decodes BOM-less files as ANSI, so non-ASCII text (Chinese
  comments/strings) can break parsing.  Keep it ASCII.  LockBright itself
  prints Chinese; that is fine because it is written in UTF-8 by Python.

  What it does:
    1. locate python.exe / pythonw.exe
    2. verify that OpenCV (cv2) imports; optionally -InstallDeps runs pip
    3. stop a previous LockBright task / process
    4. copy run.py, lb\, config.example.json, requirements.txt into <AppDir>
    5. register scheduled task <TaskName>:
         trigger  : AtLogOn of the current user
         action   : <pythonw.exe> "<AppDir>\run.py" run   (no console window)
         settings : start on batteries, do not stop on batteries,
                    no execution time limit, ignore new instances
    6. start the task now and verify both a live process and the startup
       line in %USERPROFILE%\.lockbright\lockbright.log
    7. print status, log path and the uninstall command

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install_windows.ps1
    powershell ... -File scripts\install_windows.ps1 -InstallDeps
    powershell ... -File scripts\install_windows.ps1 -AppDir C:\temp\lb-app -TaskName LockBrightTest -NoStart

  Exit code: 0 = installed and verified (or -NoStart installed), 1 = failure.
#>
[CmdletBinding()]
param(
  # where the program copy lives; default %LOCALAPPDATA%\LockBright\app
  [string]$AppDir = '',
  # scheduled task name; change it for tests so the real task is untouched
  [string]$TaskName = 'LockBright',
  # explicit python.exe; default: search PATH
  [string]$PythonExe = '',
  # run "$python -m pip install --upgrade opencv-python" when cv2 is missing
  [switch]$InstallDeps,
  # register the task but do not start/verify it (used by tests)
  [switch]$NoStart,
  # allow a custom AppDir that does not look like <drive>\...\LockBright\app
  # (test/dev only; dangerous-ancestor guards below still apply)
  [switch]$AllowUnsafeAppDir
)
$ErrorActionPreference = 'Stop'

function Fail([string]$message) {
  Write-Host ('ERROR: ' + $message) -ForegroundColor Red
  exit 1
}

function Stop-RunPyProcesses([string]$runPyPath) {
  # Kill python/pythonw processes whose command line contains runPyPath.
  $killed = 0
  try {
    $procs = Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='pythonw.exe'" -ErrorAction Stop
  } catch {
    return 0
  }
  foreach ($p in $procs) {
    if ($p.CommandLine -and $p.CommandLine.IndexOf($runPyPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
      try {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
        $killed++
      } catch { }
    }
  }
  return $killed
}

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

# ---------------------------------------------------------------- source check
$scriptDir = $PSScriptRoot
$srcRoot = Split-Path -Parent $scriptDir
foreach ($name in @('run.py', 'lb', 'config.example.json', 'requirements.txt')) {
  if (-not (Test-Path (Join-Path $srcRoot $name))) {
    Fail ('source file/dir missing: ' + (Join-Path $srcRoot $name))
  }
}

if (-not $AppDir) {
  if ($env:LOCALAPPDATA) {
    $AppDir = Join-Path $env:LOCALAPPDATA 'LockBright\app'
  } else {
    $AppDir = Join-Path $env:USERPROFILE 'AppData\Local\LockBright\app'
  }
}
$AppDir = [System.IO.Path]::GetFullPath($AppDir)
$srcFull = [System.IO.Path]::GetFullPath($srcRoot)
$appFull = $AppDir.TrimEnd('\')
$srcFullTrim = $srcFull.TrimEnd('\')
$homeFull = [System.IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\')
$driveRoot = [System.IO.Path]::GetPathRoot($appFull).TrimEnd('\')
if ($appFull -eq $srcFullTrim) {
  Fail 'AppDir must not be the source checkout directory'
}
if ($appFull -eq $driveRoot -or $appFull -eq $homeFull -or $appFull.Length -lt 8) {
  Fail ('refusing dangerous AppDir: ' + $appFull)
}
if ($srcFullTrim.StartsWith($appFull + '\') -or $homeFull.StartsWith($appFull + '\')) {
  Fail ('AppDir must not be an ancestor of the source checkout or the user profile: ' + $appFull)
}
if (-not $appFull.EndsWith('\LockBright\app', [System.StringComparison]::OrdinalIgnoreCase) -and -not $AllowUnsafeAppDir) {
  Fail ('AppDir should end with \LockBright\app (pass -AllowUnsafeAppDir for test/custom directories): ' + $appFull)
}
$runPy = Join-Path $AppDir 'run.py'

# ---------------------------------------------------------------- python lookup
$python = ''
$pythonw = ''
if ($PythonExe) {
  if (-not (Test-Path $PythonExe)) { Fail ('PythonExe does not exist: ' + $PythonExe) }
  $python = (Resolve-Path $PythonExe).Path
}
$pyCmd = Get-Command python.exe -ErrorAction SilentlyContinue | Select-Object -First 1
$pwCmd = Get-Command pythonw.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $python) {
  if ($pyCmd) { $python = $pyCmd.Source }
}
if (-not $python) {
  Fail 'python.exe not found in PATH. Install Python 3.9+ and re-run, or pass -PythonExe C:\Path\python.exe'
}
# Normalise the path through sys.executable: the Microsoft Store "python.exe"
# is a stub that forwards to the real interpreter.
try {
  $sysExe = & $python -c "import sys; print(sys.executable)" 2>$null
  if ($LASTEXITCODE -eq 0 -and $sysExe) {
    $candidate = ($sysExe | Select-Object -Last 1).Trim()
    if ($candidate -and (Test-Path $candidate)) { $python = $candidate }
  }
} catch { }
$pyDir = Split-Path -Parent $python
# Prefer the pythonw.exe next to the chosen python.exe: PATH may point at a
# different interpreter (py launcher, 3.12 + 3.14 side by side), and the task
# must use exactly the interpreter whose site-packages contain cv2.
$candidateW = Join-Path $pyDir 'pythonw.exe'
if (Test-Path $candidateW) {
  $pythonw = $candidateW
} elseif ($pwCmd) {
  $pythonw = $pwCmd.Source
} else {
  $candidateW = Join-Path $pyDir 'pythonw.exe'
  if (Test-Path $candidateW) {
    $pythonw = $candidateW
  } else {
    Write-Host 'WARNING: pythonw.exe not found, the task will run python.exe (a console window may show up).' -ForegroundColor Yellow
    $pythonw = $python
  }
}
if (-not (Test-Path $pythonw)) {
  Write-Host ('WARNING: pythonw is not a real file (' + $pythonw + '), using python.exe instead.') -ForegroundColor Yellow
  $pythonw = $python
}
Write-Host ('Python      : ' + $python)
Write-Host ('pythonw     : ' + $pythonw)

# ---------------------------------------------------------------- opencv check
$cvOut = & $python -c "import cv2; print('cv2 ' + cv2.__version__)" 2>&1
if ($LASTEXITCODE -ne 0) {
  if ($InstallDeps) {
    Write-Host 'opencv-python is not importable; installing it with pip (this may take a while) ...' -ForegroundColor Yellow
    & $python -m pip install --upgrade opencv-python
    $cvOut = & $python -c "import cv2; print('cv2 ' + cv2.__version__)" 2>&1
    if ($LASTEXITCODE -ne 0) {
      Fail ('opencv-python install failed. Output: ' + (($cvOut | Out-String).Trim()))
    }
  } else {
    Write-Host ('opencv-python is not importable with ' + $python) -ForegroundColor Red
    Write-Host 'Fix it with one of:'
    Write-Host ('    ' + $python + ' -m pip install opencv-python')
    Write-Host '    powershell -NoProfile -ExecutionPolicy Bypass -File "' + $MyInvocation.MyCommand.Path + '" -InstallDeps'
    exit 1
  }
}
Write-Host ('OpenCV      : ' + (($cvOut | Select-Object -Last 1) -replace "`r", ''))

# ------------------------------------------------------------ stop old version
$watchdogTaskName = $TaskName + 'Watchdog'
$existingWatchdog = Get-ScheduledTask -TaskName $watchdogTaskName -ErrorAction SilentlyContinue
if ($existingWatchdog) {
  try { Stop-ScheduledTask -TaskName $watchdogTaskName -ErrorAction SilentlyContinue } catch { }
  Write-Host ('Stopped existing watchdog task: ' + $watchdogTaskName)
}
$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existingTask) {
  try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch { }
  Write-Host ('Stopped existing scheduled task: ' + $TaskName)
}
$killed = Stop-RunPyProcesses $runPy
if ($killed -gt 0) {
  Write-Host ('Stopped ' + $killed + ' running LockBright process(es).')
  Start-Sleep -Milliseconds 500
}

# ---------------------------------------------------------------- copy program
if (Test-Path $AppDir) {
  if (-not (Test-Path (Join-Path $AppDir 'run.py')) -and -not $AllowUnsafeAppDir) {
    Fail ('existing AppDir does not look like a previous LockBright install (no run.py); refusing to delete: ' + $AppDir)
  }
  try {
    Remove-Item -LiteralPath $AppDir -Recurse -Force
  } catch {
    Fail ('cannot remove old app dir ' + $AppDir + ': ' + $_.Exception.Message)
  }
}
New-Item -ItemType Directory -Path $AppDir -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $srcRoot 'run.py') -Destination $AppDir -Force
Copy-Item -LiteralPath (Join-Path $srcRoot 'watchdog.py') -Destination $AppDir -Force
Copy-Item -LiteralPath (Join-Path $srcRoot 'lb') -Destination $AppDir -Recurse -Force
Copy-Item -LiteralPath (Join-Path $srcRoot 'config.example.json') -Destination $AppDir -Force
Copy-Item -LiteralPath (Join-Path $srcRoot 'requirements.txt') -Destination $AppDir -Force
# do not ship bytecode caches from the checkout
Get-ChildItem -LiteralPath $AppDir -Recurse -Directory -Filter '__pycache__' -ErrorAction SilentlyContinue |
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ('Copied program to: ' + $AppDir)

# ---------------------------------------------------------- register the task
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$currentUser = $identity.Name
$currentUserSid = $identity.User.Value
$action = New-ScheduledTaskAction -Execute $pythonw -Argument ('"' + $runPy + '" run') -WorkingDirectory $AppDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId $currentUserSid -LogonType Interactive -RunLevel Limited
try {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Principal $principal -Force `
    -Description 'LockBright: dim the screen when locked and dark, restore brightness in the morning. Auto-start at logon (hidden).' | Out-Null
} catch {
  Fail ('Register-ScheduledTask failed: ' + $_.Exception.Message)
}
$task = Get-ScheduledTask -TaskName $TaskName
Write-Host ('Registered scheduled task: ' + $TaskName + ' (state=' + $task.State + ', user=' + $currentUser + ')')

# New-ScheduledTaskSettingsSet cannot express MultipleInstancesPolicy
# "StopExisting" (its enum only has IgnoreNew/Parallel/Queue), but we need it:
# when the user logs in again after an RDP session, an instance left in the old
# disconnected session would otherwise block the new one (IgnoreNew) and the
# tool would look like it never auto-started.  Patch the task XML instead.
$taskXml = Export-ScheduledTask -TaskName $TaskName
if ($taskXml -notmatch '<MultipleInstancesPolicy>StopExisting</MultipleInstancesPolicy>') {
  $patchedXml = $taskXml -replace '<MultipleInstancesPolicy>[^<]+</MultipleInstancesPolicy>', '<MultipleInstancesPolicy>StopExisting</MultipleInstancesPolicy>'
  if ($patchedXml -eq $taskXml) {
    Fail 'cannot patch MultipleInstancesPolicy to StopExisting in task XML'
  }
  try {
    Register-ScheduledTask -TaskName $TaskName -Xml $patchedXml -Force | Out-Null
  } catch {
    Fail ('registering the StopExisting task XML failed: ' + $_.Exception.Message)
  }
  $taskXml = Export-ScheduledTask -TaskName $TaskName
}
$multiInstances = ''
if ($taskXml -match '<MultipleInstancesPolicy>([^<]+)</MultipleInstancesPolicy>') {
  $multiInstances = $Matches[1]
}

# Verify the settings that are easy to get wrong (the classic pitfall is the
# default 3-day execution time limit silently stopping the daemon, and an
# AtLogOn trigger bound to the wrong account).
$taskSettings = $task.Settings
$limitText = [string]$taskSettings.ExecutionTimeLimit
$firstTrigger = @($task.Triggers) | Select-Object -First 1
$triggerType = ''
$triggerUser = ''
if ($firstTrigger) {
  if ($firstTrigger.CimClass) { $triggerType = $firstTrigger.CimClass.CimClassName }
  $triggerUser = [string]$firstTrigger.UserId
}
$logonType = [string]$task.Principal.LogonType
$restartCount = [int]$taskSettings.RestartCount
$restartInterval = [string]$taskSettings.RestartInterval
Write-Host ('  ExecutionTimeLimit: ' + $limitText + ' (PT0S = unlimited, no auto-stop)')
Write-Host ('  Trigger           : ' + $triggerType + ' user=' + $triggerUser)
Write-Host ('  Principal         : logonType=' + $logonType + ' runLevel=' + [string]$task.Principal.RunLevel)
Write-Host ('  MultipleInstances : ' + $multiInstances + ' (StopExisting = kill stale session instance on logon)')
Write-Host ('  RestartOnFailure  : count=' + $restartCount + ' interval=' + $restartInterval)
if ($limitText -ne 'PT0S') {
  Fail ('unexpected ExecutionTimeLimit ' + $limitText + ' - the task would stop itself; expected PT0S')
}
if ($triggerType -notmatch 'LogonTrigger') {
  Fail ('unexpected trigger type "' + $triggerType + '" - expected an AtLogOn trigger')
}
if ($multiInstances -ne 'StopExisting') {
  Fail ('unexpected MultipleInstances (' + $multiInstances + ') - a stale daemon from a disconnected RDP session would block the new logon instance')
}

# --------------------------------------------------------------- watchdog task
# Task Scheduler "restart on failure" does not reliably cover externally killed
# processes, so a tiny hidden watchdog (pythonw, no console window) checks every
# 2 minutes and starts LockBright again if the daemon is gone.
$watchdogPy = Join-Path $AppDir 'watchdog.py'
if (-not (Test-Path $watchdogPy)) {
  Fail ('watchdog.py missing after copy: ' + $watchdogPy)
}
$watchdogCommand = '"' + $pythonw + '" "' + $watchdogPy + '"'
$null = schtasks.exe /Create /TN $watchdogTaskName /TR $watchdogCommand /SC MINUTE /MO 2 /IT /RL LIMITED /F 2>&1
if ($LASTEXITCODE -ne 0) {
  Fail ('schtasks /Create for the watchdog failed (exit ' + $LASTEXITCODE + ')')
}
$watchdogTask = Get-ScheduledTask -TaskName $watchdogTaskName
if (-not $watchdogTask) {
  Fail ('watchdog task not found after creation: ' + $watchdogTaskName)
}
Write-Host ('Registered watchdog task: ' + $watchdogTaskName + ' (state=' + $watchdogTask.State + ', every 2 min, hidden pythonw)')
if ($logonType -and $logonType -ne 'Interactive') {
  Write-Host ('WARNING: principal logonType is ' + $logonType + ' (expected Interactive for camera access).') -ForegroundColor Yellow
}

if ($NoStart) {
  Write-Host ''
  Write-Host 'Installed (not started because -NoStart was given).'
  Write-Host ('  App directory: ' + $AppDir)
  Write-Host ('  Data dir     : ' + (Join-Path $env:USERPROFILE '.lockbright'))
  Write-Host ('  Start it     : Start-ScheduledTask -TaskName ' + $TaskName)
  Write-Host 'Uninstall with uninstall_windows.ps1.'
  exit 0
}

# ------------------------------------------------------------ start and verify
$logFile = Join-Path $env:USERPROFILE '.lockbright\lockbright.log'
$lenBefore = -1
if (Test-Path $logFile) { $lenBefore = (Get-Item $logFile).Length }
Write-Host 'Starting the task and waiting for the daemon to come up ...'
Start-ScheduledTask -TaskName $TaskName

$proc = $null
$logOk = $false
$tail = @()
for ($i = 0; $i -lt 25; $i++) {
  Start-Sleep -Milliseconds 1000
  if (-not $proc) { $proc = Find-RunPyProcess $runPy }
  if (-not $logOk -and (Test-Path $logFile)) {
    $lenNow = (Get-Item $logFile).Length
    $newText = ''
    if ($lenBefore -ge 0 -and $lenNow -gt $lenBefore) {
      # only consider bytes appended after we started the task, so an old
      # startup line from a previous run can never fake a successful start
      $stream = [System.IO.File]::Open($logFile, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
      try {
        [void]$stream.Seek($lenBefore, [System.IO.SeekOrigin]::Begin)
        $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
        $newText = $reader.ReadToEnd()
      } finally {
        $stream.Dispose()
      }
    } elseif ($lenBefore -lt 0 -or $lenNow -lt $lenBefore) {
      $newText = Get-Content -Path $logFile -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
    }
    if ($newText -and $newText -match 'platform=windows') { $logOk = $true }
    $tail = @(Get-Content -Path $logFile -Tail 40 -Encoding UTF8 -ErrorAction SilentlyContinue)
  }
  if ($proc -and $logOk) { break }
}
$task = Get-ScheduledTask -TaskName $TaskName
if (-not $proc -and $task.State -eq 'Running') {
  # the launcher process can take a few more seconds; one last look
  Start-Sleep -Seconds 3
  $proc = Find-RunPyProcess $runPy
}

if (-not $proc) {
  Write-Host 'ERROR: the scheduled task did not leave a running LockBright process.' -ForegroundColor Red
  Write-Host ('  Task state: ' + $task.State)
  if ($tail.Count -gt 0) {
    Write-Host '  Last log lines:'
    foreach ($line in ($tail | Select-Object -Last 15)) { Write-Host ('    ' + $line) }
  } else {
    Write-Host ('  Log file not found: ' + $logFile)
  }
  Write-Host '  Debug: run the program in the foreground:'
  Write-Host ('    ' + $python + ' "' + $runPy + '" run --once')
  exit 1
}
if (-not $logOk) {
  # Do not fail on a missing startup line: with log_level=WARNING/ERROR the
  # INFO startup line never appears, and camera_name resolution can delay it.
  Write-Host 'WARNING: process is running but no startup log line was found yet.' -ForegroundColor Yellow
  Write-Host ('  Task state: ' + $task.State + '  PID: ' + $proc.ProcessId)
  Write-Host ('  Log file: ' + $logFile)
  foreach ($line in ($tail | Select-Object -Last 8)) { Write-Host ('    ' + $line) }
}

Write-Host ''
Write-Host 'LockBright installed and running.' -ForegroundColor Green
Write-Host ('  Task name    : ' + $TaskName + ' (state=' + $task.State + ', policy=' + $multiInstances + ')')
Write-Host ('  Task settings: ExecutionTimeLimit=' + $limitText + ' trigger=' + $triggerType + ' logonType=' + $logonType)
Write-Host ('  Watchdog     : ' + $watchdogTaskName + ' (state=' + $watchdogTask.State + ', every 2 min)')
Write-Host ('  Process PID  : ' + $proc.ProcessId)
Write-Host ('  App directory: ' + $AppDir)
Write-Host ('  Python       : ' + $python)
Write-Host ('  pythonw      : ' + $pythonw)
Write-Host ('  Data dir     : ' + (Join-Path $env:USERPROFILE '.lockbright'))
Write-Host ('  Log file     : ' + $logFile)
Write-Host '  Last log lines:'
foreach ($line in ($tail | Select-Object -Last 8)) { Write-Host ('    ' + $line) }
Write-Host ''
Write-Host ('The task runs hidden at every logon of ' + $currentUser + '.')
Write-Host ('Edit config : ' + (Join-Path $env:USERPROFILE '.lockbright\config.json'))
Write-Host ('Restart     : Stop-ScheduledTask -TaskName ' + $TaskName + '; Start-ScheduledTask -TaskName ' + $TaskName)
Write-Host ('Camera probe: ' + $python + ' "' + $runPy + '" probe')
Write-Host ('Uninstall   : powershell -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $scriptDir 'uninstall_windows.ps1') + '"')
exit 0
