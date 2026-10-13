# App Analyzer（应用分析器）

一个 Android 上的**应用存储分析**工具：枚举设备上已安装的应用，读取每个应用真实占用的
体积（应用本体 / 缓存 / 数据），做统计与图表，并可选调用 DeepSeek API 自动为应用分类。

> 本文档描述的是**当前代码实际能做的事情**。之前的版本列了一张很漂亮的功能清单
> （文件分类统计、大文件识别、存储健康度评分、AI 分析页、饼图/环形图、ViewModel 架构……），
> 那些**在代码里都不存在**。现在按实际实现重写。

---

> **版本 1.1.0** · 最近更新：2026-10-14
>
> **还没上传到 GitHub。** 原因不是网络（实测 github.com 现在可以访问），
> 而是这台机器上**没有你的任何 GitHub 凭据**：没装 `gh` CLI、没有 git-credential-manager、
> `~/.ssh` 下没有密钥，全局 git 身份指向的是企业微信的 `git.weixin.qq.com`。
>
> 准备推送时执行（把两个占位符换成你的）：
>
> ```powershell
> cd D:\zjc20\Documents\android-app-analyzer
> git remote add origin https://github.com/你的用户名/仓库名.git
> git push -u origin master
> ```
>
> 会弹窗要求登录 GitHub（用 Personal Access Token 当密码）。推完记得 `git remote -v` 确认。
>
> **推之前我已经确认过**：仓库里没有 `local.properties`、没有构建产物、没有 APK、
> 没有模型文件、没有密钥库，全文搜索也找不到任何 `sk-` 开头的 key。

---

## 需求 → 完成情况

这一节只写**你的原始要求**和**实际做到什么程度**，不修饰。

| # | 你的要求 | 状态 | 说明 |
|---|---|---|---|
| 1 | 白线勾勒风格（适合纯黑壁纸） | ✅ 完成 | Canny 全流程：高斯去噪 → 逐通道 Sobel → 非极大值抑制细线 → 双阈值+滞后连接 → 黑底白线 |
| 2 | 拟物化风格（图生图） | ⚠️ 本地近似 | 高光+浮雕+内阴影做出立体感，**但这不是生成出来的材质**。真正的拟物化需要生成模型，端侧没有，只能走云端 API |
| 3 | 极简主义（纯色块组合） | ✅ 完成 | k-means 量化 + **众数滤波**清碎块（只量化会留下马赛克，不像色块） |
| 4 | 自定义风格（用户手动定义） | ✅ 完成 | 用户给风格图，**在设备上训练一个小模型**（17³ 颜色查找表，约 1.5 万参数） |
| 5 | 风格迁移要「本地训练一个小模型」 | ✅ 完成 | 见下方「本地训练的小模型」一节 |
| 6 | 模型按需下载，用户选哪个下哪个 | ✅ 完成 | 4 个模型，实测下载/校验/推理全通 |
| 7 | 说明本地模型能做什么、为什么生不出图 | ✅ 完成 | 见「端侧模型到底能做什么」一节 |
| 8 | 版本号写好 | ✅ 完成 | 1.0.0 → **1.1.0**（versionCode 110），规则写在 `app/build.gradle` 注释里 |
| 9 | README 写好 | ✅ 完成 | 就是本文 |
| 10 | 上传 GitHub | ❌ 未完成 | 缺凭据，见上方说明 |

### 还没做到的（不藏）

- **拟物化只是近似**，不是真的图像生成。
- **端侧生成模型不存在**：魔搭上 AnimeGAN / CartoonGAN / AdaIN / fast-neural-style / Photo2Cartoon 等 30 多个候选全部 404，扩散模型又是几百 MB 起步。要「用文字生成图标」只能走云端 API。
- **抠图模型对图标效果差**：实测 MODNet 在图标上的掩码 100% 全不透明，等于没抠（它是人像模型）。更合适的 U2Net（167.8 MB）还没做效果验证。
- **四类风格只在单元测试层面验证过**，真机批量跑图的效果我还没看过。

---

## 一句话说清它做什么

打开 → 拿到「使用情况访问」权限 → 看到 258 个应用各自占了多少空间，谁最占地方，
缓存都堆在哪几个应用上。

---

## 功能清单（均有对应实现）

