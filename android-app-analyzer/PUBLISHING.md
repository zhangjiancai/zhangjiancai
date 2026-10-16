# 发布上架指南（国内应用市场）

> 面向「应用分析器 App Analyzer」v1.2.0
> 本文把「上架要什么、哪些已经做好了、哪些必须你去办」讲清楚。

---

## 零、先看这张表

| 事项 | 谁来做 | 状态 |
|---|---|---|
| Release 签名密钥 | 我 | ✅ 已生成 |
| Release 签名配置 | 我 | ✅ 已配好 |
| 权限过度申请清理 | 我 | ✅ 9 条 → 4 条 |
| 安全项（明文流量 / 备份） | 我 | ✅ 已修 |
| 签名版 APK | 我 | ✅ 23.23 MB |
| 备案所需信息提取 | 我 | ✅ 见 §四 |
| **软件著作权证书（软著）** | **你** | ❌ 必须办 |
| **APP 备案** | **你** | ❌ 必须办 |
| **开发者账号实名认证** | **你** | ❌ 必须办 |
| 隐私政策（要能公网访问） | 你 | ❌ 必须 |
| 应用截图 / 介绍文案 | 你 | ❌ 必须 |
| **包名是否要改** | **你** | ⚠️ 建议尽早决定 |

---

## 一、硬性门槛：三样东西缺一不可

### 1.1 软件著作权登记证书（软著）

**国内所有主流应用市场都要求**，没有软著基本会被直接驳回。

| | |
|---|---|
| 办理渠道 | 中国版权保护中心 ccopyright.com.cn |
| 常规周期 | **1~3 个月** |
| 加急 | 1~5 个工作日（额外收费，几百到几千） |
| 材料 | 源代码前后各 30 页 + 软件说明书 + 身份证明 |
| 名称 | 建议「应用分析器软件 V1.0」，与 App 名称一致 |

> **这是最耗时的一环，建议今天就去办。** 其他都能并行，只有它卡时间。

### 1.2 APP 备案（工信部）

依据《工业和信息化部关于开展移动互联网应用程序备案工作的通知》：

- 2023-09-01 起，**新 App 必须完成备案才能上架**
- 2023-12-12 起，未备案应用无法发起版本更新
- 2024-01-04 起，逐步清理在架未备案的存量应用
- **分发平台不得为未备案 APP 提供分发服务**（小米原文）

**流程**（约 20 个工作日）：

```
① 你在阿里云 / 腾讯云 / 金山云任选一家，进它的「APP备案」系统提交
② 接入商初步核验材料
③ 你收到短信，登录 beian.miit.gov.cn 确认
④ 你所在省通信管理局审核
⑤ 通过后短信 + 邮件发备案号
```

需要准备的材料见 §四（技术信息我已经提取好了）。

### 1.3 开发者账号 + 实名认证

每家市场单独注册，个人或企业均可（企业账号可上架的类目更多）：

| 市场 | 开放平台 |
|---|---|
| 华为 | developer.huawei.com/consumer/cn |
| 小米 | dev.mi.com |
| OPPO | open.oppomobile.com |
| vivo | dev.vivo.com.cn |
| 荣耀 | developer.honor.com |
| 应用宝（腾讯） | open.qq.com |
| 百度 | app.baidu.com |
| 360 | dev.360.cn |

个人实名认证通常需要：身份证 + 人脸识别 + 银行卡（打款验证）。

---

## 二、我已经做完的技术准备

### 2.1 Release 签名（上架必需）

应用市场**一律拒收 debug 签名**（它用的是 Android 默认调试密钥，公开可查，等于没签名）。

已生成正式密钥：

```
文件      release.keystore          2658 字节
别名      appanalyzer
算法      RSA-2048 / SHA384withRSA
有效期    10000 天（到 2054 年）
密码      存在 keystore.properties 里
```

> ⚠️ **务必备份 release.keystore 和 keystore.properties。**
> 丢了就永远无法给已上架的应用发更新 —— 只能换包名重新上架，老用户永远收不到更新。
> 建议拷到 U 盘 + 云盘 + 密码管理器，至少两份异地。

> 这两个文件已经加进 .gitignore，**绝不会进版本库**（泄露 = 别人能冒名发你的更新）。

### 2.2 权限清理：9 条 → 4 条

审核会逐条核对权限用途，**用不到的必须删**，否则算「过度索权」直接驳回。

