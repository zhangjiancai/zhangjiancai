# WriterTools v0.1.2 端到端验收报告（全量备份包 .wtzip）

- **验收日期**：2026-10-21（Asia/Shanghai）
- **验收人**：qa（Playwright 自动化 + 两个独立校验器：`tools/wtlog-check.mjs`、`tools/wtzip-check.mjs`）
- **被验收构建**：`npm run build` 最新源码产物（**v0.1.2**：`dist/index.html` + `dist/assets/index-BiUGc6Qn.js` 268 163 B + `dist/assets/index-RJHubUlv.css` 16 123 B；53 modules，无 dev 假引擎）
- **浏览器**：Chrome 155.0.8059.85、Edge 155.0.4283.62（系统安装版本，headless，未下载 Playwright 自带浏览器）
- **环境**：Windows 11 Pro 10.0.26300 64-bit、Node v22.23.2、npm 10.9.8、Playwright 1.64.1、fflate 0.8.3
- **测试脚本**：`tests/e2e/run.mjs`（**24 步**：原 20 步 + 4 个 .wtzip 备份/恢复场景步骤）
- **证据目录**：`tests/e2e/artifacts/`（25 张截图、`.wtlog` ×3、`.wtzip` ×2（含截断样本）、manifest 条目日志 ×2、两个校验器 JSON、完整运行日志 `e2e-chrome.log`；已 gitignore）
- **历史报告**：`ACCEPTANCE-v0.1.1.md`（加固版基线）、`ACCEPTANCE-v0.1.md`（首版基线）

## 一、结论

| 验收项 | 结果 |
| --- | --- |
| `npm run build`（tsc --noEmit + vite build） | ✅ 通过（v0.1.2，fflate 使包体 268 KB / gzip 87 KB，属预期） |
| `npm run typecheck` | ✅ 通过 |
| `npm test`（引擎单元测试） | ✅ **13 文件 / 76 测试**（含 .wtzip 导出/导入/合并/冲突/损坏隔离测试） |
| Chrome 155 `npm run e2e`（24 步） | ✅ **24/24 步通过**，退出码 0 |
| Edge 155 `E2E_CHANNEL=msedge npm run e2e`（24 步） | ✅ **24/24 步通过**，退出码 0 |
| 原有 20 步断言（逐字符/删除内容/IME/来源/持久化/快照恢复/主题/只读/自动恢复/移动端） | ✅ 无回退（Chrome + Edge） |
| **新增：全量备份包导出（2 作品含快照）** | ✅ `writertools-backup-*.wtzip` 6 599 B；导出 toast「已导出 2 个作品的备份包」；书架 `.wtzip` 路由导入显示「跳过 2」且不新增 |
| **新增：备份包独立校验** | ✅ `wtzip-check` 合规（2 作品 / 6 599 B）；manifest magic/format/app(0.1.2)/锚点/fileHash 全部正确；2 个 `.wtlog` 条目经 `wtlog-check` 通过（23 / 22 事件） |
| **新增：全新环境恢复** | ✅ 导入 2 篇、正文逐字符一致、版本历史存在、「校验全部」→ 2 个作品哈希链与快照一致；重复导入「跳过 2」、作品数不变、事件数不变 |
| **新增：损坏包隔离** | ✅ 截断包（3 959 / 6 599 B）导入显示可读错误「不是合法的 ZIP 文件」；应用不白屏、2 篇原有作品/事件数/正文均不受影响 |
| 导出 `.wtlog` header `app.version` | ✅ `WriterTools 0.1.2`、`format 1.0`（旧文件仍可读） |
| FSA 备份目录选择器 | ⚠️ 无法在 headless 交互，**需人工验证**（入口/状态已读通，见第五节） |

**总体结论：v0.1.2 全量备份包（.wtzip）功能通过端到端验收**——导出→独立校验→全新环境恢复→重复导入→损坏包隔离全链路在 Chrome/Edge 均通过，原有 20 步无回退。

## 二、新增验收场景明细（e2e 第 19–22 步，Chrome + Edge 均 PASS）

### 2.1 全量备份包导出（第 19 步）

在一套**全新 browser context**（空 IndexedDB/OPFS）中：

