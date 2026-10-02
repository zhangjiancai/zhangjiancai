# 一次性重启脚本：停掉 DSH-WeChat-Bridge 计划任务与 bridge 进程，再重新拉起；
# 起来后确认日志里出现「开始监听微信消息」，否则回滚到 .state/backup 里的上一版并再拉一次。
# 由一次性计划任务 DSH-WeChat-Bridge-OnceRestart 调用，跑完自删任务定义。
# 日志：.state/logs/restart.log
$ErrorActionPreference = 'Continue'
# 本机这份住在 .state\ 下，备份仓库里那份住在 wechat-bridge\ 根：两种布局都认。
$root = if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'bridge.mjs')) { $PSScriptRoot } else { Split-Path -Parent $PSScriptRoot }
$task = 'DSH-WeChat-Bridge'
$once = 'DSH-WeChat-Bridge-OnceRestart'
$log = Join-Path $root '.state\logs\restart.log'
$bridgeLog = Join-Path $root '.state\logs\bridge.log'
$backup = Join-Path $root '.state\backup'

function Note([string]$m) {
  Add-Content -LiteralPath $log -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $m) -Encoding utf8
}

function Stop-Bridge {
  Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'bridge\.mjs' } |
    ForEach-Object {
      Note ('stopping bridge pid=' + $_.ProcessId)
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
  Start-Sleep -Seconds 3
}

# 等待新起的桥接把「开始监听」写进日志；返回 $true 表示启动成功。
# 只看最后一次 "===== start" 之后的行，否则上一次运行留下的同一行会造成误判。
function Wait-BridgeListening([int]$timeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($timeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 3
    if (-not (Test-Path -LiteralPath $bridgeLog)) { continue }
    try {
      $tail = @(Get-Content -LiteralPath $bridgeLog -Encoding utf8 -Tail 80 -ErrorAction Stop)
    } catch {
      continue
    }
    $startAt = -1
    for ($i = $tail.Count - 1; $i -ge 0; $i--) {
      if ($tail[$i] -like '===== start *') { $startAt = $i; break }
    }
    if ($startAt -lt 0 -or $startAt -ge $tail.Count) { continue }
    $since = @($tail[($startAt + 1)..($tail.Count - 1)])
    if ($since -match '开始监听微信消息') { return $true }
    if ($since -match '===== exit ') { return $false }
  }
  return $false
}

# 等对话真正空闲再重启。桥接是在一个回合跑完之后才把 assistant 记录写进历史
# （bridge.mjs 的 handleMessage 里 appendHistory），所以「最后一条记录是 assistant
# 且文件已静默 quietSeconds 秒」就等价于「当前没有回合在跑」。
# 2026-10-02 17:58 那次重启是在一个 34 分钟的长回合中间落下的：回复没发出去，那一轮的工作全丢。
# 只有回合卡死（最后一条记录是 user 且已经过了 stuckMinutes）才不再等。
function Wait-Idle([int]$quietSeconds, [int]$stuckMinutes) {
  $histRoot = Join-Path $root '.state\history'
  while ($true) {
    $newest = $null
    foreach ($file in Get-ChildItem -LiteralPath $histRoot -Recurse -Filter '*.jsonl' -ErrorAction SilentlyContinue) {
      if ($null -eq $newest -or $file.LastWriteTimeUtc -gt $newest.LastWriteTimeUtc) { $newest = $file }
    }
    if ($null -eq $newest) { return 'no-history' }
    $idle = [int]((Get-Date).ToUniversalTime() - $newest.LastWriteTimeUtc).TotalSeconds
    $role = ''
    try {
      $tail = @(Get-Content -LiteralPath $newest.FullName -Encoding utf8 -Tail 1 -ErrorAction Stop)
      if ($tail.Count -gt 0) { $role = (ConvertFrom-Json $tail[0]).role }
    } catch {
      $role = ''
    }
    if ($role -eq 'assistant' -and $idle -ge $quietSeconds) { return ('idle ' + $idle + 's') }
    if ($role -eq 'user' -and $idle -ge ($stuckMinutes * 60)) { return ('stuck ' + $idle + 's, last record is a user message') }
    Start-Sleep -Seconds 5
  }
}

Note 'restart: begin'
$idle = Wait-Idle 120 120
Note ('restart: conversation idle (' + $idle + ')')
Stop-Bridge

# 换依赖时被运行中的桥接占住、npm 没能删掉的残留，等进程停了再删。
Get-ChildItem -LiteralPath (Join-Path $root 'node_modules') -Force -Directory -Filter '.onnxruntime-node-*' -ErrorAction SilentlyContinue | ForEach-Object {
  Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
  Note ('restart: removed leftover ' + $_.Name)
}
if (Test-Path -LiteralPath (Join-Path $root 'node_modules\@xenova')) {
  Remove-Item -LiteralPath (Join-Path $root 'node_modules\@xenova') -Recurse -Force -ErrorAction SilentlyContinue
  Note 'restart: removed leftover @xenova'
}

Start-ScheduledTask -TaskName $task

if (Wait-BridgeListening 75) {
  Note 'restart: bridge is listening'
} elseif (Test-Path -LiteralPath (Join-Path $backup 'bridge.mjs')) {
  Note 'restart: new code did NOT come up; rolling back to backup'
  Stop-Bridge
  Get-ChildItem -LiteralPath $backup -Filter '*.mjs' | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $root $_.Name) -Force
    Note ('restart: restored ' + $_.Name)
  }
  Start-ScheduledTask -TaskName $task
  if (Wait-BridgeListening 75) { Note 'restart: rolled-back bridge is listening' }
  else { Note 'restart: FAILED even after rollback - check bridge.log' }
} else {
  Note 'restart: no listening line and no backup to roll back to'
}

Note ('restart: done, task state=' + (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue).State)
Unregister-ScheduledTask -TaskName $once -Confirm:$false -ErrorAction SilentlyContinue
