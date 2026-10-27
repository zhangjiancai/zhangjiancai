# WriterTools v0.2.1 端到端验收报告（Web 全量回归 + Android APK 备份目录）

- **验收日期**：2026-10-27（Asia/Shanghai）
- **验收人**：qa（Playwright Web 自动化 + Android ADB/UIAutomator/CDP 辅助验收 + 独立 `wtlog-check`）
- **被验收构建**：
  - **Web/PWA**：v0.2.1 源码 `npm run build` 产物（`dist/assets/index-CYdo_zdc.js` 298 082 B + `index-CPkTd3_W.css` 18 043 B）
  - **Android APK**：`.lead-tmp/WriterTools-v0.2.1-android-debug.apk`，4 288 193 B，SHA-256 `d5e55f2676532f0e5a2a3f89332e34abc0d9017ad81db90892490b40a492a42a`（versionCode 201 / versionName 0.2.1 / package `com.writertools.app` / minSdk 24 / targetSdk 36）
- **环境**：Windows 11 Pro、Node v22.23.2、npm 10.9.8、Playwright 1.64.1；Android SDK（platform-tools 36.1.0 / emulator 36.3.10 / build-tools 36.1.0）
- **Web 浏览器**：Chrome 155.0.8059.85、Edge 155.0.4283.62（headless）
- **Android 设备**：独立创建 AVD `WTAcceptance36`（Android 16 / API 36.1，emulator-5558，1080×2400，未使用 Lead 的 5554）+ 次级 AVD `Small_Phone`（Android 11 / API 30，emulator-5556）
- **测试脚本**：`tests/e2e/run.mjs`（**32 步**，未新增 Web 步骤；Android 验收为独立 ADB/CDP 流程）
- **证据目录**：`tests/e2e/artifacts/`（`android-acceptance-summary.json`、`android-*.png`、`android-apk-static.json`、`apk-badging.txt`、`apk-sha256.txt`、`manifest-after-*.json`、`backup-after-first.wtlog`、`e2e-chrome.log` 等；已 gitignore）
- **历史报告**：`ACCEPTANCE-v0.2.0.md`（原始输入面板）、`ACCEPTANCE-v0.1.7.md`（Esc 丢字）、`ACCEPTANCE-v0.1.6.md`（备份权限）、`ACCEPTANCE-v0.1.5.md`（失败路径/训练导出）、`ACCEPTANCE-v0.1.4.md`（灾备）、`ACCEPTANCE-v0.1.3.md`、`ACCEPTANCE-v0.1.2.md`、`ACCEPTANCE-v0.1.1.md`、`ACCEPTANCE-v0.1.md`

## 一、结论

| 验收项 | 结果 |
| --- | --- |
| `npm run build` / `typecheck` | ✅ / ✅（v0.2.1，Web） |
| `npm test`（引擎单测） | ✅ **19 文件 / 117 测试** |
| Chrome Web 32 步 e2e | ✅ **32/32**，退出码 0 |
| Edge Web 32 步 e2e | ✅ **32/32**，退出码 0 |
| Web 备份目录 FSA 路径无回退 | ✅ 自动备份/灾备恢复/权限健康/失败路径全部通过；Web 上 `backup-status` 不含「手机目录」/「选择手机上的文件夹」（FSA 文案不变） |
| Android APK 静态合规 | ✅ 包名/版本/`BackupFolderPlugin`（classes6.dex）/6 个插件方法/assets/public 哈希与 dist 一致（11 个 asset）全部通过 |
| Android 16 原生备份：选目录→首次备份→编辑自动备份 | ✅ 目录内**精确文件名、无 `.txt`、无 (1)(2) 副本**；manifest 锚点齐全；`wtlog-check` OK |
| Android 16 原生备份：本地 Web 数据丢失→一键恢复 | ✅「导入 1 · 合并 0 · 跳过 0 · 冲突 0 · 失败 0」；正文 30 字符完整恢复 |
| Android 16 重启 App 后 SAF 持久授权 | ✅ 状态仍「已配置（WTTAcce） · 手机目录 · 上次备份」；作品持久 |
| 旧 `.txt` 文件名兼容（历史版本目录） | ✅ 恢复「导入 0 · 跳过 1」（`normalizeBackupName` 生效） |
| **发现并修复的 Android 16 bug** | ✅ 复现旧版新备份文件名被 SAF 追加 `.txt`（且产生 (1)(2) 副本）→ 恢复报「缺少 writertools-manifest.json」；修复版验证通过（详见第二节） |
| 真实物理手机 / 第三方 DocumentsProvider | ⚠️ 仅模拟器（Google 系统镜像 provider）；真机矩阵建议人工补验（见第六节） |

