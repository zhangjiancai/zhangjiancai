# WriterTools v0.1.1 加固版端到端验收报告

- **验收日期**：2026-10-21（Asia/Shanghai）
- **验收人**：qa（Playwright 自动化 + 独立格式校验器）
- **被验收构建**：最新源码 `npm run build` 产物（`dist/index.html` + `dist/assets/index-izy1djrY.js` 242 380 B + `dist/assets/index-DH6mQI2F.css` 15 901 B；50 modules，无 dev 假引擎）
- **浏览器**：Chrome 155.0.8059.85、Edge 155.0.4283.62（系统安装版本，headless，未下载 Playwright 自带浏览器）
- **环境**：Windows 11 Pro 10.0.26300 64-bit、Node v22.23.2、npm 10.9.8、Playwright 1.64.1
- **测试脚本**：`tests/e2e/run.mjs`（20 步：原 18 步 + 2 个 v0.1.1 自动恢复回归步骤）
- **证据目录**：`tests/e2e/artifacts/`（21 张截图、导出 `.wtlog` ×2、篡改样本、校验器 JSON、完整运行日志 `e2e-chrome.log`；已 gitignore）
- **上一版报告**：`tests/e2e/ACCEPTANCE-v0.1.md`（v0.1 基线，保留备查）

## 一、结论

| 验收项 | 结果 |
| --- | --- |
| `npm run build`（tsc --noEmit + vite build） | ✅ 通过 |
| `npm run typecheck` | ✅ 通过 |
| `npm test`（引擎单元测试） | ✅ **66/66 通过**（12 文件；含新增规模测试 / 截断恢复测试） |
| Chrome 155 `npm run e2e`（20 步） | ✅ **20/20 步通过**，退出码 0 |
| Edge 155 `E2E_CHANNEL=msedge npm run e2e`（20 步） | ✅ **20/20 步通过**，退出码 0 |
| 原有 18 步既有断言（逐字符/删除内容/IME/来源映射/持久化/快照恢复/主题/双标签只读/移动端…） | ✅ 无回退（Chrome + Edge 全 PASS） |
| **新增：主存储破坏 → 启动自动从 OPFS 镜像恢复** | ✅ 提示「已从镜像恢复 1 个作品」、IDB events 补回、书架字数刷新、正文/光标一致、恢复后可写、校验全部通过、恢复后导出通过独立校验器 |
| **新增反向：无损坏刷新** | ✅ 无自动恢复/副本分歧提示、事件数不变（不重复补写）、作品完整 |
| 导出 `.wtlog` 独立校验器（主作品） | ✅ 合规（282 事件 / 3 快照 / 252 字符，errors=[]） |
| 恢复后导出 `.wtlog` 独立校验器 | ✅ 合规（29 事件 / 1 快照 / 20 字符，errors=[]） |
| 篡改检测 | ✅ 篡改一行后被"哈希校验失败 + 快照不变量破坏"发现（退出码 1） |
| FSA 备份目录选择器 | ⚠️ 无法在 headless 交互，**需人工验证**（入口/状态已读通，见第五节） |

**总体结论：v0.1.1 加固版通过端到端验收**——引擎 append 热路径/恢复并发加固与 UI 启动自动恢复接入后，Chrome/Edge 各 20 步全绿；新增"主存储丢失后自动恢复"正反两个场景均通过。

## 二、v0.1.1 新增/重点场景明细

### 2.1 主存储（IndexedDB events）被清空 → 启动自动从 OPFS 镜像恢复（Chrome + Edge 均 PASS）

复验步骤（e2e 第 17 步）：

