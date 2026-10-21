# WriterTools v0.1.3 端到端验收报告（备份目录自动备份）

- **验收日期**：2026-10-21（Asia/Shanghai）
- **验收人**：qa（Playwright 自动化 + 独立日志校验器 `tools/wtlog-check.mjs`）
- **被验收构建**：**v0.1.3** 最新源码 `npm run build` 产物（`dist/index.html` + `dist/assets/index-azWcuneW.js` 270 784 B + `dist/assets/index-RJHubUlv.css` 16 123 B；无 dev 假引擎）
- **浏览器**：Chrome 155.0.8059.85、Edge 155.0.4283.62（系统安装版本，headless，未下载 Playwright 自带浏览器）
- **环境**：Windows 11 Pro 10.0.26300 64-bit、Node v22.23.2、npm 10.9.8、Playwright 1.64.1、fflate 0.8.3
- **测试脚本**：`tests/e2e/run.mjs`（**26 步**：原 24 步 + 2 个备份目录自动备份场景步骤）
- **证据目录**：`tests/e2e/artifacts/`（`backup-dir-*.wtlog`、`backup-dir-manifest*.json`、`backup-dir-export.wtlog`、`backup.wtzip`、`export.wtlog`、截图 20/21、`e2e-chrome.log` 等；已 gitignore）
- **历史报告**：`ACCEPTANCE-v0.1.2.md`（.wtzip 备份包）、`ACCEPTANCE-v0.1.1.md`（加固）、`ACCEPTANCE-v0.1.md`（首版）

## 一、结论

| 验收项 | 结果 |
| --- | --- |
| `npm run build`（tsc --noEmit + vite build） | ✅ 通过（v0.1.3：`index-azWcuneW.js` 270 784 B / gzip 87.76 KB） |
| `npm run typecheck` | ✅ 通过 |
| `npm test`（引擎单元测试） | ✅ **14 文件 / 89 测试**（含自动备份调度：四类快照触发、防抖/最小间隔/进行中补跑/失败静默） |
| Chrome 155 `npm run e2e`（26 步） | ✅ **26/26 步通过**，退出码 0 |
| Edge 155 `E2E_CHANNEL=msedge npm run e2e`（26 步） | ✅ **26/26 步通过**，退出码 0 |
| 原有 24 步断言（逐字符/IME/持久化/快照/主题/只读/自动恢复/.wtzip/移动端…） | ✅ 无回退（Chrome + Edge） |
| **新增：备份目录真实写盘（OPFS 伪目录）** | ✅ `backup-status` 显示「已配置（backup-target）· 上次备份」；目录内生成 `writertools-manifest.json` + `.wtlog`；manifest 锚点/fileHash 正确、日志过独立校验器 |
| **新增：快照后自动备份（不点「立即备份」）** | ✅ 续写 + Ctrl+S → 轮询到 `lastSeq 19 → 30`、日志 `9444 → 14653 B` 变长且旧日志为新日志字节前缀、`kv.backup.lastBackupAt` 前进 |
| **新增：刷新后启动补齐自动备份** | ✅ manifest `updatedAt` `17:28:06.836Z → 17:28:10.599Z`、`kv.lastBackupAt` 再次更新、无异常 |
| **新增：未配置备份目录无副作用** | ✅ OPFS 根目录仅 `docs/`、无 `backup-target`/manifest、kv 无 `backup.dirHandle`/无备份错误、状态「未配置」、刷新后同样干净 |
| 导出 `.wtlog` header | ✅ `app.version=0.1.3`、`format=1.0`（新增断言：header 版本与 package.json 一致） |
| 原生 FSA 目录选择器 | ⚠️ headless 用真实 OPFS 目录冒充；**真实磁盘目录/权限需人工验证**（见第五节） |

**总体结论：v0.1.3「备份目录自动备份」通过端到端验收**——选择目录→首次备份→快照触发自动备份（防抖 3s + 最小间隔 15s）→刷新启动补齐 全链路在 Chrome/Edge 均通过，原有 24 步无回退。

## 二、新增场景明细（e2e 第 23、24 步，Chrome + Edge 均 PASS）

### 2.1 备份目录真实写盘 + 自动备份（第 23 步）

headless 没有原生目录选择器，用 **真实 OPFS 子目录**冒充（`FileSystemDirectoryHandle` 可结构化克隆进 IDB、可读写）：