**总体结论：v0.2.1 Web 无回退；Android APK（修复版）原生备份目录主链路与灾备恢复在 Android 16 模拟器上通过独立验收。** 验收期间发现并验证修复了 Android 16 SAF 自动改文件名导致备份不可恢复的高危 bug。

## 二、验收中发现并验证修复的 Android SAF bug（重点）

### 2.1 复现（旧版 APK，Android 16）

在继续使用 Medium_Phone（Android 16）验证时，`Download/WriterToolsBackup/` 出现：

```
writertools-manifest.json.txt
writertools-manifest.json (1).txt
无题-fec0eba4.wtlog.txt
无题-fec0eba4.wtlog (1).txt
```

- 原因：`DocumentFile.createFile("text/plain", "x.wtlog")` 被系统 DocumentsProvider 自动追加 `.txt`；插件按精确名 `findFile` 找不到，每次备份都创建新副本 `(1)(2)`；
- `readFiles` 过滤 `name.endsWith('.wtlog') || 'writertools-manifest.json'.equals(name)` → 全部 `.txt` 被排除；
- 点「从备份目录恢复」实测报错：**「从备份目录恢复失败：备份目录缺少 writertools-manifest.json，无法恢复（请先执行一次备份）」**；
- 把 `.wtlog.txt` 拉回电脑用 `node tools/wtlog-check.mjs` 校验：**OK**（5 事件 / 17 字符 / 0 快照，仅「无 snapshot 提示」）——内容正确，**纯文件名问题**。

### 2.2 修复版验证（`.lead-tmp` SHA-256 `d5e55f…`，Android 16 独立 AVD）

- 插件修复：`ensureFile()` 创建后 `DocumentsContract.renameDocument` 改回精确名；`readFile`/`readFiles` 用 `normalizeBackupName` 兼容旧 `.txt` 名并去重；
- 全新目录 `WTTAcce`：**精确文件名**、无 `.txt`、无 `(1)(2)`；
- 连续「立即备份」×2：仍只有 2 个文件（覆盖写，`lastSeq` 12→14，`updatedAt` 更新）；
- 旧 `.txt` 目录兼容：把文件改名为 `.txt` 后恢复 →「导入 0 · 跳过 1」，说明历史目录也能读。

## 三、Android 原生备份验收明细（独立 Android 16 AVD，emulator-5558）

> 自动化方式：应用内用 WebView CDP 操作 DOM（建作品/输入/设置/按钮）；Android 系统 SAF picker 用 `adb uiautomator dump` + `input tap/swipe` 操作（系统 UI 无法在 headless DOM 中自动化）。
> 使用**独立创建**的 AVD 与**独立目录** `WTTAcce`，不依赖 Lead 的 `WTLeadTest`。

1. **安装/启动**：修复版 APK 安装成功，Capacitor `platform=android`，书架空态；
2. **选择目录**：设置 →「选择备份目录」→ 系统 picker 新建并选择 `/storage/emulated/0/WTTAcce` → 系统授权弹窗 ALLOW → `backup-status`「已配置（WTTAcce） · 手机目录 · 上次备份 10-27 22:40」；
3. **首次备份**：目录内仅 `writertools-manifest.json`（511 B）+ `无题-ae3f2d5b.wtlog`（3344 B）；
   manifest：`magic=writertools-backup-manifest`、`format=1.0`、`app.version=0.2.1`、`docId=ae3f2d5b…`、`chars=18`、`lastSeq=6`、`fileHash/lastHash` 齐全；
   `wtlog-check`：**OK（7 事件 / 18 字符 / 1 快照）**；
