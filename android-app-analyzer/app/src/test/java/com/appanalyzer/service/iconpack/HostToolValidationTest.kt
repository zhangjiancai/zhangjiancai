package com.appanalyzer.service.iconpack

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume
import org.junit.BeforeClass
import org.junit.Test
import java.io.File

/**
 * 用**真工具**验证产出的 APK：aapt2（解析 AXML + resources.arsc）与 zipalign（对齐检查）。
 *
 * 这两个工具正是 Android 构建链上的原件，aapt2 能完整读出来就说明二进制格式没写错；
 * 机器上没装 Android SDK 时整个类会被跳过（Assume），不会拖累别人的构建。
 *
 * 顺带把产物写到 app/build/tmp/iconpack-host-validation/ 下，方便手动 adb install 验证。
 */
class HostToolValidationTest {

    companion object {
        private var aapt2: File? = null
        private var zipalign: File? = null

        @BeforeClass
        @JvmStatic
        fun locateTools() {
            aapt2 = findBuildTool("aapt2" + EXE)
            zipalign = findBuildTool("zipalign" + EXE)
            println("[host-validation] aapt2 = $aapt2")
            println("[host-validation] zipalign = $zipalign")
        }

        private val EXE =
            if (System.getProperty("os.name")?.lowercase()?.contains("win") == true) ".exe" else ""

        private fun sdkDir(): File? {
            val candidates = listOfNotNull(
                System.getenv("ANDROID_HOME"),
                System.getenv("ANDROID_SDK_ROOT"),
                System.getenv("LOCALAPPDATA")?.let { "$it\\Android\\Sdk" },
                System.getenv("HOME")?.let { "$it/Android/Sdk" },
            )
            return candidates.map { File(it) }.firstOrNull { it.isDirectory }
        }

        private fun findBuildTool(name: String): File? {
            val sdk = sdkDir() ?: return null
            val buildTools = File(sdk, "build-tools")
            return buildTools.listFiles()
                ?.sortedByDescending { it.name }
                ?.map { File(it, name) }
                ?.firstOrNull { it.isFile }
        }
    }

    /** 打包一个 3 图标的样例 APK，落到 build/tmp 下（供 adb install 复验）。 */
    private fun buildSampleApk(): File {
        val dir = File(System.getProperty("user.dir"), "build/tmp/iconpack-host-validation")
        dir.mkdirs()
        val result = IconPackApkBuilder.build(
            icons = listOf(
                IconPackApkBuilder.Icon(
                    "com.tencent.mm/com.tencent.mm.ui.LauncherUI",
                    "com.tencent.mm", "微信", TestPng.solid(96, 96, 0x07C160),
                ),
                IconPackApkBuilder.Icon(
                    "com.example.app/com.example.app.MainActivity",
                    "com.example.app", "示例", TestPng.solid(96, 96, 0x336699),
                ),
                IconPackApkBuilder.Icon(
                    "com.android.settings/com.android.settings.Settings",
                    "com.android.settings", "设置", TestPng.solid(96, 96, 0x888888),
                ),
            ),
            options = IconPackApkBuilder.Options(
                label = "App Analyzer Icons",
                launcherIconPng = TestPng.solid(96, 96, 0xFF6600),
            ),
            signingKey = TestSigningKey.get(),
            workDir = dir,
        )
        val file = File(dir, "iconpack-validation.apk")
        file.writeBytes(result.apkBytes)
        println("[host-validation] APK = ${file.absolutePath} (${file.length()} bytes)")
        return file
    }

    private fun run(vararg command: String): String {
        val process = ProcessBuilder(*command).redirectErrorStream(true).start()
        val output = process.inputStream.readBytes().decodeToString()
        val code = process.waitFor()
        println("[host-validation] $ ${command.joinToString(" ")}")
        println(output)
        println("[host-validation] exit=$code")
        lastExitCode = code
        return output
    }

    private var lastExitCode: Int = -1

    /** aapt2 dump badging：包名、版本、label、sdk 版本都要对得上。 */
    @Test
    fun aapt2BadgingMatchesOptions() {
        val tool = aapt2
        Assume.assumeTrue("本机没有 aapt2，跳过", tool != null)
        val apk = buildSampleApk()
        val output = run(tool!!.absolutePath, "dump", "badging", apk.absolutePath)

        assertEquals("aapt2 dump badging 应当成功", 0, lastExitCode)
        assertTrue(output, output.contains("package: name='com.appanalyzer.iconpack'"))
        // build-tools 34 的 aapt2 打印 sdkVersion，36 打印 minSdkVersion —— 同一个清单，只是叫法变了
        assertTrue(output, output.contains("sdkVersion:'26'") || output.contains("minSdkVersion:'26'"))
        assertTrue(output, output.contains("targetSdkVersion:'34'"))
        assertTrue(output, output.contains("application-label:'App Analyzer Icons'"))
    }

    /** aapt2 dump xmltree：六个图标包 action + DEFAULT 分类 + hasCode=false 都在。 */
    @Test
    fun aapt2XmlTreeContainsEveryThemeAction() {
        val tool = aapt2
        Assume.assumeTrue("本机没有 aapt2，跳过", tool != null)
        val apk = buildSampleApk()
        val output = run(tool!!.absolutePath, "dump", "xmltree", "--file", "AndroidManifest.xml", apk.absolutePath)

        assertEquals(0, lastExitCode)
        for (action in IconPackApkBuilder.THEME_ACTIONS) {
            assertTrue("清单里缺少 action: $action", output.contains(action))
        }
        assertTrue(output, output.contains("android.intent.category.DEFAULT"))
        assertTrue(output, output.contains("hasCode(0x0101000c)=false"))
        assertTrue(output, output.contains("exported(0x01010010)=true"))
        assertTrue(output, output.contains("android.app.Activity"))
    }

    /** aapt2 dump resources：资源表能被解析，两个类型与全部图标都在。 */
    @Test
    fun aapt2ReadsResourceTable() {
        val tool = aapt2
        Assume.assumeTrue("本机没有 aapt2，跳过", tool != null)
        val apk = buildSampleApk()
        val output = run(tool!!.absolutePath, "dump", "resources", apk.absolutePath)

        assertEquals(0, lastExitCode)
        assertTrue(output, output.contains("drawable/ic_com_tencent_mm"))
        assertTrue(output, output.contains("drawable/ic_launcher"))
        assertTrue(output, output.contains("xml/appfilter"))
        assertTrue(output, output.contains("res/drawable-xxhdpi-v4/ic_com_tencent_mm.png"))
        assertTrue(output, output.contains("com.appanalyzer.iconpack"))
    }

    /** zipalign -c：全部条目必须满足 4 字节对齐（Android 11+ 装机的硬性要求）。 */
    @Test
    fun zipalignVerificationPasses() {
        val tool = zipalign
        Assume.assumeTrue("本机没有 zipalign，跳过", tool != null)
        val apk = buildSampleApk()
        val output = run(tool!!.absolutePath, "-c", "-v", "4", apk.absolutePath)
        assertEquals("zipalign 校验失败:\n$output", 0, lastExitCode)
    }
}
