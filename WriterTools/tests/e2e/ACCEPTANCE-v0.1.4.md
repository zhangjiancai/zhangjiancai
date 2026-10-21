# WriterTools v0.1.4 端到端验收报告（备份目录灾备恢复）

- **验收日期**：2026-10-21（Asia/Shanghai）
- **验收人**：qa（Playwright 自动化 + 独立日志校验器 `tools/wtlog-check.mjs`）
- **被验收构建**：**v0.1.4** 最新源码 `npm run build` 产物（`dist/index.html` + `dist/assets/index-n3MnYef8.js` 274 054 B + `dist/assets/index-RJHubUlv.css` 16 123 B；无 dev 假引擎）
- **浏览器**：Chrome 155.0.8059.85、Edge 155.0.4283.62（系统安装版本，headless，未下载 Playwright 自带浏览器）
- **环境**：Windows 11 Pro 10.0.26300 64-bit、Node v22.23.2、npm 10.9.8、Playwright 1.64.1、fflate 0.8.3
- **测试脚本**：`tests/e2e/run.mjs`（**27 步**：原 26 步 + 1 个灾备闭环场景步骤）
- **证据目录**：`tests/e2e/artifacts/`（`disaster-manifest.json`、`disaster-*.wtlog`、`22-disaster-recovery.png`、`backup-dir-*`、`export.wtlog`、`e2e-chrome.log` 等；已 gitignore）
- **历史报告**：`ACCEPTANCE-v0.1.3.md`（自动备份）、`ACCEPTANCE-v0.1.2.md`（.wtzip）、`ACCEPTANCE-v0.1.1.md`（加固）、`ACCEPTANCE-v0.1.md`（首版）

## 一、结论

| 验收项 | 结果 |
| --- | --- |
| `npm run build`（tsc --noEmit + vite build） | ✅ 通过（v0.1.4：`index-n3MnYef8.js` 274 054 B / gzip 88.66 KB） |
| `npm run typecheck` | ✅ 通过 |
| `npm test`（引擎单元测试） | ✅ **16 文件 / 98 测试**（含灾备恢复、空库不污染备份清单等） |
| Chrome 155 `npm run e2e`（27 步） | ✅ **27/27 步通过**，退出码 0 |
| Edge 155 `E2E_CHANNEL=msedge npm run e2e`（27 步） | ✅ **27/27 步通过**，退出码 0 |
| 原有 26 步断言（逐字符/IME/持久化/快照/主题/只读/自动恢复/.wtzip/自动备份/移动端…） | ✅ 无回退（Chrome + Edge） |
| **新增：浏览器数据丢失 → 从备份目录一键恢复** | ✅ 导入 2 篇、直接回**默认书架**（非回收站）、标题/正文逐字符一致、版本历史存在、「校验全部」通过 |
| **新增：空库重选备份目录不污染灾备清单** | ✅ manifest 字节不变、旧条目无 `trashed`、`.wtlog` 不变、kv `lastBackupAt` 保持；UI 提示「本地暂无作品，可直接点从备份目录恢复」 |
| **新增：重复恢复幂等** | ✅ 「导入 0 · 合并 0 · 跳过 2 · 冲突 0 · 失败 0」、作品数与各作品事件数不变 |
| 未配置备份目录时「从备份目录恢复」 | ✅ 按钮 disabled（e2e 第 13 步断言） |
| 导出 `.wtlog` header | ✅ `app.version=0.1.4`、`format=1.0`（e2e 断言与 package.json 一致） |
| 原生 FSA 目录 / 真实浏览器清站点数据 | ⚠️ headless 用真实 OPFS 目录冒充；**真实磁盘与真实"清除站点数据"流程需人工验证**（见第五节） |

**总体结论：v0.1.4 灾备闭环通过端到端验收**——"备份目录自动备份 → 本地数据全丢 → 重选同一目录 → 一键恢复全部作品"整条链路在 Chrome/Edge 均通过，且修复了"空库重选目录会把灾备清单旧条目误标 trashed 导致恢复进回收站"的边界 bug。

## 二、新增场景明细（e2e 第 25 步，Chrome + Edge 均 PASS）

前置：`addInitScript` 把 `window.showDirectoryPicker` 换成返回真实 OPFS 子目录 `backup-target`。

### 2.1 灾备备份建立