```js
await context.addInitScript(() => {
  window.showDirectoryPicker = async () => {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle('backup-target', { create: true });
  };
});
```

流程与实测（Chrome 本轮）：

1. 建作品输入中文 15 字 → Ctrl+S 快照 → 回书架；
2. 设置 → 点 `backup-choose-button`（选择备份目录）→ 首次备份：
   - `backup-status` 显示 **「备份目录：已配置（backup-target） · 上次备份 10-21 01:27」**；
   - OPFS `backup-target/` 出现 2 个文件：`writertools-manifest.json` + `无题-488ca18a.wtlog`；
   - manifest：`magic=writertools-backup-manifest`、`format=1.0`、`app.version=0.1.3`、`docs=1`、`lastSeq=19`、`lastHash=sha256:e4ff4dd2…`、`chars=15`、`backupAt` RFC3339；`fileHash` 与条目字节 SHA-256 相等；
   - 日志交 `node tools/wtlog-check.mjs` → **OK（20 事件 / 15 字符 / 1 快照）**，`docId`、`lastSeq`、`lastHash` 与 manifest 锚点一致；
   - IDB `kv.backup.lastBackupAt` = `2026-10-20T17:27:51.830Z`。
3. **续写 + Ctrl+S（不点「立即备份」）**，轮询等待（防抖 3s + 两次实际备份开始最小间隔 15s，最长 35s）：
   - manifest `lastSeq` **19 → 30**、`updatedAt` 更新；
   - 备份日志 **9 444 → 14 653 字节**，且旧日志为新日志的**字节前缀**（追加写，不重写历史行）；
   - 增量日志过独立校验器 → **OK（31 事件 / 23 字符 / 2 快照）**；
   - `kv.backup.lastBackupAt` 前进；
   - 与 UI 导出的 `.wtlog`（33 事件，含导出时新增的 session 事件）比对：**备份内容是其字节前缀**（备份文件不会多写或少写已提交的历史行）。
4. **刷新页面 → 启动补齐**：manifest `updatedAt` `2026-10-20T17:28:06.836Z → 2026-10-20T17:28:10.599Z`、`kv.backup.lastBackupAt` 再次更新，应用无异常。

### 2.2 未配置备份目录无副作用（第 24 步）

全新 context（不注入选择器、不选目录）：

1. 写作品 + Ctrl+S + 回书架，等待 2s；再刷新一次；
2. OPFS 根目录始终只有 `docs/`（镜像），**无 `backup-target`、无 `writertools-manifest.json`**；
3. IDB kv **无 `backup.dirHandle`、无 `backup.lastError`**；
4. `backup-status` 显示「备份目录：未配置」；
5. 全程无未捕获异常。

## 三、原有 24 步回归（Chrome + Edge 全 PASS，无回退）

| 分组 | 覆盖内容 | 结果 |
| --- | --- | --- |
| PWA | manifest/图标字节与尺寸、SW 注册接管、断网重载可打开应用壳 | ✅ |
| 逐字符 | 快速输入无「正文已同步」误报/无回滚/光标末尾；中文/英文/emoji + 退格；IDB insert/delete（`deleted` 非空、`pos` 整数）、seq 连续、哈希链、重放一致 | ✅ |
| IME/来源 | CDP `Input.imeSetComposition` 记录 `compose.*`；`source=ime/paste/undo/redo` 与 `inputType` 校验 | ✅ |
| 持久化/历史 | 刷新后同 docId 打开正文一致；Ctrl+S 快照、历史预览、确认恢复（恢复提示仍在、正文与快照一致） | ✅ |
| 排版/主题 | mode 切换 `text-align` right↔left + `editor.mode`；快速输入后双模式光标行居中误差 0.0 px；暗黑纯黑/亮白纯白、中性色抽样；奶白 `rgb(250,246,236)` | ✅ |
| 数据安全 | 单篇 `.wtlog` 导出校验/篡改检测/导入往返；`.wtzip` 全量包导出→独立校验→全新环境恢复→重复导入「跳过 2」→截断包可读报错不丢数据 | ✅ |
| 多标签/自动恢复 | 第二标签页只读；主存储清空后启动自动恢复（提示/补回/校验/导出）；无损坏刷新无恢复噪声、不重复补写 | ✅ |
| 移动端 | 390×844 可输入、无横向溢出；全流程无未捕获页面异常 | ✅ |