1. 新建「备份甲」，输入 `备份包甲：第一篇的中文正文内容。`（16 码元），Ctrl+S 手工快照；
2. 新建「备份乙」，输入 `备份包乙：第二篇的中文正文内容。`（16 码元）；
3. 书架确认 2 篇 → 设置 → 点 `export-archive-button` → 捕获下载保存 `artifacts/backup.wtzip`；
4. **Chrome 本轮**：`writertools-backup-20261021-0106.wtzip`，**6 599 字节**；导出 toast 含「已导出 2 个作品的备份包」；
5. 回归书架 `import-file-input` 的 `.wtzip` 路由：同一包再导入 → toast「备份包导入完成：导入 0 · 合并 0 · 跳过 2 · 冲突 0 · 失败 0」；未弹 `archive-import-modal`、未新增作品。

### 2.2 备份包独立校验（第 20 步，Node 侧，不依赖应用实现）

- `node tools/wtzip-check.mjs --quiet artifacts/backup.wtzip` → **`OK（2 个作品 / 6599 字节）`**
- fflate 解压（3 个条目 = manifest + 2 个 `.wtlog`），逐项核对：
  - `magic="writertools-backup-manifest"`、`format="1.0"`、`app={name:"WriterTools",version:"0.1.2"}`、`createdAt` RFC3339 UTC 毫秒；
  - `docs[]` 2 条：标题、`file="备份甲-19fc373a.wtlog"` / `"备份乙-264f7eb8.wtlog"`、`lastSeq=22/21`、`chars=16`、`backupAt`；
  - `fileHash` 与实际 ZIP 条目字节 SHA-256 **逐一相等**；
  - 条目路径均为安全相对路径（无 `..` / 绝对路径 / 反斜杠）。
- 把两个条目分别落盘后交独立日志校验器：
  - `备份甲-19fc373a.wtlog` → **OK（23 事件 / 16 字符 / 1 快照）**，`docId`/`lastSeq`/`lastHash` 与 manifest 锚点一致；
  - `备份乙-264f7eb8.wtlog` → **OK（22 事件 / 16 字符 / 1 快照）**，锚点一致。

### 2.3 全新环境恢复 + 重复导入（第 21 步）

另起一个**全新 browser context**（空存储）：

1. 设置 → `import-archive-input` 选 `backup.wtzip` → `archive-import-result` 显示
   **「备份包导入结果：导入 2 · 合并 0 · 跳过 0 · 冲突 0 · 失败 0」**；
2. 关闭设置：书架出现 2 篇作品；逐篇打开正文与预期**逐字符一致**；「备份甲」历史面板存在 1 个版本；
3. 设置「校验全部」→ **「校验通过：2 个作品，哈希链与快照一致。」**；
4. 同一 context 再导入同一包 → `archive-import-result` 更新为
   **「导入 0 · 合并 0 · 跳过 2 · 冲突 0 · 失败 0」**；作品数仍为 2，两篇作品的 IDB 事件数前后完全一致（不重复补写）。

### 2.4 损坏（截断）备份包隔离（第 22 步）

1. 新 context 正常导入 `backup.wtzip`（2 篇作品）并记录各作品事件数；
2. 把包字节截断为前 60% → `artifacts/backup-truncated.wtzip`（**3 959 / 6 599 字节**）；
3. 从设置导入截断包 → `archive-import-result` 显示可读中文错误：
   「备份包「backup-truncated.wtzip」导入失败：备份包（backup-truncated.wtzip）不是合法的 ZIP 文件：invalid zip data」；
4. 断言：`#root` 有内容（不白屏）、设置面板仍在、关闭后书架仍 2 篇、两篇事件数不变、原有作品仍可正常打开且正文未被破坏。

## 三、原有 20 步回归（Chrome + Edge 全 PASS，无回退）

| 分组 | 覆盖内容 | 结果 |
| --- | --- | --- |
| PWA | manifest/图标字节与尺寸、SW 注册接管、断网重载可打开应用壳 | ✅ |
| 逐字符 | 快速输入无「正文已同步」误报/无回滚/光标末尾；中文/英文/emoji + 退格；IDB insert/delete（`deleted` 非空、`pos` 整数）、seq 连续、哈希链、重放一致 | ✅ |
| IME/来源 | CDP `Input.imeSetComposition` 记录 `compose.*`；`source=ime/paste/undo/redo` 与 `inputType` 校验 | ✅ |
| 持久化/历史 | 刷新后同 docId 打开正文一致；Ctrl+S 快照、历史预览、确认恢复（恢复提示仍在、正文与快照一致） | ✅ |
| 排版/主题 | mode 切换 `text-align` right↔left + `editor.mode`；100+ 字符快速输入后双模式光标行居中误差 0.0 px；暗黑纯黑/亮白纯白、中性色抽样；奶白 `rgb(250,246,236)` | ✅ |
| 数据安全（.wtlog） | 单篇导出 `.wtlog` 独立校验器合规、篡改一行被哈希链发现；全新 context 导入往返一致、同 docId 冲突拒绝覆盖 | ✅ |
| 多标签/恢复 | 第二标签页 `readonly-banner` + `readOnly=true` + 输入无效；主存储清空后启动自动恢复（提示/补回/校验/导出）；无损坏刷新无恢复噪声、不重复补写 | ✅ |
| 移动端 | 390×844 可输入、无横向溢出；全流程无未捕获页面异常 | ✅ |

