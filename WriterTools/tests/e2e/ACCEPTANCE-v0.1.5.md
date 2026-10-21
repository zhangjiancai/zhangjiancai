# WriterTools v0.1.5 端到端验收报告（失败路径韧性 + 训练数据导出）

- **验收日期**：2026-10-21（Asia/Shanghai）
- **验收人**：qa（Playwright 自动化 + 独立校验器 `tools/wtlog-check.mjs` / 训练导出工具 `tools/wtlog-to-training.mjs`）
- **被验收构建**：**v0.1.5** 最新源码 `npm run build` 产物（`dist/index.html` + `dist/assets/index-DQLbArDV.js` 274 054 B + `dist/assets/index-RJHubUlv.css` 16 123 B；无 dev 假引擎）
- **浏览器**：Chrome 155.0.8059.85、Edge 155.0.4283.62（系统安装版本，headless）
- **环境**：Windows 11 Pro 10.0.26300 64-bit、Node v22.23.2、npm 10.9.8、Playwright 1.64.1、fflate 0.8.3
- **测试脚本**：`tests/e2e/run.mjs`（**29 步**：原 27 步 + 失败路径韧性步骤 + 训练数据导出步骤）
- **证据目录**：`tests/e2e/artifacts/`（`23-backup-write-failure.png`、`23b-backup-read-failure.png`、`training-export.jsonl` 76 373 B、`training-export-summary.json`、`export.wtlog`、`e2e-chrome.log` 等；已 gitignore）
- **历史报告**：`ACCEPTANCE-v0.1.4.md`（灾备恢复）、`ACCEPTANCE-v0.1.3.md`（自动备份）、`ACCEPTANCE-v0.1.2.md`（.wtzip）、`ACCEPTANCE-v0.1.1.md`、`ACCEPTANCE-v0.1.md`

## 一、结论

| 验收项 | 结果 |
| --- | --- |
| `npm run build`（tsc --noEmit + vite build） | ✅ 通过（v0.1.5：`index-DQLbArDV.js` 274 054 B / gzip 88.66 KB） |
| `npm run typecheck` | ✅ 通过 |
| `npm test`（引擎单元测试） | ✅ **16 文件 / 98 测试** |
| Chrome 155 `npm run e2e`（29 步） | ✅ **29/29 步通过**，退出码 0 |
| Edge 155 `E2E_CHANNEL=msedge npm run e2e`（29 步） | ✅ **29/29 步通过**，退出码 0 |
| 原有 27 步断言（逐字符/IME/持久化/快照/主题/只读/自动恢复/.wtzip/自动备份/灾备/移动端…） | ✅ 无回退（Chrome + Edge） |
| **新增：备份写盘失败注入（磁盘满/权限撤销）** | ✅ 可读 toast「已设置备份目录，但首次备份失败：模拟磁盘写入失败（e2e 注入）」、`backup-status` 含「备份错误」、`kv.backup.lastError` 记录、无 manifest 落盘、应用不白屏 |
| **新增：失败后数据零丢失/编辑不中断** | ✅ 继续输入 + Ctrl+S + 刷新后正文完整（28 码元）、历史 2 个版本；自动备份失败静默不打断编辑、无 toast 刷屏 |
| **新增：备份目录读取失败（目录删除）** | ✅「从备份目录恢复失败：未配置备份目录或备份目录不可读…」可读错误、应用不白屏、作品数与正文不变、设置「校验全部」仍通过 |
| **新增：训练数据导出工具** | ✅ `tools/wtlog-to-training.mjs` 对导出的 `.wtlog` 输出 282 行 JSONL = 282 事件；`op/insert/delete(deleted)/compose.data/snapshot` 字段齐全；摘要 `countedDocs=1` |
| 导出 `.wtlog` header | ✅ `app.version=0.1.5`、`format=1.0`（e2e 断言与 package.json 一致） |
| 真实磁盘故障/真实浏览器清站点数据 | ⚠️ headless 用注入模拟；**真实磁盘满/权限撤销等需人工验证**（见第五节） |