## 四、构建与命令

```powershell
npm run build      # ✅ v0.1.3（index-azWcuneW.js 270784B / index-RJHubUlv.css 16123B）
npm run typecheck  # ✅
npm test           # ✅ 14 files / 89 tests
npm run e2e                                   # ✅ Chrome 26/26
$env:E2E_CHANNEL='msedge'; npm run e2e          # ✅ Edge 26/26
npm run check:log -- --quiet tests/e2e/artifacts/backup-dir-488ca18a.wtlog   # ✅ 备份目录首次备份日志
npm run check:log -- --quiet tests/e2e/artifacts/backup-dir-488ca18a-2.wtlog # ✅ 增量备份日志
```

**版本说明**：v0.1.3 新写出的 `.wtlog` header `app.version="0.1.3"`（e2e 已断言与 package.json 一致），`format` 仍为 `1.0`；`writertools-manifest.json` 的 `app.version` 同为 `0.1.3`；旧版文件仍可读。

## 五、需人工验证（headless 无法覆盖）

1. **真实 FSA 备份目录（Chrome/Edge 桌面）**：原生目录选择器需要用户手势；本次用真实 OPFS 目录冒充验证了"真实文件句柄 + 结构化克隆进 IDB + 真实写文件"的完整链路，但以下需人工：
   - 选择真实磁盘目录并授权读写；重启浏览器后目录句柄/权限仍可用（Chrome 对文件系统权限的持久化行为）；
   - 真实磁盘写入（含大文件、磁盘满/目录被删/权限撤销时的 `lastError` 静默与下次重试）；
   - 用户清理目录后再次自动备份的表现。
2. **备份失败路径**：本次未注入"会抛 NotAllowedError / 写入失败"的假目录；引擎单测 + UI 自测覆盖（失败静默、`backup.lastError` 可观察、不弹错、不影响编辑），建议人工构造一次权限拒绝验证。
3. **回书架/关闭作品的 session 快照触发自动备份**：本次 e2e 覆盖 Ctrl+S 快照与启动补齐两条触发路径；关作品触发的 session 快照路径由 Lead 手工实测（15.3s 后更新）与引擎单测覆盖。
4. **PWA 安装流程**：桌面 Chrome/Edge 安装按钮、Android「添加到主屏幕」（manifest/图标/SW/离线已自动化）。
5. **真实输入法/软键盘、平台矩阵**：本次用 CDP IME 模拟；仅 Windows 11 + Chromium 桌面 + 390×844 视口模拟，macOS/Linux/真实 Android 未测。
6. **持久化存储授权**：headless 全新 context 显示「未授权」（预期）；真实浏览器首次访问需人工确认。
7. **大规模自动备份**：本次 1 篇小作品/2.6 KB 日志；数百篇/大文档时"快照后 3s 防抖 + 15s 最小间隔"的实际耗时与磁盘压力建议人工压测。

## 六、本次改动范围与剩余风险

- 引擎（task-11）：任何快照成功后按防抖 3s + 最小间隔 15s 调度 `backupNow()`；配置目录后/引擎重启后自动补齐；失败静默；`EngineOptions.autoBackup` 可配置。
- UI（task-12）：`backup-status` 状态行（已配置/未配置/上次备份/备份错误）、自动备份说明文案、"选择备份目录"后首次备份与 toast、立即备份保留。
- QA（task-13）：新增 e2e 第 23/24 步（OPFS 伪目录真实写盘 + 自动备份增量 + 启动补齐；未配置无副作用）；更新 `tests/e2e/README.md` 为 26 步；本报告 v0.1.3。
- **e2e 未覆盖**：原生 FSA 选择器/真实磁盘、失败注入路径、session 快照触发（上述人工项）；e2e 采用轮询断言相对变化（`lastSeq`/`updatedAt`/文件长度/`lastBackupAt`），不依赖固定秒数，降低时序抖动风险。
- 自动化在全新 browser context 中运行；Chrome/Edge 复验复用了环境中已启动的 `vite preview`（确认返回的 `index.html` 与磁盘 `dist/index.html` 逐字节一致）。
- 本报告不修改 `src/`；发现问题均已反馈给对应 owner。
