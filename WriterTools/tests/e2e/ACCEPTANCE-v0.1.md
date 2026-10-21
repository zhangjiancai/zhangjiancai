# WriterTools v0.1 端到端验收报告

- **验收日期**：2026-10-21（Asia/Shanghai；复验于 Lead 截图验收 bug 修复后）
- **验收人**：qa（Playwright 自动化 + 独立格式校验器）
- **被验收构建**：`npm run build` 产物（`dist/index.html` + `dist/assets/index-DDgU99O0.js` 240 169 B + `dist/assets/index-DH6mQI2F.css` 15 901 B；50 modules，无 dev 假引擎）
- **浏览器**：Chrome 155.0.8059.85、Edge 155.0.4283.62（均为系统安装版本，headless 模式，未下载 Playwright 自带浏览器）
- **环境**：Windows 11 Pro 10.0.26300 64-bit、Node v22.23.2、npm 10.9.8、Playwright 1.64.1
- **测试脚本**：`tests/e2e/run.mjs`（18 步，含 2 个真实 bug 回归步骤）、`tools/wtlog-check.mjs`（独立格式校验器，不 import 引擎代码）
- **证据目录**：`tests/e2e/artifacts/`（18 张截图、导出 `.wtlog`、校验器 JSON、完整运行日志 `e2e-chrome.log`；已 gitignore）

## 一、结论

| 验收项 | 结果 |
| --- | --- |
| `npm run build`（tsc --noEmit + vite build） | ✅ 通过 |
| `npm run typecheck` | ✅ 通过 |
| `npm test`（引擎单元测试，Vitest） | ✅ 59/59 通过 |
| `npm run e2e`（Chrome 155，18 步） | ✅ **18/18 步通过**，退出码 0 |
| `E2E_CHANNEL=msedge npm run e2e`（Edge 155，18 步） | ✅ **18/18 步通过**，退出码 0 |
| 快速连续输入回归（"正文已同步"误报/回滚） | ✅ 0 条误报、正文未回滚、光标在末尾（Chrome + Edge） |
| 双模式光标行垂直居中回归（135 字符快速输入后） | ✅ typewriter / centered 误差均 0.0 px（行高 34.0 px，要求 ≤ 1 行高） |
| 导出 `.wtlog` 经独立校验器检查 | ✅ 合规（282 事件 / 3 快照 / 252 字符，errors=[]） |
| 故意篡改一行后校验器 | ✅ 正确拒绝（哈希校验失败 + 快照不变量破坏） |
| PWA（manifest / 图标 / SW / 离线打开） | ✅ 自动化通过；安装 UI 需人工 |
| 双标签页只读锁 | ✅ 第二个标签页 `readonly-banner` + `readOnly=true` + 输入无效 |
| 历史恢复提示 | ✅ 恢复后仍出现「已恢复」提示且正文与快照一致（未因误报修复而丢失真实提示） |
| FSA 备份目录选择器 | ⚠️ 无法在 headless 交互，**需人工验证**（入口/状态已读通） |

**总体结论：v0.1 核心功能验收通过；Lead 截图验收发现的快速输入回声误报/回滚 bug 已修复并由新增回归断言覆盖（Chrome/Edge 双通过）。** 剩余未覆盖项均为 headless 环境限制（原生目录选择器、PWA 安装 UI、真实输入法/真机），见第五节。

## 二、自动化覆盖明细（Chrome / Edge 均通过）