4. **编辑后自动备份**：打开作品追加「修复后自动备份增量验证。」（+12 字符）→ 回书架约 7s 后：manifest `updatedAt` 22:40:07→22:40:43、`chars` 18→30、`lastSeq` 6→12、wtlog 3344→6081 B，目录仍 2 文件；
5. **连续立即备份 ×2**：仍 2 文件，`lastSeq` 12→14，`updatedAt` 22:43:32（覆盖写非副本）；
6. **模拟本地 Web 数据丢失**：force-stop 后删除整个 `app_webview`（IndexedDB / Local Storage / Service Worker / File System 等 WebView 数据），**保留 `shared_prefs/writertools_backup.xml` 的 SAF tree URI**（等价于"浏览器数据丢失但系统目录授权仍在"）→ 重启后书架为空、`backup-status` 仍「已配置（WTTAcce） · 手机目录」；
7. **一键恢复**：点「从备份目录恢复」→ **「导入 1 · 合并 0 · 跳过 0 · 冲突 0 · 失败 0」**；书架 1 篇（30 字 / 2 版本），打开正文 = 「修复后原生备份验收：文件名必须精确。修复后自动备份增量验证。」；
8. **重启 App**：`force-stop`/`start` 后状态仍「已配置（WTTAcce） · 手机目录 · 上次备份 22:42」、作品 30 字/2 版本仍在；SAF 持久授权生效；
9. **旧 `.txt` 兼容**：改名为 `.txt` 后恢复 →「导入 0 · 跳过 1」；
10. **次级 Android 11 验证**（Small_Phone / API 30）：原生选目录、首次备份（文件名精确）、编辑后自动备份、重启持久化均 PASS；该版本系统 SAF 不追加 `.txt`，无该 bug；恢复的"重新选目录"步骤受模拟器 DocumentsUI 自动化限制未完成（见第六节）。

## 四、Web 全量回归（Chrome + Edge 32/32，无回退）

| 分组 | 覆盖内容 | 结果 |
| --- | --- | --- |
| PWA | manifest/图标/SW 注册/断网重载应用壳 | ✅ |
| 逐字符/IME/来源 | 快速输入无误报/无回滚；中文/英文/emoji+退格；IDB insert/delete、seq/哈希链/重放；`compose.*`；`source=ime/paste/undo/redo`；双模式光标居中 0.0px | ✅ |
| 数据丢失回归 | 模式 A/B 各 10 次立即 Esc + IME/pagehide 变体，IndexedDB 真实重放零丢失 | ✅ |
| 持久化/历史/主题 | 刷新持久化；Ctrl+S 快照/预览/恢复；明暗纯黑/纯白 + 中性色；奶白 `rgb(250,246,236)` | ✅ |
| 数据安全 | `.wtlog` 导出/独立校验/篡改检测/往返；`.wtzip` 全量包导出→校验→恢复→重复「跳过 2」→截断包可读报错；备份目录自动备份/启动补齐/未配置零副作用；灾备闭环；失败路径数据零丢失；权限健康/重新授权；训练导出 | ✅ |
| 多标签/移动端/异常 | 第二标签页只读；390×844 无横向溢出；无未捕获异常 | ✅ |

Web 上 v0.2.1 新增的后端抽象是否影响 FSA：**未回退**——`createNativeBackupBridge()` 在 Web 返回 null，设置面板仍显示 FSA 文案（不含「手机目录」「选择手机上的文件夹」），32 步全部通过。

## 五、构建/命令与证据

```powershell
npm run build      # ✅ v0.2.1（index-CYdo_zdc.js 298082B / index-CPkTd3_W.css 18043B）
npm run typecheck  # ✅
npm test           # ✅ 19 files / 117 tests
npm run e2e                                   # ✅ Chrome 32/32
$env:E2E_CHANNEL='msedge'; npm run e2e          # ✅ Edge 32/32

# Android 静态检查（aapt2 + fflate 解包）
$sdk\build-tools\36.1.0\aapt2.exe dump badging .lead-tmp\WriterTools-v0.2.1-android-debug.apk
# Android 运行时（独立 AVD，emulator-5558）
adb -s emulator-5558 install -r .lead-tmp\WriterTools-v0.2.1-android-debug.apk
# WebView CDP：adb forward tcp:9224 localabstract:webview_devtools_remote_<pid>
# SAF picker：adb shell uiautomator dump / adb shell input tap|swipe
```

