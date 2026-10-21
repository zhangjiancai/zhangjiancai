# WriterTools v0.2.0 端到端验收报告（原始输入回放/查看面板）

- **验收日期**：2026-10-21（Asia/Shanghai）
- **验收人**：qa（Playwright 自动化 + CDP 真实 IME + 面板时间线/详情/播放断言）
- **被验收构建**：**v0.2.0** 最新源码 `npm run build` 产物（`dist/index.html` + `dist/assets/index-7A8JaPRm.js` 286 191 B + `dist/assets/index-CpkTd3_W.css` 18 043 B；无 dev 假引擎）
- **浏览器**：Chrome 155.0.8059.85、Edge 155.0.4283.62（系统安装版本，headless）
- **环境**：Windows 11 Pro 10.0.26300 64-bit、Node v22.23.2、npm 10.9.8、Playwright 1.64.1、fflate 0.8.3
- **测试脚本**：`tests/e2e/run.mjs`（**32 步**：原 31 步 + 原始输入面板步骤）
- **证据目录**：`tests/e2e/artifacts/`（`26-input-trace.png`、`export.wtlog`、`e2e-chrome.log` 等；已 gitignore）
- **历史报告**：`ACCEPTANCE-v0.1.7.md`（Esc 丢字回归）、`ACCEPTANCE-v0.1.6.md`（备份权限健康/重新授权）、`ACCEPTANCE-v0.1.5.md`（失败路径韧性 + 训练导出）、`ACCEPTANCE-v0.1.4.md`（灾备恢复）、`ACCEPTANCE-v0.1.3.md`（自动备份）、`ACCEPTANCE-v0.1.2.md`（.wtzip）、`ACCEPTANCE-v0.1.1.md`、`ACCEPTANCE-v0.1.md`

## 一、结论

| 验收项 | 结果 |
| --- | --- |
| `npm run build`（tsc --noEmit + vite build） | ✅ 通过（v0.2.0：`index-7A8JaPRm.js` 286 191 B / gzip 92.22 KB） |
| `npm run typecheck` | ✅ 通过 |
| `npm test`（引擎单元测试） | ✅ **18 文件 / 108 测试** |
| Chrome 155 `npm run e2e`（32 步） | ✅ **32/32 步通过**，退出码 0 |
| Edge 155 `E2E_CHANNEL=msedge npm run e2e`（32 步） | ✅ **32/32 步通过**，退出码 0 |
| 原有 31 步断言（逐字符/IME/持久化/快照/主题/只读/自动恢复/.wtzip/自动备份/灾备/失败路径/权限/Esc 回归/训练导出/移动端…） | ✅ 无回退（Chrome + Edge） |
| **新增：`editor-trace-button` → `trace-panel`** | ✅ 面板打开、只读展示，不修改日志 |
| **新增：`trace-summary` 计数** | ✅ 「组合事件 **5** / IME 上屏 **1** / 正文编辑 **32** / 时间范围 …」 |
| **新增：时间线内容（44 行）** | ✅ 含「预编辑「nihao」」、组合结束→上屏「你好」、IME 上屏「你好」、普通键盘输入、退格删除行 |
| **新增：点击行 → `trace-detail` JSON** | ✅ compose.update 含 `"phase": "update"`/`"data": "nihao"`；compose.end 含 `"phase": "end"`/`"committed": "你好"`；text.insert 含 `"source": "ime"`/`"op": "insert"` |
| **新增：播放/单步** | ✅ 播放后 `aria-selected` 行 0→1 推进、`aria-pressed=true`；暂停后「上一条/下一条」可用，下一条 1→2、上一条 2→1 |
| **新增：关闭** | ✅ `trace-close` 关闭；重开后 Esc 只关面板、仍停留编辑器 |
| 导出 `.wtlog` header | ✅ `app.version=0.2.0`、`format=1.0`（e2e 断言与 package.json 一致） |
| 只读标签页面板 / 大量事件截断提示 | ⚠️ 本次未覆盖（说明见 2.3；只读基础能力由第 17 步覆盖） |