| 权限 | 处理 | 原因 |
|---|---|---|
| QUERY_ALL_PACKAGES | **保留** | 核心功能：枚举已安装应用 |
| PACKAGE_USAGE_STATS | **保留** | 核心功能：读取各应用体积（需用户手动授权） |
| INTERNET | **保留** | 云端图像生成 + 模型下载 |
| ACCESS_NETWORK_STATE | **保留** | 判断网络状态 |
| READ_MEDIA_IMAGES | ❌ 删除 | 相册导入走系统选择器（SAF），**不需要权限** |
| READ_MEDIA_VIDEO | ❌ 删除 | 完全没用到 |
| READ_MEDIA_AUDIO | ❌ 删除 | 完全没用到 |
| READ_EXTERNAL_STORAGE | ❌ 删除 | 完全没用到 |
| WRITE_EXTERNAL_STORAGE | ❌ 删除 | 导出走 MediaStore，不需要 |

### 2.3 安全项

| 项 | 处理 | 原因 |
|---|---|---|
| usesCleartextTraffic | **移除** | 项目里所有请求都是 https，保留它会被安全审核扣分 |
| allowBackup | true → **false** | 应用存着用户的 DeepSeek API Key，开备份会被系统备份带走 |

### 2.4 签名版 APK

```
app/build/outputs/apk/release/app-release.apk   23.23 MB
```

| 检查 | 结果 |
|---|---|
| 签名方案 | v2 ✅ / v3 ✅（v1 关闭，minSdk 26 用不上） |
| 签名者 | CN=App Analyzer, O=zhangjiancai, C=CN |
| 权限数 | 4 条 |
| 支持架构 | arm64-v8a |
| **真机验证** | **六个页面全过、面板可展开、零崩溃**（Android 16 / API 36 模拟器） |

构建命令：

```
.\build-apk.bat                  # debug + release 都出
.\gradlew.bat assembleRelease    # 只出 release
```

---
---

## 三、各市场的上架流程（按启动难度排序）

### 3.1 华为 AppGallery（推荐先上这家）

1. 注册华为开发者账号并实名（个人需人脸识别）
2. 进入 AppGallery Connect → 我的应用 → 新建应用
3. 填写应用名称、包名、分类、语言
4. 上传 APK（就是 `app-release.apk`）
5. 填写隐私政策 URL、权限用途说明、内容分级
6. 提交审核（首次通常 1~3 个工作日）

华为对 `QUERY_ALL_PACKAGES` 查得比较细，需要在「权限说明」里写清楚用途。

### 3.2 小米开放平台

1. 注册小米开发者账号并实名
2. 管理中心 → 创建应用
3. 上传 APK，填写备案信息（**备案号必填**）、资质信息、联系人
4. 提交审核

### 3.3 OPPO / vivo / 荣耀

流程与上面两家基本一致：注册 → 实名 → 创建应用 → 上传 APK → 填备案号 → 提交审核。

### 3.4 应用宝（腾讯）

额外要求：需要提供**软著**，且审核相对严。

### 3.5 百度 / 360

可作为补充渠道，要求相对宽松。

> 💡 **建议**：先只上华为 + 小米 + OPPO + vivo 四家（覆盖 80%+ 国内安卓用户），
> 跑通一遍流程、拿到审核反馈后再铺其他渠道。

---

## 四、备案要填的技术信息（已提取好，直接抄）

### 4.1 应用基础信息

| 字段 | 值 |
|---|---|
| APP 名称 | 应用分析器（英文名 App Analyzer） |
| 包名 | `com.appanalyzer` |
| 版本 | 1.2.0（versionCode 120） |
| 应用类型 | 实用工具 / 系统工具 |
| 运行平台 | Android |
| 语种 | 简体中文 |

### 4.2 签名公钥与指纹（备案系统要求填）

`@
证书 DN      CN=App Analyzer, O=zhangjiancai, C=CN
MD5          B4:D5:2B:94:97:EA:DC:FB:61:DA:9C:E2:85:C7:AB:B8
SHA-1        FF:63:DF:CF:FF:76:7E:74:B8:8F:C4:FA:67:D2:52:D2:3B:D8:14:34
SHA-256      A0:A6:EC:BE:86:53:D3:DF:32:03:D6:79:61:19:EA:D2:E0:5C:F8:C9:50:B1:FF:17:87:BC:A7:69:CC:AC:77:9D
`@