## 四、构建与命令

```powershell
npm run build      # ✅ v0.1.2（index-BiUGc6Qn.js 268163B / index-RJHubUlv.css 16123B）
npm run typecheck  # ✅
npm test           # ✅ 13 files / 76 tests
npm run e2e                                   # ✅ Chrome 24/24
$env:E2E_CHANNEL='msedge'; npm run e2e          # ✅ Edge 24/24
npm run check:zip -- --quiet tests/e2e/artifacts/backup.wtzip     # ✅ 2 个作品 / 6599 字节
npm run check:log -- --quiet tests/e2e/artifacts/archive-*.wtlog # ✅ 两个条目均合规
```

**格式/版本说明**：v0.1.2 新写出的日志 header `app.version="0.1.2"`（已抽查 `export.wtlog`），`format` 仍为 `1.0`；旧版（0.1.0/0.1.1）文件仍可读（金标准 fixture 不变）。

## 五、需人工验证（headless 无法覆盖）

1. **FSA 备份目录（Chrome/Edge 桌面）**：设置 →「选择备份目录」打开原生目录选择器，headless 无法交互。
   已完成：入口 `backup-choose-button` 可见可点、`storage-status` 显示「备份目录：未配置」、未配置时「立即备份」禁用、OPFS 镜像显示「可用」、持久化状态可读。
   人工步骤：选择目录并授权 → 「立即备份」→ 检查目录内 `.wtlog` 与 `writertools-manifest.json` → 重启后目录句柄仍可用 → 「校验全部」通过；可与 `.wtzip` 的 manifest 字段对照。
2. **含回收站作品的 .wtzip**：本次 e2e 用 2 篇正常作品（便于计数断言）；导出/恢复回收站条目与 `trashed:true` 标志由引擎单测覆盖，建议人工用一篇回收站作品走一遍 UI。
3. **PWA 安装流程**：桌面 Chrome/Edge 安装按钮、Android「添加到主屏幕」、独立窗口/启动画面（manifest/图标/SW/离线已自动化）。
4. **真实输入法/软键盘**：CDP `Input.imeSetComposition` 模拟已覆盖 `compose.*` 与 `source=ime`，真实微软拼音/Android 软键盘建议真机复核。
5. **平台矩阵**：仅 Windows 11 + Chromium 桌面 + 390×844 视口模拟；macOS、Linux、真实 Android 未测。
6. **持久化存储授权**：headless 全新 context 显示「未授权」（预期）；真实浏览器首次访问需人工确认。
7. **大规模备份包**：本次 2 篇作品/6.6 KB；数百篇/大文档的导出耗时、内存与下载体验建议人工压测。

## 六、本次改动范围与剩余风险

- 引擎（task-8）：`exportArchive()` / `importArchive()`、manifest 锚点、前缀合并、冲突不覆盖、单条目失败隔离；fflate 实现 ZIP。
- UI（task-9）：设置「导出全部备份包 / 从备份包恢复」入口与常驻结果区 `archive-import-result`；书架 `import-file-input` 按扩展名路由（`.wtzip` + 冲突时 `archive-import-modal`）。
- QA（task-10）：e2e 新增第 19–22 步（导出/独立校验/恢复+重复导入/损坏包隔离）；更新 `tests/e2e/README.md` 为 24 步；本报告 v0.1.2。
- **e2e 未覆盖（由引擎单测/人工覆盖）**：merged（本地为备份前缀）与 conflict（同 seq 分歧）的 UI 路径、含回收站条目、被外部 Web Lock 锁定条目的导入失败提示、FSA 备份目录。
- 自动化在全新 browser context 中运行；不覆盖真实崩溃/断电/磁盘满场景（可用删除 IDB events/截断备份包模拟近似）。
- 本次 Chrome/Edge 复验复用了环境中已启动的 `vite preview`（已确认其返回的 `index.html` 与磁盘 `dist/index.html` 逐字节一致，被测构建与最终构建相同）。
- 本报告不修改 `src/`；发现问题均已反馈给对应 owner。
