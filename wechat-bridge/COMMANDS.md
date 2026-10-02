# 微信桥接 · 指令与操作速查

> 随手查的清单：微信里能发什么、电脑上能跑什么、有哪些开关。
> 完整背景、架构与实测数据见 [README.md](README.md)。**两边必须同步改**——新增或修改任何指令时，README 的第 4.1 / 第 5 节和本文件一起更新。

## 一、微信里发的本地指令（桥接自己处理，不进模型、不花 token）

| 指令 | 作用 | 备注 |
| --- | --- | --- |
| `/help` | 显示帮助 | README 第 5 节那张表的精简版 |
| `/status` | 工作区、会话、模型、权限、**提示词档位**、活跃运行时、历史路径、运行时长 | 排查问题先发这个 |
| `/pwd`（或 `/ws`） | 查看当前工作区 + 该工作区的会话 id | |
| `/ws <路径>` | 切换工作区 | `/cd` 同义；相对路径按当前工作区解析，支持 `~` 与 `..` |
| `/ws+ <路径>` | 新建目录并切过去 | 目录不存在时用这个 |
| `/ws -` | 切回上一个工作区 | |
| `/ls [路径]` | 列目录 | 最多 60 项 |
| `/send <路径>` | 把本机文件发到微信 | `jpg/png/gif/webp/bmp` 显示成图片，其他类型当文件发 |
| `/history [n]` | 回看该工作区最近 n 轮对话 | 默认 10，上限 50；回复末尾给出 jsonl 路径 |
| `/new` | 在当前工作区开新会话，清空上下文 | 会在历史里划一条时间线，预处理不再选中它之前的内容 |
| `/pre` | 看预处理状态（判定器、阈值、模型缓存目录） | |
| `/pre on` / `/pre off` | 开关本地预处理 | 落盘，重启仍生效 |
| `/profile` | 看当前提示词档位 | |
| `/profile lean` | 瘦身档：禁 computer-use，固定提示词 **11.6k** tokens | 默认档，省钱 |
| `/profile full` | 完整档：含截图 / 桌面操作，固定提示词 **38.4k** tokens | 要截图时临时开，用完切回来 |

**不以 `/` 开头的任何文本**都会当作提示词交给 DSH Agent，用完整工具能力（读写文件、执行命令、搜索）干活。

## 二、Agent → 微信 的方向（怎么让回复带图 / 带文件）

| 做法 | 效果 |
| --- | --- |
| 回复里独占一行写 `MEDIA:<本机路径>` | 桥接把该文件当附件发出去，并从文字里删掉这一行；相对路径按当前工作区解析，支持 `~` |
| 微信里发 `/send <路径>` | 手动把本机文件推过来 |
| 电脑上跑 `node send-media.mjs <文件>` | 不重启桥接也能推（见第三节） |
| 自动附加的两行 | 每回合回复末尾带「预处理判定」和「token 消耗」，可用 `WECHAT_PRE_NOTIFY=0` / `WECHAT_TOKEN_FOOTER=0` 关掉 |

## 三、电脑上的脚本（不是在微信里发）

| 在哪跑 | 命令 | 作用 |
| --- | --- | --- |
| `wechat-bridge/` | `node bridge.mjs` | 前台启动（首次会打印扫码链接） |
| `wechat-bridge/` | `node bridge.mjs --login` | 强制重新扫码登录 |
| `wechat-bridge/` | `node bridge.mjs --check` | 自检：DSH 运行时能否启动（有 key 时会跑一次真实对话并打印用量） |
| `wechat-bridge/` | `node bridge.mjs --check-wechat` | 自检：iLink 服务是否可达（不登录） |
| `wechat-bridge/` | `node bridge.mjs --check-media <文件>` | 自检：媒体通道（给已配对用户发一张图） |
| `wechat-bridge/` | `node send-media.mjs <文件> [--caption 文字]` | 旁路推文件，不重启桥接 |
| `wechat-bridge/` | `node send-media.mjs --text "一句话"` | 旁路推纯文字 |
| `wechat-bridge/` | `node test-preprocess.mjs [--scores]` | 预处理自检与阈值标定（9 条中文用例） |
| `wechat-bridge/` | `pwsh -File install-task.ps1` | 注册 / 更新并重启计划任务（**改代码或改配置后跑这个**） |
| `wechat-bridge/` | `pwsh -File install-task.ps1 -Status` | 看任务状态与桥接进程 |
| `wechat-bridge/` | `pwsh -File install-task.ps1 -Stop` | 停桥接 |
| `wechat-bridge/` | `pwsh -File install-task.ps1 -Uninstall` | 停止并删除任务 |
| `wechat-bridge/` | `pwsh -File sync-backup.ps1` | 把可公开文件同步到备份仓库并推送 |
| 任意目录 | `Get-Content wechat-bridge\.state\logs\bridge.log -Wait -Tail 20` | 实时看日志 |

## 四、环境变量开关（写在 `wechat-bridge/.env`，**改完要重启桥接**）

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `WECHAT_LEAN_PROFILE` | `1` | 提示词档位默认值：`1` 瘦身（11.6k），`0` 完整（38.4k）；微信里 `/profile` 的持久化设置优先 |
| `WECHAT_PREPROCESS` | `1` | 本地预处理默认开关；`/pre off` 优先 |
| `WECHAT_TOKEN_FOOTER` | `1` | 回复末尾附本回合 token 消耗 |
| `WECHAT_PRE_NOTIFY` | `1` | 回复末尾附预处理判定 |
| `WECHAT_MAX_CHARS` | `1200` | 单条消息分片长度 |
| `WECHAT_ALLOW` | 空 | 允许的微信用户 ID（逗号分隔）；不设则第一个发消息的人自动配对 |
| `DSH_PERMISSION_MODE` | `danger-full-access` | 子进程权限；改 `workspace-write` 可限制在工作区内 |
| `DSH_CWD` | DSH 仓库根 | 默认工作区 |
| `DSH_MAX_RUNTIMES` | `3` | 同时保留几个工作区的 dsh 子进程 |
| `DSH_MODEL` / `DSH_PROVIDER` | `deepseek-v4-flash` / `deepseek-official` | 模型路由 |

其余（预处理阈值、模型名、超时等）见 README 第 7 节。

## 五、改完代码怎么生效

Node 只在启动时读 `.mjs`，在磁盘上改文件对常驻进程没有任何影响：

| 方式 | 命令 |
| --- | --- |
| 手动 | `pwsh -File wechat-bridge/install-task.ps1`（停旧进程再拉起） |
| 等空闲再重启（推荐，避免打断长回合） | 让 Agent 安排一次性任务跑 `.state/restart-bridge-once.ps1` |

**发布新版本前**把当前三个 `.mjs` 复制进 `.state/backup/`（回滚快照），`restart-bridge-once.ps1` 会在启动失败时自动回滚。

## 六、这份清单怎么维护

新增或修改任何微信指令，**同一次改动里**必须更新三处：

1. `COMMANDS.md`（本文件）—— 第一、二节
2. `README.md` —— 第 4.1 节指令分发表 + 第 5 节微信里的指令表
3. `bridge.mjs` 的 `HELP_TEXT` 与 `/help` 输出（`bridge.mjs:70-84`）

改完跑 `pwsh -File sync-backup.ps1` 推到备份仓库。
