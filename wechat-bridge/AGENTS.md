# wechat-bridge 目录约定

给在这个目录里干活的 Agent 看的最小约定。

## 改指令 = 三处一起改

新增或修改任何微信指令（`/xxx`）时，**同一次改动里**必须更新：

1. `bridge.mjs` 的 `HELP_TEXT`（`/help` 的输出，约 70-84 行）
2. `COMMANDS.md` 第一、二节
3. `README.md` 第 4.1 节指令分发表 + 第 5 节「微信里的指令」表

漏掉任何一个都算没做完。改完跑 `pwsh -File sync-backup.ps1` 推到备份仓库。

## 别把密钥同步出去

备份仓库（`zhangjiancai/zhangjiancai`）是**公开**的。`.env`、`.state/`、`node_modules/` 永远不进备份。
只走 `sync-backup.ps1`：它有显式白名单和密钥特征扫描，命中就中止推送。不要手工 `git add` 这个目录。

## 改完怎么生效

Node 只在启动时读 `.mjs`，磁盘上改文件对常驻进程没有任何影响。改完必须重启桥接进程：

- 手动：`pwsh -File install-task.ps1`
- 等空闲（推荐，避免打断长回合）：让 Agent 安排一次性任务跑 `.state/restart-bridge-once.ps1`

发布前把当前三个 `.mjs` 复制进 `.state/backup/`（回滚快照）。

## 只读、永不外传

`.state/wechat-bridge.json`（登录态、会话票据、配对用户）、`.state/history/*`（对话记录）、`.env`（凭据）。
这些是**数据**不是代码，不要改、不要提交、不要贴到任何地方。
