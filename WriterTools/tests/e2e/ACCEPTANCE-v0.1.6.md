# WriterTools v0.1.6 端到端验收报告（备份目录权限健康检查与重新授权）

- **验收日期**：2026-10-21（Asia/Shanghai）
- **验收人**：qa（Playwright 自动化 + 独立校验器 `tools/wtlog-check.mjs` / `tools/wtzip-check.mjs` / 训练导出工具）
- **被验收构建**：**v0.1.6** 最新源码 `npm run build` 产物（`dist/index.html` + `dist/assets/index-mGB4njgq.js` 277 137 B + `dist/assets/index-RJHubUlv.css` 16 123 B；无 dev 假引擎）
- **浏览器**：Chrome 155.0.8059.85、Edge 155.0.4283.62（系统安装版本，headless）
- **环境**：Windows 11 Pro 10.0.26300 64-bit、Node v22.23.2、npm 10.9.8、Playwright 1.64.1、fflate 0.8.3
- **测试脚本**：`tests/e2e/run.mjs`（**30 步**：原 29 步 + 权限健康/重新授权场景步骤）
- **证据目录**：`tests/e2e/artifacts/`（`24-backup-permission.png`、`23-backup-write-failure.png`、`23b-backup-read-failure.png`、`training-export.jsonl`、`export.wtlog`、`e2e-chrome.log` 等；已 gitignore）
- **历史报告**：`ACCEPTANCE-v0.1.5.md`（失败路径韧性/训练导出）、`ACCEPTANCE-v0.1.4.md`（灾备恢复）、`ACCEPTANCE-v0.1.3.md`（自动备份）、`ACCEPTANCE-v0.1.2.md`（.wtzip）、`ACCEPTANCE-v0.1.1.md`、`ACCEPTANCE-v0.1.md`

## 一、结论

| 验收项 | 结果 |
| --- | --- |
| `npm run build`（tsc --noEmit + vite build） | ✅ 通过（v0.1.6：`index-mGB4njgq.js` 277 137 B / gzip 89.54 KB） |
| `npm run typecheck` | ✅ 通过 |
| `npm test`（引擎单元测试） | ✅ **105 测试**（17 文件，含权限状态机/自动备份权限门控/重新授权补备份） |
| Chrome 155 `npm run e2e`（30 步） | ✅ **30/30 步通过**，退出码 0 |
| Edge 155 `E2E_CHANNEL=msedge npm run e2e`（30 步） | ✅ **30/30 步通过**，退出码 0 |
| 原有 29 步断言（逐字符/IME/持久化/快照/主题/只读/自动恢复/.wtzip/自动备份/灾备/失败路径/训练导出/移动端…） | ✅ 无回退（Chrome + Edge） |
| **新增：权限撤销 → 启动健康告警** | ✅ `backup-health-toast` 出现，文案「备份目录需要重新授权，自动备份已暂停。请到「设置 · 数据安全」点「重新授权备份目录」。」；`backup-status` 含「需要重新授权（自动备份已暂停）」 |
| **新增：自动备份权限门控** | ✅ 权限缺失期间编辑 + Ctrl+S 后等 8s：manifest `updatedAt`/文件数/`kv.backup.lastBackupAt` **零变化**（自动备份被暂停） |
| **新增：一键重新授权 + 补备份** | ✅ `backup-grant-button` 点击后 toast「备份目录已重新授权，正在补备份…」、状态不再显示需授权；manifest `updatedAt` `18:12:58.001Z → 18:13:07.662Z`、`lastBackupAt` 更新；再次刷新无健康告警、正文完整 |
| **新增：denied 分支** | ✅ denied 时健康告警仍出现、`backup-status` 含「权限被拒绝（自动备份已暂停）」 |
| **新增：lastError 分支健康告警** | ✅ 备份写盘失败后刷新出现「备份需要处理：模拟磁盘写入失败（e2e 注入）。请到「设置 · 数据安全」查看。」 |
| 正常授权刷新 / 未配置目录 | ✅ 均不出现健康告警（未配置场景亦断言） |
| 导出 `.wtlog` header | ✅ `app.version=0.1.6`、`format=1.0`（e2e 断言与 package.json 一致） |
| 真实浏览器权限撤销/真实磁盘 | ⚠️ headless 用原型补丁模拟权限状态机；**真实 FSA 权限撤销/重新授权需人工验证**（见第五节） |

