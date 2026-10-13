package com.appanalyzer.service.iconpack

import java.io.File

/**
 * 在手机里把「一批图标」直接打成**可安装的图标包 APK**。
 *
 * 本类是整个功能的核心，而且**完全不依赖 Android**：给它图标字节和一把签名钥匙，
 * 它就能吐出装得上手机的 APK。Android 侧只负责「取图标 / 存文件」（见 IconPackApkService）。
 *
 * 产物结构（纯资源 APK，没有 classes.dex）：
 *   AndroidManifest.xml                    手写 AXML：声明图标包 action，hasCode=false
 *   resources.arsc                         手写 arsc：drawable(480dpi) + xml 两个类型
 *   res/drawable-xxhdpi-v4/ic_xxx.png      图标本体
 *   res/xml/appfilter.xml                  组件→图标映射（二进制 XML，部分图标包面板读这份）
 *   res/xml/drawable.xml                   图标清单（二进制 XML）
 *   assets/appfilter.xml                   启动器真正读的那份（纯文本 XML）
 *   assets/drawable.xml
 *
 * 签名：APK Signature Scheme v2（apksig），v1/v3/v4 都不写。
 */
object IconPackApkBuilder {

    const val DEFAULT_APPLICATION_ID = "com.appanalyzer.iconpack"
    const val DEFAULT_LABEL = "App Analyzer Icons"

    /** 图标放 xxhdpi 目录，与电脑端 :iconpack 模块以及主流图标包一致。 */
    const val DRAWABLE_DIR = "res/drawable-xxhdpi-v4"
    const val DRAWABLE_DENSITY = 480

    private const val XML_DIR = "res/xml"
    private const val LAUNCHER_ICON_KEY = "ic_launcher"
    private const val PNG_MAGIC = "\u0089PNG\r\n\u001a\n"

    /**
     * 第三方启动器识别图标包靠的就是这些 action。
     * org.adw.launcher.THEMES 通用程度最高（Nova / ADW / Lawnchair / Apex / Smart Launcher 都查它），
     * 其余几个是各家启动器历史上的私有 action；一个 intent-filter 里写多个 action 是合法的
     * （语义是「命中任意一个即匹配」），可以一次覆盖更多启动器。
     */
    val THEME_ACTIONS: List<String> = listOf(
        "org.adw.launcher.THEMES",
        "com.gau.go.launcherex.theme",
        "com.novalauncher.THEME",
        "ch.deletescape.lawnchair.ICONPACK",
        "com.anddoes.launcher.THEME",
        "com.teslacoilsw.launcher.THEME",
    )

    /** 待打包的一个图标。 */
    class Icon(
        /** 形如 com.tencent.mm/com.tencent.mm.ui.LauncherUI */
        val component: String,
        val packageName: String,
        val appName: String,
        val pngBytes: ByteArray,
    )

    class Options(
        val applicationId: String = DEFAULT_APPLICATION_ID,
        /** 图标包在启动器列表里显示的名字 */
        val label: String = DEFAULT_LABEL,
        val versionCode: Int = 1,
        val versionName: String = "1.0",
        val minSdkVersion: Int = 26,
        val targetSdkVersion: Int = 34,
        /** 图标包自己的启动图标（可选）。不传就不写 android:icon，系统会给个默认图标。 */
        val launcherIconPng: ByteArray? = null,
        val author: String = "",
    )

    class Skipped(val packageName: String, val reason: String)

    class Result(
        val apkBytes: ByteArray,
        /** 真正打进包里的图标数量 */
        val iconCount: Int,
        /** appfilter.xml 里的映射条数（一个图标可能对应两条） */
        val appFilterItemCount: Int,
        val skipped: List<Skipped>,
        /** 包名 → 资源名，便于上层做提示 */
        val drawableNames: Map<String, String>,
    )

    /** android.R.attr 的 framework 属性 id（取自 AOSP 的 public.xml，这些值永远不变）。 */
    private object Attr {
        const val LABEL = 0x01010001
        const val ICON = 0x01010002
        const val NAME = 0x01010003
        const val HAS_CODE = 0x0101000C
        const val DEBUGGABLE = 0x0101000F
        const val EXPORTED = 0x01010010
        const val MIN_SDK_VERSION = 0x0101020C
        const val VERSION_CODE = 0x0101021B
        const val VERSION_NAME = 0x0101021C
        const val TARGET_SDK_VERSION = 0x01010270
        const val ALLOW_BACKUP = 0x01010280
        const val SUPPORTS_RTL = 0x010103AF
    }

    private const val PACKAGE_ID = ResourceTable.PACKAGE_ID

    private fun android(name: String, value: XmlValue, id: Int) =
        XmlAttribute(BinaryXml.ANDROID_NS, name, value, id)

