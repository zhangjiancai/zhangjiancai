# 微信桥接 · 指令与操作速查

> 随手查的清单：微信里能发什么、电脑上能跑什么、有哪些开关。
> 完整背景、架构与实测数据见 [README.md](README.md)。**两边必须同步改**——新增或修改任何指令时，README 的第 4.1 / 第 5 节和本文件一起更新。

## 当前默认配置（2026-10-03 实测）

这台上**实际生效**的值。优先级：`.state/wechat-bridge.json` 里持久化的设置 → `wechat-bridge/.env` → 代码默认值。

| 项 | 当前值 | 在哪改 |
| --- | --- | --- |
| **提示词档位** | **lean** —— 固定提示词 **11.4k** tokens（完整档是 38.2k） | 微信 `/profile lean\|full`；或 `.env` 的 `WECHAT_LEAN_PROFILE` |
| **本地预处理** | **开启** | 微信 `/pre off`；或 `WECHAT_PREPROCESS=0` |
| 会话策略 | **每回合新建会话**，只带选中的历史轮次 | 跟着预处理走 |
| 判定器 A（嵌入） | 进程内 ONNX `Xenova/paraphrase-multilingual-MiniLM-L12-v2`（384 维，约 120 MB） | `WECHAT_PRE_LOCAL_MODEL` |
| 判定器 B（生成式） | 进程内 ONNX `onnx-community/Qwen2.5-0.5B-Instruct`（q8，约 490 MB） | `WECHAT_PRE_GEN_MODEL` / `_DTYPE` |
| 相关性阈值 | 相关 ≥ **0.30**，选中某轮 ≥ **0.45**；词面兜底 0.06 / 0.10 | `WECHAT_PRE_LOW` / `_KEEP` |
| 生成式闸门 | `embed` —— B 不能凭空引入 A 判为无关的轮次 | `WECHAT_PRE_GEN_GATE=none` 关掉（纯并集，实测 9/9 → 5/9） |
| 回放前缀上限 | 总量 8000 字、单轮 600 字；参与判定的记录数 `0` = 整条时间线 | README 第 7.4 节 |
| 关预处理时的回放 | 最近 4 轮、最多 4000 字 | `WECHAT_REPLAY_EXCHANGES` / `_MAX_CHARS` |
| 模型 | `deepseek-official` / `deepseek-flash` | `DSH_PROVIDER` / `DSH_MODEL` |
| 权限 | `danger-full-access` —— 不询问审批，能读写任意路径 | `DSH_PERMISSION_MODE=workspace-write` 收紧 |
| 默认工作区 | DSH 仓库根目录 | `DSH_CWD`；微信里 `/ws` 可临时切 |
| 运行时上限 | 同时保留 3 个工作区的 dsh 子进程；单运行时 50 个会话后回收 | `DSH_MAX_RUNTIMES` / `DSH_MAX_SESSIONS` |
| 回复分片 | 1200 字/条 | `WECHAT_MAX_CHARS` |
| 回复脚注 | token 消耗 **开**、预处理判定 **开** | `WECHAT_TOKEN_FOOTER=0` / `WECHAT_PRE_NOTIFY=0` |
| 授权 | 已配对 **1** 个微信用户（不设 `WECHAT_ALLOW` 时第一个发消息的人自动配对） | `.env` 的 `WECHAT_ALLOW` |
| 计划任务 | `DSH-WeChat-Bridge`：登录即启 + 每 30 分钟看护；`IgnoreNew`；无运行时长上限；失败重试 999 次 / 每 1 分钟；RunLevel=Limited | `install-task.ps1` |
| 日志 | `.state/logs/bridge.log`，超过 5 MB 轮转到 `.log.1` | `run-bridge.ps1 -MaxLogBytes` |
| `.env` 里设了什么 | 只有 `DEEPSEEK_API_KEY`，其余全部走代码默认值 | — |

没列到的项见 README 第 7 节（完整变量表，含每一项的默认值）。想核当前值：`/status` 看档位与权限，`/pre` 看判定器与阈值。

## 新机器上从零跑起来

1. **装依赖并构建 Harness 的 SDK 客户端**（桥接靠它拉起 dsh 子进程）：

   ```powershell
   cd <deepseek-harness 仓库根>
   pnpm install
   pnpm run build:lib
   ```

2. **装桥接自己的依赖**（只有一个 `@huggingface/transformers`）：

   ```powershell
   cd wechat-bridge
   npm ci
   ```