**总体结论：v0.1.5 失败路径韧性通过端到端验收**——备份写入失败与备份目录读取失败时均有可读提示、主存储正文/历史零丢失、编辑不中断；训练数据导出工具输出结构正确。原有 27 步无回退。

## 二、新增场景明细

### 2.1 失败注入 A：备份写盘失败（e2e 第 27 步，Chrome + Edge 均 PASS）

`context.addInitScript` 注入（仅该 context 生效，使用真实 OPFS 目录冒充 `showDirectoryPicker`）：

```js
FileSystemFileHandle.prototype.createWritable = () =>
  Promise.reject(new DOMException('模拟磁盘写入失败（e2e 注入）', 'NotAllowedError'));
```

1. 建作品「韧性甲」输入 18 码元 → Ctrl+S 快照 → 回书架 → 设置选备份目录；
2. 断言可读失败提示：toast **「已设置备份目录，但首次备份失败：模拟磁盘写入失败（e2e 注入）」**；`backup-status` = **「备份目录：已配置（backup-target） · 备份错误：模拟磁盘写入失败（e2e 注入）」**；IDB `kv.backup.lastError` 非空；
3. `backup-target/` 目录存在但**没有任何 manifest**（写入全部失败）；`#root` 有内容、设置面板仍在（不白屏）；
4. 失败后继续编辑：重新打开作品正文完整 18 码元 → 再输入「写盘失败后继续输入。」→ 保存 → 等待防抖后自动备份同样失败：**无 toast 刷屏**（失败提示 ≤ 2）、textarea 值未被改写、仍可正常输入（输入 + 退格验证）；
5. 刷新页面：正文完整（**28 码元**）、版本历史 **2 个**（Ctrl+S 快照仍在）——备份写盘失败只影响备份目录，主存储/历史零丢失；
6. 备份目录读取失败（B）：删除 `backup-target` 目录后点 `restore-from-backup-button` → `archive-import-result` 显示 **「从备份目录恢复失败：未配置备份目录或备份目录不可读，请先在设置中选择并授权备份目录」**；应用不白屏；「校验全部」仍 **校验通过**；书架仍 1 篇、正文未被破坏。

### 2.2 训练数据导出工具（e2e 第 15 步，Node 侧）

命令（等价 `npm run export:training -- …`）：

```powershell
node tools/wtlog-to-training.mjs tests/e2e/artifacts/export.wtlog \
  --out tests/e2e/artifacts/training-export.jsonl \
  --summary tests/e2e/artifacts/training-export-summary.json
```

实测（Chrome 本轮，导出的 `.wtlog` 为 282 事件 / 252 字符 / 3 快照）：

- 退出码 0（默认先过 `tools/wtlog-check.mjs` 校验）；
- JSONL **282 行 = 摘要 events 282 = 日志事件数**；首行 `doc.init`；
- 抽查字段：`text.insert`（`op="insert"`、`text` 非空）、`text.delete`（`op="delete"`、`deleted` 非空）、`compose.update`（保留原始输入法 `data`）、`snapshot` 均存在；
- 摘要：`schemaVersion=1`、`countedDocs=1`、`byType` 含 `doc.init=1 / session.start=3 / text.insert=246 / text.delete=4 / compose.start=2 / compose.update=5 / compose.end=2 / snapshot=3 / text.reset=1 / editor.mode=4 / selection.set=10 / session.end=1`；`stats`：insert 246 / delete 4 / reset 1 / compose 9 / snapshot 3 / selection 10 / finalCharsApprox 252；
- JSONL 记录字段：`v/label/docId/title/seq/ts/type/affects/app`，`app.version=0.1.5`。

## 三、原有 27 步回归（Chrome + Edge 全 PASS，无回退）