1. 刷新进入书架，新建作品并输入中文：`镜像自动恢复测试：这段中文必须完整回来。`（20 个 UTF-16 码元）；
2. 等待 OPFS 镜像落盘：轮询 `navigator.storage.getDirectory()` → `docs/<docId>.wtlog`，确认镜像文本已包含完整正文（Chrome 本轮 25 行）；
3. 返回书架，记录 `data-doc-id`；
4. 用 `page.evaluate` 打开 `writertools` 数据库，按 `IDBKeyRange.bound([docId,0],[docId,MAX_SAFE_INTEGER])` **删除该 docId 的全部 events**（保留 `docs` 摘要记录），断言删除后事件数为 0；
5. `page.reload()` 后断言：
   - 出现 `[data-testid="auto-recover-toast"]`，文案含 **「已从镜像恢复 1 个作品」**；
   - 书架出现该作品，字数刷新为 20 字；
   - IDB events 已补回（Chrome 本轮 25 条）；
   - 打开后 `textarea.value` 与预期**完全一致**、光标在文末；
   - **恢复后为可写状态**（无 `readonly-banner`、`textarea.readOnly=false`；对应引擎"截断/损坏只读、需 recover 修复"的新行为）；
   - 设置 →「校验全部」→「校验通过：2 个作品，哈希链与快照一致。」；
   - 恢复后导出 `.wtlog`（`artifacts/export-recovered.wtlog`）→ `tools/wtlog-check.mjs` 判定 **合规**：29 事件 / 1 快照 / 20 字符 / `errors=[]`。

### 2.2 反向：无损坏刷新不得误报、不得重复补写（Chrome + Edge 均 PASS）

e2e 第 18 步：

- 正常刷新页面，等待后台自动恢复扫描完成（约 2.5 s）；
- 断言**不出现** `auto-recover-toast`，toast 中**不出现**「已从镜像恢复」「副本存在分歧」；
- 该作品 IDB 事件数刷新前后一致（Chrome 本轮 30 → 30，Edge 同理），**未重复补写**；
- 刷新后书架作品数保持 2 个，应用正常。

### 2.3 原有 18 步回归（Chrome + Edge 全 PASS，无回退）

| 分组 | 覆盖内容 | 结果 |
| --- | --- | --- |
| PWA | manifest/图标字节与尺寸、SW 注册接管、断网重载可打开应用壳 | ✅ |
| 逐字符 | 快速输入无"正文已同步"误报/无回滚/光标末尾（43 字符 + 40 空格）；中文/英文/emoji + 退格；IDB `text.insert`/`text.delete`（`deleted` 非空、`pos` 整数）、seq 连续、哈希链、重放一致 | ✅ |
| IME/来源 | CDP `Input.imeSetComposition` 记录 `compose.*`；`source=ime/paste/undo/redo` 与对应 `inputType` 校验 | ✅ |
| 持久化/历史 | 刷新后同 `docId` 打开正文一致；Ctrl+S 快照、历史预览、确认恢复（恢复提示仍在、正文与快照一致） | ✅ |
| 排版/主题 | mode 切换 `text-align` right↔left + `editor.mode`；100+ 字符快速输入后双模式光标行居中误差 **0.0 px**；暗黑纯黑/亮白纯白、中性色抽样；奶白 `rgb(250,246,236)` | ✅ |
| 数据安全 | 设置面板默认值/存储状态/备份入口；应用内「校验全部」通过；导出 `.wtlog` 独立校验器合规；篡改一行被哈希链发现；全新 context 导入往返一致、同 docId 冲突拒绝覆盖 | ✅ |
| 多标签/移动端 | 第二标签页 `readonly-banner` + `readOnly=true` + 输入无效；390×844 可输入、无横向溢出；无未捕获页面异常 | ✅ |

## 三、构建与测试

```powershell
npm run build      # ✅ tsc --noEmit + vite build（index-izy1djrY.js / index-DH6mQI2F.css）
npm run typecheck  # ✅
npm test           # ✅ 12 files / 66 tests passed（含 engine 新增规模测试与截断恢复测试）
npm run e2e                                   # ✅ Chrome 20/20
$env:E2E_CHANNEL='msedge'; npm run e2e          # ✅ Edge 20/20
npm run check:log -- --quiet tests/e2e/artifacts/export.wtlog            # ✅ 合规
npm run check:log -- --quiet tests/e2e/artifacts/export-recovered.wtlog  # ✅ 合规
```

## 四、格式合规抽查（导出 `.wtlog`）

主作品（`artifacts/export.wtlog`，133 443 B，282 行）：
- 字节级：UTF-8 无 BOM、LF、末行以 `\n` 结尾、行数 = 事件数；
- 独立校验器：`ok=true`、`format="1.0"`、`events=282`、`edits=251`、`snapshots=3`、`sessions=4`、`textChars=252`、`lastSeq=281`、`lastHash=sha256:13929603…`、`errors=[]`、`warnings=[]`；
- 快照不变量（3 个快照的 `text`/`textHash`/`chars`）全部通过；
- 篡改第 3 行 `text.insert` 后：`第 3 行：哈希校验失败（内容被修改过？）` + `第 135 行：snapshot.text 与重放正文不一致（快照不变量被破坏）`，退出码 1。