| 功能 | 实现位置 |
|---|---|
| 枚举所有已安装应用 | `service/AppInfoService.kt` `getAllInstalledApps()` |
| 读取真实体积（应用/缓存/数据） | `AppInfoService.measureAppSizes()`，数据来自 `StorageStatsManager` |
| 搜索 / 按大小/名称/分类排序 | `ui/screens/AppListScreen.kt` |
| 汇总统计（总数、总占用、均值、极值） | `service/AnalysisService.kt` |
| 体积分布直方图 | `StatisticsScreen.kt` 内的 Canvas |
| 排行榜横向柱状图 | `ChartScreen.kt` `BarChartView()` |
| L 型折线图 + 面积填充 | `ChartScreen.kt` `LCurveChart()` |
| 应用分类（本地启发式） | `AppInfoService.smartClassify()`，包名/应用名/权限加权评分 |
| 应用分类（AI，可选） | `DeepSeekService.classifyWithCustomTags()` |
| 图标生成 · 云端 API | `service/imagegen/` —— 通义万相 / 豆包 SeedEdit / Gemini / OpenAI |
| 图标生成 · 本地风格迁移 | `service/image/StyleTransfer.kt`（风格参考图 + 原图标 → 新图标） |
| 图标生成 · 端侧模型 | `service/localmodel/`（ONNX Runtime，模型按需下载） |
| 风格参考图库 | `service/image/StyleLibrary.kt`（相册导入 + 内置参考图） |
| 导出图标包（给启动器用） | `service/IconPackExporter.kt` + `:iconpack` Gradle 模块 |
| 文件日志 + 自动轮转 | `service/DebugLogger.kt` |

---

## 关键设计：数据诚实性

这个应用最容易犯的错误是**在拿不到数据时编一个数出来**。当前实现对此有硬约束：

### 1. 没有权限就显示「—」

`StorageStatsManager` 需要「使用情况访问」（PACKAGE_USAGE_STATS）权限。
没有它，系统根本不允许读取其他应用的数据目录。

- 老实现：拿不到就读 `File(dataDir)` → 必然失败返回 0 → 于是用
  `apkSize * 0.2` 当缓存、`apkSize * 1.0` 当数据"估算"出来，并当成测量值展示。
  实测在 258 个应用的模拟器上，未授权时统计页显示 **8.0 GB**，而真实值是 **2.9 GB** ——
  虚高 2.76 倍，用户完全无从分辨。
- 现实现：读不到就是读不到。`AppInfo.hasSizeDetail=false`，
  UI 统一显示 `—`（`ui/util/FormatUtil.kt` 的 `UNKNOWN_SIZE`），并提示需要授权。

### 2. 缓存不会被算两遍

Android 官方文档（`StorageStats.getDataBytes()`）明确写明：

> Return the size of all data. This includes files stored under
> `Context.getDataDir()`, **`Context.getCacheDir()`**, `Context.getCodeCacheDir()`.

也就是说 **dataBytes 已经包含 cacheBytes**。老实现做 `appSize + dataSize + cacheSize`
求和，把缓存重复计算了一次。现在 `dataSize = dataBytes - cacheBytes`，
三个字段互不重叠。

### 3. 应用体积用 APK 文件的直接 stat 值，**不用** `appBytes`

这里走过一次弯路，值得记下来：一度以为 `StorageStats.getAppBytes()`（= APK + native 库 +
dexopt 产物）比直接读 APK 文件更准确，就换了过去。结果实测发现它**只统计默认卷（/data）
上的代码，不包含预装在只读分区（/product）上的 APK**：

| 应用 | APK 真实大小 | 用 `appBytes` 后显示 |
|---|---|---|
| Photos | 168.4 MB | 排不进前 11（< 6.5 MB） |
| Gmail | 174.0 MB | 同上 |
| YouTube | 139.0 MB | 同上 |
| Google Play services | 190.2 MB | 52.2 MB |

所有系统应用体积集体缩水，应用本体总和从真实的 **2.68 GB** 掉到 **0.2 GB**。
所以现在用 `File(sourceDir).length()`（含 split APK）—— 直接读文件大小，与分区无关，永远是真值。

---

## 权限

| 权限 | 用途 | 获取方式 |
|---|---|---|
| `QUERY_ALL_PACKAGES` | 列出全部已安装应用 | 自动授予（注意：Google Play 对此权限有额外审核要求） |
| `PACKAGE_USAGE_STATS` | 读取各应用缓存/数据大小 | **用户在 系统设置 → 使用情况访问 中手动开启** |
| `INTERNET` | 调用 DeepSeek API（可选功能） | 自动授予 |

授权后返回应用会**自动重新加载**（`MainScreen.kt` 里的 `ON_RESUME` 监听），
不需要手动点刷新。

---

## AI 分类（可选）

在「设置」里填入 DeepSeek API Key 后可用。流程是**两步**：

1. 把应用名样本发给模型，让**模型自己定义 10–20 个分类标签**；
2. 再分批（每批 50 个）把应用名发给模型，让它按第一步的标签输出 `名称|标签`。

结果按 **应用显示名** 匹配（AI 只拿得到应用名），所以**同名应用共享同一个分类**。
分类结果按 `MD5(排序后的包名列表)` 缓存，应用列表没变化就不会重复调用 API。

### 🔐 关于 API Key

**API Key 只保存在本机 SharedPreferences 里，不会被打包进 APK。**

