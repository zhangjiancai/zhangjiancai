# 端到端冒烟测试（Playwright）

这是 WriterTools 的浏览器端冒烟测试，用**系统 Chrome**（不下载 Playwright 自带浏览器）在生产构建上验证核心用户路径与文件格式落盘。

## 前置

- Node.js 22+，依赖已 `npm install`（`playwright` 包已带，**不需要** `npx playwright install`）。
- 系统安装了 Chrome（`C:\Program Files\Google\Chrome\Application\chrome.exe` 等常见路径）；也支持 Edge。
- 需要生产构建产物：脚本会自动检查 `dist/`，缺失或比源码旧时自动执行 `npm run build`（需要 `npm run build` 本身能通过）。

## 运行

```powershell
npm run e2e                    # 自动构建（如需）→ 启动 preview → 跑全部步骤 → 关闭 preview
node tests/e2e/run.mjs --dry-run   # 只验证 Chrome/preview 可用、首页能打开
```

如果服务器已经在跑，可以直接复用（脚本不负责关闭外部服务）：

```powershell
$env:BASE_URL = 'http://127.0.0.1:4173'; node tests/e2e/run.mjs
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BASE_URL` | `http://127.0.0.1:4173` | 复用的服务地址；设置后脚本不会自动启动服务器 |
| `E2E_BUILD` | — | `1` = 强制重新构建 |
| `E2E_HEADLESS` | `1` | `0` = 有头模式（调试用，也可用 `--headed`） |
| `E2E_CHANNEL` | `chrome` | 浏览器 channel，如 `chrome` / `msedge` |
| `E2E_EXECUTABLE_PATH` | — | 直接指定浏览器可执行文件（优先级最高） |
| `E2E_SKIP_PWA` | — | `1` = 跳过 manifest/图标/SW/离线的检查（例如指向 dev server 时） |
| `E2E_SKIP_OFFLINE` | — | `1` = 跳过 Service Worker 离线重载检查 |
| `E2E_KEEP_SERVER` | — | `1` = 测试结束后保留自己启动的 preview（调试用） |

## 覆盖步骤