1. 建「灾备甲」（16 码元，Ctrl+S 快照）与「灾备乙」（16 码元）；
2. 设置 → 选择备份目录 → 首次备份；manifest 校验（Chrome 本轮）：

   | 作品 | 文件 | lastSeq | chars | fileHash（sha256） |
   | --- | --- | --- | --- | --- |
   | 灾备乙 | `灾备乙-3d1227aa.wtlog` | 21 | 16 | `38648127…` |
   | 灾备甲 | `灾备甲-bf55853c.wtlog` | 22 | 16 | `8aecab35…` |

   manifest：`magic=writertools-backup-manifest`、`format=1.0`、`app.version=0.1.4`、`docs=2`、`createdAt/updatedAt/backupAt` RFC3339；两篇日志独立 `wtlog-check` → **OK（22 / 23 事件、16 字符、各 1 快照）**，docId/lastSeq/lastHash 与 manifest 锚点一致。

### 2.2 模拟浏览器本地数据全部丢失

- `page.evaluate` 清空 IndexedDB `writertools` 的 `docs`/`events`/`kv` 三个 store（`kv` 含备份目录句柄）；
- 删除 OPFS `docs/` 镜像目录，**保留 `backup-target/`**；
- 刷新后书架为空（`docItem` 数 0），应用无异常。

### 2.3 重新选择同一备份目录（空库保护）

- 本地书架为空时，UI **不再自动做"首次备份"**，只提示「已设置备份目录；本地暂无作品，可直接点「从备份目录恢复」」；
- 引擎侧兜底：本地 `records.length === 0` 且目录已有非空旧 manifest 时**完全跳过本次 manifest 写入**；
- e2e 断言：重选目录后 manifest 仍为 2 个作品、旧条目 **无 `trashed`**、各条目 `lastSeq` / `fileHash` 与首次备份完全一致、两个 `.wtlog` 内容字节不变；这正是被修复的边界 bug 的回归护栏。

### 2.4 一键恢复 + 幂等验证

1. 设置 → 点 `restore-from-backup-button` → `archive-import-result` 显示
   **「从备份目录恢复结果：导入 2 · 合并 0 · 跳过 0 · 冲突 0 · 失败 0」**；
2. 关闭设置 → 书架 **2 篇（默认书架，非回收站）**；逐篇打开：标题正确、正文逐字符一致；「灾备甲」历史面板存在 1 个版本；
3. 设置「校验全部」→ **「校验通过：2 个作品，哈希链与快照一致。」**；
4. 再次点「从备份目录恢复」→ **「导入 0 · 合并 0 · 跳过 2 · 冲突 0 · 失败 0」**；书架仍 2 篇、两篇作品 IDB 事件数前后一致（不重复写入）。

### 2.5 损坏隔离（本次未执行，说明原因）

任务中为"可选但建议"。本次跳过 e2e 构造"篡改备份目录中某条 `.wtlog` 后恢复"的场景，理由：
- `restoreFromBackupDirectory()` 复用 `importArchive()` 的逐条目校验/隔离语义，该路径的"单条损坏 → 该条 failed、其余 imported、应用不白屏"已被 e2e 第 22 步（截断 `.wtzip` 可读报错）与引擎单测（损坏条目隔离）覆盖；
- 再构造该场景需二次清空本地库并篡改目录文件，增加时序复杂度与污染风险，收益有限。列为人工验证项（见第五节）。

## 三、原有 26 步回归（Chrome + Edge 全 PASS，无回退）

| 分组 | 覆盖内容 | 结果 |
| --- | --- | --- |
| PWA | manifest/图标字节与尺寸、SW 注册接管、断网重载可打开应用壳 | ✅ |
| 逐字符 | 快速输入无「正文已同步」误报/无回滚/光标末尾；中文/英文/emoji + 退格；IDB insert/delete（`deleted` 非空、`pos` 整数）、seq 连续、哈希链、重放一致 | ✅ |
| IME/来源 | CDP `Input.imeSetComposition` 记录 `compose.*`；`source=ime/paste/undo/redo` 与 `inputType` 校验 | ✅ |
| 持久化/历史 | 刷新后同 docId 打开正文一致；Ctrl+S 快照、历史预览、确认恢复（恢复提示仍在、正文与快照一致） | ✅ |
| 排版/主题 | mode 切换 `text-align` right↔left + `editor.mode`；双模式光标行居中误差 0.0 px；暗黑纯黑/亮白纯白、中性色抽样；奶白 `rgb(250,246,236)` | ✅ |
| 数据安全 | 单篇 `.wtlog` 导出校验/篡改检测/导入往返；`.wtzip` 全量包导出→独立校验→全新环境恢复→重复导入「跳过 2」→截断包可读报错不丢数据 | ✅ |
| 自动备份 | OPFS 伪目录真实写盘 + 快照后自动备份（lastSeq 19→30）+ 刷新启动补齐；未配置目录零副作用、状态显示未配置 | ✅ |
| 多标签/镜像恢复 | 第二标签页只读；主存储清空后启动自动恢复（提示/补回/校验/导出）；无损坏刷新无恢复噪声、不重复补写 | ✅ |
| 移动端 | 390×844 可输入、无横向溢出；全流程无未捕获页面异常 | ✅ |