早期版本用 `buildConfigField` 把 `local.properties` 里的密钥编译进了
`BuildConfig.DEEPSEEK_API_KEY` —— 那等于把密钥随 APK 一起发出去，反编译即可读取。
该路径已完全删除。**如果你用过那个版本并分发过 APK，请到 DeepSeek 控制台吊销重建密钥。**

另外，客户端直连第三方 API 本身就无法真正保护密钥。如果这个应用要给他人使用，
正确做法是自建一个后端做代理，而不是把密钥放进客户端。

---

## 图标生成（图生图）

「图标」页做的是**图生图**：输入是「原图标 + 应用名 + 你填的特征描述 + 选中的风格」，
输出是一张新图标。可以批量生成，再导出一整套图标包给启动器用。

### 生成引擎

引擎是可插拔的，在页面上点「更换」切换。每家的 Key 各存各的，换服务商不用重填。

| 引擎 | 说明 | 是否需要 Key |
|---|---|---|
| 阿里云百炼 · 通义万相 | `wanx2.1-imageedit`，走 `description_edit` 指令编辑 | 是 |
| 火山引擎方舟 · 豆包 SeedEdit | `doubao-seededit-3-0-i2i-250628` | 是 |
| Google Gemini | `gemini-2.5-flash-image` | 是 |
| OpenAI | `gpt-image-1`，走 `/v1/images/edits` | 是 |
| 本地图像算法 | 对**原图标**做像素级处理，**不联网、零成本** | 否 |

**DeepSeek 没有生图接口**（只有 deepseek-chat / deepseek-reasoner 两个纯文本模型），
所以图标生成用的是上面这些服务，和「AI 分类」用的 DeepSeek Key 是两回事。

所有服务商都是**直接传 Base64 图片**（`data:image/png;base64,...`），不需要把图片先传到
某个公网地址 —— 通义万相的 `base_image_url` 字段官方说明就是「URL 或 Base64 编码数据」。
输入图统一用 512×512（万相要求输入分辨率在 512~4096 之间），输出统一归一化到 192×192。

### 输入输出约定（这一节是重点）

| 引擎 | 输入 | 输出 |
|---|---|---|
| **本地风格迁移** | **风格参考图 + 原图标** | 新图标 |
| **API / 端侧模型** | **文字 + 可选风格参考图 + 原图标** | 新图标 |

**本地风格迁移**由**用户提供的风格参考图**决定风格，不是写死几个预设。
用户从相册导入任意一张图当作风格基准，之后所有图标都按这张图的风格迁移。
内置另外提供了 6 张程序生成的参考图，保证没导入图片时也能直接开箱使用。

算法是经典的 **Reinhard 色彩迁移**（Reinhard et al., "Color Transfer between Images", 2001）：
把原图标和风格图都转到 **lαβ 空间**（该色彩空间就是为色彩迁移设计的，三通道相关性最低），
再逐通道做

```
out = (src − μ_src) × (σ_ref / σ_src) + μ_ref
```

结果是**结构 100% 来自原图标、色彩统计 100% 来自风格图**。另有两种模式：

- **调色板**：从风格图 k-means 求 6 个主色，把图标吸附上去，出色块感
- **渐变映射**：把风格图主色按亮度排成渐变带，用图标亮度查表

还有一个**强度**滑块（0~1）在「原图」和「迁移结果」之间线性混合。

### 四类本地风格

风格不是几张写死的预设图，而是四类**做法完全不同**的算法。全部在 `service/image/LocalStyleRenderer.kt`，
纯像素运算，不依赖 GPU / RenderScript，可以脱离 Android 直接跑单元测试。

| 风格 | 算法 | 说明 |
|---|---|---|
| **白线勾勒** | Canny 全流程 | 高斯去噪 → **逐通道** Sobel → 非极大值抑制把线细到 1px → Otsu 自适应双阈值 + 滞后连接 → 黑底白线 |
| **拟物化** | 光照模拟 | 提饱和 → 方向性差分求浮雕当法线 → 左上打光 → 上方叠高光（screen）→ 底部压暗做内阴影 |
| **极简色块** | 量化 + 众数滤波 | k-means 求 N 个主色 → 吸附 → **3x3 众数滤波清掉碎块** |
| **自定义** | 本地训练的小模型 | 用户给风格图，在设备上训练一个 17³ 颜色查找表 |

两个细节值得说：

1. **白线勾勒的梯度算在 RGB 三个通道上，不是只算灰度**。应用图标经常出现
   「亮度相同但颜色不同」的边界（红块挨着绿块），只算灰度会把这类边界整条丢掉。
2. **极简色块的第三步不能省**。只做量化会留下大量 1~2 像素的噪点，看起来是马赛克而不是色块；
   众数滤波把小块并进周围大块，才得到干净的纯色块拼合。

### 本地训练的小模型（自定义风格）

这一条是重点：**自定义风格不是套公式，而是在用户手机上真的训练一个模型出来。**