    /**
     * 生成 APK 字节。
     *
     * @param workDir apksig 需要真实文件做输入输出，这里放临时文件；默认用系统临时目录
     *               （Android 上是应用自己的 cache 目录），上层最好显式传 context.cacheDir。
     */
    fun build(
        icons: List<Icon>,
        options: Options,
        signingKey: SigningKey,
        workDir: File? = null,
    ): Result {
        validate(options)

        val skipped = ArrayList<Skipped>()
        val prepared = ArrayList<PreparedIcon>()
        val usedNames = HashSet<String>()
        for (icon in icons) {
            if (!isPng(icon.pngBytes)) {
                skipped.add(Skipped(icon.packageName, "不是有效的 PNG 数据"))
                continue
            }
            val baseName = AppFilterXml.drawableNameOf(icon.packageName)
            var name = baseName
            var suffix = 1
            while (!usedNames.add(name)) {
                suffix++
                name = "${baseName}_$suffix"
            }
            prepared.add(PreparedIcon(icon.component, icon.packageName, name, icon.pngBytes))
        }

        // 图标包自己的图标放第一位，这样它的资源 id 固定是 0x7f010000（见 launcherIconResourceId）
        val launcherIcon = options.launcherIconPng?.takeIf { isPng(it) }
        val drawableEntries = ArrayList<ResourceFileEntry>()
        var launcherIconIndex = -1
        if (launcherIcon != null) {
            launcherIconIndex = drawableEntries.size
            drawableEntries.add(ResourceFileEntry(LAUNCHER_ICON_KEY, "$DRAWABLE_DIR/$LAUNCHER_ICON_KEY.png"))
        }
        for (icon in prepared) {
            drawableEntries.add(
                ResourceFileEntry(icon.drawableName, "$DRAWABLE_DIR/${icon.drawableName}.png"),
            )
        }

        val mappings = prepared.map { IconMapping(it.component, it.packageName, it.drawableName) }
        val appFilterText = AppFilterXml.buildAppFilter(mappings)
        val drawableListText = AppFilterXml.buildDrawableList(prepared.map { it.drawableName })

        val resources = listOf(
            ResourceTypeConfig("drawable", DRAWABLE_DENSITY, drawableEntries),
            ResourceTypeConfig(
                "xml", 0,
                listOf(
                    ResourceFileEntry("appfilter", "$XML_DIR/appfilter.xml"),
                    ResourceFileEntry("drawable", "$XML_DIR/drawable.xml"),
                ),
            ),
        )
        val resourcesArsc = ResourceTable.encode(options.applicationId, resources)

        val manifest = BinaryXml.encode(
            buildManifest(options, if (launcherIcon != null) launcherIconResourceId(launcherIconIndex) else null),
        )
        val appFilterBinary = BinaryXml.encode(buildResourceItemsXml(mappings))
        val drawableBinary = BinaryXml.encode(buildDrawableItemsXml(prepared.map { it.drawableName }))

        val zipEntries = ArrayList<ZipWriter.Entry>()
        zipEntries.add(ZipWriter.Entry("AndroidManifest.xml", manifest, alignment = 4))
        zipEntries.add(ZipWriter.Entry("resources.arsc", resourcesArsc, alignment = 4))
        if (launcherIcon != null) {
            zipEntries.add(
                ZipWriter.Entry("$DRAWABLE_DIR/$LAUNCHER_ICON_KEY.png", launcherIcon, alignment = 4),
            )
        }
        for (icon in prepared) {
            zipEntries.add(
                ZipWriter.Entry("$DRAWABLE_DIR/${icon.drawableName}.png", icon.pngBytes, alignment = 4),
            )
        }
        zipEntries.add(ZipWriter.Entry("$XML_DIR/appfilter.xml", appFilterBinary, alignment = 4))
        zipEntries.add(ZipWriter.Entry("$XML_DIR/drawable.xml", drawableBinary, alignment = 4))
        zipEntries.add(
            ZipWriter.Entry("assets/appfilter.xml", appFilterText.toByteArray(Charsets.UTF_8), alignment = 4),
        )
        zipEntries.add(
            ZipWriter.Entry("assets/drawable.xml", drawableListText.toByteArray(Charsets.UTF_8), alignment = 4),
        )

        val unsigned = ZipWriter().write(zipEntries)
        val signed = ApkSignerV2.sign(unsigned, signingKey, workDir, options.minSdkVersion)

        return Result(
            apkBytes = signed,
            iconCount = prepared.size,
            appFilterItemCount = appFilterText.lineSequence().count { it.trimStart().startsWith("<item ") },
            skipped = skipped,
            drawableNames = prepared.associate { it.packageName to it.drawableName },
        )
    }

    /** 图标包的启动图标资源 id：包 id 0x7f、drawable 类型 id、条目的下标。 */
    fun launcherIconResourceId(entryIndex: Int): Int {
        val typeNames = listOf("drawable", "xml").sorted()
        val typeId = typeNames.indexOf("drawable") + 1
        return (PACKAGE_ID shl 24) or (typeId shl 16) or entryIndex
    }