**总体结论：v0.1.6 备份目录权限健康检查与重新授权通过端到端验收**——权限被撤销后启动有可读告警、自动备份正确暂停、一键重新授权后补备份并恢复，denied/lastError 分支文案正确；原有 29 步无回退。

## 二、新增场景明细（e2e 第 28 步，Chrome + Edge 均 PASS）

`context.addInitScript` 注入权限状态机（localStorage 控制）+ 使用真实 OPFS 子目录 `backup-target` 冒充 `showDirectoryPicker`：

```js
Object.defineProperty(FileSystemHandle.prototype, 'queryPermission', {
  configurable: true, writable: true,
  value: async () => localStorage.getItem('e2e.perm') || 'granted',
});
Object.defineProperty(FileSystemHandle.prototype, 'requestPermission', {
  configurable: true, writable: true,
  value: async () => { localStorage.setItem('e2e.perm', 'granted'); return 'granted'; },
});
```

1. **初始 granted**：建作品「权限甲」（18 码元）+ Ctrl+S → 设置选备份目录 → 首次备份成功（manifest/.wtlog 落盘，`backup-status` 已配置且无「需要重新授权」）；
2. **模拟浏览器重启后权限丢失**：`localStorage.setItem('e2e.perm','prompt')` → reload：
   - 启动出现 `[data-testid=backup-health-toast]`：「**备份目录需要重新授权，自动备份已暂停。请到「设置 · 数据安全」点「重新授权备份目录」。**」（含「备份」「重新授权/暂停」）；
   - `backup-status`：「已配置（backup-target） · 上次备份 … · **需要重新授权（自动备份已暂停）**」；`backup-grant-button` 可见；
   - 应用不白屏。
3. **自动备份权限门控**：继续输入「权限撤销后继续写作。」+ Ctrl+S → 等 8s（覆盖 3s 防抖）→ 备份目录 **manifest `updatedAt`/文件数/kv `backup.lastBackupAt` 均未变化**（自动备份被暂停、无静默失败写入）；
4. **重新授权**：点 `backup-grant-button`（用户手势）→ toast「备份目录已重新授权，正在补备份…」、状态不再显示需授权；轮询到 manifest `updatedAt` **2026-10-20T18:12:58.001Z → 2026-10-20T18:13:07.662Z**、`kv.backup.lastBackupAt` 更新（补备份完成）；
5. **再次刷新**：无 `backup-health-toast`；打开作品正文完整（26 码元）；
6. **denied 分支**：置 `e2e.perm='denied'` → reload → 健康告警仍出现；`backup-status` 显示「**权限被拒绝（自动备份已暂停）**」；
7. **lastError 分支**（复用第 27 步失败注入）：备份写盘失败后刷新 → 健康告警「**备份需要处理：模拟磁盘写入失败（e2e 注入）。请到「设置 · 数据安全」查看。**」；
8. **未配置目录**（第 25 步）：不出现任何健康告警/备份文件。

## 三、原有 29 步回归（Chrome + Edge 全 PASS，无回退）

| 分组 | 覆盖内容 | 结果 |
| --- | --- | --- |
| PWA | manifest/图标字节与尺寸、SW 注册接管、断网重载可打开应用壳 | ✅ |
| 逐字符/IME/来源 | 快速输入无误报/无回滚；中文/英文/emoji + 退格；IDB insert/delete（`deleted`/`pos`）、seq/哈希链/重放；`compose.*`；`source=ime/paste/undo/redo`；双模式光标行居中误差 0.0 px | ✅ |
| 持久化/历史/主题 | 刷新持久化；Ctrl+S 快照/预览/确认恢复；明暗纯黑/纯白 + 中性色抽样；奶白 `rgb(250,246,236)` | ✅ |
| 数据安全 | 单篇 `.wtlog` 导出/独立校验/篡改检测/导入往返；`.wtzip` 全量包导出→独立校验→恢复→重复「跳过 2」→截断包可读报错；备份目录自动备份/启动补齐/未配置零副作用；灾备闭环（数据丢失→重选目录→一键恢复→重复跳过）；备份写盘失败/读取失败数据零丢失 | ✅ |
| 训练导出（v0.1.5） | `wtlog-to-training` 输出行数/字段抽查通过 | ✅ |
| 多标签/移动端 | 第二标签页只读；390×844 可输入、无横向溢出；全流程无未捕获页面异常 | ✅ |