**模型**：一张 17×17×17 的三维颜色查找表（4913 个格点、14739 个参数）加三线性插值。
它把「任意输入颜色」映射成「风格化后的颜色」。

**训练**：梯度下降 + Adam + 余弦退火。目标函数是让变换后的内容在 lαβ 空间里的
**均值、标准差、以及 5 个分位数**（10/25/50/75/90%）都逼近风格图的对应统计量。
因为模型是非线性的，它能表达解析公式做不到的映射。

**为什么训练代价很小**：三线性插值对参数的梯度就是那 8 个角的插值权重，反向传播只有几行；
每次迭代只在一张降采样到约 2500 像素的图上前向。实测几百次迭代一秒左右完成。

**训练数据是整个 RGB 色立方，不是某一个图标** —— 这是关键设计。
喂均匀采样的色立方（16³ 格点，灰阶轴额外加权），学出来的查找表是一个完整的
「任意颜色 → 风格化颜色」映射，于是**一张风格图只需要训练一次，之后所有图标直接套用**。
训练结果按「风格图内容哈希」缓存到磁盘，换一张图才会重训。

#### 收敛速度：一个必须解决的坑

从恒等映射直接开始训练，慢得没法用。实测（同一份数据、纯灰阶风格）：

| 迭代次数 | β 通道标准差（越小越灰） |
|---|---|
| 300 | 0.045 |
| 1500 | 0.022 |
| 5000 | 0.011 |

而且把学习率从 0.02 提到 0.30 **几乎没有变化** —— 说明瓶颈在收敛路径的长度，不在步长。
β 标准差 0.03 在 lαβ 里已经对应约 70 的 RGB 通道差，肉眼可见；要压到无感需要几万次迭代，手机上不可接受。

**解法是热启动**：先用解析法（逐通道矩匹配）把每个格点直接算出来，再让梯度下降只做精修。
因为风格图是灰阶时 σ_α 与 σ_β 都是 0，这一步能把彩度一次性归零：

| 迭代次数 | 直接训练 | 热启动后 |
|---|---|---|
| 300 | 0.0453 | **0.00206** |
| 1500 | 0.0218 | 0.00147 |
| 5000 | 0.0107 | 0.00089 |

300 次迭代好了 **22 倍**，loss 从 0.00715 降到 0.00081。

#### 实测结果

用纯灰阶风格图训练（其 α=β=0，输出必须去色）：

| 指标 | 风格图 | 训练后的输出 |
|---|---|---|
| l 均值 | -0.7755 | -0.7852 |
| l 标准差 | 0.7961 | 0.8073 |
| α 均值 / 标准差 | 0.0008 / 0.0001 | -0.0001 / 0.0022 |
| β 均值 / 标准差 | 0.0001 / 0.0000 | 0.0003 / 0.0019 |
| 平均彩度（RGB 通道差） | 0 | **3.27** |

统计量全部收敛到 0.02 以内，平均彩度 3.27 肉眼不可见。
最大彩度 57 出现在 **2.29%** 的像素上 —— 那是训练微调明度时三通道步长不完全一致留下的偏色，
属于已知残差。测试按「平均彩度 + 超标像素占比」两个指标卡，没有假装它是 0。

### 一个曾经很隐蔽的坑：透明像素污染统计量

（这段保留，因为它是上一版解析式迁移里最花时间才找到的 bug，教训现在仍然成立。）

应用图标有大量**全透明**像素（实测 Google 图标占 **21.5%**），它们的 RGB 是 (0,0,0)，
经 log10 变换后 l 会掉到 **-6.9** 这种极端值。第一版实现把这 21.5% 也算进统计量，
把亮度标准差从真实的 **0.248 撑到 2.790（11 倍）**。而迁移公式里 σ_src 在分母上，
σ 虚高 11 倍 → 输出层次被压缩到 **1/11** → 图标塌成一块纯色（实测 55% 的像素变成同一个颜色）。

**现在的做法**：统计量只算不透明像素（alpha ≥ 8）；透明像素原样保留；
log10 输入下限从 1e-4 改成 1/255。四类风格和 k-means 取主色都遵守这条规则。

### 提示词是怎么拼的



`ImageGenService.buildPrompt()` 把三段拼在一起：

1. 应用名：「这是手机应用「微信」的图标。」
2. 风格指令：`IconStyle.editInstruction`（8 种风格各一句，就是页面选的那个）
3. 通用约束：正方形构图、不要文字、不要边框、小尺寸下要清晰
4. 用户填的特征：`额外要求：圆角方形底、保留品牌主色…`

超过服务商上限（万相 800 字）会自动截断，截断时保留开头和结尾 —— 结尾是用户填的最具体的
那句，不能被丢掉。

