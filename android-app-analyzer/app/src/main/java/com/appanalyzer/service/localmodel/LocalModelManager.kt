package com.appanalyzer.service.localmodel

import android.content.Context
import com.appanalyzer.service.DebugLogger
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * 本地模型的按需下载与存放。
 *
 * 「按需」的含义：**用户想跑哪个模型才下哪个**，不预置、不打包进 APK。
 * 模型放在应用私有目录 `files/models/`，可以单独删除。
 */
class LocalModelManager(private val context: Context) {

    private val dir: File by lazy { File(context.filesDir, "models").also { it.mkdirs() } }

    /** 下载用的客户端：模型动辄上百 MB，读超时给足 */
    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.MINUTES)
        .build()

    fun fileOf(spec: ModelSpec): File = File(dir, spec.fileName)

    /** 已下载且大小对得上才算可用 */
    fun isReady(spec: ModelSpec): Boolean {
        val f = fileOf(spec)
        return f.exists() && f.length() == spec.sizeBytes
    }

    fun downloadedBytes(spec: ModelSpec): Long = fileOf(spec).let { if (it.exists()) it.length() else 0L }

    fun delete(spec: ModelSpec): Boolean = try { fileOf(spec).delete() } catch (e: Exception) { false }

    /**
     * 下载模型。
     *
     * 先下到 `.part` 临时文件，大小校验通过后再改名 —— 这样中途断网不会留下
     * 一个"看起来存在但实际是半截"的模型文件（那种情况后面加载时会很难排查）。
     *
     * @param onProgress (已下载字节, 总字节)
     */
    suspend fun download(spec: ModelSpec, onProgress: (Long, Long) -> Unit): Result<File> =
        withContext(Dispatchers.IO) {
            val target = fileOf(spec)
            val part = File(dir, spec.fileName + ".part")
            try {
                if (target.exists() && target.length() == spec.sizeBytes) return@withContext Result.success(target)
                part.delete()

                val req = Request.Builder().url(spec.url).get().build()
                client.newCall(req).execute().use { resp ->
                    if (!resp.isSuccessful) {
                        return@withContext Result.failure(Exception("下载失败：HTTP ${resp.code}"))
                    }
                    val total = resp.body?.contentLength()?.takeIf { it > 0 } ?: spec.sizeBytes
                    resp.body?.byteStream()?.use { input ->
                        part.outputStream().use { output ->
                            val buf = ByteArray(64 * 1024)
                            var done = 0L
                            var lastReport = 0L
                            while (true) {
                                val n = input.read(buf)
                                if (n < 0) break
                                output.write(buf, 0, n)
                                done += n
                                // 每 256KB 回报一次，避免刷爆 UI
                                if (done - lastReport >= 256 * 1024) {
                                    lastReport = done
                                    onProgress(done, total)
                                }
                            }
                            onProgress(done, total)
                        }
                    }
                }

                val got = part.length()
                if (got != spec.sizeBytes) {
                    part.delete()
                    return@withContext Result.failure(
                        Exception("下载不完整：期望 ${spec.sizeBytes} 字节，实际 $got 字节")
                    )
                }
                if (target.exists()) target.delete()
                if (!part.renameTo(target)) {
                    part.delete()
                    return@withContext Result.failure(Exception("无法保存模型文件"))
                }
                DebugLogger.d("[本地模型] ${spec.name} 下载完成，${got / 1024 / 1024} MB")
                Result.success(target)
            } catch (e: Exception) {
                DebugLogger.e("[本地模型] 下载失败", e)
                try { part.delete() } catch (_: Exception) {}
                Result.failure(e)
            }
        }

    fun totalDownloadedBytes(): Long =
        LocalModelCatalog.all.sumOf { downloadedBytes(it) }
}