> ⚠️ **这些指纹和签名密钥绑定，改了包名或重新生成密钥都会变。**
> 所以：**先决定包名，再备案**，否则要重新走一遍。

### 4.3 域名（备案要填「域名」一栏）

应用会连的服务端：

| 域名 | 用途 |
|---|---|
| api.deepseek.com | AI 分类 + 拟物化描述生成（需用户自己填 Key） |
| www.modelscope.cn | 端侧模型按需下载 |
| dashscope.aliyuncs.com | 通义万相 图像生成（可选，需用户自己填 Key） |
| ark.cn-beijing.volces.com | 豆包 SeedEdit 图像生成（可选） |
| generativelanguage.googleapis.com | Google Gemini（可选） |
| api.openai.com | OpenAI gpt-image-1（可选） |

**注意**：这些域名都**不属于你**，是第三方服务。备案系统里如果强制要求填自有域名，
可以说明「本应用为工具类，不提供自建服务端，所有网络请求由用户自行配置的第三方 API 完成」。

如果备案因此卡住，还有一个办法：**把 AI 相关功能做成可选插件**，
主体功能（应用列表 / 统计 / 图表 / 本地图标生成）完全离线，作为「单机应用」备案。
（工信部规定：单机应用不需要备案。）

---

## 五、这个应用的特殊审核风险

### 5.1 QUERY_ALL_PACKAGES 是最大风险点

这个权限在 Google Play 上被严格限制，国内虽宽松但也要**说明清楚用途**。

**建议的准备**：

- 写一份《权限使用说明》，逐条说明为什么需要
- 录一段**操作视频**：展示「打开应用 → 看到已安装应用列表 → 点开某个应用看到体积」，
  让审核员直观理解这是应用管理工具的正常功能
- 在应用商店描述里明确写「本应用是应用管理工具，需要读取已安装应用列表才能工作」

**可以这样说**：

```
本应用是一款应用管理工具，核心功能是帮用户查看已安装应用的体积占用并批量管理图标。
因此需要 QUERY_ALL_PACKAGES 权限来获取设备上已安装应用的列表。
该权限仅用于本地展示与统计，不会上传、不会分享给任何第三方。
所有数据都在设备本地处理。
```

### 5.2 「图标包」功能可能被误解

图标包会生成一个可安装的 APK。审核可能怀疑这是「二次打包」或「恶意插件」。

**建议说明**：

- 图标包是**第三方启动器生态的标准格式**（Nova / Lawnchair / ADW 等），不是系统级修改
- 图标包内**不含任何可执行代码**（纯资源 APK，无 dex）
- 必须由用户在启动器里主动选择启用，**不会自动替换任何东西**
- 应用内已有完整教程说明

> 实测证据：生成的图标包 APK 里 **0 个 .dex 文件**，可以用 `aapt2 dump badging` 复现。

### 5.3 其他注意点

- 应用内**不申请存储权限**（见 §2.2），审核时这一点是加分项
- API Key 由用户自己填写、只存本机、**不编译进 APK**（可以主动说明，体现安全意识）
- 应用内关于页有完整的 README，能证明功能透明

---

## 六、上架材料清单

| 材料 | 规格 | 状态 |
|---|---|---|
| 签名 APK | 23.23 MB，已签名 | ✅ 已有 |
| 应用图标 | 512×512 PNG，**不能有透明通道**、不能有圆角 | ⚠️ 需要做 |
| 应用截图 | 通常 3~5 张，1080×1920 或 1080×2340 | ⚠️ 需要做 |
| 应用简介 | 一句话，一般 ≤ 30 字 | ⚠️ 需要写 |
| 应用描述 | 详细描述，一般 200~1000 字 | ⚠️ 需要写 |
| 隐私政策 | **必须能公网访问的 URL** | ⚠️ 需要托管 |
| 软著证书 | 扫描件或照片 | ❌ 你去办 |
| 备案号 | 形如「京ICP备xxxxxxxx号-1A」 | ❌ 你去办 |

### 6.1 应用图标

现在的图标是简单的矢量图（紫色底 + 图形），**上架需要专门的商店图标**：

- 512×512 px
- **PNG，不带透明通道**（很多市场会因此驳回）
- 不要自己做圆角（各市场会自己加）
- 不要放文字（缩小后看不清）

### 6.2 应用描述参考

**一句话简介**：

```
看清每个应用占了你多少空间，还能批量换图标
```

**详细描述**：