> `IconStyle.editInstruction` 这个字段在早期版本里叫 `promptTemplate`，内容是
> 「为{name}设计霓虹风格图标…」，但**全项目没有任何一行代码引用它**，纯粹是摆设。
> 现在它由 `ImageGenService` 真实消费。

---

## 导出图标包（批量替换桌面图标）

### 先说清楚能做到什么

Android **不允许**一个普通应用直接修改其他应用的图标 —— 那需要系统签名或 root。
所以「批量替换」的现实做法是导出一个**图标包（icon pack）**，由支持图标包的启动器统一应用。

**支持图标包的启动器**：Nova、Smart Launcher、ADW、Lawnchair、Apex、GO 等。
**不支持**：Pixel 原生启动器（装上了也选不了）。

### 流程

1. 手机端：「图标」页 → 选风格 → 填特征 → 批量生成 → 点「导出图标包」
   → 在 **下载/AppAnalyzerIconPack/** 得到一个 ZIP
2. 电脑端：把 ZIP 解压到 `iconpack/src/main/generated/`（解压后该目录下应直接出现
   `assets/` 和 `res/` 两个文件夹）
3. 电脑端：`gradlew :iconpack:assembleDebug`
   → `iconpack/build/outputs/apk/debug/iconpack-debug.apk`
4. 装到手机，在启动器的「图标包 / 主题」设置里选中它

### ZIP 里有什么

| 文件 | 用途 |
|---|---|
| `assets/appfilter.xml` | **启动器真正读的那份**：组件名 → 图标资源名 的映射 |
| `res/xml/appfilter.xml` | 同样的内容，给读 res 的图标包面板用 |
| `assets/drawable.xml`、`res/xml/drawable.xml` | 图标清单 |
| `res/drawable-xxhdpi/ic_<包名>.png` | 192×192 的图标 |
| `meta.json`、`README.txt` | 元信息与操作说明 |

appfilter.xml 里每个图标会写**两条**映射（完整组件名 + `包名/.Activity` 缩写形式），
因为不同启动器对 ComponentInfo 的匹配方式不完全一致，两条都写能显著提高命中率。

图标包 APK 的 manifest 里声明了 `org.adw.launcher.THEMES` 等 5 个 intent-filter action，
这是启动器识别图标包的依据。

### 为什么要在电脑上打包

图标包 APK 需要 `res/drawable` 里的资源被 **aapt2 编译进 resources.arsc**，
而 Android 应用在运行时没有 aapt2，也无法凭空生成 resources.arsc。
所以手机负责生成图片和映射表，电脑用标准工具链打包 —— 这也是所有图标包作者的做法。

---

## 构建 APK

### 方式一：双击一键脚本（推荐）

直接双击项目根目录的 **`build-apk.bat`**。它会自动：

1. 找到 JDK —— 依次尝试已有的 `JAVA_HOME` → Android Studio 自带的 JBR
   （`C:\Program Files\Android\Android Studio\jbr`、`D:\...`、`%LOCALAPPDATA%\Programs\...`）
   → `C:\Program Files\Java\jdk-17`
2. 找到 Android SDK（`ANDROID_HOME` 或 `%LOCALAPPDATA%\Android\Sdk`）
3. 编译 `:app` 和 `:iconpack` 两个模块
4. 打印产物路径和安装命令

> ⚠️ **最常见的坑**：本机 PATH 里没有 `java`，`JAVA_HOME` 也没设。
> 这时直接双击 `gradlew.bat` 会立刻报
> `ERROR: JAVA_HOME is not set and no 'java' command could be found in your PATH`。
> 用 `build-apk.bat` 就不会有这个问题，它自己会去找 Android Studio 自带的 JDK。

### 配套脚本（只有这三个，各司其职）

| 脚本 | 作用 |
|---|---|
| `build-apk.bat` | **构建 APK**。自动定位 JDK 与 SDK，编译 `:app` + `:iconpack`，打印产物路径 |
| `run-app.ps1` | **构建并跑起来**：`-Run` 启动模拟器 → 编译 → 安装 → 启动应用；`-Build` 只编译；`-Stop` 停模拟器 |
| `open-studio.bat` | 用 Android Studio 打开本项目（路径取自脚本自身位置，项目移动也不会坏） |

> 早先还有 `一键构建.bat`、`check-env.bat`、`check-env.ps1`、`wait-and-build.ps1` 等，
> 要么只是转发、要么互相重复、要么硬编码了过时的 build-tools 版本，已经删掉了。

### 方式二：手动敲命令

```powershell
cd D:\zjc20\Documents\android-app-analyzer
$env:JAVA_HOME = 'D:\Program Files\Android\Android Studio\jbr'
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"

.\gradlew.bat assembleDebug :iconpack:assembleDebug
```

### 产物

| 模块 | 路径 | 说明 |
|---|---|---|
| 主程序 | `app/build/outputs/apk/debug/app-debug.apk` | **可直接安装**（用调试签名） |
| 图标包 | `iconpack/build/outputs/apk/debug/iconpack-debug.apk` | 需先导出图标再构建，否则只有占位图 |

### 安装到手机

手机打开「开发者选项 → USB 调试」，用数据线连电脑，然后：

```powershell
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
& $adb install -r app\build\outputs\apk\debug\app-debug.apk
```

也可以把 APK 直接拷到手机上点击安装（需要允许「安装未知来源应用」）。

调试时想省掉手动授权那一步（**仅限调试**）：

```powershell
& $adb shell appops set com.appanalyzer GET_USAGE_STATS allow
```

### 关于 release 包

`gradlew assembleRelease` 能跑通，但产物是 `app-release-unsigned.apk` ——
**未签名，装不上**。要发布需要自己在 `app/build.gradle` 里加 `signingConfigs`：

```groovy
android {
    signingConfigs {
        release {
            storeFile file("你的.keystore")
            storePassword "***"
            keyAlias "***"
            keyPassword "***"
        }
    }
    buildTypes {
        release { signingConfig signingConfigs.release }
    }
}
```

生成密钥库：`keytool -genkeypair -v -keystore my.keystore -alias appanalyzer -keyalg RSA -keysize 2048 -validity 10000`

> `app/proguard-rules.pro` 之前被 `build.gradle` 引用但**文件并不存在**，已补上。
> 目前 `minifyEnabled = false` 所以没暴露问题，一旦打开混淆就会直接构建失败。

---

## 项目结构

```
app/src/main/java/com/appanalyzer/
├── MainActivity.kt                      # 入口，只负责 setContent
├── data/model/
│   ├── AppInfo.kt                       # 应用信息（含 hasSizeDetail 标志）
│   ├── StatisticsInfo.kt                # 统计结果
│   └── DeepSeekModels.kt                # API 请求/响应模型
├── service/
│   ├── AppInfoService.kt                # 枚举应用 + 测量体积 + 本地分类 + AI 分类编排
│   ├── AnalysisService.kt               # 纯计算：统计与分布
│   ├── DeepSeekService.kt               # 两步式 AI 分类（文本模型）
│   ├── IconReplaceService.kt            # 图标风格定义 + 本地绘制引擎 + 结果落盘
│   ├── IconPackExporter.kt              # 导出图标包 ZIP（appfilter.xml + PNG）
│   ├── PreferencesManager.kt            # SharedPreferences + 各类缓存与设置
│   ├── DebugLogger.kt                   # 文件日志（2MB 轮转）
│   └── imagegen/
│       ├── ImageGenProvider.kt          # 生图服务商抽象 + 请求/结果模型 + 共享 HTTP 客户端
│       ├── RemoteProviders.kt           # 万相 / SeedEdit / Gemini / OpenAI 四个实现
│       └── ImageGenService.kt           # 拼提示词 + 调用 + 归一化 + 落盘
├── ../iconpack/                         # 独立 Gradle 模块：把导出的 ZIP 打成图标包 APK
└── ui/
    ├── screens/                         # 6 个页面 + 设置弹窗
    ├── components/                      # AppItem / StatItem / StatRow / StorageBar / StorageItem
    ├── icons/AppIcons.kt                # 自己实现的 Material 图标（见下）
    └── util/                            # 体积格式化（Locale.US，未知显示 —）
```

**没有 ViewModel，没有 Navigation-Compose。** 全部状态集中在 `MainScreen.kt` 里，
页面通过 `when(selectedTab)` 切换，服务对象由 `MainScreen` 创建后向下传递。
`build.gradle` 里仍声明着 `navigation-compose` 和 `lifecycle-viewmodel-compose`
但源码中零引用，属于可以清理的死依赖。

---

## 图标：为什么不用 material-icons-extended

官方依赖 `androidx.compose.material:material-icons-extended` 的 aar 有 **34 MB**，
它把两千多个图标每个都生成为一个 Kotlin 对象。而本项目 `minifyEnabled = false`，
R8 不会剔除未使用的类，于是整个库都被编进 dex。

实测（同一份代码，只切换这一个依赖，两次都 `clean` 后全量构建）：

| | APK 体积 | dex 原始体积 |
|---|---|---|
| 带 material-icons-extended | 16.30 MB | 57.0 MB |
| 已移除 | **9.71 MB** | 25.3 MB |
| | **减少 6.59 MB（-40.4%）** | |

现在项目用的图标分两部分：

1. **material-icons-core 里自带的**（随 material3 传递进来，体积很小，49 个常用图标）
   —— 直接用 `Icons.Default.Xxx`，例如 `Icons.Default.Settings`。
2. **core 里没有的** —— 放在 `ui/icons/AppIcons.kt`，用 `AppIcons.Xxx` 调用。

`AppIcons.kt` 里的 path 数据取自 Google 官方 24px SVG
（`fonts.gstatic.com/s/i/materialicons/<名字>/v<N>/24px.svg`），用脚本把 SVG path 指令
逐条翻译成 Compose 的 `PathBuilder` 调用，**没有手工描摹**。转换结果是逐点验证过的：
33 个图标、819 段路径，绝对坐标序列与官方 SVG 完全一致。

**要加新图标时**：

1. 先看 core 里有没有（`Icons.Default.Xxx`），有就直接用；
2. 没有就去 <https://fonts.google.com/icons> 找（风格选 Material Icons → Filled），
   把 24px SVG 里 `<path d="...">` 的指令照 `AppIcons.kt` 里的写法翻译过来。

## 端侧模型（按需下载）

### 先说清楚：本地模型现在**能做什么、不能做什么**

清单里一共 4 个模型，**没有一个是生成模型**：

| 模型 | 任务 | 输入 → 输出 |
|---|---|---|
| MODNet 量化版（6.3 MB） | 抠图 | 图片 → **一张掩码** |
| RMBG-1.4（42.3 MB） | 抠图 | 图片 → 掩码 |
| U2Net（167.8 MB） | 抠图 | 图片 → 掩码 |
| Swin2SR（20.5 MB） | 超分 | 图片 → **放大 2 倍的图片** |

**为什么生不出图**：抠图和超分都是**分析 / 变换**类模型 —— 它们把输入图变成掩码或放大图，
输出的像素信息全部来自输入。**生成**类模型（扩散、GAN）才会「画出」原本不存在的内容。
两者是完全不同的东西，装多少个抠图模型都变不出生成能力。

而生成类模型在端侧现实里拿不到：

- 魔搭上按 AnimeGANv2/v3、CartoonGAN、AdaIN、fast-neural-style、Photo2Cartoon、UGATIT、
  waifu2x、Real-CUGAN 等 **30 多个候选逐个找过，全部 404**；
- 那些只发布 `.pth / .pt` 权重（PyTorch），Android 上根本加载不了；
- 真正的扩散模型动辄几百 MB 到几 GB，手机上跑不动。

所以：**想「用文字生成全新图标」，只能走云端 API。端侧只能做抠图和超分。**
这一点在 UI 里也直接写出来了，没有藏着。

### 按需下载

**模型不打包进 APK，用户要用哪个才下哪个**，下完存在应用私有目录 `files/models/`，可以随时删掉。

内置清单（4 个，下载 URL 与文件大小**全部实测过**：HTTP 200 + 字节数一致）：

| 模型 | 大小 | 用途 | 许可证 |
|---|---|---|---|
| MODNet 量化版 | 6.3 MB | 抠图 | Apache-2.0 |
| Swin2SR | 20.5 MB | 超分 x2 | Apache-2.0（上游） |
| RMBG-1.4 量化版 | 42.3 MB | 抠图 | Bria 非商用 |
| U2Net | 167.8 MB | 通用显著性抠图 | Apache-2.0 |

下载走 `/api/v1/models/{ns}/{name}/repo?Revision=master&FilePath=...`（带 Content-Length，
能做真实进度条；`/models/.../resolve/...` 那种是 302 到 OSS 的 chunked 响应，拿不到总大小）。
下完先落 `.part` 再校验字节数、通过才改名，避免留下"看起来存在其实是半截"的模型文件。

### 实测结论与三个必须知道的限制

**1. 为什么模型源只能用魔搭。** 在你机器上实测：

| 站点 | 可达性 |
|---|---|
| huggingface.co / cdn-lfs.huggingface.co | ❌ 不可达（SSL 建连失败） |
| github.com / objects.githubusercontent.com | ❌ 不可达 |
| dl.google.com / tfhub.dev | ❌ 不可达 |
| **modelscope.cn（魔搭）** | ✅ 323 ms |
| **gitee.com** | ✅ 146 ms |

所有教程里默认的 HuggingFace / GitHub 直链在这台机器上一条都连不上。

**2. `onnxruntime-mobile` 不能加载标准 `.onnx`（实测踩坑）。**
用它加载会直接抛：

```
ORT_INVALID_ARGUMENT: ONNX format model is not supported in this build.
```

mobile 版只认官方 Python 工具转出来的 `.ort` 格式，而格式转换必须在电脑上做、手机端做不到。
所以「按需下载任意 .onnx 模型」只能配完整版 `onnxruntime-android`。
代价是原生库很大：**arm64-v8a 16.3 MB、x86_64 18.1 MB**（`.so` 不压缩）。
默认只打 arm64，APK 因此从 9.95 MB 变成 **26.11 MB**；要在 x86_64 模拟器上测就加 `-PwithX86`（44.2 MB）。

**不想要这个功能的话，把 `app/build.gradle` 里那一行 `onnxruntime-android` 删掉即可**，
体积会立刻回到 10 MB 左右，其余功能不受影响。

**3. 端侧没有可用的「图生图 / 风格迁移」模型。**
在魔搭上按 AnimeGAN、CartoonGAN、AdaIN、fast-neural-style、Photo2Cartoon、UGATIT 等
30 多个候选逐个试过，**全部 404（模型不存在）**。端侧现实可做的只有**抠图**和**超分**；
要"用文字生成新图标"只能走云端 API。

### 已验证到什么程度（不夸大）

| 环节 | 状态 |
|---|---|
| 模型下载（6.3 MB，MODNet 量化版） | ✅ 实测完整下载，落盘 6,632,188 字节与清单一致 |
| ONNX 会话建立 | ✅ 实测日志 `会话已建立：输入=[input] 输出个数=1`，与模型真实张量签名一致 |
| 推理执行 + 输出成图 | ✅ 实测产出 192×192 PNG，无异常 |
| **抠图效果** | ⚠️ **用 MODNet 时对图标无效** —— 掩码实测平均 alpha 255/255、100% 全不透明，等于没抠。MODNet 是人像抠图模型，本来就不适合 App 图标。真正合适的 U2Net（167.8 MB）已列入清单但未做效果验证 |
| 超分（Swin2SR） | ⚠️ 未实测（20.5 MB 未下载） |

> ⚠️ **移除依赖后必须 `gradlew clean`**。
> 我在实测中踩到过：只是删掉 build.gradle 里那一行再构建，AGP 的增量 dex 合并会把旧产物
> 留在 APK 里 —— 未压缩 dex 确实从 44 MB 降到了 25 MB，但 APK 体积纹丝不动（17.07 MB），
> 里面藏着约 6.9 MB 的死数据。`clean` 之后才真正降到 9.71 MB。

---

## 性能：两个曾经很致命的坑

### 1. 属性访问器里做文件系统 IO

`IconReplaceService` 里原本是：

```kotlin
private val storageDir: File
    get() = File(context.getExternalFilesDir("icons") ?: context.filesDir, "generated").also { it.mkdirs() }
```

`get()` 属性**每次读取**都要执行一遍 `getExternalFilesDir()`（过一次 StorageManager）
外加一次 `mkdirs()`。图标页要给全部 258 个应用回填生成结果，就是 500 多次文件系统调用 ——
实测**光这一项吃掉 11 秒**。

改成 `by lazy` 只做一次，并且把「逐个 File.exists()」换成「列一次目录拿集合」，
同一操作 **11003 ms → 115 ms**。

### 2. 进入页面时给前 50 个应用各做一次 512px 图标流水线

取图标 → 缩放 512×512 → PNG 压缩 → 写盘 → Base64，一个大概几十毫秒，50 个就是好几秒，
而且每次切到这个页面都重来一遍。

现在：列表只建轻量条目（**258 个耗时 7~11 ms**），缩略图由每行按需懒加载（64px），
512px 原图**只在真正点「生成」时才取**并缓存到磁盘。

> 这也是原来「图标只有前 50 个」的原因 —— 上限本来就是被这个开销逼出来的。开销没了，上限也就去掉了。

另外 `DebugLogger` 的文件写入也从主线程挪到了单独的写线程（每写一行 open/close 一次文件，
而日志调用点大量在主线程上）。

---

## 已知限制

- **旋转屏幕会丢失全部状态**（筛选、排序、图表选项），因为用的是 `remember` 而非 `rememberSaveable`。
- **切换 Tab 也会重置页面内的筛选/排序状态**（`when` 分支会销毁重建 Composable）。
- **文本全部硬编码在代码里**，没有走 `stringResource`。`res/values/strings.xml` 里的
  40 多条字符串目前是零引用。
- **不扫描设备文件系统**：「存储」页只汇总应用占用，不做照片/视频/大文件分类。
- **不统计设备总容量/剩余空间**（需要 `MANAGE_EXTERNAL_STORAGE` 或 `StorageStatsManager`
  的卷级接口，目前未接入）。
- **AI 分类最多发送 200 个应用名样本**用于生成标签，超出部分不参与标签定义（但仍参与分类）。
- **图标生成的远程服务商未经端到端实测**：四个 provider 都是严格按各自官方文档实现的，
  端点用无凭据请求验证过（返回 401/403 而不是 404，说明路径正确），通义万相的请求体也已在
  设备上实际发出并收到服务端 `401 InvalidApiKey`（说明 URL、鉴权头与 JSON 结构都能被正确解析），
  但**没有可用的 Key 完成一次真实的出图**。第一次配好 Key 后建议先对单个应用点一次生成，
  失败时应用会把 HTTP 状态码和**服务端原始响应**直接显示在列表项下面，照着一改即可。
- **图标包依赖启动器支持**：Pixel 原生启动器不支持第三方图标包。
- **批量替换不是「直接改系统图标」**：Android 不提供这种能力，只能通过图标包由启动器应用。

---

## 许可

MIT