## 四、构建与命令

```powershell
npm run build      # ✅ v0.1.4（index-n3MnYef8.js 274054B / index-RJHubUlv.css 16123B）
npm run typecheck  # ✅
npm test           # ✅ 16 files / 98 tests
npm run e2e                                   # ✅ Chrome 27/27
$env:E2E_CHANNEL='msedge'; npm run e2e          # ✅ Edge 27/27
npm run check:log -- --quiet tests/e2e/artifacts/disaster-*.wtlog   # ✅ 灾备备份日志
```

**版本说明**：v0.1.4 新写出的 `.wtlog` header `app.version="0.1.4"`、备份 manifest `app.version="0.1.4"`（e2e 断言与 package.json 一致），`format` 仍为 `1.0`；旧版文件仍可读。

## 五、需人工验证（headless 无法覆盖）

1. **真实磁盘灾备演练（Chrome/Edge 桌面）**：本次用真实 OPFS 目录冒充备份目录，链路等价，但以下需人工：
   - 选择真实磁盘目录并授权；用 DevTools/浏览器设置**真实清除站点数据**（IndexedDB/OPFS 被清空、FSA 目录句柄与权限丢失）→ 重新选择同一目录并授权 → 「从备份目录恢复」→ 数据完整；
   - 真实 FSA 权限在浏览器重启后的持久化/重新授权行为。
2. **损坏隔离（备份目录内单条日志损坏）**：可作为人工项：篡改备份目录中某条 `.wtlog`（或删除其中一个文件）→「从备份目录恢复」→ 该篇 failed、其余 imported、应用不白屏；引擎单测已覆盖。
3. **真实备份目录失败路径**：目录被删除/权限撤销/磁盘满时，恢复按钮报可读错误、原有数据不丢（引擎单测 + e2e 未覆盖）。
4. **PWA 安装流程**：桌面 Chrome/Edge 安装按钮、Android「添加到主屏幕」（manifest/图标/SW/离线已自动化）。
5. **真实输入法/软键盘、平台矩阵**：CDP IME 模拟；仅 Windows 11 + Chromium 桌面 + 390×844 视口模拟，macOS/Linux/真实 Android 未测。
6. **持久化存储授权**：headless 全新 context 显示「未授权」（预期）；真实浏览器首次访问需人工确认。
7. **大规模灾备**：本次 2 篇小作品；数百篇/大文档的备份目录恢复耗时、内存与进度反馈建议人工压测。

## 六、本次改动范围与剩余风险

- 引擎（task-14）：`restoreFromBackupDirectory()` 读取已配置目录的 manifest + `.wtlog`，内存打包 `.wtzip` 后复用 `importArchive()`（校验/合并/冲突/锁语义一致）；未配置/缺 manifest/无日志抛中文可读错误。
- 引擎（task-17）：`runBackup()` 在"本地库为空 + 目录已有非空旧清单"时**完全跳过写入**，避免把灾备清单旧条目误标 `trashed`；手动/自动备份同样受保护。
- UI（task-15）：设置「从备份目录恢复」按钮（未配置/busy 时 disabled）、`archive-import-result` 复用展示「从备份目录恢复结果」、成功刷新书架、失败可读错误、空库重选目录不自动首次备份的提示。
- QA（task-16）：新增 e2e 第 25 步灾备闭环；更新 `tests/e2e/README.md` 为 27 步；本报告 v0.1.4。
- **e2e 未覆盖**：真实 FSA 磁盘/浏览器真实清站点数据、备份目录内单条损坏隔离、备份目录权限失败路径（人工/引擎单测覆盖）。
- 自动化在全新 browser context 中运行；Chrome/Edge 复验复用了环境中已启动的 `vite preview`（确认返回的 `index.html` 与磁盘 `dist/index.html` 逐字节一致）。
- 本报告不修改 `src/`；发现问题均已反馈给对应 owner。