```
应用分析器能帮你搞清楚手机空间到底被什么占满了，并且批量给应用换上新图标。

【真实体积，不估算】
读取每个应用的本体、缓存、数据三项真实占用，读不到的地方直接显示「—」，不会用公式编一个数字糊弄你。

【多种图表】
应用体积排行、体积分布曲线、存储构成堆叠条，一眼看清空间去向。

【四类图标风格】
白线勾勒（适合纯黑壁纸）、拟物化、极简色块，以及自定义风格。
自定义风格会在你手机上现场训练一个小模型，一张风格参考图就能让所有图标统一风格。

【端侧 AI，按需下载】
抠图、超分模型不打包进安装包，用到哪个才下哪个，下载后完全离线运行。

【一键生成图标包】
生成的图标包可以直接安装，在 Nova、Lawnchair、ADW 等第三方启动器里一键应用。

【隐私】
所有数据都在设备本地处理，不联网也能用（除了你自己配置的 AI 服务）。
API Key 只存在你手机里，不会上传到任何服务器。
```

---

## 七、建议的执行顺序

`@
第 1 天   去办软著（加急）        ← 最耗时，先启动
第 1 天   决定包名要不要改        ← 定了才能备案
第 2 天   做商店图标 + 截图 + 文案
第 2 天   托管隐私政策（GitHub Pages 免费，见 §7.1）
第 3 天   提交 APP 备案
第 3 天   注册 4 家市场的开发者账号并实名
全 程     等软著 + 等备案（并行）
拿到后    上传 APK，逐家提交审核
`@

### 7.1 隐私政策怎么最快托管

用 GitHub Pages（免费，5 分钟）：

1. 在 `zhangjiancai/zhangjiancai` 仓库里新建 `privacy.md`
2. 仓库 Settings → Pages → Source 选 main 分支
3. 访问 `https://zhangjiancai.github.io/zhangjiancai/privacy.html`

我可以帮你写好隐私政策正文并提交，你只需要在仓库设置里打开 Pages。

---

## 八、需要你决定的两件事

### 8.1 包名要不要改？

现在是 `com.appanalyzer`。问题：

- 太通用，**可能已经被别人注册**（备案时会查重）
- 不符合「反向域名」惯例（正常应该是 `com.你的域名.应用名`）

建议改成 `com.zhangjiancai.appanalyzer` 之类。

**为什么现在就要定**：包名会写进备案，改了要重新备案；密钥指纹也会变。
越早决定成本越低。

### 8.2 个人还是企业开发者？

| | 个人 | 企业 |
|---|---|---|
| 认证材料 | 身份证 + 人脸 | 营业执照 + 对公打款 |
| 可上架类目 | 部分受限 | 更全 |
| 软著申请人 | 个人 | 公司 |
| 备案主体 | 个人 | 企业 |

如果只是自己用 + 小范围分享，个人账号够用；
想正经长期维护，企业主体会少很多麻烦。

---

## 九、我还能帮你做什么

- [ ] 改包名并重新构建（你定了名字我就改）
- [ ] 写隐私政策正文并提交到仓库
- [ ] 生成 512×512 商店图标
- [ ] 写应用商店的简介 / 详细描述文案
- [ ] 写《权限使用说明》文档
- [ ] 生成截图（可以在模拟器上跑起来截）

说一声就行。

---

## 十、怎么打包 APK（三种方式，任选）

### 方式 A：Android Studio 图形界面（最直观，推荐给你）

> **重要**：签名已经在 `build.gradle` 里配好了，所以**不要**用
> `Build → Generate Signed Bundle / APK` —— 那个会让你手动选密钥库、手填密码，
> 反而容易填错。直接用下面的 `Build APK(s)` 就会自动用 release.keystore 签名。

**步骤**：

```
① 打开项目
   双击项目根目录的 open-studio.bat
   （或 Studio 里 File → Open → 选 D:\zjc20\Documents\android-app-analyzer）

② 等 Gradle Sync 完成
   首次要下载依赖，几分钟；右下角进度条走完再进行下一步

③ 切换构建变体到 release
   左侧边栏找 Build Variants 面板（没有就 View → Tool Windows → Build Variants）
   把 :app 那一行的 Active Build Variant 从 debug 改成 release
   把 :iconpack 也改成 release（可选）

④ 打包
   菜单 Build → Build Bundle(s) / APK(s) → Build APK(s)

⑤ 产物
   app/build/outputs/apk/release/app-release.apk
   右下角会弹一个通知，点「locate」直接定位到文件
```