    private fun buildManifest(options: Options, launcherIconId: Int?): XmlElement {
        val label = XmlValue.Text(options.label)
        val applicationAttributes = ArrayList<XmlAttribute>()
        applicationAttributes.add(android("hasCode", XmlValue.Bool(false), Attr.HAS_CODE))
        applicationAttributes.add(android("label", label, Attr.LABEL))
        if (launcherIconId != null) {
            applicationAttributes.add(android("icon", XmlValue.Reference(launcherIconId), Attr.ICON))
        }
        applicationAttributes.add(android("allowBackup", XmlValue.Bool(false), Attr.ALLOW_BACKUP))
        applicationAttributes.add(android("supportsRtl", XmlValue.Bool(true), Attr.SUPPORTS_RTL))
        applicationAttributes.add(android("debuggable", XmlValue.Bool(false), Attr.DEBUGGABLE))

        val intentFilterChildren = ArrayList<XmlElement>()
        for (action in THEME_ACTIONS) {
            intentFilterChildren.add(
                XmlElement("action", listOf(android("name", XmlValue.Text(action), Attr.NAME))),
            )
        }
        intentFilterChildren.add(
            XmlElement(
                "category",
                listOf(android("name", XmlValue.Text("android.intent.category.DEFAULT"), Attr.NAME)),
            ),
        )

        val activity = XmlElement(
            "activity",
            listOf(
                android("name", XmlValue.Text("android.app.Activity"), Attr.NAME),
                android("exported", XmlValue.Bool(true), Attr.EXPORTED),
                android("label", label, Attr.LABEL),
            ),
            listOf(XmlElement("intent-filter", emptyList(), intentFilterChildren)),
        )

        val application = XmlElement("application", applicationAttributes, listOf(activity))

        val usesSdk = XmlElement(
            "uses-sdk",
            listOf(
                android("minSdkVersion", XmlValue.Decimal(options.minSdkVersion), Attr.MIN_SDK_VERSION),
                android("targetSdkVersion", XmlValue.Decimal(options.targetSdkVersion), Attr.TARGET_SDK_VERSION),
            ),
        )

        return XmlElement(
            "manifest",
            listOf(
                XmlAttribute(null, "package", XmlValue.Text(options.applicationId)),
                android("versionCode", XmlValue.Decimal(options.versionCode), Attr.VERSION_CODE),
                android("versionName", XmlValue.Text(options.versionName), Attr.VERSION_NAME),
            ),
            listOf(usesSdk, application),
        )
    }

    /** res/xml/appfilter.xml：与 assets 里那份内容等价，但编成二进制 XML。 */
    private fun buildResourceItemsXml(mappings: List<IconMapping>): XmlElement {
        val children = ArrayList<XmlElement>()
        for (m in mappings.sortedBy { it.packageName }) {
            children.add(
                XmlElement(
                    "item",
                    listOf(
                        XmlAttribute(null, "component", XmlValue.Text("ComponentInfo{${m.component}}")),
                        XmlAttribute(null, "drawable", XmlValue.Text(m.drawableName)),
                    ),
                ),
            )
            val activity = m.component.substringAfter('/', "")
            if (activity.startsWith("${m.packageName}.")) {
                val short = "ComponentInfo{${m.packageName}/.${activity.removePrefix("${m.packageName}.")}}"
                children.add(
                    XmlElement(
                        "item",
                        listOf(
                            XmlAttribute(null, "component", XmlValue.Text(short)),
                            XmlAttribute(null, "drawable", XmlValue.Text(m.drawableName)),
                        ),
                    ),
                )
            }
        }
        return XmlElement("resources", emptyList(), children)
    }

    private fun buildDrawableItemsXml(names: List<String>): XmlElement {
        val children = names.sorted().map {
            XmlElement("item", listOf(XmlAttribute(null, "drawable", XmlValue.Text(it))))
        }
        return XmlElement("resources", emptyList(), children)
    }

    private fun isPng(bytes: ByteArray): Boolean {
        if (bytes.size < 16) return false
        val magic = PNG_MAGIC.toByteArray(Charsets.ISO_8859_1)
        for (i in magic.indices) if (bytes[i] != magic[i]) return false
        return true
    }

    private fun validate(options: Options) {
        require(PACKAGE_NAME_PATTERN.matches(options.applicationId)) {
            "包名非法: ${options.applicationId}"
        }
        require(options.label.isNotBlank()) { "图标包名字不能为空" }
        require(options.versionCode >= 1) { "versionCode 必须 >= 1" }
        require(options.minSdkVersion in 21..99) { "minSdkVersion 非法: ${options.minSdkVersion}" }
        require(options.targetSdkVersion in options.minSdkVersion..99) { "targetSdkVersion 非法" }
    }

    private val PACKAGE_NAME_PATTERN = Regex("^[a-zA-Z][a-zA-Z0-9_]*(\\.[a-zA-Z][a-zA-Z0-9_]*)+$")

    private class PreparedIcon(
        val component: String,
        val packageName: String,
        val drawableName: String,
        val pngBytes: ByteArray,
    )
}