证据（`tests/e2e/artifacts/`，gitignore）：

- `android-acceptance-summary.json`（结构化验收记录）、`android-apk-static.json`、`apk-badging.txt`、`apk-sha256.txt`；
- `android-20-fixed-home.png`、`android-21-native-data-loss-home.png`、`android-22-native-restore-result.png`、`android-23-native-restored-library.png`、`android-24-native-restart-home.png`、`android-25-native-restart-settings.png`、`android-26-legacy-txt-restore.png`；
- `manifest-after-first-backup.json`（511B）、`manifest-after-auto-backup.json`（512B，chars 30/lastSeq 12）、`manifest-after-manual-backups.json`（lastSeq 14）、`backup-after-first.wtlog`（3344B，`wtlog-check` OK）、`status-after-restart.txt`；
- Web：`e2e-chrome.log`（32/32）、截图若干；Android 11 次级证据 `android-10…17-*.png`。

**版本说明**：Web 导出 `.wtlog` / manifest / 训练摘要 `app.version=0.2.1`，`format=1.0`；APK versionName 0.2.1（versionCode 201）。

## 六、需人工验证 / 剩余风险

1. **真实物理手机**：本次为 Android 16 / Android 11 模拟器（Google 系统镜像 provider）。真机上不同厂商 DocumentsProvider（三星 My Files、Google Files、第三方文件管理器）的 `createFile/renameDocument` 行为可能不同，建议在至少 2 台真机复验"新目录精确文件名 + 旧 `.txt` 目录恢复"。
2. **SAF 权限生命周期**：本次以"删除 WebView 数据、保留 shared_prefs"模拟本地数据丢失（SAF 授权仍在）；真实 `pm clear`/卸载重装/系统撤销授权后需要重新选目录，本环境自动化 DocumentsUI 点击受限，未完成"清数据后手动重选同一目录→恢复"完整链路（Lead 已在 Medium_Phone 做过类似人工验证，可合并引用）。
3. **系统 picker 取消/异常**：取消选择、目录被删除、SD 卡移除、存储满、provider 读写失败的错误路径未逐一在 APK 上验证（引擎单测已覆盖 bridge 失败可读错误）。
4. **重复文件清理**：修复版不再产生 `.txt/(1)(2)`；但旧版本已在用户目录留下的 `.txt` 重复副本不会自动删除（读取已兼容、去重逻辑保证恢复可用）。是否提供清理建议需产品确认。
5. **`readFiles` 上限/大目录**：插件对文件数量/大小有上限（代码常量），超大目录（数百作品/超大 `.wtlog`）的读取耗时与上限行为建议压测。
6. **App 升级/重装**：覆盖安装保留 shared_prefs+SAF 授权已验证；卸载重装会丢授权需重选（预期，需 UI 引导文案确认）。
7. **Web 备份目录/FSA**：原有真实磁盘 FSA、清站点数据灾备等人工项继续保留（历史报告）。
8. **WebView 版本矩阵**：Android 11（Chrome 83 WebView）与 Android 16 均跑通主链路；更低版本（minSdk 24 设备）的 WebView 能力建议抽查。

## 七、本次改动范围

- Lead/engine/UI：备份后端抽象（FSA + native）、`BackupFolderPlugin` SAF 实现与本次 `.txt` 文件名修复（`ensureFile/renameDocument/normalizeBackupName`）、原生备份设置面板提示、Android 工程/APK 构建、README/USER-GUIDE。
- QA（task-29）：Web Chrome/Edge 全量回归 32/32；Android APK 静态检查 + 独立 Android 16 AVD 运行时验收（SAF 选目录/首次备份/自动备份/覆盖写/本地数据丢失恢复/重启持久授权/旧 `.txt` 兼容）+ Android 11 次级验证；本报告与 `tests/e2e/README.md` Android 验收说明。**未修改 `src/` 与 Android 工程代码**。
- 本报告不修改 `src/`；验收中发现的问题已反馈 Lead（含修复版 SHA-256 与验证结果）。
