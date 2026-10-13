package com.appanalyzer.service.iconpack

import com.android.apksig.ApkVerifier
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * 端到端：图标 → 图标包 APK。
 *
 * 这里做的是「真打包 + 真校验」：产物会用 apksig 的 ApkVerifier（apksigner verify 的同一套实现）
 * 验签，再把清单、资源表、assets 全部解析回来逐项核对。
 */
class IconPackApkBuilderTest {

    @get:Rule
    val temp = TemporaryFolder()

    private fun icons(count: Int): List<IconPackApkBuilder.Icon> = (1..count).map { i ->
        IconPackApkBuilder.Icon(
            component = "com.example.app$i/com.example.app$i.MainActivity",
            packageName = "com.example.app$i",
            appName = "应用 $i",
            pngBytes = TestPng.solid(48, 48, 0x336699, seed = i),
        )
    }

    private fun build(
        icons: List<IconPackApkBuilder.Icon> = icons(3),
        options: IconPackApkBuilder.Options = IconPackApkBuilder.Options(
            label = "测试图标包",
            launcherIconPng = TestPng.solid(48, 48, 0xFF0000),
        ),
    ): IconPackApkBuilder.Result =
        IconPackApkBuilder.build(icons, options, TestSigningKey.get(), temp.newFolder())

    private fun apkFile(bytes: ByteArray, name: String = "pack.apk"): File {
        val file = File(temp.root, name)
        file.writeBytes(bytes)
        return file
    }

    /** 纯资源 APK：有清单、有资源表、有图标，就是**不能有** classes.dex。 */
    @Test
    fun apkIsResourceOnlyAndHasEveryExpectedEntry() {
        val result = build()
        val names = ZipInspector(result.apkBytes).entries.map { it.name }.toSet()

        assertTrue(names.contains("AndroidManifest.xml"))
        assertTrue(names.contains("resources.arsc"))
        assertTrue(names.contains("assets/appfilter.xml"))
        assertTrue(names.contains("assets/drawable.xml"))
        assertTrue(names.contains("res/xml/appfilter.xml"))
        assertTrue(names.contains("res/xml/drawable.xml"))
        assertTrue(names.contains("res/drawable-xxhdpi-v4/ic_launcher.png"))
        assertTrue(names.contains("res/drawable-xxhdpi-v4/ic_com_example_app1.png"))
        assertFalse("图标包不能有 dex", names.any { it.endsWith(".dex") })
        assertEquals(3, result.iconCount)
    }

    /** Android 11+ 要求 resources.arsc 未压缩且 4 字节对齐，否则装机直接失败。 */
    @Test
    fun resourcesArscIsStoredAndAligned() {
        val inspector = ZipInspector(build().apkBytes)
        val arsc = inspector.entry("resources.arsc")!!
        assertEquals("resources.arsc 必须 STORED（未压缩）", 0, arsc.method)
        assertEquals("resources.arsc 必须 4 字节对齐", 0, arsc.dataOffset % 4)
        assertTrue(inspector.verifyCrc("resources.arsc"))
    }

