# :iconpack — 图标包 APK 构建模块

把手机 App（AppAnalyzer）导出的图标包源目录，编译成一个能被 Nova / Smart Launcher /
ADW / Lawnchair / Apex / GO 等第三方启动器识别的**图标包 APK**。

本模块是**纯资源模块**：没有 Kotlin/Java 源码，不依赖任何第三方库，
只有一个 AndroidManifest + assets + res。

---

## 三步流程

### 第 1 步：把手机导出的 zip 解压到 `iconpack/src/main/generated/`

从手机里导出图标包 zip，**直接解压到本模块的 `src/main/generated/` 目录**，
不要移动、不要改名。解压后目录必须长这样：

```
iconpack/src/main/generated/
├── assets/
│   ├── appfilter.xml
│   └── drawable.xml
├── res/
│   ├── xml/
│   │   ├── appfilter.xml
│   │   └── drawable.xml
│   └── drawable-xxhdpi/
│       ├── ic_com_example_app.png
│       └── ...
└── meta.json
```

仓库里已经预置了一份**占位内容**（空的 `appfilter.xml` / `drawable.xml`、
一张 `ic_placeholder.png`），所以**不做任何导出也能直接构建成功**。
解压导出的 zip 时会覆盖这些占位文件，这是预期行为。

> `res/drawable-xxhdpi/` **不能为空**，否则 aapt2 会报错。所以占位图
> `ic_placeholder.png` 请保留（除非导出的包里已经有别的 png）。
>
> `meta.json` 只是模块的元信息，**不会**被打进 APK，也不需要打包。

### 第 2 步：构建

在**项目根目录**执行（Windows PowerShell）：

```powershell
$env:JAVA_HOME = 'D:\Program Files\Android\Android Studio\jbr'
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
.\gradlew.bat :iconpack:assembleDebug --offline --console=plain
```

产物路径固定为：

```
iconpack/build/outputs/apk/debug/iconpack-debug.apk
```

### 第 3 步：安装并在启动器里选择图标包

```bat
adb install -r iconpack\build\outputs\apk\debug\iconpack-debug.apk
```

然后打开启动器设置：

* **Nova Launcher**：设置 → 外观 → 图标样式 → 图标包 → 选择 App Analyzer Icons
* **Smart Launcher**：设置 → 全局外观 → 图标包 → 选择 App Analyzer Icons
* **ADW / Lawnchair / Apex / GO**：设置 → 外观 / 主题 → 图标包 → 选择 App Analyzer Icons

图标包在列表里显示的名字来自 `src/main/res/values/strings.xml` 的 `app_name`
（默认 `App Analyzer Icons`），改那里即可换名字。

---

## 启动器识别的依据（为什么要这么写）

### 1. Manifest 里必须有带主题 action 的 exported activity

```xml
<activity android:name="android.app.Activity" android:exported="true">
    <intent-filter>
        <action android:name="org.adw.launcher.THEMES" />
        <action android:name="com.gau.go.launcherex.theme" />
        <action android:name="com.novalauncher.THEME" />
        <action android:name="com.anddoes.launcher.THEME" />
        <action android:name="com.teslacoilsw.launcher.THEME" />
        <category android:name="android.intent.category.DEFAULT" />
    </intent-filter>
</activity>
```

`org.adw.launcher.THEMES` 是启动器识别图标包的**关键 action**（Smart Launcher 官方文档
和 Blueprint 图标包模板都是这么写的）。一个 `<intent-filter>` 里写多个 `<action>`
是合法的，语义是「命中任意一个 action 即匹配」，可以一次覆盖更多启动器。
`android.intent.category.DEFAULT` 必须保留，否则隐式 Intent 查询不到。

本模块没有源码，所以 Activity 直接用框架的 `android.app.Activity`：
它是 public、非抽象、有默认构造函数，框架可以直接实例化并启动，不会
`ClassNotFoundException`，也就不需要任何 .java / .kt 文件。

### 2. appfilter.xml 与 drawable.xml 必须**同时**存在于 assets/ 和 res/xml/

* 启动器（Nova、ADW、Smart Launcher 等）读的是 APK 里的 **`assets/appfilter.xml`**；
* 一部分图标包管理面板 / 兼容层读的是 **`res/xml/appfilter.xml`**（编译后的 XML 资源）。

所以两份内容完全相同，本模块两份都打进 APK。
这就是为什么源目录里同时有 `generated/assets/` 和 `generated/res/xml/`。

### 3. 图标是 res/drawable-xxhdpi/ 下的 PNG

`appfilter.xml` 里形如 `drawable="ic_com_example_app"` 的名字，
对应 `res/drawable-xxhdpi/ic_com_example_app.png`。

---

## sourceSets 配置说明（重要，别改错）

```groovy
sourceSets {
    main {
        assets.srcDirs += 'src/main/generated/assets'
        res.srcDirs += 'src/main/generated/res'
    }
}
```

**指向的是 `generated/assets` 和 `generated/res`，而不是 `generated/` 本身。**
原因：assets 的 source dir 本身就是 APK 里 `assets/` 的根目录 ——
如果写成 `assets.srcDirs += 'src/main/generated'`，`generated/assets/appfilter.xml`
在 APK 里会变成 `assets/assets/appfilter.xml`，启动器就找不到了。
res 同理：写成 `generated` 的话，`res/` 会被当成一个非法资源类型目录，
`generated/res/xml/appfilter.xml` 根本不会被编译进去。

用 `+=` 是追加，所以默认的 `src/main/assets` 与 `src/main/res` 依然有效
（本模块的 `app_name` 字符串和自带图标就放在 `src/main/res`）。

---

## 验证 APK 是否正确（可选）

```bat
set AAPT2=%LOCALAPPDATA%\Android\Sdk\build-tools\34.0.0\aapt2.exe

:: 1) 确认 intent-filter 里有 org.adw.launcher.THEMES
%AAPT2% dump xmltree --file AndroidManifest.xml iconpack\build\outputs\apk\debug\iconpack-debug.apk

:: 2) 确认 assets/appfilter.xml 打进包里了
tar -tf iconpack\build\outputs\apk\debug\iconpack-debug.apk
```
