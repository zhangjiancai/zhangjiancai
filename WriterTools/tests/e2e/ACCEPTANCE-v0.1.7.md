# WriterTools v0.1.7 端到端验收报告（输入后立即 Esc 不丢字回归）

- **验收日期**：2026-10-21（Asia/Shanghai）
- **验收人**：qa（Playwright 自动化 + 从 IndexedDB 真实事件流重放校验）
- **被验收构建**：**v0.1.7** 最新源码 `npm run build` 产物（`dist/index.html` + `dist/assets/index-Dpuc86sN.js` 277 606 B + `dist/assets/index-RJHubUlv.css` 16 123 B；无 dev 假引擎）
- **浏览器**：Chrome 155.0.8059.85、Edge 155.0.4283.62（系统安装版本，headless）
- **环境**：Windows 11 Pro 10.0.26300 64-bit、Node v22.23.2、npm 10.9.8、Playwright 1.64.1、fflate 0.8.3
- **测试脚本**：`tests/e2e/run.mjs`（**31 步**：原 30 步 + 数据丢失回归步骤）
- **证据目录**：`tests/e2e/artifacts/`（`25-escape-flush.png`、`export.wtlog`、`e2e-chrome.log` 等；已 gitignore）
- **历史报告**：`ACCEPTANCE-v0.1.6.md`（备份权限健康/重新授权）、`ACCEPTANCE-v0.1.5.md`（失败路径韧性/训练导出）、`ACCEPTANCE-v0.1.4.md`（灾备恢复）、`ACCEPTANCE-v0.1.3.md`（自动备份）、`ACCEPTANCE-v0.1.2.md`（.wtzip）、`ACCEPTANCE-v0.1.1.md`、`ACCEPTANCE-v0.1.md`

## 一、结论

| 验收项 | 结果 |
| --- | --- |
| `npm run build`（tsc --noEmit + vite build） | ✅ 通过（v0.1.7：`index-Dpuc86sN.js` 277 606 B / gzip 89.70 KB） |
| `npm run typecheck` | ✅ 通过 |
| `npm test`（引擎单元测试） | ✅ **105 测试** |
| Chrome 155 `npm run e2e`（31 步） | ✅ **31/31 步通过**，退出码 0 |
| Edge 155 `E2E_CHANNEL=msedge npm run e2e`（31 步） | ✅ **31/31 步通过**，退出码 0 |
| 原有 30 步断言（逐字符/IME/持久化/快照/主题/只读/自动恢复/.wtzip/自动备份/灾备/失败路径/权限/训练导出/移动端…） | ✅ 无回退（Chrome + Edge） |
| **新增：模式 A「确认后立即 Esc」×10** | ✅ 每次 IndexedDB 重放正文 === 预期、`docs.chars` === 长度、末尾正文事件为 `text.insert`；累计 221 码元零丢失 |
| **新增：模式 B「输入后立即 Esc（不等待）」×10** | ✅ 同上；累计 422 码元零丢失（原 bug 场景：Lead 压力脚本在原构建 12 次丢 10 次） |
| **新增：IME 上屏后立即 Esc** | ✅ 正文含「你好」、`compose.*` 事件 4 条、重放一致 |
| **新增：pagehide 后 reload 重开** | ✅ 最终 439 码元完整、IndexedDB 重放一致 |
| 导出 `.wtlog` header | ✅ `app.version=0.1.7`、`format=1.0`（e2e 断言与 package.json 一致） |
| 真实硬件/真实输入法/真实关标签页 | ⚠️ CDP 合成事件模拟；**真实输入法、真实进程/标签页关闭需人工验证**（见第五节） |

**总体结论：v0.1.7「输入后立即 Esc 丢字」修复通过端到端验收**——模式 A/B 各 10 次、全部以 IndexedDB 真实事件重放校验零丢失，IME 上屏与 pagehide 变体也完整；原有 30 步无回退。

## 二、新增场景明细（e2e 第 29 步，Chrome + Edge 均 PASS）

独立 browser context + 真实引擎 + 生产构建；每次返回书架后**不只看 UI**，而是读取该 docId 的 IndexedDB `events` 并重放为正文：

1. 新建作品「Esc韧性」；
2. **模式 A（等待确认后立即 Esc）×10**：每轮在文末输入一段 ≥20 字中文 → 等待 `textarea.value === 预期` → **立即**按 Esc 回书架 → 下一轮重开续写；
   - 每轮/结束后从 IndexedDB 重放正文 === 预期；`docs.chars` === 预期长度；末尾正文事件为 `text.insert`；无 delete/replace；
   - 累计 **221 码元** 零丢失；重新打开 textarea 正文一致。
3. **模式 B（输入后不等待立即 Esc）×10**：每轮输入后**不做任何等待**立刻 Esc；
   - 唯一校验来源仍是 IndexedDB 真实重放：累计 **422 码元** 零丢失；`docs.chars` 一致、末尾 `text.insert`；
   - 重新打开 textarea 正文一致。
