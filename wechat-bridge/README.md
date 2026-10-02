# 微信 ↔ DeepSeek Harness 桥接 · 实现档案与运维手册

把微信当遥控器：在微信里给一个机器人发消息，消息进入本机的 DeepSeek Harness（`dsh`），Agent 用完整的工具能力（读写文件、执行命令、搜索、看屏幕）干活，结果回到微信。

微信侧走腾讯官方开放的 **iLink Bot API**（即「微信 ClawBot 插件功能」，`ilinkai.weixin.qq.com`），Harness 侧走 **SDK JSON-RPC**（等价于 `dsh --profile sdk`）。因此不需要安装 OpenClaw，也不需要 openclaw 的任何插件。

本文档是这套系统的**唯一权威说明**：文件在哪、怎么连起来、你提过的每条需求落在哪段代码、出问题怎么查。运维速查见第 6 节，WSL 与磁盘问题见第 8 节。

## 文档地图

| 你想要的 | 看哪节 |
| --- | --- |
| 一张图看懂整体结构 | [2.1 部署全景](#21-部署全景) |
| 每个文件在哪、干什么 | [2.2 文件地图](#22-文件地图) |
| 模块之间怎么调用 | [2.3 模块依赖](#23-模块依赖与导出) |
| 一条消息进来会发生什么 | [2.4 文字回合时序](#24-一次文字回合时序) |
| 图片是怎么发出去的 | [2.5 媒体发送时序](#25-一次媒体发送时序) |
| 我提的需求实现到哪了 | [3. 需求 → 实现对照表](#3-需求--实现对照表) |
| 某个函数在哪一行 | [4. 代码导览](#4-代码导览按文件) |
| 微信里能发哪些指令 | [COMMANDS.md](COMMANDS.md)（速查表）/ 第 5 节 |
| 怎么启动/重启/看日志 | [6. 运维](#6-快速开始与运维) |
| WSL 为什么吃盘、怎么清 | [8. WSL 侧](#8-wsl-侧崩溃转储rdp-守护与磁盘) |
| 为什么这么贵、缓存怎么算 | [12. 成本与缓存](#12-成本与缓存2026-10-03-实测) |

---

## 1. 它是什么

```
微信 App  --iLink 长轮询-->  bridge.mjs  --JSON-RPC(stdio)-->  dsh --profile sdk
微信 App  <--sendmessage---  bridge.mjs  <--finalResponse----  DSH Agent（带工具）
```

一条消息的完整旅程：

1. `bridge.mjs` 用 `ilink/bot/getupdates` 长轮询（35 秒一轮）向 iLink 要新消息。
2. 收到消息后先过**授权**（未配对用户直接拒绝），再交给**指令解析**（`/ws`、`/send` 这类本地指令在桥接里就处理掉了，不进模型）。
3. 普通文本进**预处理层**：本机小模型判断这条消息和已有对话有没有关系，无关就当新会话、有关就只带相关的那几轮。目的是省 token。
4. 文本交给该工作区的 **dsh 子进程**（一个工作区一个运行时，带 LRU 回收），Agent 干活。
5. 回复回到桥接：摘掉 `MEDIA:<路径>` 行当附件发、附上 token 脚注、按 1200 字分片发回微信。
6. 用户消息与 Agent 回复都追加进历史文件，供下一回合预处理挑选。

### 能力清单

| 能力 | 状态 | 入口 |
| --- | --- | --- |
| 收发文字 | ✅ | 任意文本 |
| 发图片 / 视频 / 文件到微信 | ✅ | `/send`、回复里的 `MEDIA:`、`send-media.mjs` |
| 收图片进来交给模型 | ❌（只处理文字与语音转写） | — |
| 工作区切换（多个项目） | ✅ | `/ws`、`/ws+`、`/ws -` |
| 本地预处理省 token | ✅ | `/pre on\|off` |
| 每条回复附 token 消耗 | ✅ | `WECHAT_TOKEN_FOOTER` |
| 对话历史回看 | ✅ | `/history` |
| 开机自启 + 崩溃自愈 | ✅ | 计划任务 `DSH-WeChat-Bridge` |
| 截图 / 桌面操作（computer-use） | ✅（需 `/profile full`） | `/profile full` |
| 远程操作自己的桌面（RDP） | ✅（WSL 侧） | `~/.dsh/wsl_rdp_keeper.sh` |
| 群聊 | ❌ | — |

---

## 2. 全景关系图

### 2.1 部署全景

```
                           Windows 主机 ZJC20250914（用户 zjc20）
  ┌────────────┐                                                        ┌──────────────────┐
  │  手机微信    │   iLink Bot API (HTTPS)   ┌──────────────────────┐    │  ~/.dsh/          │
  │  （你自己）  │ ◄═══════════════════════► │ ilinkai.weixin.qq.com│    │   models/  ONNX   │
  └────────────┘   长轮询 getupdates        │ novac2c.cdn.weixin…  │    │   crops/          │
        ▲          sendmessage / CDN        └──────────┬───────────┘    │   sessions/       │
        │                                              │                └──────────────────┘
        │                                              │ ①长轮询              ▲
        │                                              ▼                     │ 模型缓存
        │                              ┌───────────────────────────────┐     │
        │                              │  计划任务 DSH-WeChat-Bridge    │     │
        │                              │  wscript → run-bridge-hidden  │     │
        │                              │  → run-bridge.ps1 → node      │     │
        │                              └───────────────┬───────────────┘     │
        │                                              │ 拉起                 │
        │                                              ▼                      │
        │   ②回复                        ┌──────────────────────────────┐    │
        └─────────────────────────────── │  bridge.mjs（常驻单进程）      │────┘
                                         │  · 指令解析   · 工作区/会话映射 │
                                         │  · 历史记录   · 分片/脚注/媒体  │
                                         └───┬────────┬─────────┬───────┘
                                             │        │         │
                       ③import 本地模块      │        │         │ ④SDK JSON-RPC (stdio)
                    ┌────────────────────────┘        │         └──────────────┐
                    ▼                                 ▼                        ▼
        ┌───────────────────────┐        ┌────────────────────┐   ┌────────────────────────┐
        │ preprocess.mjs        │        │ ilink-media.mjs    │   │  dsh 子进程（每工作区 1 个）│
        │ A 嵌入 / B 生成式 并集 │        │ AES-128-ECB → CDN  │   │  cwd = 该工作区          │
        └───────────┬───────────┘        └────────────────────┘   │  DSH_PERMISSION_MODE =   │
                    │                                             │  danger-full-access      │
                    ▼                                             └───────────┬────────────┘
        ┌───────────────────────┐                                                 │
        │ 本机 ONNX 模型         │                                    读写文件 / 执行命令 / 搜索
        │ 或 Ollama 或 词面兜底  │                                                 ▼
        └───────────────────────┘                                    ┌────────────────────────┐
                                                                     │ 当前工作区（默认仓库根） │
                                                                     └────────────────────────┘

  ── 旁路（不经过长轮询，直接推消息）────────────────────────────────────────────────
   send-media.mjs ──读 .state/wechat-bridge.json 里的登录态──► iLink sendmessage
   %TEMP%\wsl-crashes  ◄── WSLg weston 崩溃转储（见第 8 节）
   ~/.dsh/wsl_rdp_keeper.sh（WSL 内）──► xfreerdp3 维持 RDP 会话渲染
```

三件常驻的东西，别搞混：

| 组件 | 在哪 | 谁拉起 | 挂了会怎样 |
| --- | --- | --- | --- |
| `bridge.mjs` | Windows，node 进程 | 计划任务 `DSH-WeChat-Bridge` | 微信不回消息；任务每 30 分钟看护、失败自动重启 |
| RDP keeper | WSL 内 bash 循环 | 计划任务 `DSH-RDP-Keeper` → `run_rdp_keeper.ps1` | 无人连接时桌面停止渲染（不影响 bridge） |
| 转储清理 | Windows，pwsh | 计划任务 `DSH-Prune-WslCrashes` | `%TEMP%\wsl-crashes` 重新堆积（见 8.1） |

### 2.2 文件地图

**A. 仓库内（`wechat-bridge/`）—— 全部未纳入 git**

| 路径 | 角色 | 规模 |
| --- | --- | --- |
| `bridge.mjs` | 主进程：iLink 客户端 + 指令解析 + 运行时管理 + 历史 | 1058 行 |
| `preprocess.mjs` | 本地预处理：两个判定器 + 嵌入缓存 | 577 行 |
| `ilink-media.mjs` | 媒体协议：加密、上传 CDN、组装 item | 253 行 |
| `send-media.mjs` | 命令行旁路推送（复用登录态，不重启桥接） | 106 行 |
| `test-preprocess.mjs` | 预处理自检 / 阈值标定（9 条中文用例） | 94 行 |
| `run-bridge.ps1` | 拉起桥接 + 日志按 5 MB 轮转 | — |
| `run-bridge-hidden.vbs` | 用 wscript 无窗口启动 `run-bridge.ps1` | — |
| `install-task.ps1` | 注册/更新/停止/卸载计划任务 | — |
| `sync-backup.ps1` | 把可公开文件同步到 GitHub 备份仓库（白名单 + 密钥扫描） | — |
| `COMMANDS.md` | 指令与操作速查：微信指令 / 本机脚本 / 环境变量开关 | — |
| `AGENTS.md` | 本目录约定：改指令要同步哪三处、密钥不外传 | — |
| `lean.patch.yml` | 瘦身档补丁：禁掉 computer-use 工具组（固定提示词 38.4k→11.6k tokens） | — |
| `package.json` | 唯一的 npm 依赖：`@huggingface/transformers` | — |
| `.env` | `DEEPSEEK_API_KEY` 等凭据（已 gitignore） | — |
| `.gitignore` | 忽略 `.env`、`.state/`、`node_modules/`、`package-lock.json` | — |
| `README.md` | 本文件 | — |

**B. 运行时状态（`wechat-bridge/.state/`，已 gitignore，可整目录备份）**

| 路径 | 内容 |
| --- | --- |
| `wechat-bridge.json` | 登录凭据、同步游标、配对用户、会话映射、工作区、最新 context_token、预处理开关 |
| `history/<用户>/<工作区>.jsonl` | 一行一条 `{ts, role, workspace, text}`，用户消息与 Agent 回复都写 |
| `history/<用户>/<工作区>.vec.json` | 嵌入缓存，按文本指纹（SHA-1）复用，不重复编码 |
| `logs/bridge.log` | 桥接 stdout/stderr，超过 5 MB 轮转到 `.log.1` |
| `logs/restart.log` | 一次性重启脚本的日志 |
| `backup/{bridge,preprocess,ilink-media}.mjs` | 上一版快照；重启失败时回滚（当前与线上逐字节一致） |
| `restart-bridge-once.ps1` | 一次性重启脚本：等空闲 → 停 → 清理残留 → 起 → 健康检查 → 失败回滚 |

**C. 本机其它位置（不在仓库里）**

| 路径 | 角色 |
| --- | --- |
| `packages/sdk/client/lib/index.js` | 桥接依赖的 SDK 客户端构建产物（`pnpm run build:lib` 生成） |
| `~/.dsh/models/` | ONNX 模型缓存（A 判定器 129 MB + B 判定器 488 MB，详见 8.3） |
| `~/.dsh/profiles/sdk/cordis.patch.yml` | 为桥接会话加的 computer-use 插件、vision 子代理、vision 模型条目 |
| `~/.dsh/sessions/` | Web/桌面端会话日志（**不含**微信侧会话，机制见 2.7） |
| `~/.dsh/wsl_rdp_keeper.sh` | WSL 内的 RDP 守护（见 8.2） |
| `~/.dsh/run_rdp_keeper.ps1` / `run_rdp_keeper_hidden.vbs` | keeper 的 Windows 监管器与无窗口启动器 |
| `~/.dsh/enable_boot_autostart.ps1` | 可选的一次性提权步骤：给 keeper 加开机启动 |
| `~/.dsh/prune-wsl-crashes.ps1` / `.log` | WSL 崩溃转储清理（见 8.1） |
| `~/.dsh/README-rdp-keeper.md` | RDP keeper 的原始设计说明 |
| `~/.wslconfig` | `[wsl2] guiApplications=false`（见 8.1） |

### 2.3 模块依赖与导出

```
bridge.mjs
 ├─ import { sendMediaFile }              from './ilink-media.mjs'
 ├─ import { analyzeContext,              from './preprocess.mjs'
 │           embeddingCacheFile,
 │           preprocessInfo,
 │           warmupPreprocess }
 └─ import('file://…/packages/sdk/client/lib/index.js')   ← 动态 import，运行期才加载
                                                            缺产物时报「请先 pnpm run build:lib」

ilink-media.mjs     导出：mediaTypeFor / isImagePath / sendTextMessage / sendMediaFile
preprocess.mjs      导出：analyzeContext / embeddingCacheFile / preprocessInfo / warmupPreprocess

send-media.mjs      ── import { sendMediaFile, sendTextMessage } from './ilink-media.mjs'
                       自己实现最小 api()（只用到 sendmessage / getuploadurl 两条接口）
test-preprocess.mjs ── import { analyzeContext, preprocessInfo, warmupPreprocess } from './preprocess.mjs'
```

依赖方向是单向的：`bridge.mjs` 依赖两个模块，两个模块互不依赖，`send-media.mjs` 只依赖 `ilink-media.mjs`。**改 `ilink-media.mjs` 会同时影响桥接和命令行推送**，改 `preprocess.mjs` 只影响桥接。

### 2.4 一次文字回合时序

```
微信         iLink 云            bridge.mjs                        dsh 子进程
 │             │                    │                                  │
 │ 发消息 ────►│                    │                                  │
 │             │◄── getupdates ─────│  (35s 长轮询)                    │
 │             │─── msgs[] ────────►│                                  │
 │             │                    │ ① 授权检查（配对/白名单）          │
 │             │                    │ ② 是指令？→ 本地处理并 return      │
 │             │                    │ ③ 记 context_token 到状态文件      │
 │             │                    │ ④ analyzeContext() 预处理 ──► 本机模型
 │             │                    │    ├ 无关 → 新会话，不带历史        │
 │             │                    │    └ 有关 → prefix = 选中轮次      │
 │◄─ 收到，正在处理… ───────────────│ ⑤ 立即回执                        │
 │◄─ 正在输入…(每 5s 保活) ─────────│                                  │
 │             │                    │ ⑥ appendHistory(user)            │
 │             │                    │ ⑦ runtime.run(sessionId, text) ─►│ 干活
 │             │                    │ ◄── finalResponse + events ──────│
 │             │                    │ ⑧ 摘 MEDIA: 行、累加 usage        │
 │             │                    │ ⑨ appendHistory(assistant)        │
 │◄─ 正式回复（+预处理说明+token 脚注，>1200 字分片）──────────────────│
 │◄─ 附件（若有 MEDIA:）────────────│                                   │
 │             │                    │ ⑩ 会话数超限则回收运行时           │
```

### 2.5 一次媒体发送时序

```
bridge.mjs / send-media.mjs            ilink-media.mjs                  iLink / CDN
      │                                      │                             │
      │ sendMediaFile(filePath) ────────────►│                             │
      │                                      │ ① mediaTypeFor(扩展名)       │
      │                                      │    图片 1 / 视频 2 / 文件 3   │
      │                                      │ ② 随机 AES-128 key + filekey │
      │                                      │ ③ getuploadurl ─────────────►│
      │                                      │    filesize = 密文长度        │
      │                                      │    （明文 + PKCS#7 补齐）     │
      │                                      │ ④ AES-128-ECB 加密本地文件    │
      │                                      │ ⑤ POST 密文到 CDN ──────────►│
      │                                      │ ◄─ 响应头 x-encrypted-param ─│
      │                                      │ ⑥ 组装 item（image/file/video）│
      │                                      │ ⑦ sendmessage ──────────────►│
      │                                      │    aes_key = base64(十六进制) │
      │ ◄── 已发送媒体 ───────────────────────│                             │
```

三个协议坑（都在 `ilink-media.mjs` 的文件头注释里）：`filesize` 要报**密文**长度；`encrypted_query_param` 在**响应头**而不是 body；`aes_key` 是 `base64(密钥的十六进制字符串)`，不是 `base64(密钥原始字节)`——传错时图片显示成灰块。

### 2.6 预处理判定

```
新消息
   │
   ├─► 判定器 A（嵌入）        ┌ 进程内 ONNX（paraphrase-multilingual-MiniLM-L12-v2，384 维）
   │    每轮问答 → 一个向量     ├ 降级 1：本机 Ollama（all-minilm）
   │    与当前问题算余弦        └ 降级 2：零依赖词面相似度（字符二元组 + 英文词的 Jaccard）
   │
   ├─► 判定器 B（生成式）      ┌ 进程内 ONNX（Qwen2.5-0.5B-Instruct q8）
   │    整段对话一次输入，      └ 降级：本机 Ollama（qwen2.5:3b）
   │    直接点名相关轮次编号        都没有 → B 直接缺席，只用 A
   │
   ▼  两者并行跑，结果取并集（召回优先）
┌──────────────────────────────────────────────────────────┐
│ 闸门：B 只能「捞回」A 评在 0.30~0.45 的轮次，             │
│       不能凭空引入 A 判为无关（< 0.30）的轮次              │
│ 承接兜底：「继续 / 接着 / 然后呢 / 刚才的…」一律相关，      │
│           并带上最新一轮                                  │
└──────────────────────────────────────────────────────────┘
   │
   ├─ 无关 → 新会话，一条历史都不带（等价 /new）
   └─ 有关 → 只把选中的轮次拼成前缀，随本轮提示词一起发出
```

判定单元始终是**一轮问答**（用户那句话 + 对应的回复绑成整体，判定/编码/选中/回放都不拆开）；判定输入是 **`/new` 之后的整条时间线**，不按轮数截断。

### 2.7 状态与落盘布局

```
wechat-bridge/.state/
├── wechat-bridge.json          # 唯一的状态文件（原子写：临时文件 + rename）
│   ├── account{}               #   token / baseUrl / botId / userId / loginAt
│   ├── syncBuf                 #   getupdates 游标，断点续传用
│   ├── paired[]                #   已配对用户（未设 WECHAT_ALLOW 时第一个发消息的人自动进这里）
│   ├── sessions{}              #   "用户|工作区" → wx-xxxx 会话 id
│   ├── workspaces{}            #   用户当前工作区
│   ├── previousWorkspaces{}    #   /ws - 的回退目标
│   ├── contextTokens{}         #   每个用户最新 context_token（旁路脚本靠它发消息）
│   ├── preprocess              #   /pre 开关，落盘，重启仍生效
│   └── preprocessSince{}       #   "用户|工作区" → /new 划下的时间线（毫秒）
├── history/<用户>/<工作区>.jsonl
├── history/<用户>/<工作区>.vec.json
├── logs/{bridge.log,bridge.log.1,restart.log}
└── backup/*.mjs
```

**为什么微信侧会话不在 `~/.dsh/sessions/`**：实测 `dsh --profile sdk` 创建的会话不落成可读的会话日志（只在 `~/.dsh/storages/session_projcache/` 留一行投影缓存），进程结束即失忆。所以桥接自己记历史，并在「新进程/新运行时第一次接手一个旧会话」时把最近 `WECHAT_REPLAY_EXCHANGES` 轮回放给模型。代价：Web/桌面端的会话列表看不到微信会话，历史以桥接的 jsonl 为准。

---

## 3. 需求 → 实现对照表

按你在微信里提出的顺序（时间为你本机时间）。「位置」里的行号对应当前代码。

| # | 时间 | 你的原话（摘要） | 落地实现 | 位置 |
| --- | --- | --- | --- | --- |
| 1 | 10-01 16:07 | 更换到 wechat-todo 的工作目录 | 工作区概念：每工作区独立运行时 + 独立会话；`/ws`、`/ws+`、`/ws -`、`/cd`；相对路径按当前工作区解析，支持 `~` 与 `..` | `bridge.mjs:567-594`、`710-756`、`526-545` |
| 2 | 10-01 16:11 | 能不能打开崩坏星穹铁道，帮我做日常 | 装了 computer-use 服务 + CUA Driver 原生 provider（能枚举窗口、点击、截图）；**游戏本身没做** | `~/.dsh/profiles/sdk/cordis.patch.yml` |
| 3 | 10-01 16:15 | 先按上插件 | 同上：`dsh-computer-use` + `dsh-experimental-computer-use-cua-driver-native` 两个 insert | 同上 |
| 4 | 10-01 16:26 | 让语言模型调用支持图片的模型，省的改默认模型 | 新增模型条目 `deepseek-v4-flash-vision-exp`（声明 image 输入）+ 额外 subagent 实例 `subagent_vision`，静态把子 agent 路由到 vision 模型；默认模型仍是 `deepseek-v4-flash` | 同上 |
| 5 | 10-01 16:29 | 重启重启 | 一次性计划任务 `DSH-WeChat-Bridge-OnceRestart` 延迟执行，避免「回复还没发出去就把自己杀了」；后来演化为带 Wait-Idle + 健康检查 + 回滚的 `.state/restart-bridge-once.ps1` | `.state/restart-bridge-once.ps1` |
| 6 | 10-01 16:47 | 你来操作一下 RDP 会话（给了一个锁屏 PIN） | 确认那是锁屏 PIN 而不是账户密码（`LogonUser` 三种用户名格式实测均失败） | 会话记录 |
| 7 | 10-01 17:28 | （微软账号 + 密码） | 用真实凭据救活会话；WSL 内 `xfreerdp3` + `Xvfb` 连本机，源地址经 NAT 与真实客户端不同 | `~/.dsh/wsl_rdp_keeper.sh` |
| 8 | 10-01 18:36 | 我远程连不了桌面，是不是会定期回连 | keeper 改成「你在就让」：`qwinsta` 报 `Active` 立即让位，只有 `Disc` 持续 30 秒才接管 | `wsl_rdp_keeper.sh` 的 `session_state()` |
| 9 | 10-01 20:39 | 设置为开机自启 | 计划任务 `DSH-RDP-Keeper`（登录即启，之后补 `AtStartup`）；无窗口启动走 wscript | `~/.dsh/run_rdp_keeper.ps1`、`enable_boot_autostart.ps1` |
| 10 | 10-02 16:17 | 再试试能不能发图片 + **每条回复备注 token 数** | 媒体通道（AES→CDN→item）；token 脚注累加该回合所有 `assistant/message` 事件的 usage | `ilink-media.mjs:241-253`；`bridge.mjs:334`、`343-371`、`903` |
| 11 | 10-02 16:27 | 只保留部分截图，防止存储爆满；获取最新截图 | 清理 `~/.dsh/crops`（51→5）、桌面、`%TEMP%\dsh-*`；定位并处置 WSL 崩溃转储 | 见 8.1 |
| 12 | 10-02 16:33 | 图片是怎么发出去的；查看 wsl 崩溃原因 | 三步协议写进 `ilink-media.mjs` 头注释；WSL 崩溃定位为 WSLg 的 weston 崩溃循环 | `ilink-media.mjs:1-13`；`~/.dsh/prune-wsl-crashes.ps1` |
| 13 | 10-02 16:41 | 修改 wslconfig，然后重启 | `.wslconfig` 写 `[wsl2] guiApplications=false` + `wsl --shutdown`；崩溃循环停止 | `~/.wslconfig` |
| 14 | 10-02 16:47 | 本地搭个小模型做预处理，判断消息与上文是否相关；要有开关 | `preprocess.mjs`：三级降级 + `/pre on\|off`（落盘）；关掉时退回持久会话 | `preprocess.mjs:233-291`、`497-572`；`bridge.mjs:817-842` |
| 15 | 10-02 17:12 | 判定单元是一轮问答、输入是整个对话、输出是相关部分 | 改造：`toExchanges()` 以轮为单位；`WECHAT_PRE_SELECT_RECORDS=0` 表示整条时间线不截断；词面路径也不再拆半轮 | `preprocess.mjs:345-357`、`455-483` |
| 16 | 10-02 17:24 | 用 AB 方案取并集 | 两个判定器并行 + 并集；再加「嵌入闸门」防止小模型假阳性 | `preprocess.mjs:455-483`、`517-524` |
| 17 | 10-02 18:15 | 重启脚本是干啥；单轮为什么会有上限 | 解释 Node 只在启动时读 `.mjs`；上限已改为 0（不限），并加 Wait-Idle 防止打断长回合 | `.state/restart-bridge-once.ps1:53-78` |
| 18 | 10-02 21:37 | 之前的问题又出现了，自动把我挤下去了 | `session_state()` 两个叠加 bug：硬编码会话 ID、`qwinsta` 的 `>` 标记打在调用者自己的行上导致整行左移 → 改为按用户名定位、状态取其后第二个 token | `wsl_rdp_keeper.sh` |
| 19 | 10-02 22:42 | `npx @deepseek-ai/dsh web` 报 `'dsh' is not recognized` | 诊断：在仓库目录里 `npx` 会命中本地 workspace 包 `apps/cli`（包名正是 `@deepseek-ai/dsh`），转去跑 `node_modules/.bin/dsh`，而 pnpm 不建这个链接 → 换目录执行或用 `pnpm dsh` | 未改代码 |
| 20 | 10-03 01:00 | 预处理有效果吗、会不会掉缓存命中率、怎么提高 | 逐会话实测成本账本；定位到固定提示词 38.4k、其中 26.8k 是 computer-use；落地瘦身档 + `/profile` 开关 | `lean.patch.yml`、`bridge.mjs:465-469`、`471-540`、`877-899`（详见第 12 节） |

### 3.1 三个被实测推翻的设计

诚实记录，避免以后重走：

1. **旧文档里的「纯并集掉到 4/9」是错的**，2026-10-02 复测是 **5/9**（失败：`aes_key`、3 条新话题）。带闸门（默认）9/9，只用 A 也是 9/9。差的那条 `aes_key`：A 选中为空、B 凭空点了第 1 轮，并集非空导致判成「相关」——这正是闸门要拦的情况。**本文档已按实测数字修正**。
2. **英文小模型不可用**：`all-MiniLM-L6-v2`（23 MB）对中文的相关句 0.54~0.71、无关句 0.49~0.53，几乎重叠；多语言版对同样 8 个用例给出相关 0.42~0.83、无关 ≤0.06，8/8 正确。所以默认值是多语言版。
3. **词面降级路径最初把一轮拆成两半判**（`max(词面(问题,用户句), 词面(问题,回答句)×0.9)`），与「判定单元是一轮问答」冲突，已改成整轮打分。

### 3.2 一次「活儿干完了但没送到」的故障

2026-10-02 17:58 的一次性重启落在一个已跑了 34 分钟的长回合中间：回合连同回复被一起杀掉，你什么也没收到。

两个修复都保留了：

- **发送侧**：iLink 的 `context_token` 会随时间失效，长回合结束时正好撞上，表现是整条回复静默丢失（日志里 `sendmessage ret=-2`）。现在带 token 被拒（`-2`/`-14`）会自动去掉 token 降级重发一次——文字路径和媒体路径都有。
- **重启侧**：`.state/restart-bridge-once.ps1` 先 `Wait-Idle`（最后一条历史是 assistant 且静默 120 秒；只有卡死 120 分钟才不等），再停进程；起来后等日志出现「开始监听微信消息」，否则从 `.state/backup` 回滚并再拉一次。

---

## 4. 代码导览（按文件）

### 4.1 `bridge.mjs`（1119 行）

| 区块 | 行 | 说明 |
| --- | --- | --- |
| 常量 | 28-68 | 路径、iLink 参数、模型路由、权限模式、各类上限、瘦身档开关 |
| `HELP_TEXT` | 70-84 | `/help` 的正文 |
| CLI 模式 | 86-91 | `--login` / `--check` / `--check-wechat` / `--check-media` |
| `log`/`sleep` | 94-102 | 带时间戳输出；等待 |
| `parseDotEnv` | 104-115 | 解析 `KEY=VALUE`，忽略注释 |
| `childEnv` | 117-126 | 子进程环境 = 仓库根 `.env` + 本目录 `.env` + 进程环境；强制注入权限模式 |
| `loadState`/`saveState` | 128-146 | 原子写：写 `.tmp` 再 rename |
| `randomUin`/`buildHeaders`/`baseInfo` | 148-172 | 每次请求随机 `X-WECHAT-UIN`（uint32 → 十进制字符串 → base64） |
| `api` | 174-192 | 统一 iLink 调用；超时用 AbortController，长轮询里超时是正常的 |
| `fetchQr`/`qrLogin` | 194-281 | 二维码 8 分钟有效，过期自动换新；处理 `wait/scaned/need_verifycode/expired/binded_redirect` 等全部状态 |
| `chunkText` | 283-298 | 按 1200 字分片，尽量在换行处断开 |
| `isStaleSession` | 300-303 | `-2`（会话不新鲜）/ `-14`（登录态过期）判定 |
| `sendText` | 305-335 | 分片 + 加「(1/2)」序号 + 带 token 被拒则去 token 重发 |
| `mediaApi`/`TOKEN_FOOTER` | 337-342 | 媒体接口超时 60 秒；token 脚注开关 |
| `sumUsage`/`tokenFooter` | 351-380 | 一个回合内所有 step 的 usage 累加（不是取最后一次） |
| `sendMedia` | 382-397 | 转调 `ilink-media.mjs` |
| `extractMediaLines` | 399-414 | 摘 `MEDIA:<路径>` 行；文件不存在只记日志 |
| `typingTicket`/`setTyping` | 416-446 | 「正在输入」票据缓存 10 分钟；失败静默忽略 |
| `messageText`/`enqueue` | 448-463 | 取文本或语音转写；同一用户串行，不会并发跑多个回合 |
| `leanProfile` | 465-469 | 当前提示词档位（`/profile` 改它；`state.leanProfile` 持久化） |
| `DshRuntime` | 471-540 | 一个工作区一个 dsh 子进程；动态 import SDK 客户端；瘦身档在这里挂 `patches`；失败丢弃实例下次重拉 |
| `runtimeFor` | 545-571 | 超 `DSH_MAX_RUNTIMES` 时按 LRU 关掉空闲运行时；档位变了就重建 |
| `closeIdleRuntimes`/`closeAllRuntimes` | 573-589 | 回收空闲运行时（`/profile` 切档后用）；关掉全部 |
| `recycleRuntimeIfNeeded` | 591-598 | 单运行时累计会话数超 `DSH_MAX_SESSIONS` 就回收（预处理每回合新建会话，不回收会持续涨内存） |
| `resolveWorkspacePath` | 600-607 | 支持 `~`、绝对路径、相对当前工作区 |
| 会话/历史 | 609-687 | `sessionKey`、`ensureSession`（旧版单 key 会话自动迁移）、`appendHistory`、`readHistory`、`replayPrefix` |
| `handleMessage` | 694-983 | 全部指令在这里分发，见下表 |
| `monitor` | 985-1029 | 长轮询主循环；`-14` 时提示重新扫码并退避 10 分钟 |
| `checkDsh`/`checkWechat`/`checkMedia` | 1031-1072 | 三个自检 |
| `main` | 1074-1119 | 档位落定、已有会话登记为「需要回放」、后台预热判定器 |

指令分发表（`handleMessage` 内）：

| 指令 | 行 | 行为 |
| --- | --- | --- |
| `/help` | 731 | 回 `HELP_TEXT` |
| `/pwd` `/ws` | 735 | 当前工作区 + 该工作区会话 id |
| `/ws <路径>` `/ws+ <路径>` `/cd <路径>` `/ws -` | 743-789 | 切工作区；`+` 会先建目录；`-` 回上一个 |
| `/ls [路径]` | 790-811 | 最多列 60 项 |
| `/send <路径>` | 812-829 | 发文件（图片直接显示） |
| `/history [n]` | 830-840 | 最近 n 轮（默认 10，上限 50）+ 记录文件路径 |
| `/new` | 841-849 | 换新会话 id，**并在历史里划时间线**（否则旧话题会被预处理重新塞回来） |
| `/pre [on\|off\|status]` | 850-875 | 开关与状态；状态里显示当前生效的判定器、阈值、缓存目录 |
| `/profile [lean\|full]` | 877-899 | 切换提示词档位；切档时回收空闲运行时，下一条消息用新档位重建 |
| `/status` | 901-912 | 工作区、会话、模型、权限、提示词档位、活跃运行时数、历史路径、运行时长 |

### 4.2 `ilink-media.mjs`（253 行）

| 区块 | 行 | 说明 |
| --- | --- | --- |
| 常量 | 19-33 | CDN 地址、media_type（1/2/3）、item type（2/4/5）、扩展名集合 |
| `mediaTypeFor` | 39-44 | 按扩展名判定 |
| `paddedSize`/`encryptEcb` | 47-55 | PKCS#7 补齐后的长度；AES-128-ECB |
| `uploadMedia` | 63-126 | 申请上传位 → 加密 → POST 到 CDN → 取响应头参数 |
| `buildItem` | 129-143 | 组装 `image_item` / `video_item` / `file_item` |
| `sendTextItem`/`sendMediaItem` | 154-204 | 发消息；带 token 失败则去 token 重试 |
| `assertSendOk` | 207-217 | 把 `ret`/`errcode` 翻成人话（`-2` 会提示「先给机器人发条消息刷新会话」） |
| `sendMediaFile` | 241-253 | caption 必须单独发一条——caption 和媒体放同一个 item_list 会被整包拒绝 |

### 4.3 `preprocess.mjs`（577 行）

| 区块 | 行 | 说明 |
| --- | --- | --- |
| 配置 | 31-86 | 模型名、下载源、缓存目录、阈值、各类字数/超时上限 |
| `preprocessInfo` | 97-120 | 给 `/pre` 展示的状态快照 |
| `cosine`/`shingles`/`lexicalScore` | 128-158 | 余弦；字符二元组 + 英文词的 Jaccard |
| `localEmbed`/`ollamaEmbed` | 162-188 | 嵌入的两级 |
| `localGenerate`/`ollamaGenerate` | 192-226 | 生成式的两级 |
| `warmupPreprocess` | 233-291 | 两条预热各自独立、互不阻塞；预热期间自动走已就绪的那级 |
| 嵌入缓存 | 294-343 | 按 SHA-1 指纹复用向量，文件是 `.vec.json` |
| `toExchanges`/`turnText`/`renderContext` | 345-392 | 把记录切成「一轮问答」；渲染回放前缀（默认 600 字/轮、8000 字总量） |
| `CONTINUE_CUE`/`looksLikeContinuation` | 394-400 | 承接兜底 |
| `buildGenPrompt`/`parseGenSelection` | 402-447 | 整段对话进 prompt，只让它吐轮次编号 |
| `runJudges` | 455-483 | 两个判定器 `Promise.all` 并行，任一失败不影响另一个 |
| `analyzeContext` | 497-572 | 并集 + 闸门 + 承接兜底 + 超限裁剪；返回 `context`/`digest`/`scores` 等 |
| `embeddingCacheFile` | 575-577 | 缓存路径 |

### 4.4 `send-media.mjs` / `test-preprocess.mjs`

`send-media.mjs`：不重启桥接也能推消息。默认收件人是状态文件里已配对的第一个用户，context token 也来自状态文件，所以**需要近期有用户消息刷新会话**。

```powershell
node send-media.mjs <文件> [--caption 文字] [--to <用户ID>] [--context-token <token>]
node send-media.mjs --text "一句话" [--to <用户ID>]
```

`test-preprocess.mjs`：9 条固定中文用例（4 轮历史），打印每个判定器选中的轮次、并集结果与耗时；`--scores` 额外打印每轮原始相似度，用来重新标定阈值。

```powershell
npm run test:preprocess            # 或 node test-preprocess.mjs
node test-preprocess.mjs --scores
```

---

## 5. 微信里的指令

| 指令 | 作用 |
| --- | --- |
| `/help` | 显示帮助 |
| `/status` | 工作区、会话、模型、权限、活跃运行时、运行时长 |
| `/pwd`（或 `/ws`） | 查看当前工作区与该工作区的会话 |
| `/ws <路径>` | 切换工作区（`/cd` 同义；相对路径按当前工作区解析，支持 `~` 与 `..`） |
| `/ws+ <路径>` | 新建目录并切过去 |
| `/ws -` | 切回上一个工作区 |
| `/ls [路径]` | 列出目录内容 |
| `/send <路径>` | 把本机文件发到微信：`jpg/png/gif/webp/bmp` 直接显示成图片，其他类型作为文件 |
| `/pre [on\|off]` | 查看或开关本地预处理 |
| `/profile [lean\|full]` | 提示词档位：`lean`（默认）省 token，`full` 开回截图/桌面操作 |
| `/history [n]` | 回看该工作区最近 n 轮对话（默认 10），并给出记录文件路径 |
| `/new` | 在**当前工作区**开新会话，清空上下文 |

其他任何文本都会作为提示词发给 DSH。会话按「微信用户 × 工作区」绑定（会话 ID 形如 `wx-xxxx`）。

**Agent 主动带图回复**：回复里出现独占一行的 `MEDIA:<本机路径>`，桥接就把该文件当附件发出去，并从文字里删掉这一行。相对路径按当前工作区解析，支持 `~`；文件不存在时只记日志、不发。

回复末尾还会附两行机器生成的说明（都可关）：

- 预处理判定：`（预处理：相关，带入 2 轮（生成式 1 ＋ 嵌入 1，并集 2）；判定器 gen+local；最高相似度 0.63）`
- token 消耗：`（本条消耗 12,345 tokens：输入 11,000，其中缓存 9,000，输出 1,345）`——数字来自该回合每个 `assistant/message` 事件的 usage，按 step 累加。**这行只发给微信，不写进回放历史。**

---

## 6. 快速开始与运维

### 6.1 前置条件

| 项 | 要求 |
| --- | --- |
| Node.js | >= 22（本仓库 engines 要求） |
| DSH 仓库 | 已 `pnpm install`，且构建过 SDK 客户端：`pnpm run build:lib` |
| 模型凭据 | `DEEPSEEK_API_KEY`（或兼容的 `DEEPSEEK_BASE_URL`） |
| 微信 | 手机微信（扫码授权用），建议用一个不常用的微信号 |
| 桥接依赖 | `npm install --registry=https://registry.npmmirror.com`（只有 `@huggingface/transformers`） |

用的是 `@huggingface/transformers` 3.x，它依赖 `sharp ^0.34.1`（Windows 预编译包可用）；本桥接只做**文本**推理，从不用它的图像能力。早期版本依赖 `@xenova/transformers`，那一版要的 sharp 0.32 预编译包已经下架，当时用 `stubs/sharp` 桩顶过；换到 3.x 后桩已删除。

### 6.2 凭据与首次登录

1. 在本目录建 `.env`（已被 `.gitignore` 忽略）：

```ini
DEEPSEEK_API_KEY=sk-你的key
# DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
```

2. 首次运行会打印一个 `https://liteapp.weixin.qq.com/q/...` 链接，用手机微信打开并确认授权（可能要输入手机微信上显示的数字）：

```powershell
node bridge.mjs
```

3. 用手机微信给这个机器人发一条消息，第一个发消息的微信号会被自动配对（见第 9 节），之后所有消息都会转给 DSH。

登录凭据与消息游标保存在 `.state/wechat-bridge.json`，下次启动直接复用；要换号执行 `node bridge.mjs --login`。

### 6.3 自检

```powershell
node bridge.mjs --check                        # DSH 运行时能否启动；有 key 时会跑一次真实对话
node bridge.mjs --check-wechat                 # iLink 服务是否可达（不登录）
node bridge.mjs --check-media C:\path\shot.png  # 用已保存的登录态给已配对用户发一张图
```

### 6.4 后台常驻与开机自启

`run-bridge.ps1` 带日志拉起桥接（输出按 5 MB 轮转到 `.state/logs/bridge.log`），`install-task.ps1` 注册计划任务 `DSH-WeChat-Bridge`：当前用户登录时自动启动、隐藏窗口、失败自动重试、每 30 分钟看护一次、无运行时长上限、不会起重复实例。

```powershell
pwsh -File wechat-bridge/install-task.ps1            # 注册并启动（重复执行 = 更新配置并重启）
pwsh -File wechat-bridge/install-task.ps1 -Status    # 查看任务状态与桥接进程
pwsh -File wechat-bridge/install-task.ps1 -Stop      # 停止桥接
pwsh -File wechat-bridge/install-task.ps1 -Uninstall # 停止并删除任务
```

实时看日志：

```powershell
Get-Content .\wechat-bridge\.state\logs\bridge.log -Wait -Tail 20
```

**为什么任务的动作是 `wscript.exe run-bridge-hidden.vbs`，而不是直接 `pwsh -WindowStyle Hidden`**：Windows 11 默认把控制台窗口交给 Windows Terminal 托管，托管出来的窗口不受 `-WindowStyle Hidden` 控制，会一直挂在桌面上；关掉它还会连带杀死桥接（任务退出码 `0xC000013A` = 控制台关闭），然后看护逻辑又把任务拉起来，于是「黑窗口关了又出现」。`wscript` 是 GUI 子系统进程，用 `WScript.Shell.Run(cmd, 0, True)` 从一开始就以 SW_HIDE 启动 pwsh，不再出现任何窗口；pwsh 的控制台依旧存在（隐藏），node/dsh/命令子进程都继承它，所以 Agent 干活时也不会弹窗。

如果还是看到黑窗口，把任务「常规」里改成「不管用户是否登录都要运行」（进程跑在会话 0，物理上没有桌面可显示窗口）——那一步需要管理员权限，且要保存账户密码。

注意：改动 `.env`（例如换 API key）后要重新执行一次 `install-task.ps1` 重启进程才会生效；任务只在你的用户登录时运行（注册不需要管理员、不需要密码），注销即停止。

### 6.5 改代码后怎么生效

Node 只在启动时读 `.mjs`。桥接是常驻进程，在磁盘上改 `preprocess.mjs` 对它没有任何影响——想让新代码生效只能把进程停掉重拉。

手动：

```powershell
pwsh -File wechat-bridge/install-task.ps1        # 内部会停旧进程再拉起
```

自动（推荐，尤其是从微信里下的指令）：把新代码放进目录、`.state/backup/` 留一份上一版，然后安排一次性计划任务执行 `.state/restart-bridge-once.ps1`。它做六件事：

1. `Wait-Idle`：等对话空闲（最后一条记录是 assistant 且静默 120 秒；只有卡死 120 分钟才不等）
2. 停计划任务 + 杀掉命令行匹配 `bridge.mjs` 的 node 进程
3. 删掉 npm 装依赖时被运行中进程占住、没删掉的 `node_modules/.onnxruntime-node-*` 和 `@xenova` 残留
4. 重新拉起计划任务
5. 等日志出现「开始监听微信消息」（75 秒）；没出现就回滚 `.state/backup` 里的上一版并再拉一次
6. 跑完自删任务定义

`.state/backup/` 里的三个 `.mjs` 是**上一版快照**，回滚用。发布新版本时记得同步更新它。

### 6.7 备份到 GitHub

可公开的部分同步到公开仓库 `zhangjiancai/zhangjiancai` 的 `wechat-bridge/` 目录（[仓库里的 README](https://github.com/zhangjiancai/zhangjiancai/blob/main/wechat-bridge/README.md)、[指令速查](https://github.com/zhangjiancai/zhangjiancai/blob/main/wechat-bridge/COMMANDS.md)）：

```powershell
pwsh -File sync-backup.ps1 -WhatIf     # 演练：密钥扫描 + 列出要同步的文件，不写不推
pwsh -File sync-backup.ps1             # 同步并推送
```

- **白名单 17 个文件**：五个 `.mjs`、四个启动/安装脚本、`package.json`/`package-lock.json`、`lean.patch.yml`、三份文档、`sync-backup.ps1`。
- **永不外传**：`.env`（API key）、`.state/`（登录态、会话票据、配对用户、真实对话记录）、`node_modules/`。脚本按密钥形状扫描，命中任何一条就中止，什么都不写。
- 备份仓库里的 `.gitignore` 由脚本生成（`.env` / `.state/` / `node_modules/`），是第二道防线。
- **改了指令或文档就再跑一次**；README 与 COMMANDS.md 必须同一次改完（见 `AGENTS.md`）。

### 6.8 查看当前在位的进程与任务

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'bridge\.mjs' } |
  Select-Object ProcessId, CreationDate
Get-ScheduledTask | Where-Object TaskName -like 'DSH-*' |
  ForEach-Object { $_ | Get-ScheduledTaskInfo | Select-Object TaskName, LastRunTime, LastTaskResult }
```

---

## 7. 配置项（环境变量）

写在 `wechat-bridge/.env` 或系统环境变量里；`.env` 改动后需要重启桥接进程。

### 7.1 桥接与模型

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | 无 | 必填，模型凭据；也可写在仓库根 `.env` |
| `DEEPSEEK_BASE_URL` | 官方地址 | 兼容网关地址 |
| `DSH_CWD` | DSH 仓库根目录 | 默认工作区（微信里可用 `/ws` 随时切换） |
| `DSH_PERMISSION_MODE` | `danger-full-access` | 子进程权限：`danger-full-access`（不提权、不询问）或 `workspace-write`（限制在工作区内） |
| `DSH_MAX_RUNTIMES` | `3` | 同时保留多少个工作区的 dsh 子进程（LRU 回收） |
| `DSH_MAX_SESSIONS` | `50` | 单个运行时累计多少个会话后回收它（预处理每回合新建会话） |
| `DSH_PROVIDER` / `DSH_MODEL` | `deepseek-official` / `deepseek-v4-flash` | 模型路由 |
| `DSH_INIT_TIMEOUT_MS` | `60000` | 拉起 dsh 子进程的握手超时（默认 10 秒在本机偏紧） |
| `DSH_HOME` | 用户默认 | Harness home；设成独立目录可隔离会话数据 |
| `DSH_REPO` | 本目录上一级 | DSH 仓库位置（用于找 SDK 客户端） |
| `DSH_BIN` | 空 | 指定 dsh 可执行文件，覆盖 SDK 默认解析 |
| `WECHAT_LEAN_PROFILE` | `1` | 提示词档位默认值：`1` = 瘦身（禁 computer-use，固定提示词 11.6k），`0` = 完整（38.4k）。微信里 `/profile` 的持久化设置优先 |

### 7.2 iLink 与微信侧

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WECHAT_ILINK_BASE` | `https://ilinkai.weixin.qq.com` | iLink 接入点（一般不用改） |
| `WECHAT_BOT_TYPE` | `3` | 取二维码时的 bot_type |
| `WECHAT_APP_ID` | `bot` | `iLink-App-Id` 请求头 |
| `WECHAT_BOT_AGENT` | `DSH-WeChat-Bridge/1.0.0` | `base_info.bot_agent` |
| `WECHAT_CHANNEL_VERSION` | `1.0.2` | `base_info.channel_version`（`send-media.mjs` 用） |
| `WECHAT_CDN_BASE` | `https://novac2c.cdn.weixin.qq.com/c2c` | 媒体上传 CDN |
| `WECHAT_MEDIA_DEBUG` | 空 | 设 `1` 打印上传与发包细节，用于诊断 ret/errcode |
| `WECHAT_ALLOW` | 空 | 允许的微信用户 ID，逗号分隔；设置后只有名单内的人能用 |
| `WECHAT_STATE_DIR` | `./.state` | 状态目录（多开账号时用它隔离） |
| `WECHAT_MAX_CHARS` | `1200` | 单条微信消息最大字符数，超长自动分片 |

### 7.3 上下文与 token

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WECHAT_REPLAY_EXCHANGES` | `4` | 新运行时接手续用旧会话时，回放最近几轮历史（0 = 关闭） |
| `WECHAT_REPLAY_MAX_CHARS` | `4000` | 回放内容的最大字符数 |
| `WECHAT_TOKEN_FOOTER` | `1` | 回复末尾附本回合 token 消耗；设 `0` 关闭 |
| `WECHAT_PREPROCESS` | `1` | 本地预处理默认开关；微信里 `/pre off` 的状态优先 |
| `WECHAT_PRE_NOTIFY` | `1` | 回复末尾是否附预处理判定 |

### 7.4 预处理层

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WECHAT_PRE_MODEL` | `all-minilm` | 判定器 A 降级到 Ollama 时用的嵌入模型 |
| `WECHAT_OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama 地址 |
| `WECHAT_PRE_LOCAL_MODEL` | `Xenova/paraphrase-multilingual-MiniLM-L12-v2` | 判定器 A 的进程内 ONNX 模型 |
| `WECHAT_PRE_MODEL_HOST` | `https://hf-mirror.com` | 模型下载源（换官方源设 `https://huggingface.co`） |
| `WECHAT_PRE_CACHE_DIR` | `~/.dsh/models` | ONNX 模型缓存目录（A、B 共用） |
| `WECHAT_PRE_LOCAL` | `1` | 设 `0` 跳过 A 的进程内模型，直接用 Ollama / 词面 |
| `WECHAT_PRE_LOW` / `WECHAT_PRE_KEEP` | `0.30` / `0.45` | 模型路径：判为相关 / 选中某轮的相似度阈值 |
| `WECHAT_PRE_LOW_LEXICAL` / `_KEEP_LEXICAL` | `0.06` / `0.10` | 词面降级路径的同名阈值 |
| `WECHAT_PRE_GEN` | `1` | 设 `0` 关闭判定器 B，只用 A |
| `WECHAT_PRE_GEN_MODEL` | `onnx-community/Qwen2.5-0.5B-Instruct` | 判定器 B 的进程内 ONNX 生成模型 |
| `WECHAT_PRE_GEN_DTYPE` | `q8` | B 的量化档位（`q4` / `q4f16` 更省内存，CPU 上没那么稳） |
| `WECHAT_PRE_GEN_GATE` | `embed` | 设 `none` 关掉闸门，恢复纯并集 |
| `WECHAT_PRE_OLLAMA_GEN_MODEL` | `qwen2.5:3b` | 判定器 B 降级到 Ollama 时用的生成模型 |
| `WECHAT_PRE_GEN_MAX_CHARS` | `16000` | 交给 B 的对话正文上限（超出保留最近的部分并标注） |
| `WECHAT_PRE_GEN_TURN_CHARS` | `800` | 交给 B 的单轮字数上限 |
| `WECHAT_PRE_GEN_MAX_TOKENS` | `32` | B 的输出上限（只吐轮次编号） |
| `WECHAT_PRE_GEN_TIMEOUT_MS` | `180000` | B 单次推理超时 |
| `WECHAT_PRE_GEN_WARMUP_TIMEOUT_MS` | `1800000` | B 的预热超时（首次要下约 490 MB） |
| `WECHAT_PRE_WARMUP_TIMEOUT_MS` | `120000` | A 的预热超时 |
| `WECHAT_PRE_TIMEOUT_MS` | `5000` | A 降级到 Ollama 时的单次请求超时 |
| `WECHAT_PRE_CACHE_LIMIT` | `2000` | 嵌入缓存最多保留多少条指纹 |
| `WECHAT_PRE_SELECT_RECORDS` | `0` | 参与判定的历史记录条数上限；`0` = 整条时间线 |
| `WECHAT_PRE_MAX_ENTRIES` / `_MAX_CHARS` | `0` / `8000` | 最多带入几轮（`0` = 不限）、回放前缀总字数 |
| `WECHAT_PRE_TURN_CHARS` | `600` | 回放前缀里单轮的字数上限 |

---

## 8. WSL 侧：崩溃转储、RDP 守护与磁盘

WSL 不是这套桥接的运行环境（桥接跑在 Windows 上），但**它在这台机器上一次吃掉过几 GB/小时的磁盘**，而且 RDP 守护跑在它里面。这一节把两件事都记清楚。

### 8.1 吃盘真凶：WSLg 的 weston 崩溃转储

**现象**：C 盘持续下降，`%TEMP%\wsl-crashes` 里不断冒出新文件。

**证据链**：

- 文件名规律 `wsl-crash-<pid>-<tid>-_usr_bin_weston-<n>.dmp`——崩溃的进程是 `/usr/bin/weston`，也就是 **WSLg 的合成器**。
- 每个转储约 **107~111 MB**，大约每 **100 秒**产生一个，**约合每小时 4 GB**。
- 2026-10-02 16:34~16:45 的三次清理日志（`~/.dsh/prune-wsl-crashes.log`）：

```
2026-10-02 16:34:06 删除 8 个转储，释放 854 MB（保留最新 2 个）
2026-10-02 16:35:07 删除 1 个转储，释放 107 MB（保留最新 2 个）
2026-10-02 16:45:08 删除 3 个转储，释放 320 MB（保留最新 2 个）
```

- 同一时间其它大头：`DiagOutputDir` 966 MB、`9.0.1-Release.260920012.exe` 468 MB、`vscode-stable-user-x64` 222 MB。**截图只是零头，真凶在 `%TEMP%`。**

**根因**：WSLg 的 weston 处于崩溃循环。（当时按「省 token」处理，没有继续深挖 weston 内部；处置方式直接绕开了它。）

**处置（2026-10-02 16:41）**：

```ini
# C:\Users\zjc20\.wslconfig
[wsl2]
guiApplications=false
```

然后 `wsl --shutdown` 重新引导。结果：最后一次转储停在 **16:40:19**，之后零新增；WSLg 挂载数 0、`weston` 进程 0；RDP 会话没断（keeper 不依赖 WSLg，自己跑在 Xvfb 上）。

**保险**：计划任务 `DSH-Prune-WslCrashes` 每 10 分钟跑一次 `~/.dsh/prune-wsl-crashes.ps1`，只保留最新 2 个转储；日志自身也只留最近 200 行，避免它自己变成负担。

**现状（2026-10-03 00:40 实测）**：`%TEMP%\wsl-crashes` 2 个文件共 **213 MB**，最新的停在 10-02 16:40；`.wslconfig` 的 `guiApplications=false` 仍在位。**崩溃循环没有复现。**

**代价**：`guiApplications=false` 关掉了 WSLg（WSL 里跑不了 GUI 程序）。RDP keeper 用的是 `Xvfb` 虚拟屏，不依赖 WSLg，所以**不受影响**——这点在改动前专门确认过。

### 8.2 WSL 里的 RDP keeper

需求来自 10-01 你提的「我远程连不了桌面」和「能不能搞两个桌面/两个用户」。最终方案不是在 Windows 上再开一个桌面，而是**在 WSL 里、经 NAT 用 `xfreerdp3` 连回本机**：客户端在 Windows 主机上自己连自己会把桌面叠成垃圾，WSL 的 NAT 给了一个**真正不同的源地址**，`Xvfb` 又把画面渲染进没人看的虚拟屏。

设计规则（写在 `~/.dsh/wsl_rdp_keeper.sh` 头部）：

- **你在就让**：`qwinsta` 报你的会话 `Active` 就立刻让位；只有报 `Disc` 持续 30 秒（`QUIET_CHECKS=3` × `CHECK_INTERVAL=10`）才接管。
- **读不到行 ≠ 没人连**：正在建立会话时那一行也不可读，所以读不到要走 90 秒的长倒计时（`UNKNOWN_CHECKS=9`），不能当成断线。
- **稳态只记一条日志**，不能每 10 秒刷一行（这循环要跑几周）。
- **连接判定只看会话状态**，不看有没有 `xfreerdp` 进程——否则会把自己没启动的客户端算成自己的。

**踩过的两个坑**（10-02 21:37「又被挤下去」的根因，都在 `session_state()` 里）：

1. 硬编码会话 ID = 1，而实际会话 ID 已经变成 2 → 读成「没人连」，于是 keeper 每 10 秒抢一次。
2. `qwinsta` 的 `>` 标记打在**调用者自己**的会话行上。从 keeper 的 WSL 会话调用时，标记落在 `services` 行，于是用户那一行整体左移一列，按固定列读永远是空的。

现在的读法是：找到用户名 token，读它后面**第二个** token 当状态；任何一行报 `Active` 就算有人持有会话。

事件日志里当时看到 `.217` 和 `.30` 每分钟互抢一次，而 `192.168.31.217` **就是这台机器自己的 IP**——那是 keeper 的自连（经 WSL NAT 出网，源地址看起来和本机一样）。真正的你（`.30`，微软账号）每次连上就被这个本地自连踢掉（RDS session arbitration，reason code 5）。

### 8.3 磁盘账本（2026-10-03 00:40 实测）

| 位置 | 占用 | 说明 |
| --- | --- | --- |
| **C 盘整体** | 473.5 GB 总 / **52.5 GB 可用** | 清理前一度更低 |
| `%TEMP%` 合计 | 0.61 GB | `wsl-crashes` 213 MB、`DiagOutputDir` 60 MB、各类安装器残留 |
| `C:\Users\zjc20\.dsh` | **4.03 GB** | 其中 `models/` 3.75 GB、`speech-to-text/` 0.22 GB |
| └ `~/.dsh/models/onnx-community/Qwen2.5-1.5B-Instruct` | **3.14 GB** | ⚠️ **当前配置不用的实验残留**（默认生成模型是 0.5B） |
| └ `~/.dsh/models/onnx-community/Qwen2.5-0.5B-Instruct` | 0.48 GB | 判定器 B 在用 |
| └ `~/.dsh/models/Xenova/paraphrase-multilingual-…` | 0.13 GB | 判定器 A 在用 |
| `%LOCALAPPDATA%\npm-cache` | 2.00 GB | npm 缓存 |
| `%LOCALAPPDATA%\pnpm` | 2.87 GB | pnpm store |
| 仓库 `node_modules` | 1.80 GB | DSH 仓库依赖 |
| `wechat-bridge/node_modules` | 0.36 GB | 只有 transformers + onnxruntime |
| **WSL 的 ext4.vhdx** | **3.68 GB** | `%LOCALAPPDATA%\wsl\{235f9bee-…}\ext4.vhdx` |
| └ WSL 内部实际使用 | 2.1 GB | `/usr` 1.2 GB、`/var` 870 MB（apt cache 123 MB + lists 201 MB）、`/home` 52 KB |

WSL 发行版：`Ubuntu-24.04`，WSL 2.7.13.0，内核 6.18.33.2-2。

### 8.4 可回收项与命令

按「收益 / 风险」排序，**每条都先看一眼再删**：

```powershell
# 1) 3.14 GB：不用的 1.5B 生成模型实验残留（默认配置用的是 0.5B）
#    只有当你打算把 WECHAT_PRE_GEN_MODEL 换成 1.5B 时才需要保留
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\models\onnx-community\Qwen2.5-1.5B-Instruct"

# 2) npm / pnpm 缓存（合计约 4.8 GB，会按需重新下载）
npm cache clean --force
pnpm store prune

# 3) WSL 崩溃转储：手动只留最新 2 个（任务本来每 10 分钟做一次）
pwsh -File "$env:USERPROFILE\.dsh\prune-wsl-crashes.ps1"

# 4) WSL 内部：apt 缓存（约 320 MB）
wsl -d Ubuntu-24.04 -u root -- bash -lc "apt-get clean && rm -rf /var/lib/apt/lists/*"
```

**VHDX 不会自己变小**：删掉 WSL 里的文件，`ext4.vhdx` 仍然占着原来的大小。要真正把空间还给 Windows：

```powershell
wsl --shutdown
wsl --manage Ubuntu-24.04 --set-sparse true   # WSL 2.7 支持；之后 VHDX 会随删除自动收缩
```

或（需要 Hyper-V 模块，管理员）：

```powershell
wsl --shutdown
Optimize-VHD -Path "$env:LOCALAPPDATA\wsl\{235f9bee-b2dc-42af-b370-d4456fd55f0f}\ext4.vhdx" -Mode Full
```

### 8.5 WSL 侧文件与任务清单

| 路径 / 任务 | 作用 |
| --- | --- |
| `~/.wslconfig` | `[wsl2] guiApplications=false`——停掉 WSLg，崩溃循环随之停止 |
| `~/.dsh/wsl_rdp_keeper.sh` | WSL 内的 RDP 守护（让位逻辑 + `Xvfb` + `xfreerdp3`） |
| `~/.dsh/run_rdp_keeper.ps1` | Windows 监管器：keeper 死了就重启，日志超 5 MB 轮转，拒绝起第二个实例 |
| `~/.dsh/run_rdp_keeper_hidden.vbs` | 无窗口启动监管器 |
| `~/.dsh/enable_boot_autostart.ps1` | 可选提权步骤：给 `DSH-RDP-Keeper` 加 `AtStartup`（保存凭据，才能无人登录时启动） |
| `~/.dsh/prune-wsl-crashes.ps1` / `.log` | 只留最新 2 个 weston 转储；日志自截断到 200 行 |
| 任务 `DSH-WeChat-Bridge` | 登录时启动桥接；每 30 分钟看护；`IgnoreNew` |
| 任务 `DSH-RDP-Keeper` | 登录（+10s）/开机（+45s）启动 keeper 监管器 |
| 任务 `DSH-Prune-WslCrashes` | 每 10 分钟清理 `%TEMP%\wsl-crashes` |

**两个 keeper 不能同时跑**：两个重连循环会互相打架，把你踢下会话。监管器已经用「命令行里出现 `run_rdp_keeper.ps1` 就退出」防止手工重复启动，但**不要手工再起一个**。

---

## 9. 安全

- **默认是完全访问**：桥接给 dsh 子进程设 `DSH_PERMISSION_MODE=danger-full-access`——不受文件沙箱限制、也不再询问审批，能读写工作区之外的任意路径、执行任意命令。无人值守时没人点「允许」，这是微信远程干活的前提。
- 配对对象等于拿到了你机器的操作权，务必确认 `WECHAT_ALLOW` 里只有你自己。不设 `WECHAT_ALLOW` 时，**第一个发消息的人会被自动配对**并写入状态文件，其他人会被拒绝并收到自己的用户 ID。
- 想收回权限：在 `.env` 里设 `DSH_PERMISSION_MODE=workspace-write`，再执行一次 `install-task.ps1`。实测对比（同一提示词：在 `C:\Users\zjc20\dsh-perm-probe` 写文件）：

| 权限模式 | 结果 |
| --- | --- |
| `workspace-write`（Harness 默认） | 被拒：`[sandbox: file access denied under workspace-write mode]`，文件未创建 |
| `danger-full-access`（桥接默认） | 成功写入，返回 OK |

- 想更保守就把 `DSH_CWD` 指到一个专用工作目录，或把 `DSH_HOME` 指到独立目录，避免 Agent 碰到你的真实项目与历史会话。
- 凭据放在本目录 `.env` 或系统环境变量里，不要提交到 git。`.state/wechat-bridge.json` 里也有 bot token 和 `context_token`，同样别外传。
- 同一微信号不要同时绑定两个客户端（本桥接与 OpenClaw 插件），否则 iLink 返回 `binded_redirect`。

### 与 OpenClaw / ClawBot 的关系

腾讯官方的 `@tencent-weixin/openclaw-weixin` 插件把微信接进 OpenClaw 的 Agent 循环；本桥接复用同一套 iLink Bot API，但把消息交给 DeepSeek Harness 的 Agent 循环，因此两边可以各自独立存在。

---

## 10. 已知限制

- 一个桥接进程对应一个微信账号；多账号就多开几个进程（用不同的 `WECHAT_STATE_DIR`）。
- 同一微信用户的消息串行处理，不会并发跑多个回合。
- 没有 `/stop`：SDK 协议目前只提供提交提示词，不提供取消进行中的回合。
- 回复按 `WECHAT_MAX_CHARS` 分片发送，微信侧会显示为多条消息。
- 每个活跃工作区一个 dsh 子进程（内存开销随工作区数量增长），超过 `DSH_MAX_RUNTIMES` 会按最近使用回收；回收后再切回要 ~10 秒冷启动。
- **接收方向只处理文字与语音转写**，你发图片进来机器人会回一句提示。
- 群聊未支持，只在单聊里工作。
- `deepseek-v4-flash` 不支持图像输入：桥接能截图、能发图，但**看不见图里的内容**。要看图得起 `subagent_vision` 子代理（见第 3 节需求 4）。
- 微信侧会话不在 DSH 的会话存储里，Web/桌面端会话列表看不到它们。
- 完全没有权限确认环节：`danger-full-access` 下 Agent 的任何写操作与命令都直接执行，不会先问你。
- 预处理每回合新建会话，Agent 不保留上一回合的工作状态（读过的文件、内部计划），只保留被选中的对话轮次。

---

## 11. 常见问题

**`无法加载 SDK 客户端 .../packages/sdk/client/lib/index.js`**：仓库还没构建，执行 `pnpm run build:lib` 后重试。

**日志出现 `errcode -14` 或机器人突然不回消息**：iLink 登录态过期。重新执行 `node bridge.mjs --login` 扫码，然后重启桥接进程。

**回复很慢**：一次 Agent 回合可能跑几分钟（要读文件、执行命令）。桥接会先回「收到，正在处理…」并持续发送「正在输入」（每 5 秒保活），完成后发送结果。预处理本身另加 1~4.3 秒（本机生成式判定器，不花 token）。

**`/send` 报 `-2 prepare failed`**：iLink 把这条会话判定为「不新鲜」。用户消息自带的 `context_token` 会随时间失效——一次跑几分钟的回合结束时正好会撞上，表现是**回复整条丢失**（日志里是 `处理失败 ... sendmessage ret=-2`）。桥接和 `send-media.mjs` 现在都会在带 token 被拒后**去掉 token 降级重发一次**，这是 iLink 认可的回退路径。仍然失败时，先给机器人发一条消息刷新会话再重试。

**图片显示成灰块**：`aes_key` 传成了 `base64(原始 16 字节)`。必须是 `base64(密钥的十六进制字符串)`（`ilink-media.mjs:120-121`）。

**上传报错但看不到细节**：设 `WECHAT_MEDIA_DEBUG=1`，`ilink-media.mjs` 会打印 `getuploadurl` 响应、CDN 状态码与响应头参数长度。

**微信里没有截图 / 桌面操作能力了**：默认的瘦身档禁用了 computer-use 那一组工具——它占固定提示词 26,837 tokens，是全部 38.4k 的 70%。需要时发 `/profile full` 开回来，用完发 `/profile lean` 切回去（见 12.5）。

**改了代码没生效**：Node 只在启动时读 `.mjs`，必须重启桥接进程（见 6.5）。

**`npx @deepseek-ai/dsh web` 报 `'dsh' is not recognized`**：不要在 `deepseek-harness` 仓库目录里用 `npx`。npm 会先找「本地前缀」，在仓库里 `npm prefix` 一律返回仓库根，而根 `package.json` 的 workspaces 里 `apps/cli` 的包名**正好是** `@deepseek-ai/dsh`，于是 npm 判定「本地已有」，转去跑 `node_modules/.bin/dsh`——但仓库用 pnpm，不会建这个链接。换到别的目录执行，或在仓库里用 `pnpm dsh`。

**C 盘又满了**：先看 `%TEMP%\wsl-crashes` 有没有在涨（见 8.1），再看 `~/.dsh/models`（见 8.4）。

**后台常驻**：见 6.4；Linux/macOS 用 `nohup node bridge.mjs &` 或 systemd。

---

## 12. 成本与缓存（2026-10-03 实测）

### 12.1 成本公式

`dsh` 是 agentic 循环：一个回合 12–78 步，**每一步都把当前上下文整个重发**。DeepSeek 的上下文缓存命中按约 1/10 计价，所以：

```
每回合成本 ≈ Σ_步 [ 0.1 × 该步上下文 + 1.0 × 该步新增 ] + 输出
```

命中率决定的是那个 `0.1`；**上下文体积和步数才是乘数**。把命中率从 98% 提到 100%，收益远不如砍掉一段每步都重发的提示词。

### 12.2 实测：命中率不是瓶颈

数据来自 `~/.dsh/storages/session_projcache`（每个会话一份用量账本；「持久会话」= 预处理上线前的行为，17:58 重启后每回合新建会话）：

| 会话 | 时间 | 模式 | 回合 | 末步上下文 | 缓存命中 | 未命中 | 命中率 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| wx-360e7b0f | 10-02 16:17 | 持久会话 | 5 | 272,256 | 34,772,096 | 111,233 | 99.68% |
| wx-bb61115b | 10-02 17:12 | 持久会话 | 2 | 143,232 | 6,174,848 | 37,223 | 99.40% |
| wx-16c90da8 | 10-02 17:59 | 预处理开 | 1 | 171,904 | 6,221,696 | 86,183 | 98.63% |
| wx-e4b9501c | 10-02 18:15 | 预处理开 | 1 | 71,808 | 710,784 | 32,227 | 95.66% |
| wx-8dee71db | 10-02 18:32 | 预处理开 | 1 | 63,616 | 611,072 | 23,222 | 96.34% |
| wx-9d44faa9 | 10-02 21:37 | 预处理开 | 1 | 140,544 | 3,063,808 | 33,273 | 98.93% |
| wx-d0a9915a | 10-02 22:42 | 预处理开 | 1 | 72,448 | 1,137,280 | 22,391 | 98.07% |

两条结论：

- **持久会话的上下文随对话单调增长**（第 5 回合单步已经 272k），预处理把它按回合截断——这才是预处理真正的价值。注意被丢掉的不是历史文本（`history/*.jsonl` 总共才 ~24k tokens），而是**上一回合的工具输出**。
- **两个模式的命中率都是 95.7%–99.4%**：一个回合 12–78 步，第 2 步起全部命中，跨回合那一刀只切在第一步。所以「预处理会不会掉命中率」的答案是不会（见 12.3）。

### 12.3 一次新会话要付多少未命中

受控探针（走桥接同一条 SDK 路径、同一 cwd、同一 profile）：

| 场景 | 未命中 | 命中 | 命中率 |
| --- | --- | --- | --- |
| 全新会话 + **同一个**用户消息 | 145 | 38,272 | 99.6% |
| 全新会话 + **新的**用户消息 | **5,905** | 32,512 | 84.6% |
| 同一会话续聊 | 161 | 38,272 | 99.6% |

原因：`AGENTS.md` + `packages/AGENTS.md` 的指令块（约 6.2k tokens）排在**用户消息之后**，用户消息一变，它们整块落进未命中区。所以「每回合新会话」的代价 ≈ **5.9k tokens/回合**，相对它省下的几十万可以忽略（约 50:1）。

### 12.4 固定提示词的构成（大头在这里）

每一步都要重发的那部分，用逐组禁用的方式量出来（`dsh --profile sdk`，2026-10-03）：

| 组成 | tokens | 占比 | 处置 |
| --- | --- | --- | --- |
| **computer-use + cua-driver-native** | **26,837** | 69.9% | ✅ 已由 `lean.patch.yml` 禁用 |
| AGENTS.md + packages/AGENTS.md | 6,250 | 16.3% | 保留（仓库规范，有用） |
| skill + workflow + subagent-fork | 2,534 | 6.6% | 保留（每步只 253，能力优先） |
| 系统提示 + 其余核心工具 | 2,456 | 6.4% | 保留 |
| 视觉子代理（tool-subagent-vision） | 220 | 0.6% | 保留（便宜，且是「文本模型外包看图」那条路） |
| plan-mode | 119 | 0.3% | 保留 |
| **合计** | **38,416** | | |

这条历史完全对得上：9-30 的桥接自检固定提示词是 11,383 tokens；10-01 16:18 装完 computer-use 后变成 38,196（+26,813）——**为了「玩游戏 / 看屏幕」加的那组工具，给之后每一次模型请求都加了 27k**。

### 12.5 已经做的优化：瘦身档（默认开启）

`lean.patch.yml` 只禁掉 `computer-use` 与 `computer-use-cua-driver-native` 两行：

| | 固定提示词 | 每步有效成本 | 20 步回合的固定开销 |
| --- | --- | --- | --- |
| 完整档 | 38,417 | 3,842 | 76,840 |
| **瘦身档** | **11,579** | **1,158** | **23,160** |
| 变化 | −26,838（−69.9%） | −2,684 | −53,680 |

**验证**（同一条 `node bridge.mjs --check` 路径，同一提示词，间隔两分钟）：

| 档位 | 运行时日志 | 真实用量 | 固定提示词 |
| --- | --- | --- | --- |
| lean | `提示词=lean` | `inputTokens 5,819 + cacheRead 5,760` | **11,579** |
| full | `提示词=full` | `inputTokens 144 + cacheRead 38,272` | **38,416** |

差 26,837，与逐组禁用测出来的 computer-use 那一组完全对上。瘦身档下 `read` 与 `pwsh` 实测可用（读文件 + `node -v` 都成功）。

**怎么切换**：微信里发 `/profile` 看当前档位；`/profile full` 把截图 / 桌面操作能力开回来（会回收空闲运行时，下一条消息生效），`/profile lean` 切回去。也可以设 `WECHAT_LEAN_PROFILE=0` 改默认值。档位持久化在 `state.leanProfile`。

### 12.6 还没做、可以再压的

| 措施 | 预期收益 | 为什么不默认开 |
| --- | --- | --- |
| 收紧 `spill-policy.maxInlineTokens`（现 12500）与 `tool-result-pruner`（现 8192/4096/1024） | 直接压缩每步上下文，量级取决于工具输出多大 | 截断更狠可能换来更多次重读，净收益不确定，先留观察 |
| 前缀锚定：复用上一回合的历史前缀、只在尾部追加 | ~1–3k 未命中/回合（1–2%） | 收益小，改的是 `handleMessage` 主路径 |
| 把默认工作区换成一个没有 AGENTS.md 的目录 | ~6.2k 未命中/回合 + 620/步 | 会丢掉仓库规范，取舍在你 |
| 再禁 skill / workflow / subagent-fork | 253/步（20 步约 5k） | 这个仓库重度使用 skill |
| 减少步数（合并工具调用） | 每省一步就省一次整份上下文 | 取决于任务，没有通用开关 |

---

## 附录：维护这套文档

- **行号会漂**：第 4 节的表格按行号索引，改代码后请一并更新；第 3 节的位置列同理。
- **实测数字优先于旧结论**：本文档已修正旧版关于「纯并集 4/9」的说法（实测 5/9，见 3.1）。改阈值后跑 `node test-preprocess.mjs --scores` 重新标定，并把新数字写回这里。
- **新功能要有落点**：加一条能力时，同时更新第 1 节能力清单、第 2.2 节文件地图（新文件）、第 5 节指令表（新指令）、第 7 节配置表（新变量）。
- **备份**：`.state/` 可整目录备份；只备份 `wechat-bridge.json` 也够恢复登录态与配对关系。
- **同步快照**：发布新版本前把当前三个 `.mjs` 复制进 `.state/backup/`，否则回滚会退回更老的版本。
- **瘦身档的边界**：`lean.patch.yml` 只禁 computer-use 那两行；动它等于动固定提示词的体积。改完用 `node bridge.mjs --check` 看真实用量，并把新数字写回 12.4 / 12.5 两节。

---

### 需求-实现时间线（速查）

```
10-01 16:07  工作区切换        → /ws 系列
10-01 16:11  玩游戏日常        → computer-use 插件（游戏未做）
10-01 16:26  图片模型外包      → subagent_vision + vision 模型条目
10-01 16:29  重启              → 一次性重启任务 → restart-bridge-once.ps1
10-01 16:47  RDP 会话          → xfreerdp on Xvfb（WSL）
10-01 18:36  别抢我的会话      → keeper「你在就让」
10-01 20:39  开机自启          → DSH-RDP-Keeper
10-02 16:17  发图片 + token    → ilink-media.mjs + tokenFooter
10-02 16:27  清理 + 省空间     → 清理 + DSH-Prune-WslCrashes
10-02 16:33  查 WSL 崩溃       → weston 崩溃循环
10-02 16:41  改 wslconfig      → guiApplications=false
10-02 16:47  本地预处理        → preprocess.mjs + /pre
10-02 17:12  判定口径修正      → 以「轮」为单位、整条时间线
10-02 17:24  AB 取并集         → 双判定器 + 闸门
10-02 18:15  重启脚本/上限     → Wait-Idle + 上限放开
10-02 21:37  又被挤下去        → session_state() 两个 bug 修复
10-02 22:42  npx dsh 报错      → 本地前缀命中 workspace 包
10-03 00:31  系统整理          → 本文件
10-03 01:04  成本优化          → lean.patch.yml + /profile（固定提示词 38.4k→11.6k）
```