## 四、构建与命令

```powershell
npm run build      # ✅ v0.1.6（index-mGB4njgq.js 277137B / index-RJHubUlv.css 16123B）
npm run typecheck  # ✅
npm test           # ✅ 105 tests（17 文件）
npm run e2e                                   # ✅ Chrome 30/30
$env:E2E_CHANNEL='msedge'; npm run e2e          # ✅ Edge 30/30
```

**版本说明**：v0.1.6 新写出的 `.wtlog` header / 备份 manifest / 训练摘要的 `app.version` 均为 `0.1.6`（e2e 断言与 package.json 一致），`format` 仍为 `1.0`；旧版文件仍可读。

## 五、需人工验证（headless 无法覆盖）

1. **真实 FSA 权限撤销/重新授权**：本次用原型补丁模拟 `queryPermission/requestPermission` 状态机；真实浏览器（权限被系统撤销、重启后需要重新授权、`requestPermission` 弹窗拒绝/允许）建议人工走一遍：配置目录并备份 → 撤销权限/重启 → 健康告警 → 点「重新授权备份目录」→ 浏览器授权弹窗允许 → 补备份成功。
2. **真实磁盘故障**：磁盘满/目录被删/外接盘拔出/权限被系统拒时的可读错误、`lastError`、编辑不中断（本次用 `createWritable` 抛错模拟）。
3. **真实浏览器清站点数据后的灾备恢复**（v0.1.4 场景，仍建议真机演练）。
4. **恢复读取失败的其它形态**：目录存在但缺 manifest / 目录内单条 `.wtlog` 损坏（引擎单测覆盖隔离语义）。
5. **PWA 安装 UI**、**真实输入法/软键盘**、**macOS/Linux/真实 Android**、**持久化存储授权**（headless 显示未授权属预期）。
6. **训练数据**：大规模导出性能、未知事件兼容、隐私（compose 原始拼音）与 `docs/TRAINING-DATA.md` 全字段复核。

## 六、本次改动范围与剩余风险

- 引擎（task-19）：`backup().status()` 增加 `permission`/`needsPermission`；`requestPermission()` 授权成功后自动调度补备份；自动备份在 `needsPermission` 时暂停；手动备份权限不足返回可读 `lastError`。
- UI（task-20）：`backup-status` 权限状态文案、`backup-grant-button`「重新授权备份目录」、启动一次性 `backup-health-toast`（needsPermission / lastError 两种文案）、授权后补备份提示。
- QA（task-21）：e2e 新增第 28 步（权限状态机模拟/自动备份暂停/重新授权补备份/denied 分支），并在失败路径步骤补充 lastError 健康告警、未配置步骤补充「无告警」断言；更新 `tests/e2e/README.md` 为 30 步；本报告 v0.1.6。
- **未覆盖**：真实 FSA 权限撤销/重新授权、真实磁盘故障、真实清站点数据灾备、目录内单条损坏（人工/引擎单测覆盖）。
- e2e 用原型补丁模拟浏览器权限行为；断言的是「用户可见健康提示 + 自动备份暂停 + 重新授权后补备份 + 数据不丢」行为契约。
- 自动化在全新 browser context 中运行；Chrome/Edge 复验复用了环境中已启动的 `vite preview`（确认返回 `index.html` 与磁盘 `dist/index.html` 逐字节一致）。
- 本报告不修改 `src/`；发现问题均已反馈给对应 owner。