4. **IME 变体**：CDP `Input.imeSetComposition` + `Input.insertText` 上屏「你好」后**立即 Esc** → 重开正文含「你好」、该 doc 有 **4 条 `compose.*`** 事件、重放一致；
5. **pagehide 变体**：输入后派发 `PageTransitionEvent('pagehide')` → reload → 重开作品，最终正文 **439 码元**完整、IndexedDB 重放一致；
6. 全程无未捕获页面异常。

> 断言口径：修复前后数据差异只来自 IndexedDB `events` 重放与 `docs.chars`，不依赖 textarea 显示，避免"假绿"。Lead 压力脚本复核：修复前模式 B 12 次丢 10 次；修复后 Lead 独立复验 A/B 各 12 次 0 丢失，与本次 e2e 结果一致。

## 三、原有 30 步回归（Chrome + Edge 全 PASS，无回退）

| 分组 | 覆盖内容 | 结果 |
| --- | --- | --- |
| PWA | manifest/图标字节与尺寸、SW 注册接管、断网重载可打开应用壳 | ✅ |
| 逐字符/IME/来源 | 快速输入无误报/无回滚；中文/英文/emoji + 退格；IDB insert/delete（`deleted`/`pos`）、seq/哈希链/重放；`compose.*`；`source=ime/paste/undo/redo`；双模式光标行居中误差 0.0 px | ✅ |
| 持久化/历史/主题 | 刷新持久化；Ctrl+S 快照/预览/确认恢复；明暗纯黑/纯白 + 中性色抽样；奶白 `rgb(250,246,236)` | ✅ |
| 数据安全 | `.wtlog` 导出/独立校验/篡改检测/导入往返；`.wtzip` 全量包导出→独立校验→恢复→重复「跳过 2」→截断包可读报错；备份目录自动备份/启动补齐/未配置零副作用；灾备闭环；失败路径数据零丢失；权限健康/重新授权 | ✅ |
| 训练导出（v0.1.5） | `wtlog-to-training` 输出行数/字段抽查通过 | ✅ |
| 多标签/移动端 | 第二标签页只读；390×844 可输入、无横向溢出；全流程无未捕获页面异常 | ✅ |

## 四、构建与命令

```powershell
npm run build      # ✅ v0.1.7（index-Dpuc86sN.js 277606B / index-RJHubUlv.css 16123B）
npm run typecheck  # ✅
npm test           # ✅ 105 tests
npm run e2e                                   # ✅ Chrome 31/31
$env:E2E_CHANNEL='msedge'; npm run e2e          # ✅ Edge 31/31
```

**版本说明**：v0.1.7 新写出的 `.wtlog` header `app.version="0.1.7"`、备份 manifest/训练摘要同为 `0.1.7`（e2e 断言与 package.json 一致），`format` 仍为 `1.0`；旧版文件仍可读。

## 五、需人工验证（headless 无法覆盖）

1. **真实输入法/软键盘**：本次 IME 用 CDP `imeSetComposition/insertText` 模拟；真实拼音候选上屏、中文输入法组合过程（尤其上屏后立即 Esc/切窗）建议人工验证。
2. **真实关闭/隐藏标签页**：pagehide 为合成事件；真实关窗、切后台、系统休眠、浏览器崩溃前的 flush 行为建议人工验证（与录音/输入法组合过程叠加）。
3. **真实键盘节奏**：e2e 的 `keyboard.type`+立即 Esc 已尽可能贴近；真实硬件快速敲击+快捷键（含超大粘贴）仍建议人工抽查。
4. **真实磁盘/FSA 权限/清站点数据灾备**（v0.1.4–v0.1.6 场景）：仍保留人工项。
5. **PWA 安装 UI、macOS/Linux/真实 Android、持久化存储授权、大规模文档性能**。
6. **训练数据**（v0.1.5）：大规模导出性能、未知事件兼容、隐私复核。

## 六、本次改动范围与剩余风险

- UI（task-22）：录制器新增 `flush()`（循环等待自身写队列清空、含尚未 append 的排队项）；`dispose()` 改为 async 等待；EditorView 注册 flush 给 App；pagehide/visibilitychange 先 recorder.flush 再 handle.flush；App.closeDoc 严格按 `editorFlush() → handle.flush() → handle.close()` 卸载。
- QA（task-23）：e2e 新增第 29 步「输入后立即返回书架不丢字」（模式 A/B 各 10 次 + IME/pagehide 变体，全部以 IndexedDB 真实重放断言）；更新 `tests/e2e/README.md` 为 31 步；本报告 v0.1.7。
- **未覆盖**：真实输入法/真实关标签页、真实硬件极限节奏、真实 FSA/磁盘/清站点数据（人工项）。
- e2e 用 IndexedDB 真实重放规避"UI 假绿"；但仍是单机 headless Chromium，真实浏览器进程退出瞬间的持久化边界建议人工补充验证。
- 自动化在全新 browser context 中运行；Chrome/Edge 复验复用了环境中已启动的 `vite preview`（确认返回 `index.html` 与磁盘 `dist/index.html` 逐字节一致）。
- 本报告不修改 `src/`；发现问题均已反馈给对应 owner。