**在手机上跑起来**（可选）：

手机开 USB 调试插上电脑 → Studio 顶部设备下拉里选中它 → 点绿色三角 ▶ Run。
注意：release 变体点 Run 会在手机上装**正式签名版**，和之前装的 debug 版签名不同，
要先卸载旧的。

### 方式 B：一键脚本（双击就行，不用开 Studio）

双击项目根目录的 **build-apk.bat**。

它会自动找到 JDK 和 SDK，同时构建 debug + release 两个包，然后打印产物路径。

> 这个脚本存在的意义：这台机器上 `JAVA_HOME` 没设、PATH 里也没有 `java`，
> 直接双击 `gradlew.bat` 会报 `ERROR: JAVA_HOME is not set`。
> 脚本会自己去 Android Studio 的 JBR 目录里找。

**更省事的做法**：右键 build-apk.bat → 发送到 → 桌面快捷方式，以后双击快捷方式就行。

### 方式 C：命令行（想自己控制时）

```powershell
cd D:\zjc20\Documents\android-app-analyzer
$env:JAVA_HOME = 'D:\Program Files\Android\Android Studio\jbr'
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"

.\gradlew.bat assembleRelease      # 只出 release（上架用这个）
.\gradlew.bat assembleDebug        # 只出 debug（自己测试用）
.\gradlew.bat :app:testDebugUnitTest   # 跑 151 个单元测试
```

---

## 十一、debug 包和 release 包的区别（别搞混）

| | debug | release |
|---|---|---|
| 用途 | 自己测试 | **上架应用市场** |
| 签名 | Android 默认调试密钥（公开可查） | 你自己的 release.keystore |
| 体积 | 26.49 MB | **23.23 MB** |
| 市场接受 | ❌ 一律拒收 | ✅ |
| 体积为什么大 | 带调试工具（Compose Preview 等） | 去掉了 |

> ⚠️ 两者签名不同，**不能互相覆盖安装**。手机上装了一个，装另一个要先卸载。

---

## 十二、打包常见问题

### Q: Studio 里 Build 菜单是灰的 / 找不到 Build Variants

Gradle Sync 还没完成。看右下角进度条，或者 File → Sync Project with Gradle Files 手动同步。

### Q: Sync 报错找不到 SDK

检查项目根目录的 `local.properties`，应该有 `sdk.dir` 指向你的 SDK：

```properties
sdk.dir=C\:\\Users\\zjc20\\AppData\\Local\\Android\\Sdk
```

这个文件**不进版本库**（在 .gitignore 里），换电脑要自己建。

### Q: 提示 JAVA_HOME is not set

用 build-apk.bat 就不会有这个问题。如果坚持用命令行，先设：

```powershell
$env:JAVA_HOME = 'D:\Program Files\Android\Android Studio\jbr'
```

### Q: 我想换个新的签名密钥

重新生成 keystore 并更新 keystore.properties 即可：

```powershell
cd D:\zjc20\Documents\android-app-analyzer
$env:JAVA_HOME = 'D:\Program Files\Android\Android Studio\jbr'
& "$env:JAVA_HOME\bin\keytool.exe" -genkeypair -v `
  -keystore release.keystore -alias appanalyzer `
  -keyalg RSA -keysize 2048 -validity 10000 `
  -storepass 你的纯字母数字密码 -keypass 你的纯字母数字密码 `
  -dname "CN=你的名字,O=你的组织,C=CN"
```

> 密码**只能用字母数字**：Java 的 Properties 会把反斜杠 / 冒号 / 等号 / 空格当转义符，
> 带这些字符的密码读出来会不一样（这个坑我踩过）。

> ⚠️ 换密钥意味着已上架的应用**无法再更新**（Android 校验签名一致性），
> 除非用 Google Play 的应用签名或各市场的密钥托管。**上架前就把密钥定下来。**

### Q: 打包出来是 arm64 的，能在 32 位手机上装吗

不能。当前只打了 `arm64-v8a`（2018 年后的手机基本都是）。

要加 32 位支持，在 app/build.gradle 里把 `abiFilters` 加上 `'armeabi-v7a'`，
代价是 APK 会大 **10.4 MB**（ONNX Runtime 的 32 位 .so）。

现在国内主流市场都接受纯 64 位应用，**不建议加**。