    /** 清单里必须有全部图标包 action，否则第三方启动器根本发现不了这个包。 */
    @Test
    fun manifestDeclaresEveryThemeAction() {
        val inspector = ZipInspector(build().apkBytes)
        val root = TestAxmlParser.parse(inspector.data("AndroidManifest.xml")).root
        assertEquals("manifest", root.name)
        assertEquals("com.appanalyzer.iconpack", root.attribute("package")?.stringValue)
        assertEquals(1, root.attribute("versionCode")?.intValue)

        val usesSdk = root.child("uses-sdk")!!
        assertEquals(26, usesSdk.attribute("minSdkVersion")?.intValue)
        assertEquals(34, usesSdk.attribute("targetSdkVersion")?.intValue)

        val application = root.child("application")!!
        assertEquals("测试图标包", application.attribute("label")?.stringValue)
        assertEquals("没有 dex 必须显式写 hasCode=false", 0, application.attribute("hasCode")?.intValue)

        val activity = application.child("activity")!!
        assertEquals("android.app.Activity", activity.attribute("name")?.stringValue)
        assertEquals("有 intent-filter 就必须 exported", -1, activity.attribute("exported")?.intValue)

        val filter = activity.child("intent-filter")!!
        val actions = filter.children.filter { it.name == "action" }.map { it.attribute("name")!!.stringValue }
        assertEquals(IconPackApkBuilder.THEME_ACTIONS.toSet(), actions.toSet())
        assertTrue(actions.contains("org.adw.launcher.THEMES"))
        assertTrue(actions.contains("com.novalauncher.THEME"))
        assertTrue(actions.contains("ch.deletescape.lawnchair.ICONPACK"))
        assertEquals(
            "android.intent.category.DEFAULT",
            filter.child("category")!!.attribute("name")!!.stringValue,
        )
    }

    /** 图标包自己的图标资源 id 必须是 0x7f010000，清单里的 android:icon 要指向它。 */
    @Test
    fun launcherIconResourceIdAndManifestReference() {
        assertEquals(0x7F010000, IconPackApkBuilder.launcherIconResourceId(0))
        val inspector = ZipInspector(build().apkBytes)
        val application = TestAxmlParser.parse(inspector.data("AndroidManifest.xml")).root.child("application")!!
        val icon = application.attribute("icon")
        assertNotNull(icon)
        assertEquals(0x01, icon!!.dataType)
        assertEquals(IconPackApkBuilder.launcherIconResourceId(0), icon.intValue)
    }

    /** 资源表里的路径必须与 ZIP 里真实存在的条目一一对应 —— 对不上启动器就取不到图。 */
    @Test
    fun everyResourcePathExistsInTheZip() {
        val inspector = ZipInspector(build().apkBytes)
        val table = TestArscParser.parse(inspector.data("resources.arsc"))
        assertEquals("com.appanalyzer.iconpack", table.packageName)
        assertEquals(0x7F, table.packageId)
        assertNotNull(table.type("drawable"))
        assertEquals(480, table.type("drawable")!!.density)

        val keys = table.type("drawable")!!.entries.map { it.key }
        assertTrue(
            keys.containsAll(
                listOf("ic_launcher", "ic_com_example_app1", "ic_com_example_app2", "ic_com_example_app3"),
            ),
        )
        for (entry in table.types.flatMap { it.entries }) {
            assertNotNull(
                "资源表里的路径在 ZIP 里不存在: ${entry.value}",
                inspector.entry(entry.value),
            )
        }
        assertEquals(listOf("appfilter", "drawable"), table.type("xml")!!.entries.map { it.key })
    }

    /** assets 里的文本 appfilter 与 res/xml 里的二进制 appfilter 必须是同一份内容。 */
    @Test
    fun assetsAndCompiledAppFilterAgree() {
        val inspector = ZipInspector(build().apkBytes)
        val assets = inspector.data("assets/appfilter.xml").decodeToString()
        assertTrue(assets.contains("ComponentInfo{com.example.app1/com.example.app1.MainActivity}"))
        assertTrue(assets.contains("ComponentInfo{com.example.app1/.MainActivity}"))
        assertTrue(assets.contains("drawable=\"ic_com_example_app1\""))

        val binary = TestAxmlParser.parse(inspector.data("res/xml/appfilter.xml"))
        val binaryComponents = binary.root.children.map { it.attribute("component")!!.stringValue }
        assertEquals(6, binaryComponents.size)                       // 3 个图标 × 2 条映射
        assertTrue(binaryComponents.contains("ComponentInfo{com.example.app1/.MainActivity}"))

        // drawable.xml 只列「应用图标」，不含图标包自己的 ic_launcher（与导出 zip 的口径一致）
        val drawableList = TestAxmlParser.parse(inspector.data("res/xml/drawable.xml"))
        assertEquals(
            listOf("ic_com_example_app1", "ic_com_example_app2", "ic_com_example_app3"),
            drawableList.root.children.map { it.attribute("drawable")!!.stringValue!! }.sorted(),
        )
    }