| # | 验收点 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | PWA 资源：manifest 字段、图标实际尺寸/字节、sw.js 可访问、SW 注册并接管、断网重载可打开应用壳 | PASS | `01-library.png`、日志 |
| 2 | 首页书架（空态 `library-empty`）→ 新建作品 → 编辑器 `editor-view` / `editor-textarea` 可见且聚焦 | PASS | `02-editor-new.png` |
| 3 | **回归：快速连续输入无回声误报**——`keyboard.type` 无 delay 输入 43 字符（含空格）+ 40 个空格，各等待 1.5 s：`[data-testid=toast]` 中「正文已同步」数量为 **0**、textarea 值未被回滚、`selectionStart === selectionEnd === value.length` | PASS | `03-rapid-typing.png` |
| 4 | 中文/英文/emoji 逐字符输入 + 退格 3 次，textarea 值正确 | PASS | `03-editor-typed.png` |
| 5 | IndexedDB 事件流：108 条 `text.insert` / 3 条 `text.delete`（`deleted`="界","世"," " 非空、`pos` 整数）、seq 从 0 连续、prev/hash 链完整、重放正文与编辑器一致 | PASS | `04-indexeddb.png` |
| 6 | IME 组合过程：CDP `Input.imeSetComposition` 记录 `compose.start/update/end`（5 条） | PASS | `05-composition.png` |
| 7 | 来源映射：IME 上屏 `source=ime`(`insertCompositionText`)、粘贴 `paste`(`insertFromPaste`)、撤销 `undo`(`historyUndo`)、重做 `redo`(`historyRedo`)，重放仍一致 | PASS | `06-source-mapping.png` |
| 8 | 刷新持久化：书架出现同 `data-doc-id` 的 `doc-item`，打开后正文与刷新前一致（117 码元） | PASS | `06-reloaded.png` |
| 9 | Ctrl+S 快照（`snapshot` manual、`save-toast`）→ 历史面板 `history-item` / `history-preview` → 二次确认恢复：恢复提示「已恢复」仍在、正文与快照一致（追加 text.reset，历史不丢） | PASS | `07-history.png` |
| 10 | 模式切换：`text-align` right → left → right，`editor.mode` 事件落盘 | PASS | `08-mode.png` |
| 11 | **回归：双模式光标行垂直居中**——快速输入 135 字符后，typewriter / centered 两模式下用独立镜像测量光标行位置，误差均 0.0 px（≤ 1 行高 34.0 px）；期间 0 条「正文已同步」、正文不回滚、光标在末尾 | PASS | `09-centering.png` |
| 12 | 明暗主题：dark → body `rgb(0,0,0)`；light → `rgb(255,255,255)`；抽样 16 个元素颜色均中性（R≈G≈B ±4） | PASS | `09-theme-dark.png`、`10-theme-light.png` |
| 13 | 设置面板：默认 theme=system / lightBg=white / Ctrl+S；奶白 `rgb(250,246,236)` 生效；应用内「校验全部」→「校验通过：1 个作品，哈希链与快照一致。」；备份入口可见、未配置时「立即备份」禁用；`storage-status` 可读 | PASS | 日志 |
| 14 | 导出 `.wtlog` + 独立校验器 + 篡改检测（详见第四节） | PASS | `export.wtlog`、`wtlog-check-*.json`、`12-export-check.png` |
| 15 | 全新浏览器上下文（空 IndexedDB）导入导出文件：`docId`/252 码元正文一致；重复导入同 `docId` 被拒绝（"不会覆盖现有数据"）且作品数不变 | PASS | `13-imported.png` |
| 16 | 双标签页只读锁：主标签页可写；第二标签页 `readonly-banner` 可见、`textarea.readOnly=true`、输入被忽略 | PASS | `14-readonly-second-tab.png` |
| 17 | 移动端 390×844：刷新后打开作品可输入，`scrollWidth=390 <= innerWidth=390`，无横向溢出 | PASS | `11-mobile-390x844.png` |
| 18 | 全流程无未捕获页面异常 | PASS | 日志 |

运行日志：`tests/e2e/artifacts/e2e-chrome.log`。复现命令：

```powershell
npm run build
npm run e2e                                   # Chrome（channel: chrome）
$env:E2E_CHANNEL='msedge'; npm run e2e          # Edge
npm run check:log -- --quiet tests/e2e/artifacts/export.wtlog   # 独立格式校验器
```

## 三、快速输入回归（Lead 截图验收 bug）复验

**原 bug**：快速连续输入（无 delay、含空格）时，UI 的引擎回声识别队列（文本相等 + 时间窗 + 容量）会误判引擎回放的正文事件为"外部变化"，弹出几十条「正文已同步」toast，并可能把 textarea 回滚到旧文本/移动光标。

**UI 修复**：回声识别改为 1:1 计数（每次 `appendEdit` 计 1 次、每收到一条 `DocChange.text` 消费 1 次）；toast 改为顶部居中、同文案去重、最多同时 2 条；历史恢复仍保留有意的同步/恢复提示。

**新增回归断言与结果**（Chrome / Edge 均通过）：

1. 新建文档后 `page.keyboard.type('a b c d e f g h i j k l m n o p q r s t u v')`（无 delay）→ 等待 1.5 s：`[data-testid=toast]` 中「正文已同步」数量 **0**；`textarea.value` 完全正确；`selectionStart === selectionEnd === value.length`。
2. 继续快速输入 40 个空格 → 等待 1.5 s：「正文已同步」数量 **0**；值未回滚；光标在末尾。
3. 100+ 字符（135 字符）快速输入后同样 0 误报、正文不回滚、光标在末尾。
4. 历史恢复：确认恢复后仍出现「已恢复」提示，正文与快照一致（真实提示未被误删）。
5. 100+ 字符快速输入后，typewriter / centered 两模式光标行垂直居中误差均 **0.0 px**（行高 34.0 px，要求 ≤ 1 行高）。

## 四、文件格式合规抽查（导出 `.wtlog`）