**总体结论：v0.2.0 原始输入回放/查看面板通过端到端验收**——真实 CDP IME 的预编辑串与上屏文本能在时间线中正确展示、详情 JSON 字段完整、播放/单步/关闭交互正常；原有 31 步无回退。

## 二、新增场景明细（e2e 第 30 步，Chrome + Edge 均 PASS）

### 2.1 输入构造（真实引擎 + 生产构建）

1. 打开已有作品，光标移到文末；
2. **CDP 真实 IME**：`Input.imeSetComposition` preedit 「ni」→「nihao」→ `Input.insertText` 提交「你好」；
3. 普通键盘输入 `trace普通输入`；
4. 退格 ×2（删除「输入」两字）；
5. 断言 textarea 正文 === 预期（IME 上屏与普通输入、删除都生效）。

### 2.2 面板断言（Chrome 本轮实测）

- 打开 `editor-trace-button` → `trace-panel` 可见；
- `trace-summary`：**「组合事件 5 IME 上屏 1 正文编辑 32 时间范围 23:08:47–23:10:13」**（数字解析后断言 compose≥3、IME≥1、text≥3）；
- 时间线共 **44 行**，命中：
  - `#29` 「预编辑「nihao」」（compose.update，原始拼音 `data` 完整保留）；
  - `#31` 「组合结束 → 上屏「你好」」（compose.end，`committed` 保留）；
  - `#32` 「上屏 +2 字「你好」」（text.insert，`source=ime`）；
  - `#1` 普通键盘输入行（含「键盘输入」）；
  - `#42` 退格删除行（含「删除」与被删内容）。
- **详情 JSON**：点击上述行后 `trace-detail` 依次断言
  - compose.update：`"kind": "compose"`、`"phase": "update"`、`"data": "nihao"`；
  - compose.end：`"phase": "end"`、`"committed": "你好"`；
  - text.insert：`"source": "ime"`、`"op": "insert"`。
- **播放**：选中第 0 行 → 点 `trace-play-button` → `aria-selected` 行推进 **0→1**、按钮 `aria-pressed=true`；再点暂停，状态复位；
- **单步**：`trace-next-button` → 选中 **2**；`trace-prev-button` → 回到 **1**；两按钮在非空时间线均可用；
- **关闭**：`trace-close` 关闭；重新打开后按 Esc → 面板关闭、仍停留在编辑器（不会误退出作品）。

### 2.3 未覆盖的可选项（说明原因）

- **只读标签页面板**：第二标签页只读能力已由第 17 步覆盖（`readonly-banner`/输入无效）；只读态打开原始输入面板属于同一只读渲染分支，单独构造双标签页并断言面板会显著增加用例复杂度，本次未做（列为人工验证项）。
- **大量事件截断提示（>2000 条）**：需构造 2000+ 事件（约 2000 次输入）才能触发「只显示最近 2000 条 / 加载全部」UI；单步耗时会显著拉长全量回归，引擎/UI 已有 limit 逻辑与类型契约，本次未构造（列为人工验证项）。

## 三、原有 31 步回归（Chrome + Edge 全 PASS，无回退）

| 分组 | 覆盖内容 | 结果 |
| --- | --- | --- |
| PWA | manifest/图标字节与尺寸、SW 注册接管、断网重载可打开应用壳 | ✅ |
| 逐字符/IME/来源 | 快速输入无误报/无回滚；中文/英文/emoji + 退格；IDB insert/delete、seq/哈希链/重放；`compose.*`；`source=ime/paste/undo/redo`；双模式光标行居中误差 0.0 px | ✅ |
| 数据丢失回归 | 模式 A/B 各 10 次立即 Esc + IME/pagehide 变体，IndexedDB 真实重放零丢失 | ✅ |
| 持久化/历史/主题 | 刷新持久化；Ctrl+S 快照/预览/确认恢复；明暗纯黑/纯白 + 中性色抽样；奶白 `rgb(250,246,236)` | ✅ |
| 数据安全 | `.wtlog` 导出/独立校验/篡改检测/导入往返；`.wtzip` 全量包导出→独立校验→恢复→重复「跳过 2」→截断包可读报错；备份目录自动备份/启动补齐/未配置零副作用；灾备闭环；失败路径数据零丢失；权限健康/重新授权 | ✅ |
| 训练导出（v0.1.5） | `wtlog-to-training` 输出行数/字段抽查通过 | ✅ |
| 多标签/移动端 | 第二标签页只读；390×844 可输入、无横向溢出；全流程无未捕获页面异常 | ✅ |