    /** 用 apksig 的校验器验签：必须是 v2、且没有 v1 —— Android 8+ 就是看 v2。 */
    @Test
    fun apkV2SignatureVerifies() {
        val file = apkFile(build().apkBytes)
        val result = ApkVerifier.Builder(file).build().verify()
        assertTrue(result.errors.joinToString { it.issue.name }, result.isVerified)
        assertTrue("必须是 v2 签名", result.isVerifiedUsingV2Scheme)
        assertFalse("不需要 v1 签名", result.isVerifiedUsingV1Scheme)
        assertEquals(1, result.signerCertificates.size)
        assertTrue(result.errors.isEmpty())
    }

    /** PNG 数据不合法就跳过，绝不把一个装了也显示不出来的图标塞进包里。 */
    @Test
    fun invalidPngIsSkippedAndReported() {
        val list = icons(2) + IconPackApkBuilder.Icon(
            "com.bad/com.bad.Main", "com.bad", "坏的", ByteArray(100) { 7 },
        )
        val result = build(list)
        assertEquals(2, result.iconCount)
        assertEquals(listOf("com.bad"), result.skipped.map { it.packageName })
        assertNull(ZipInspector(result.apkBytes).entry("res/drawable-xxhdpi-v4/ic_com_bad.png"))
    }

    /** 两个包名规范化后撞名时要自动加后缀，否则资源名重复会让整张资源表废掉。 */
    @Test
    fun collidingResourceNamesGetSuffix() {
        val list = listOf(
            IconPackApkBuilder.Icon("com.a.b/c", "com.a.b", "x", TestPng.solid(8, 8, 1)),
            IconPackApkBuilder.Icon("com.a_b/c", "com.a_b", "y", TestPng.solid(8, 8, 2)),
        )
        val result = build(list)
        assertEquals(setOf("ic_com_a_b", "ic_com_a_b_2"), result.drawableNames.values.toSet())
        val keys = TestArscParser.parse(ZipInspector(result.apkBytes).data("resources.arsc"))
            .type("drawable")!!.entries.map { it.key }
        assertEquals(keys.distinct().size, keys.size)
    }

    /** 同样的输入必须产出同样的字节（ZIP 时间戳固定），便于排查与复现。 */
    @Test
    fun outputIsDeterministic() {
        val key = TestSigningKey.get()
        val dir = temp.newFolder()
        val options = IconPackApkBuilder.Options(label = "固定", launcherIconPng = TestPng.solid(8, 8, 3))
        val first = IconPackApkBuilder.build(icons(2), options, key, dir).apkBytes
        val second = IconPackApkBuilder.build(icons(2), options, key, dir).apkBytes
        assertTrue("两次打包结果不一致", first.contentEquals(second))
    }

    @Test
    fun invalidApplicationIdIsRejected() {
        try {
            IconPackApkBuilder.build(
                icons(1),
                IconPackApkBuilder.Options(applicationId = "com.appanalyzer.iconpack "),
                TestSigningKey.get(),
                temp.newFolder(),
            )
            org.junit.Assert.fail("应该抛异常")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("包名"))
        }
    }

    @Test
    fun emptyIconListStillProducesInstallableApk() {
        val result = build(emptyList())
        assertEquals(0, result.iconCount)
        val inspector = ZipInspector(result.apkBytes)
        assertNotNull(inspector.entry("resources.arsc"))
        assertNotNull(inspector.entry("AndroidManifest.xml"))
    }
}

/** 整个测试类共用一把签名钥匙：RSA-2048 生成一次要几百毫秒，没必要每个用例都来一遍。 */
object TestSigningKey {
    private var cached: SigningKey? = null

    @Synchronized
    fun get(): SigningKey = cached ?: SigningKey.generate("IconPack Unit Test").also { cached = it }
}