| 分组 | 覆盖内容 | 结果 |
| --- | --- | --- |
| PWA | manifest/图标字节与尺寸、SW 注册接管、断网重载可打开应用壳 | ✅ |
| 逐字符/IME/来源 | 快速输入无误报/无回滚；中文/英文/emoji + 退格；IDB insert/delete（`deleted`/`pos`）、seq/哈希链/重放；`compose.*`；`source=ime/paste/undo/redo`；双模式光标行居中误差 0.0 px | ✅ |
| 持久化/历史/主题 | 刷新持久化；Ctrl+S 快照/预览/确认恢复；明暗纯黑/纯白 + 中性色抽样；奶白 `rgb(250,246,236)` | ✅ |
| 数据安全 | 单篇 `.wtlog` 导出/独立校验/篡改检测/导入往返；`.wtzip` 全量包导出→独立校验→恢复→重复「跳过 2」→截断包可读报错；备份目录自动备份/启动补齐/未配置零副作用；灾备闭环（数据丢失→重选目录→一键恢复→重复跳过） | ✅ |
| 多标签/移动端 | 第二标签页只读；390×844 可输入、无横向溢出；全流程无未捕获页面异常 | ✅ |

## 四、构建与命令

```powershell
npm run build        # ✅ v0.1.5（index-DQLbArDV.js 274054B / index-RJHubUlv.css 16123B）
npm run typecheck    # ✅
npm test             # ✅ 16 files / 98 tests
npm run e2e                                   # ✅ Chrome 29/29
$env:E2E_CHANNEL='msedge'; npm run e2e          # ✅ Edge 29/29
npm run export:training -- tests/e2e/artifacts/export.wtlog --out tests/e2e/artifacts/training-export.jsonl --summary tests/e2e/artifacts/training-export-summary.json   # ✅ 282 行
```

**版本说明**：v0.1.5 新写出的 `.wtlog` header `app.version="0.1.5"`、备份 manifest/训练摘要 `app.version` 同为 `0.1.5`，`format` 仍为 `1.0`；旧版文件仍可读。

## 五、需人工验证（headless 无法覆盖）

1. **真实磁盘备份失败**：本次用 `createWritable` 抛错模拟"磁盘满/权限撤销"；真实场景（磁盘满、目录被删、权限被系统撤销、外接盘拔出）建议人工构造，确认可读错误、`backup-status` lastError、编辑不中断、主数据不丢。
2. **真实 FSA 灾备演练**：真实磁盘目录 + 浏览器真实「清除站点数据」（IndexedDB/OPFS 清空、FSA 句柄/权限丢失）→ 重选目录并授权 → 一键恢复；真实权限重新授权行为。
3. **恢复读取失败的其它形态**：目录存在但缺 manifest / 目录内单条 `.wtlog` 损坏（引擎单测已覆盖隔离语义，本次 e2e 只测目录整体不可读）。
4. **PWA 安装流程**：桌面 Chrome/Edge 安装按钮、Android「添加到主屏幕」。
5. **真实输入法/软键盘、平台矩阵**：CDP IME 模拟；仅 Windows 11 + Chromium 桌面 + 390×844 视口模拟，macOS/Linux/真实 Android 未测。
6. **持久化存储授权**：headless 新 context 显示「未授权」（预期）。
7. **训练数据**：本次仅对 1 个 282 事件日志抽查字段；大规模导出性能、含未知事件/乱序兼容、隐私（compose 原始拼音）与 `docs/TRAINING-DATA.md` 全字段覆盖建议人工复核。

## 六、本次改动范围与剩余风险

- QA（task-18）：e2e 新增第 15 步（训练数据导出）、第 27 步（备份写盘失败/目录读取失败注入）；更新 `tests/e2e/README.md` 为 29 步；本报告 v0.1.5。
- 同期 Lead 提供：`tools/wtlog-to-training.mjs` 与 `docs/TRAINING-DATA.md`；版本号升至 0.1.5。
- **未覆盖**：真实磁盘故障/真实浏览器清站点数据/真实权限撤销、目录内单条日志损坏的恢复隔离、大规模数据与训练导出性能（人工验证项，引擎单测已覆盖模拟语义）。
- 失败注入仅 patch 页面原型方法，真实浏览器错误类型/时机可能不同；e2e 断言的是"用户可见的可读提示 + 数据零丢失 + 编辑不中断"这一行为契约。
- 自动化在全新 browser context 中运行；Chrome/Edge 复验复用了环境中已启动的 `vite preview`（确认返回 `index.html` 与磁盘 `dist/index.html` 逐字节一致）。
- 本报告不修改 `src/`；发现问题均已反馈给对应 owner。
