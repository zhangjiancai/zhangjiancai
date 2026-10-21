# 训练数据导出说明（WriterTools → JSONL）

> 用途：把 WriterTools 的逐字符日志（`.wtlog` / `.wtzip` / 备份目录）转换成便于训练"个人写作分身"或做行为分析的 JSONL。
> 原则：**不丢信息**。日志格式（[FILE-FORMAT.md](FILE-FORMAT.md)）里的事件全部保留语义；未来新增的事件类型（`x.*`）也会原样带出，不会因为工具没更新而丢数据。

## 1. 快速使用

工具：`tools/wtlog-to-training.mjs`（纯 Node，不依赖浏览器）。

```powershell
# 单个作品
npm run export:training -- 我的作品.wtlog --out training.jsonl --summary summary.json

# 整个备份目录（递归扫描 .wtlog / .wtzip）
npm run export:training -- D:\WriterBackup --out all-training.jsonl

# 全量备份包
npm run export:training -- writertools-backup-20261021-0102.wtzip --out training.jsonl

# 带上完整原始事件（数据量约翻倍，适合要自己重新解析的场合）
npm run export:training -- 作品.wtlog --out training.jsonl --with-raw

# 工具自检（用仓库里的金标准文件）
npm run export:training -- --self-test
```

- 默认每个日志会先经**独立格式校验器**（`tools/wtlog-check.mjs`）校验，不合规的文件会被跳过并报错（可用 `--no-validate` 强制转换）。
- 不给 `--out` 时输出到 stdout；摘要默认打印到 stderr。
- 退出码：`0` 成功；`1` 有无效输入；`2` 用法错误。

## 2. 输出格式（训练 JSONL，schema v1）

每行一个 JSON 对象，对应日志中的一个事件，按作品、按 `seq` 顺序排列。

公共字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `v` | 整数 | 训练导出 schema 版本，当前为 `1` |
| `label` | 字符串 | 来源（文件路径，或 `备份包::包内条目`） |
| `docId` | 字符串 | 作品 ID（跨文件稳定） |
| `title` | 字符串 | 该事件发生时作品标题（`doc.title` 之前的初始标题/更新后标题） |
| `seq` | 整数 | 日志内序号（从 0 连续递增） |
| `ts` | 字符串 | UTC 毫秒时间戳（`2026-10-20T15:32:02.200Z`） |
| `type` | 字符串 | 原始事件类型 |
| `affects` | `"text"` / `"meta"` | 是否改变正文 |

按事件类型的额外字段：

| type | 额外字段 | 说明 |
| --- | --- | --- |
| `doc.init` | `createdAt`、`app`、`settings` | 作品创建信息；`docId`/`title` 已在公共字段 |
| `text.insert` | `op:"insert"`、`pos`、`text`、`source`、`inputType`? | 插入；`pos` 为 UTF-16 码元偏移 |
| `text.delete` | `op:"delete"`、`pos`、`length`、`deleted`、`source`、`direction`?、`inputType`? | **被删原文在 `deleted`**，可直接训练"删了什么/在哪删" |
| `text.replace` | `op:"replace"`、`pos`、`length`、`deleted`、`text`、`source`、`inputType`? | 替换（含输入法上屏、粘贴覆盖、撤销结果等） |
| `text.reset` | `op:"reset"`、`text`、`reason`?、`targetSeq`? | 全文重置（版本恢复/导入/抢救） |
| `compose.start/update/end` | `phase`、`data`（原始预编辑串，如拼音）、`from`/`to`?、`committed`?、`candidate`? | 输入法原始过程（若用户在设置中开启记录） |
| `selection.set` | `from`、`to`、`direction`?、`reason`? | 光标/选区 |
| `editor.mode` | `mode` | `typewriter` / `centered` |
| `doc.title` | `newTitle` | 标题变更 |
| `snapshot` | `reason`、`message`?、`chars`、`textHash`、`eventsSince`? | **不重复输出全文**（快照文本可由前序事件重放得到），只保留校验/统计信息 |
| `session.start` / `session.end` | `sessionId`、`startedAt`/`endedAt`、`device`?、`editorMode`? | 写作场次，适合切分"一次写作" |
| `doc.trash` / `doc.untrash` | `reason`? | 回收站状态 |
| `app.checkpoint` | `anchor`、`target` | 外部锚点记录 |
| 未知/扩展事件（`x.*` 或未来类型） | `data`（原样） | 保证未来信息不丢 |

`--with-raw` 会为每行额外带上完整原始事件 `raw`（含 `prev`/`hash`/未知字段），适合需要自定义解析或审计的场合。

## 3. 语义与使用提示

- **坐标是 UTF-16 码元偏移**（JavaScript 字符串下标）；`"😀"` 占 2。跨语言训练时如需 Unicode 码点坐标，请自行按字符串转换。
- **时间线**：`ts` 是写作事件真实发生时间；配合 `session.start/end` 可以还原"一次坐了多久、什么时候写、什么时候删"。
- **删除即数据**：`text.delete` / `text.replace` 的 `deleted` 是这一段被删文字的全部内容；配合 `pos` 可精确还原编辑轨迹。
- **输入法**：`compose.*` 的 `data` 是浏览器 CompositionEvent 的原始预编辑串（中文场景通常是拼音串，受系统输入法影响）。它不等于最终上屏文字；上屏文字看 `text.insert/replace` 的 `source:"ime"`。
- **不是按键级数据**：当前只记录文本事件与输入法组合过程，不记录每个 keydown/keyup 与按键间隔。未来若新增 `x.input.key` 之类事件，本工具会把它归到"未知事件"并原样保留（不会丢）。
- **快照全文**：`snapshot` 事件在日志里保存了当时全文，但本工具不重复输出（避免训练数据膨胀）；需要某个时间点全文时，按 `seq` 重放 `text.*` 事件即可，或直接用 `tools/wtlog-check.mjs --text <文件>` 得到最终正文。

## 4. 隐私与安全

日志是**明文**（目前无加密）。其中包含你的完整写作过程、删除内容，以及开启记录时的输入法拼音。请像对待日记一样对待导出的训练数据：
- 不要把原始日志/训练数据提交到公共仓库或上传到不可信服务；
- 云端同步/加密属于后续版本能力（见路线图）。

## 5. 与格式演进的关系

训练导出格式本身也遵循"只增不删"：后续版本只会新增字段/事件类型；已输出的 `v:1` 记录字段不会删除或改变语义。如果你在训练管线里做了字段依赖，建议忽略未知字段而不是报错。

## 6. 相关工具

| 工具 | 用途 |
| --- | --- |
| `tools/wtlog-check.mjs` | 独立校验 `.wtlog`（哈希链/快照/重放），也可 `--text` 输出最终正文 |
| `tools/wtzip-check.mjs` | 独立校验 `.wtzip` 全量备份包（manifest 锚点 + 每个日志） |
| `tools/wtlog-to-training.mjs` | 本工具：日志 → 训练 JSONL |
