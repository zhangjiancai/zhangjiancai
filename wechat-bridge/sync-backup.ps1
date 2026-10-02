<#
  把本目录里「可公开」的文件同步到备份仓库并推送。

  为什么需要它：备份仓库（zhangjiancai/zhangjiancai）是公开的，而这个目录里同时躺着
  API key（.env）、iLink 登录态与会话票据（.state/wechat-bridge.json）、真实对话记录
  （.state/history/*.jsonl）。手工 git add 迟早会把它们带出去。这里用显式白名单 +
  密钥特征扫描：命中任何一条就中止，什么都不写、什么都不推。

  pwsh -File sync-backup.ps1                     # 同步并推送（提交信息自动生成）
  pwsh -File sync-backup.ps1 -Message "改了什么"  # 自定义提交信息
  pwsh -File sync-backup.ps1 -WhatIf             # 只演练：扫描 + 列出要同步的文件

  注意：扫描用的正则是「形状」而不是密钥原文（例如 o9cq[A-Za-z0-9_-]{20,} 而不是
  某个具体 ID），这样脚本自己不会命中自己。
#>[CmdletBinding()]
param(
  [string]$Repo = 'D:\zjc20\Documents\zhangjiancai',
  [string]$Target = 'wechat-bridge',
  [string]$Message = '',
  [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$dest = Join-Path $Repo $Target

# 白名单：只有这些进入备份仓库。左边是仓库里的文件名，右边是本地来源
# （默认同名；restart-bridge-once.ps1 本地在 .state\ 下，因为它是一次性运行产物）。
$files = [ordered]@{
  'bridge.mjs'              = 'bridge.mjs'
  'preprocess.mjs'          = 'preprocess.mjs'
  'ilink-media.mjs'         = 'ilink-media.mjs'
  'send-media.mjs'          = 'send-media.mjs'
  'test-preprocess.mjs'     = 'test-preprocess.mjs'
  'run-bridge.ps1'          = 'run-bridge.ps1'
  'run-bridge-hidden.vbs'   = 'run-bridge-hidden.vbs'
  'install-task.ps1'        = 'install-task.ps1'
  'restart-bridge-once.ps1' = '.state\restart-bridge-once.ps1'
  'package.json'            = 'package.json'
  'package-lock.json'       = 'package-lock.json'
  'lean.patch.yml'          = 'lean.patch.yml'
  'README.md'               = 'README.md'
  'COMMANDS.md'             = 'COMMANDS.md'
  'AGENTS.md'               = 'AGENTS.md'
  'sync-backup.ps1'         = 'sync-backup.ps1'
}

# 密钥特征：按形状匹配，任何一条命中就中止。宁可误报，不可漏报。
$patterns = @(
  @{ name = 'DeepSeek API key'; re = 'sk-[A-Za-z0-9_-]{16,}' }
  @{ name = 'GitHub token';     re = 'gh[porsu]_[A-Za-z0-9]{20,}' }
  @{ name = 'iLink bot id';     re = '[0-9a-f]{12}@im\.bot' }
  @{ name = '微信用户 ID';       re = 'o9cq[A-Za-z0-9_-]{20,}' }
  @{ name = 'Windows 账户密码';  re = 'Zhangjiancai[0-9]' }
  @{ name = 'context_token';    re = 'AARz[A-Za-z0-9+/]{40,}' }
)

Write-Output ('同步 ' + $root + '  ->  ' + $dest)
$staged = @()
foreach ($name in $files.Keys) {
  $src = Join-Path $root $files[$name]
  if (-not (Test-Path -LiteralPath $src)) { throw ('白名单里的文件不存在：' + $src) }
  $text = Get-Content -LiteralPath $src -Raw -Encoding utf8
  foreach ($p in $patterns) {
    if ($text -match $p.re) { throw ('中止：' + $src + ' 命中密钥特征「' + $p.name + '」，未写入任何文件。确认清理后再跑。') }
  }
  $staged += [pscustomobject]@{ Name = $name; Source = $src; Bytes = (Get-Item -LiteralPath $src).Length }
}
Write-Output ('密钥扫描通过：' + $staged.Count + ' 个文件')
$staged | ForEach-Object { '  {0,-26} {1,8} B' -f $_.Name, $_.Bytes }

if ($WhatIf) { Write-Output '(WhatIf：未写入、未提交、未推送)'; return }

if (-not (Test-Path -LiteralPath (Join-Path $Repo '.git'))) { throw ('不是 git 仓库：' + $Repo) }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
foreach ($row in $staged) { Copy-Item -LiteralPath $row.Source -Destination (Join-Path $dest $row.Name) -Force }
# 备份仓库自己的 .gitignore：即使有人误放文件进来也不会被提交。
@('.env', '.state/', 'node_modules/') | Set-Content -LiteralPath (Join-Path $dest '.gitignore') -Encoding utf8

Push-Location $Repo
try {
  # package-lock.json 在本地 .gitignore 里，但备份要它（可复现安装），所以按名单强制 add。
  git add -f -- $Target
  $pending = @(git status --porcelain -- $Target)
  if ($pending.Count -eq 0) { Write-Output '没有变化，无需提交。'; return }
  if (-not $Message) { $Message = 'wechat-bridge: 同步 ' + (Get-Date -Format 'yyyy-MM-dd HH:mm') }
  git -c user.name='wechat-bridge sync' -c user.email='noreply@local' commit -m $Message -- $Target | Out-String | Write-Output
  git push origin HEAD 2>&1 | Out-String | Write-Output
  Write-Output '已推送。'
} finally {
  Pop-Location
}
