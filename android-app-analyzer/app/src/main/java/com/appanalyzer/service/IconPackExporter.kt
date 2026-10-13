package com.appanalyzer.service

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/**
 * 把生成好的图标导出成「图标包源码包」（一个 ZIP）。
 *
 * 为什么是 ZIP 而不是直接产出可安装的 APK：
 * 图标包 APK 需要 res/drawable 里的资源被 aapt2 编译进 resources.arsc，而 Android 应用在
 * 运行时**没有** aapt2，也无法凭空生成 resources.arsc。所以这里导出标准的图标包工程结构，
 * 由电脑上的 :iconpack Gradle 模块用标准工具链打成 APK。
 *
 * 产出的 ZIP 结构（与 iconpack 模块的约定一致）：
 *   meta.json
 *   assets/appfilter.xml          启动器真正读的那份
 *   assets/drawable.xml
 *   res/xml/appfilter.xml         部分图标包面板读这份，内容相同
 *   res/xml/drawable.xml
 *   res/drawable-xxhdpi/ic_xxx.png
 */
class IconPackExporter(private val context: Context) {

    data class Entry(
        /** 形如 com.tencent.mm/com.tencent.mm.ui.LauncherUI */
        val component: String,
        val packageName: String,
        val appName: String,
        /** 已生成图标的 PNG 字节 */
        val pngBytes: ByteArray
    )

    data class Result(val fileName: String, val location: String, val bytes: Long, val iconCount: Int)

    /** 包名 → 合法的 Android 资源名（只能小写字母/数字/下划线，且不能以数字开头） */
    private fun drawableNameOf(packageName: String): String {
        val sanitized = packageName.lowercase().map { c ->
            if (c.isLetterOrDigit() && c.code < 128) c else '_'
        }.joinToString("")
        return "ic_" + sanitized.trim('_')
    }

    private fun xmlEscape(s: String): String = s
        .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        .replace("\"", "&quot;")

    /**
     * appfilter.xml。
     *
     * 同一个图标写两条映射：一条用完整组件名，一条用「包名/.Activity」缩写形式。
     * 不同启动器对 ComponentInfo 的匹配方式不完全一致，两条都写能显著提高命中率，
     * 这也是主流图标包的实际做法。
     */
    private fun buildAppFilter(entries: List<Entry>): String {
        val sb = StringBuilder()
        sb.append("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n")
        sb.append("<resources>\n")
        for (e in entries.sortedBy { it.packageName }) {
            val name = drawableNameOf(e.packageName)
            val full = "ComponentInfo{${e.component}}"
            sb.append("    <item component=\"${xmlEscape(full)}\" drawable=\"$name\"/>\n")
            // 缩写形式：com.foo.bar/com.foo.bar.MainActivity -> com.foo.bar/.MainActivity
            val pkg = e.packageName
            val activity = e.component.substringAfter('/', "")
            if (activity.startsWith("$pkg.")) {
                val short = "ComponentInfo{$pkg/.${activity.removePrefix("$pkg.")}}"
                sb.append("    <item component=\"${xmlEscape(short)}\" drawable=\"$name\"/>\n")
            }
        }
        sb.append("</resources>\n")
        return sb.toString()
    }

    private fun buildDrawableXml(entries: List<Entry>): String {
        val sb = StringBuilder()
        sb.append("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n")
        sb.append("<resources>\n")
        for (e in entries.sortedBy { it.packageName }) {
            sb.append("    <item drawable=\"${drawableNameOf(e.packageName)}\"/>\n")
        }
        sb.append("</resources>\n")
        return sb.toString()
    }

    fun buildZipBytes(entries: List<Entry>, packName: String, author: String): ByteArray {
        val appFilter = buildAppFilter(entries)
        val drawableXml = buildDrawableXml(entries)
        val stamp = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).format(Date())

        val out = java.io.ByteArrayOutputStream()
        ZipOutputStream(out).use { zip ->
            fun put(name: String, content: ByteArray) {
                zip.putNextEntry(ZipEntry(name))
                zip.write(content)
                zip.closeEntry()
            }
            fun putText(name: String, text: String) = put(name, text.toByteArray(Charsets.UTF_8))

            val meta = "{\n" +
                "  \"packName\": \"${packName.replace("\"", "'")}\",\n" +
                "  \"author\": \"${author.replace("\"", "'")}\",\n" +
                "  \"generatedAt\": \"$stamp\",\n" +
                "  \"iconCount\": ${entries.size}\n" +
                "}\n"
            putText("meta.json", meta)
            putText("assets/appfilter.xml", appFilter)
            putText("assets/drawable.xml", drawableXml)
            putText("res/xml/appfilter.xml", appFilter)
            putText("res/xml/drawable.xml", drawableXml)
            putText(
                "README.txt",
                "图标包源码包 —— 由 App Analyzer 生成（${entries.size} 个图标，$stamp）\n\n" +
                    "用法：\n" +
                    "  1. 把本压缩包解压到  android-app-analyzer/iconpack/src/main/generated/\n" +
                    "     （解压后该目录下应直接出现 assets/ 与 res/ 两个文件夹）\n" +
                    "  2. 在项目根目录执行：gradlew :iconpack:assembleDebug\n" +
                    "  3. 安装 iconpack/build/outputs/apk/debug/iconpack-debug.apk\n" +
                    "  4. 在启动器的「图标包 / 主题」设置里选中它\n\n" +
                    "注意：只有支持第三方图标包的启动器才能用（Nova、Smart Launcher、ADW、\n" +
                    "Lawnchair、Apex、GO 等）。Pixel 原生启动器不支持图标包，装上也选不了。\n"
            )

            for (e in entries) {
                put("res/drawable-xxhdpi/${drawableNameOf(e.packageName)}.png", e.pngBytes)
            }
        }
        return out.toByteArray()
    }

    /**
     * 导出到公共「下载」目录（Android 10+ 走 MediaStore，不需要存储权限），
     * 低版本回退到应用外部私有目录。
     */
    fun export(entries: List<Entry>, packName: String, author: String): Result {
        val bytes = buildZipBytes(entries, packName, author)
        val fileName = "IconPack_" + SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date()) + ".zip"

        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, fileName)
                put(MediaStore.Downloads.MIME_TYPE, "application/zip")
                put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/AppAnalyzerIconPack")
            }
            val uri: Uri? = context.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            if (uri == null) throw IllegalStateException("无法在下载目录创建文件")
            context.contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
                ?: throw IllegalStateException("写入失败")
            Result(fileName, "下载/AppAnalyzerIconPack/$fileName", bytes.size.toLong(), entries.size)
        } else {
            val dir = File(context.getExternalFilesDir(null), "iconpack").also { it.mkdirs() }
            val file = File(dir, fileName)
            FileOutputStream(file).use { it.write(bytes) }
            Result(fileName, file.absolutePath, bytes.size.toLong(), entries.size)
        }
    }
}