- **导出文件**：`tests/e2e/artifacts/export.wtlog`，133 445 字节，282 行，建议文件名 `无题-76eff188.wtlog`
- **字节级**：UTF-8 无 BOM、LF 换行、末行以 `\n` 结尾、行数 = 事件数（282）
- **header**（seq=0）：`type=doc.init`、`affects=meta`、`magic=writertools-log`、`format=1.0`、`prev=""`、`data.docId=76eff188-ece2-49cb-acc8-05ad6f579c7f`、`data.app={name:"WriterTools",version:"0.1.0"}`、`data.createdAt` 为 RFC3339 UTC 毫秒格式
- **独立校验器**：`node tools/wtlog-check.mjs --quiet tests/e2e/artifacts/export.wtlog`

  ```
  OK   tests\e2e\artifacts\export.wtlog（282 事件 / 252 字符 / 3 快照）
  ```
  报告字段：`ok=true`、`format="1.0"`、`events=282`、`edits=251`、`snapshots=3`、`sessions=4`、`textChars=252`、`lastSeq=281`、`lastHash=sha256:e86e4a3d…`、`errors=[]`、`warnings=[]`；派生正文与编辑器一致（含快速输入的英文/空格 + 中文/emoji + 粘贴内容 + 长句）。
- **快照不变量**：3 个快照的 `text`/`textHash`/`chars` 均与重放正文一致（校验器逐条验证通过）。
- **篡改检测**：把第 3 行 `text.insert` 的 `data.text` 追加一个字符后：

  ```
  FAIL tests\e2e\artifacts\export-tampered.wtlog
    ✗ 第 3 行：哈希校验失败（内容被修改过？）
    ✗ 第 135 行：snapshot.text 与重放正文不一致（快照不变量被破坏）
  退出码 1
  ```
- **应用内交叉验证**：设置 → 数据安全 →「校验全部」→「校验通过：1 个作品，哈希链与快照一致。」

## 五、需人工验证（headless 无法覆盖）

1. **FSA 备份目录（Chrome/Edge 桌面）**：设置 →「选择备份目录」会打开**原生目录选择器**，headless 无法交互。
   已完成：入口 `backup-choose-button` 可见可点、`storage-status` 显示「备份目录：未配置」、未配置时「立即备份」禁用、OPFS 镜像显示「可用」、持久化状态可读。
   人工步骤：点选择目录并授权 → 「立即备份」→ 检查目录内生成 `.wtlog` 与 `writertools-manifest.json` → 重启浏览器后目录句柄仍可用 → 「校验全部」通过。
2. **PWA 安装流程**：桌面 Chrome/Edge 地址栏安装按钮、Android Chrome「添加到主屏幕」、安装后独立窗口与启动画面。自动化已验证 manifest/图标/SW/离线应用壳，安装 UI 本身需人工。
3. **真实输入法/软键盘**：本报告用 CDP `Input.imeSetComposition` 模拟（已覆盖 `compose.*` 与 `source=ime`）；真实微软拼音/Android 软键盘的候选、联想、上屏行为建议真机复核。
4. **平台矩阵**：本次仅 Windows 11 + Chromium 桌面（Chrome/Edge）+ 390×844 视口模拟；macOS、Linux、真实 Android 设备未测。
5. **持久化存储授权**：headless 全新 context 显示「持久化存储：未授权」（预期现象）；真实浏览器首次访问会请求 `navigator.storage.persist()`，需人工确认授权结果。

## 六、验收期间发现并已修复的问题

| # | 问题 | 状态 |
| --- | --- | --- |
| 1 | **快速连续输入回声误报**：几十条「正文已同步」toast，且可能回滚 textarea/移动光标 | UI 已改为 1:1 回声计数 + toast 顶部居中/去重；新增回归步骤 3、11 在 Chrome/Edge 通过 |
| 2 | `readonly-banner` 缺少 `data-testid`（只读功能正常，UI 契约与实现不一致） | UI 已修复，严格 testid 重跑通过 |
| 3 | 只读标签页出现无关 toast「写入失败：作品为只读模式…」（只读下仍尝试 selection 写入） | UI 已修复（只读不创建录制器），重跑无该提示 |
| 4 | Service Worker 离线资源 504：Vite 预览响应带 `Vary: Origin`，预缓存 Request 与 `<script crossorigin>` 请求头不同导致 Cache miss | qa 已修复 `public/sw.js`（`ignoreVary`），e2e 离线步骤覆盖 |
| 5 | e2e 自身问题：点击已填充 textarea 后光标位置不可控、构建与 preview 存在并发竞态 | qa 已修复（显式归位光标、构建后再起服务） |

## 七、剩余风险与说明

- 自动化在**全新 browser context（空 IndexedDB）**中运行，不覆盖大量历史文档、超长文本与长期使用的性能表现（本次文档 252 字符 / 282 事件、3 快照）。
- 双标签页锁用同一 browser context 的两个 page 模拟，与真实双窗口等价性较高，但非 100% 相同。
- 本次 Chrome/Edge 复验复用了环境中已启动的 `vite preview`（已确认其返回的 `index.html` 与磁盘 `dist/index.html` 逐字节一致，即被测构建与最终构建相同）。
- v0.1 功能限制（无云同步/无端到端加密/备份目录仅 Chromium 桌面/回收站软删除等）见 `README.md`「已知限制」。
- 本报告不修改 `src/`；发现问题均已反馈给对应 owner 并由其修复。