3. **写凭据**：把 `.env.example` 复制成 `.env`，填上自己的 `DEEPSEEK_API_KEY`。`.env` 已被 `.gitignore` 忽略，不会被提交。

4. **自检**：`node bridge.mjs --check`（有 key 时会跑一次真实对话并打印用量）。

5. **登录**：`node bridge.mjs` —— 打印一个 `https://liteapp.weixin.qq.com/q/...` 链接，用手机微信打开确认授权，可能要输入手机上显示的数字。

6. **后台常驻**：`pwsh -File install-task.ps1`；然后给机器人发一条消息完成配对。

**注意**：仓库里**没有**登录态、会话记录和凭据（那些永不外传），所以每次换机器都要重新扫码。仓库里也**没有**本机那套 WSL / RDP 附加件（`wsl_rdp_keeper.sh`、`prune-wsl-crashes.ps1`），它们不属于这个桥接，是那台机器的额外设施。

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
| `/profile lean` | 瘦身档：禁 computer-use，固定提示词 **11.4k** tokens | 默认档，省钱 |
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
| `~/.dsh/` | `pwsh -File prune-wsl-crashes.ps1` | WSL 崩溃转储看护：保留 2 个 + 崩溃循环自动止血（加 `-NoRemediate` 只报警不动 WSL） |

### WSL 崩溃看护（本机额外件，不在备份仓库里）

**为什么会有这个**：WSLg 自带的 weston（RDP 后端）会空指针崩溃并疯狂写转储 —— 每约 **104 秒**一个 **107 MB**，约 **4 GB/小时**。2026-10-03 从 core dump 定案：崩溃指令 `/usr/lib/libweston-9/rdp-backend.so +0x1717b`，`SIGSEGV / SEGV_MAPERR / si_addr=0x218`。是 WSLg 自身缺陷，与本机配置无关。

| # | 防线 | 现状 |
| --- | --- | --- |
| 1 | `maxCrashDumpCount=2` | 已设。**任何**进程的转储最多留 2 个（默认 10），约 214 MB 封顶 |
| 2 | `guiApplications=false` | 已设。不启动 WSLg 就没有 weston 可崩 |
| 3 | 崩溃循环看护 | 计划任务 `DSH-Prune-WslCrashes` 每 10 分钟跑；15 分钟内出现 ≥3 个**新**转储就自动关掉 WSLg + `wsl --shutdown` 止血，并推一条微信 |

**想跑 Linux GUI 程序**：把 `%USERPROFILE%\.wslconfig` 的 `guiApplications` 改成 `true`，再 `wsl --shutdown`。万一 weston 又开始崩：占用被压到 214 MB 以内，第 3 道防线会在 15 分钟内自动关回来。

日志：`~/.dsh/prune-wsl-crashes.log`。详细来龙去脉见 [README](README.md) 第 8.1 节。

## 四、环境变量开关（写在 `wechat-bridge/.env`，**改完要重启桥接**）

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `WECHAT_LEAN_PROFILE` | `1` | 提示词档位默认值：`1` 瘦身（11.4k），`0` 完整（38.2k）；微信里 `/profile` 的持久化设置优先 |
| `WECHAT_PREPROCESS` | `1` | 本地预处理默认开关；`/pre off` 优先 |
| `WECHAT_TOKEN_FOOTER` | `1` | 回复末尾附本回合 token 消耗 |
| `WECHAT_PRE_NOTIFY` | `1` | 回复末尾附预处理判定 |
| `WECHAT_MAX_CHARS` | `1200` | 单条消息分片长度 |
| `WECHAT_ALLOW` | 空 | 允许的微信用户 ID（逗号分隔）；不设则第一个发消息的人自动配对 |
| `DSH_PERMISSION_MODE` | `danger-full-access` | 子进程权限；改 `workspace-write` 可限制在工作区内 |
| `DSH_CWD` | DSH 仓库根 | 默认工作区 |
| `DSH_MAX_RUNTIMES` | `3` | 同时保留几个工作区的 dsh 子进程 |
| `DSH_MODEL` / `DSH_PROVIDER` | `deepseek-flash` / `deepseek-official` | 模型路由 |
| `DSH_VISION_CHANNEL` | 空（关） | 图像外包子代理 `subagent_vision`：`1` 启用图像外包通道；默认模型已支持图片，不需要它 |

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
