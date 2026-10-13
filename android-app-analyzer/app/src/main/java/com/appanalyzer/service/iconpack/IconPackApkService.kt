package com.appanalyzer.service.iconpack

import android.content.ContentValues
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import com.appanalyzer.service.IconPackExporter
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Android 侧的入口：把图标页生成好的图标，直接在手机里打成**可安装的图标包 APK**。
 *
 * 这里只负责 Android 相关的事：
 *  · 签名密钥的生成与持久化（放应用私有目录）；
 *  · 取本应用自己的图标当图标包的启动图标；
 *  · 把产物写进「下载」目录（Android 10+ 走 MediaStore，不需要存储权限）。
 * 真正的打包逻辑全在纯 JVM 的 [IconPackApkBuilder] 里。
 *
 * 典型调用（放在 IO 线程上跑）：
 *   val result = IconPackApkService(context).buildAndExport(entries, "App Analyzer Icons")
 */
class IconPackApkService(private val context: Context) {

    class BuildResult(
        val fileName: String,
        /** 人类可读的存放位置，直接拿去提示用户 */
        val location: String,
        val bytes: Long,
        val iconCount: Int,
        /** 被跳过的包名（PNG 数据不合法） */
        val skippedPackages: List<String>,
    )

    private val signingDir: File get() = File(context.filesDir, SIGNING_DIR_NAME)

    /**
     * 打包并签名，返回 APK 字节。不写文件，方便调用方自己决定存哪。
     *
     * @param entries 图标页的导出条目（与「导出图标包 zip」用的是同一份数据）
     * @param onProgress 进度文案回调，可能在工作线程被调用
     */
    fun buildApk(
        entries: List<IconPackExporter.Entry>,
        packName: String = IconPackApkBuilder.DEFAULT_LABEL,
        onProgress: ((String) -> Unit)? = null,
    ): IconPackApkBuilder.Result {
        require(entries.isNotEmpty()) { "没有可打包的图标" }
        onProgress?.invoke("准备签名密钥…")
        val signingKey = SigningKey.loadOrCreate(signingDir)
        onProgress?.invoke("生成清单与资源表…")
        val icons = entries.map {
            IconPackApkBuilder.Icon(
                component = it.component,
                packageName = it.packageName,
                appName = it.appName,
                pngBytes = it.pngBytes,
            )
        }
        val options = IconPackApkBuilder.Options(
            label = packName,
            launcherIconPng = loadOwnIconPng(),
        )
        val result = IconPackApkBuilder.build(icons, options, signingKey, context.cacheDir)
        onProgress?.invoke("签名…")
        return result
    }

    /** 打包 → 签名 → 写入「下载/AppAnalyzerIconPack/」。 */
    fun buildAndExport(
        entries: List<IconPackExporter.Entry>,
        packName: String = IconPackApkBuilder.DEFAULT_LABEL,
        onProgress: ((String) -> Unit)? = null,
    ): BuildResult {
        val result = buildApk(entries, packName, onProgress)
        val fileName = "AppAnalyzerIconPack_" +
            SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date()) + ".apk"
        onProgress?.invoke("写入文件…")
        val location = writeToDownloads(fileName, result.apkBytes)
        return BuildResult(
            fileName = fileName,
            location = location,
            bytes = result.apkBytes.size.toLong(),
            iconCount = result.iconCount,
            skippedPackages = result.skipped.map { it.packageName },
        )
    }

    /**
     * Android 10+ 用 MediaStore 写进公共「下载」目录，不需要任何存储权限；
     * 低版本回退到应用自己的外部私有目录（与「导出图标包 zip」的做法一致）。
     */
    private fun writeToDownloads(fileName: String, bytes: ByteArray): String {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, fileName)
                put(MediaStore.Downloads.MIME_TYPE, "application/vnd.android.package-archive")
                put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/" + DOWNLOAD_DIR_NAME)
            }
            val resolver = context.contentResolver
            val uri: Uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: throw IllegalStateException("无法在下载目录创建文件")
            resolver.openOutputStream(uri)?.use { it.write(bytes) } ?: throw IllegalStateException("写入失败")
            return "下载/$DOWNLOAD_DIR_NAME/$fileName"
        }
        val dir = File(context.getExternalFilesDir(null), "iconpack").also { it.mkdirs() }
        val file = File(dir, fileName)
        FileOutputStream(file).use { it.write(bytes) }
        return file.absolutePath
    }

    /** 用本应用自己的图标当图标包的启动图标（启动器的图标包列表里会显示它）。 */
    private fun loadOwnIconPng(): ByteArray? = try {
        val drawable = context.packageManager.getApplicationIcon(context.packageName)
        val size = LAUNCHER_ICON_SIZE
        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        drawable.setBounds(0, 0, size, size)
        drawable.draw(canvas)
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
        bitmap.recycle()
        out.toByteArray()
    } catch (e: Exception) {
        // 拿不到就用系统默认图标，不影响图标包本身能不能用
        null
    }

    companion object {
        private const val SIGNING_DIR_NAME = "iconpack-signing"
        private const val DOWNLOAD_DIR_NAME = "AppAnalyzerIconPack"
        private const val LAUNCHER_ICON_SIZE = 192
    }
}
