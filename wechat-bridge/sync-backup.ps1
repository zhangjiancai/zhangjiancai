<#
  把本目录里「可公开」的文件同步到备份仓库并推送。

  为什么需要它：备份仓库是公开的，而这个目录里同时躺着 API key（.env）、
  iLink 登录态与会话票据（.state/wechat-bridge.json）、真实对话记录
  （.state/history/*.jsonl），还有一堆只属于这台机器的路径与名字。
  手工 git add 迟早会把它们带出去。这里三层防护：

    1. 白名单 —— 只有列出的文件会进入备份仓库；
    2. 密钥形状扫描 —— API key / token / bot id / context_token 之类；
    3. 本机禁用词 —— 同目录的 .backup-deny（一行一条正则，本身不发布）。

  任何一层命中就中止，什么都不写、什么都不推。

  pwsh -File sync-backup.ps1                     # 同步并推送（提交信息自动生成）
  pwsh -File sync-backup.ps1 -Message "改了什么"  # 自定义提交信息
  pwsh -File sync-backup.ps1 -WhatIf             # 只演练：扫描 + 列出要同步的文件
  pwsh -File sync-backup.ps1 -Repo D:\other\clone   # 指定别的克隆位置

  克隆位置默认取同目录 .backup-repo 的第一行，其次取环境变量 WECHAT_BACKUP_REPO，
  最后退回 %USERPROFILE%\zhangjiancai。

  扫描用的正则是「形状」而不是密钥原文，所以脚本自己不会命中自己。
#>[CmdletBinding()]
param(
  [string]$Repo = '',
  [string]$Target = 'wechat-bridge',
  [string]$Message = '',
  [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

# git 输出是 UTF-8；不设置的话中文提交信息在控制台会显示成乱码（提交内容本身没问题）。
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

if (-not $Repo) {
  $localRepoFile = Join-Path $root '.backup-repo'
  if (Test-Path -LiteralPath $localRepoFile) {
    $Repo = (Get-Content -LiteralPath $localRepoFile -Raw).Trim().Split("`n")[0].Trim()
  } elseif ($env:WECHAT_BACKUP_REPO) {
    $Repo = $env:WECHAT_BACKUP_REPO
  } else {
    $Repo = Join-Path $env:USERPROFILE 'zhangjiancai'
  }
}
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
  '.env.example'            = '.env.example'
  '.gitattributes'          = '.gitattributes'
  'README.md'               = 'README.md'
  'COMMANDS.md'             = 'COMMANDS.md'
  'AGENTS.md'               = 'AGENTS.md'
  'sync-backup.ps1'         = 'sync-backup.ps1'
}

# 密钥 / 凭据形状：任何一条命中就中止。宁可误报，不可漏报。
$patterns = @(
  @{ name = 'DeepSeek API key'; re = 'sk-[A-Za-z0-9_-]{16,}' }
  @{ name = 'GitHub token';     re = 'gh[porsu]_[A-Za-z0-9]{20,}' }
  @{ name = 'iLink bot id';     re = '[0-9a-f]{12}@im\.bot' }
  @{ name = '微信用户 ID';       re = 'o9cq[A-Za-z0-9_-]{20,}' }
  @{ name = 'context_token';    re = 'AARz[A-Za-z0-9+/]{40,}' }
  @{ name = '疑似口令';          re = '[A-Za-z]{6,}[0-9]{1,4}[!@#$%^&*]' }
  @{ name = '含用户名的本机路径'; re = '[A-Za-z]:\\Users\\(?!me\\|<)[A-Za-z0-9._-]+' }
)

# 本机禁用词：.backup-deny 一行一条正则（文件本身不发布）。
$denyFile = Join-Path $root '.backup-deny'
if (Test-Path -LiteralPath $denyFile) {
  foreach ($line in Get-Content -LiteralPath $denyFile) {
    $rule = $line.Trim()
    if (-not $rule -or $rule.StartsWith('#')) { continue }
    # cs = 大小写敏感：这样公开的仓库名（全小写）不会撞上口令里的姓名（首字母大写）。
    $patterns += @{ name = '本机禁用词 /' + $rule + '/'; re = $rule; cs = $true }
  }
}

Write-Output ('同步 ' + $root + '  ->  ' + $dest)
$staged = @()
foreach ($name in $files.Keys) {
  $src = Join-Path $root $files[$name]
  if (-not (Test-Path -LiteralPath $src)) { throw ('白名单里的文件不存在：' + $src) }
  $text = Get-Content -LiteralPath $src -Raw -Encoding utf8
  foreach ($p in $patterns) {
    $hit = if ($p.cs) { $text -cmatch $p.re } else { $text -match $p.re }
    if ($hit) { throw ('中止：' + $src + ' 命中「' + $p.name + '」，未写入任何文件。确认清理后再跑。') }
  }
  $staged += [pscustomobject]@{ Name = $name; Source = $src; Bytes = (Get-Item -LiteralPath $src).Length }
}
Write-Output ('三层扫描通过：' + $staged.Count + ' 个文件，' + $patterns.Count + ' 条规则')
$staged | ForEach-Object { '  {0,-26} {1,8} B' -f $_.Name, $_.Bytes }

if ($WhatIf) { Write-Output '(WhatIf：未写入、未提交、未推送)'; return }

if (-not (Test-Path -LiteralPath (Join-Path $Repo '.git'))) { throw ('不是 git 仓库：' + $Repo) }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
foreach ($row in $staged) { Copy-Item -LiteralPath $row.Source -Destination (Join-Path $dest $row.Name) -Force }
# 备份仓库自己的 .gitignore：即使有人误放文件进来也不会被提交。
@('.env', '.state/', 'node_modules/', '.backup-repo', '.backup-deny') | Set-Content -LiteralPath (Join-Path $dest '.gitignore') -Encoding utf8

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