## 四、构建与命令

```powershell
npm run build      # ✅ v0.2.0（index-7A8JaPRm.js 286191B / index-CpkTd3_W.css 18043B）
npm run typecheck  # ✅
npm test           # ✅ 18 files / 108 tests
npm run e2e                                   # ✅ Chrome 32/32
$env:E2E_CHANNEL='msedge'; npm run e2e          # ✅ Edge 32/32
```

**版本说明**：v0.2.0 新写出的 `.wtlog` header `app.version="0.2.0"`、备份 manifest/训练摘要同为 `0.2.0`（e2e 断言与 package.json 一致），`format` 仍为 `1.0`；旧版文件仍可读。

## 五、需人工验证（headless 无法覆盖）

1. **真实输入法**：本次用 CDP `Input.imeSetComposition` 模拟；真实拼音候选/多候选翻页/长预编辑串、上屏后立即打开面板建议人工复核（时间线应展示每一步预编辑原文）。
2. **只读标签页面板**：第二标签页只读状态下打开原始输入面板，确认可查看且无写入。
3. **大量事件（>2000）**：构造 2000+ 事件验证「只显示最近 2000 条」提示、「加载全部」按钮、滚动性能与内存。
4. **播放体验**：350ms 间隔播放、长日志下的自动滚动、播放到末尾自动停止、播放中切换/关闭面板。
5. **无障碍/键盘操作**：列表 `role=listbox/option`、Tab 焦点、屏幕阅读器朗读。
6. **移动端布局**：窄屏下面板双栏（时间线+详情）布局与滚动；真实软键盘输入后查看。
7. **隐私**：原始输入面板会展示输入法预编辑原文（拼音），确认用户对本地数据可见性预期；导出/备份包仍按既有格式。
8. 保留人工项：真实 FSA 权限/磁盘故障/清站点数据灾备、PWA 安装 UI、macOS/Linux/真实 Android、大规模文档性能。

## 六、本次改动范围与剩余风险

- 引擎（task-24）：`DocHandle.getInputTrace()` 把 `compose.*`、正文编辑、场次/排版边界归一化为 `InputTraceEntry[]`，默认限最近 2000 条、`limit:0` 全量；只读不修改日志。
- UI（task-25）：`editor-trace-button` + `InputTracePanel`（`trace-panel`/`trace-summary`/`trace-row`/`trace-detail`/`trace-play-button`/`trace-prev-button`/`trace-next-button`/`trace-close`），时间线、详情 JSON、播放/单步、截断提示与加载全部。
- QA（task-26）：e2e 新增第 30 步（真实 CDP IME + 键盘 + 退格 → 面板 summary/时间线/详情/播放/单步/关闭/Esc）；更新 `tests/e2e/README.md` 为 32 步；本报告 v0.2.0。
- **未覆盖**：只读标签页面板、>2000 条截断/加载全部、播放到末尾自动停止（人工项）。
- e2e 用 CDP 合成 IME 与真实引擎事件流；真实输入法厂商差异（多候选、长串、输入法特殊事件）建议人工补充。
- 自动化在全新 browser context 中运行；Chrome/Edge 复验复用了环境中已启动的 `vite preview`（确认返回 `index.html` 与磁盘 `dist/index.html` 逐字节一致）。
- 本报告不修改 `src/`；发现问题均已反馈给对应 owner。