1. **PWA 资源与 Service Worker**：manifest 字段/图标尺寸与字节、`sw.js` 可访问、SW 注册并接管页面、断网重载能打开应用壳。
2. **首页书架 → 新建作品 → 编辑器可见且聚焦**（`data-testid` 契约）。
3. **回归：快速连续输入无回声误报**：`page.keyboard.type` 无 delay 依次输入 41 字符（含空格）与 40 个空格，各等待 1.5s：`[data-testid=toast]` 中"正文已同步"数量必须为 0，textarea 值不得被回滚，光标必须在末尾（selectionStart=selectionEnd=value.length）。对应"回声识别队列误判导致几十条 toast/正文回滚"的真实 bug。
4. **逐字符输入**：中文/英文/emoji 混合输入 + 退格删除，断言 textarea 值。
5. **IndexedDB 事件流**：`text.insert` / `text.delete` 存在、`deleted` 非空、`pos` 为整数、seq 从 0 连续、prev/hash 链完整、按事件重放出的正文与 textarea 一致。
6. **输入法组合**：优先 CDP `Input.imeSetComposition`，不可用时在 textarea 派发合成 `CompositionEvent`，断言 `compose.*` 事件落盘。
7. **编辑来源映射**：IME 上屏 `source=ime`、Ctrl+V 粘贴 `source=paste`、Ctrl+Z 撤销 `source=undo`、Ctrl+Y 重做 `source=redo`，并校验 `inputType`（`insertFromPaste` / `historyUndo` / `historyRedo`）；之后整条事件流仍需可安全重放。
8. **刷新持久化**：刷新后书架出现带 `data-doc-id` 的 `doc-item`，打开后正文与刷新前一致。
9. **Ctrl+S 快照与历史**：`snapshot`(manual) 落盘、`save-toast` 出现、历史面板 `history-item` / 预览区 / 恢复（确认弹窗 → 正文与快照一致，且真实恢复提示"已恢复"仍会出现、不误报"正文已同步"）。
10. **排版模式切换**：`mode-toggle` 两次，textarea computed `text-align` 在 `right`（打字机）/ `left`（居中）间切换，并断言 `editor.mode` 事件。
11. **回归：双模式光标行垂直居中**：快速输入 135 字符后，在 typewriter 与 centered 两种模式下用独立镜像测量光标行位置，要求与理想值误差 ≤ 1 行高；期间无"正文已同步"、正文不回滚、光标在末尾。
12. **明暗主题**：`emulateMedia` dark → body 背景纯黑 `rgb(0,0,0)`；light → 纯白/奶白；抽样元素颜色均为中性色（R≈G≈B ±4）。
13. **设置面板**：默认设置（theme=system、lightBg=white、保存快捷键）；奶白背景 `rgb(250,246,236)` 生效；应用内「校验全部」通过；备份目录入口与存储状态可读（FSA 目录选择器无法在 headless 交互，需人工验证）。
14. **导出 .wtlog**：原始字节（无 BOM、LF、结尾换行）+ 下载文件；用独立校验器 `tools/wtlog-check.mjs --json` 校验 header/seq/哈希链/快照不变量/正文重放；**篡改一行后校验器必须报哈希错误**；header `app.version` 必须等于 package.json 版本。
15. **训练数据导出工具（v0.1.5）**：`node tools/wtlog-to-training.mjs <导出的.wtlog> --out training-export.jsonl --summary training-export-summary.json` → 退出码 0；JSONL 行数 = summary.events = 日志事件数；首行 `doc.init`；抽查 `text.insert/op=insert/text`、`text.delete/op=delete/deleted`、`compose.update/data`、`snapshot` 字段齐全；summary `countedDocs=1`。
16. **导出再导入**：在全新 browser context（空 IndexedDB）导入 `.wtlog`，`docId`/正文与导出前一致；重复导入同 `docId` 必须失败提示且不新增/不覆盖作品。
17. **双标签页只读锁**：主标签页打开作品持写锁，第二个标签页打开同一作品显示 `readonly-banner`、`textarea.readOnly=true` 且输入无效。
18. **回归：主存储破坏 → 启动自动恢复**：新建作品输入中文 → 等 ≥1.2s（OPFS 镜像防抖写入，轮询 `docs/<docId>.wtlog` 含完整正文）→ 回书架 → 用 `page.evaluate` 删除 IndexedDB `writertools`/`events` 中该 `docId` 全部事件（保留 docs 记录）→ 刷新 → 断言 `[data-testid=auto-recover-toast]` 出现且文案含「已从镜像恢复」、书架字数刷新、打开后正文与预期完全一致、光标在文末、设置「校验全部」通过、恢复后导出的 `.wtlog` 通过独立校验器。
19. **回归：无损坏刷新无恢复噪声**：正常刷新后等待后台扫描完成，不得出现 `auto-recover-toast`/「已从镜像恢复」/「副本存在分歧」，且该作品 IDB 事件数不变（不重复补写）、原有作品仍在。
20. **全量备份包导出（.wtzip）**：全新 context 建 2 篇作品（改名「备份甲/备份乙」、不同中文，其一 Ctrl+S 快照）→ 设置 `export-archive-button` 捕获下载保存 `backup.wtzip` → 导出 toast 含「已导出 2 个作品」；回归书架 `import-file-input` 的 `.wtzip` 路由：同一包再导入应提示「跳过 2」、不弹 `archive-import-modal`、不新增作品。
21. **备份包独立校验**：`tools/wtzip-check.mjs --json` 判定合规；并用 fflate 解压独立核对 manifest（magic/format/app.version=package.json 版本/docs 数/逐作品 title/chars/file/lastSeq/lastHash/backupAt/fileHash/SHA-256 条目字节）；把每个 `.wtlog` 条目落盘后交给 `tools/wtlog-check.mjs` 校验正文/锚点/快照。
22. **全新环境恢复备份包**：全新 context → 设置 `import-archive-input` 导入 → `archive-import-result` 含「导入 2 · 合并 0 · 跳过 0 · 冲突 0 · 失败 0」→ 书架 2 篇、逐篇正文逐字符一致、含快照作品历史版本存在、设置「校验全部」通过；再次导入同一包 → 结果含「跳过 2」、作品数仍 2、各作品 IDB 事件数不变。
23. **损坏备份包隔离**：正常导入后，把 `.wtzip` 截断为前 60% 再导入 → 出现可读错误提示（`archive-import-result` 或 error toast 含失败/不合法/ZIP）、应用不白屏（设置面板仍在）、2 篇原有作品与事件数不变、仍可正常打开；生成 `backup-truncated.wtzip` 留证。
24. **备份目录真实写盘 + 自动备份（OPFS 伪目录）**：`context.addInitScript` 把 `window.showDirectoryPicker` 换成返回 OPFS `backup-target` 目录的真实 `FileSystemDirectoryHandle`；建作品写中文 + Ctrl+S → 设置 `backup-choose-button` → `backup-status` 含「已配置 + 上次备份」、`backup-target/` 出现 `writertools-manifest.json` + `.wtlog`；校验 manifest（magic/format/app.version/docs/lastSeq/lastHash/fileHash）与日志（`tools/wtlog-check.mjs`），并核对 `fileHash`=条目字节 SHA-256、锚点一致；续写 + Ctrl+S（不点立即备份）→ 轮询 manifest `lastSeq` 增加、日志变长且旧日志为新日志前缀、kv `backup.lastBackupAt` 更新；与 UI 导出的 `.wtlog` 做字节前缀比对；刷新页面 → 轮询 manifest `updatedAt` 更新（启动补齐自动备份）且 `kv.backup.lastBackupAt` 更新。
25. **未配置备份目录无副作用**：写作品 + Ctrl+S + 刷新，OPFS 根目录不得出现 `backup-target`/`writertools-manifest.json`，IDB kv 无 `backup.dirHandle`/无备份错误，`backup-status` 显示「未配置」，无异常。
26. **灾备闭环「浏览器数据丢失 → 从备份目录一键恢复」（v0.1.4）**：OPFS `backup-target` 冒充备份目录 → 建 2 篇作品（改名「灾备甲/灾备乙」、写中文，其一 Ctrl+S）→ 首次备份后校验 manifest/2 个 `.wtlog`（独立 `wtlog-check`）→ `page.evaluate` 清空 IDB `docs`/`events`/`kv` 并删除 OPFS `docs/` 镜像（保留 `backup-target/`）→ 刷新后空书架 → 重选同一目录：断言 manifest 字节/条目锚点不变、旧条目无 `trashed`（空库不污染灾备清单）、状态「已配置」→ 点 `restore-from-backup-button` → `archive-import-result` 含「从备份目录恢复结果：导入 2 · 合并 0 · 跳过 0 · 冲突 0 · 失败 0」→ 书架 2 篇、标题/正文逐字符一致、「灾备甲」历史版本存在、「校验全部」通过 → 重复恢复 → 「跳过 2」、作品数与各作品事件数不变。
27. **失败路径韧性（v0.1.5）**：注入 `FileSystemFileHandle.prototype.createWritable` 抛错（模拟磁盘满/权限撤销）→ 选备份目录后首次备份出现可读失败 toast、`kv.backup.lastError` 记录、无 manifest 落盘、应用不白屏；失败后继续输入 + Ctrl+S + 刷新，正文与历史仍完整、自动备份失败不打断编辑（无 toast 刷屏）；删除备份目录后点「从备份目录恢复」→ 可读错误（"未配置备份目录或备份目录不可读"）、作品数与正文不变、设置「校验全部」仍通过。
28. **备份目录权限撤销 → 重新授权 → 自动备份恢复（v0.1.6）**：`addInitScript` 用 localStorage 状态机补丁 `FileSystemHandle.prototype.queryPermission/requestPermission` + OPFS `backup-target` 冒充 picker；初始 granted 选目录并首次备份成功 → 置 `e2e.perm=prompt` 后 reload → 断言启动 `[data-testid=backup-health-toast]` 出现（含「备份」「重新授权/暂停」）、`backup-status` 含「需要重新授权（自动备份已暂停）」、`backup-grant-button` 可见；继续写 + Ctrl+S 等 8s：manifest `updatedAt`/文件数/`kv.backup.lastBackupAt` 均不变（自动备份确实暂停）；点 `backup-grant-button` → 状态不再显示需授权、有「已重新授权/已补备份」提示，轮询到 manifest `updatedAt` 与 `lastBackupAt` 更新（自动补备份）；再次刷新无 `backup-health-toast`、正文完整。未配置/正常授权刷新不得出现健康告警（未配置步骤亦断言）。
29. **输入后立即返回书架不丢字（v0.1.7）**：独立 context 新建作品；模式 A（输入 ≥20 中文字、等 `textarea.value === 预期` 后立即 Esc）×10 + 模式 B（输入后不等待、立即 Esc）×10；每次回书架后 **从 IndexedDB `events` 真实重放该 docId 正文并断言 === 预期**、`docs.chars === 预期长度`、末尾正文事件为 `text.insert`、无 delete/replace；随后 IME 上屏后立即 Esc（断言 `compose.*` 事件与正文含「你好」）、输入后派发 `pagehide` 再 reload 重开两个变体；最终正文 439 码元重放一致。
30. **原始输入回放/查看面板（v0.2.0）**：在已有作品上复用 CDP 真实 IME（`Input.imeSetComposition` ni→nihao → `Input.insertText` 「你好」）+ 普通键盘输入 + 退格 → 点 `editor-trace-button` 打开 `trace-panel`；断言 `trace-summary` 含「组合事件 N / IME 上屏 N / 正文编辑 N」且计数合理；时间线 `trace-row` 含「预编辑「nihao」」、IME 上屏「你好」、组合结束上屏行、键盘输入行、删除行；点击行后 `trace-detail` JSON 含 `"phase"`/`"data"`（update）、`"committed"`（end）、`"source": "ime"`/`"op": "insert"`；`trace-play-button` 播放后 `aria-selected` 行推进且 `aria-pressed=true`，暂停后 `trace-prev-button`/`trace-next-button` 单步回退/前进可用；`trace-close` 关闭、重开后 Esc 只关面板仍留在编辑器。
31. **移动端 390×844**：刷新后打开作品、可输入、`scrollWidth <= innerWidth + 1` 无横向溢出。
32. **无未捕获页面异常**。

每一步输出一行 `PASS`/`FAIL`；失败时截图写入 `tests/e2e/artifacts/`（已 gitignore），进程退出码非 0。

## 失败排查

- 截图在 `tests/e2e/artifacts/`（每次运行开始会清理上一次的全部产物，只保留 `.gitignore`）。
- 构建失败：先手动 `npm run build` 看 tsc/vite 报错（脚本吞掉构建输出，只报退出码）。
- 端口占用：`npm run preview` 用 4173；如果已有服务占用但内容不是本次构建，先关掉再跑。
- Service Worker 相关：只在生产构建注册；用 `E2E_SKIP_PWA=1` 指向 dev server 时跳过。
- 测试会在全新 browser context 中运行（空 IndexedDB），刷新验证持久化；不会污染日常浏览器数据。