恢复后的作品（`artifacts/export-recovered.wtlog`，13 742 B，29 行）：
- 独立校验器：`ok=true`、`events=29`、`snapshots=1`、`textChars=20`、`lastSeq=28`、`errors=[]`、`warnings=[]`；
- 派生正文 `镜像自动恢复测试：这段中文必须完整回来。` 与恢复后编辑器一致，证明"镜像恢复出的日志仍然是合法可校验的哈希链"。

## 五、需人工验证（headless 无法覆盖）

1. **FSA 备份目录（Chrome/Edge 桌面）**：设置 →「选择备份目录」会打开原生目录选择器，headless 无法交互。
   已完成：入口 `backup-choose-button` 可见可点、`storage-status` 显示「备份目录：未配置」、未配置时「立即备份」禁用、OPFS 镜像显示「可用」、持久化状态可读。
   人工步骤：点选择目录并授权 → 「立即备份」→ 检查目录内生成 `.wtlog` 与 `writertools-manifest.json` → 重启浏览器后目录句柄仍可用 → 「校验全部」通过。
   另建议人工验证：删除本地备份目录中的文件后重启，应用只从 OPFS 镜像恢复（不涉及 FSA 目录）的行为。
2. **PWA 安装流程**：桌面 Chrome/Edge 地址栏安装按钮、Android Chrome「添加到主屏幕」、安装后独立窗口与启动画面。自动化已验证 manifest/图标/SW/离线应用壳，安装 UI 本身需人工。
3. **真实输入法/软键盘**：本报告用 CDP `Input.imeSetComposition` 模拟（已覆盖 `compose.*` 与 `source=ime`）；真实微软拼音/Android 软键盘的候选、联想、上屏行为建议真机复核。
4. **平台矩阵**：本次仅 Windows 11 + Chromium 桌面（Chrome/Edge）+ 390×844 视口模拟；macOS、Linux、真实 Android 设备未测。
5. **持久化存储授权**：headless 全新 context 显示「持久化存储：未授权」（预期现象）；真实浏览器首次访问会请求 `navigator.storage.persist()`，需人工确认授权结果。
6. **真实"断电/崩溃"恢复**：本报告用"直接删除 IDB events"模拟主存储损坏；真实浏览器崩溃、磁盘满、系统断电后的恢复建议人工构造验证（多副本一致性、恢复到最近快照）。

## 六、本次改动范围与说明

- 引擎（task-5）：append 热路径去 O(n²)、OPFS 镜像增量序列化、`recover()` 跳过被外部 Web Lock 持有的作品、新增 3000 次 append 规模测试与主存储截断恢复测试（单测 66/66）。
- UI（task-6）：页面加载后后台调用 `engine.recover()`（不阻塞首屏、失败静默、每次加载一次）；恢复/分歧时显示 `auto-recover-toast`；恢复后刷新书架。
- QA（task-7）：新增 e2e 第 17/18 步（正向自动恢复 + 反向无误报）；更新本报告与 `tests/e2e/README.md` 步骤清单（20 步）。
- 本报告不修改 `src/`；验收脚本只使用公开 `data-testid` 与浏览器 API（IndexedDB / OPFS），不直接依赖引擎内部实现。

## 七、剩余风险

- 自动化在全新 browser context（空 IndexedDB/OPFS）中运行；本轮文档规模为 252 字符 / 282 事件 / 3 快照，未覆盖数万事件的长文档性能（引擎侧有 3000 次 append 单测，UI 交互性能建议真机长文验证）。
- 双标签页锁用同一 browser context 的两个 page 模拟；`recover()` 跳过外部锁作品的并发场景目前由引擎单测覆盖，e2e 未构造"另一标签页持锁 + 本页启动恢复"的组合。
- 本次 Chrome/Edge 复验复用了环境中已启动的 `vite preview`（已确认其返回的 `index.html` 与磁盘 `dist/index.html` 逐字节一致）。
- v0.1 功能限制（无云同步/无端到端加密/备份目录仅 Chromium 桌面/回收站软删除等）见 `README.md`「已知限制」。
