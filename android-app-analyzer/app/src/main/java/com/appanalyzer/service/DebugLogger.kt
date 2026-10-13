package com.appanalyzer.service

import android.content.Context
import android.util.Log
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 文件持久化日志——不丢数据、只读最近 N 行到内存。
 *
 * 两点改进：
 * 1. 文件现在有体积上限并会自动轮转。原来注释里明写「无上限」，
 *    在长期使用中会把用户存储一点点吃满（每条 AI 响应还会截取 2000 字写进去）。
 * 2. 内存缓存从 MutableList 换成 ArrayDeque。原来的
 *    `while (size > 500) removeAt(0)` 每次都是 O(n) 的整体搬移。
 */
object DebugLogger {
    private const val MEMORY_LINES = 500

    /** 主日志文件体积上限；超过就轮转，旧内容保留为 .1 备份 */
    private const val MAX_FILE_BYTES = 2L * 1024 * 1024

    private val timeFormat = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)
    private var logFile: File? = null

    data class LogEntry(val time: String, val level: String, val message: String)

    private val memoryCache = ArrayDeque<LogEntry>()

    fun init(context: Context) {
        if (logFile != null) return
        val dir = context.getExternalFilesDir("logs") ?: context.filesDir
        dir.mkdirs()
        logFile = File(dir, "app_analyzer_debug.log")
        Log.d("AppAnalyzer", "日志文件: ${logFile!!.absolutePath}")
    }

    @Synchronized
    fun d(message: String) { write("D", message) }

    @Synchronized
    fun w(message: String) { write("W", message) }

    @Synchronized
    fun e(message: String, throwable: Throwable? = null) {
        val fullMsg = if (throwable != null) "$message | ${throwable.message}" else message
        write("E", fullMsg)
    }

    @Synchronized
    fun getEntries(): List<LogEntry> = memoryCache.toList()

    private fun backupFile(file: File) = File(file.parentFile, file.name + ".1")

    @Synchronized
    fun getFullText(): String {
        val file = logFile ?: return memoryCache.joinToString("\n") { "[${it.time}][${it.level}] ${it.message}" }
        return try {
            val backup = backupFile(file)
            val head = if (backup.exists()) backup.readText() else ""
            head + file.readText()
        } catch (_: Exception) {
            memoryCache.joinToString("\n") { "[${it.time}][${it.level}] ${it.message}" }
        }
    }

    /** 当前日志文件字节数（含轮转备份），供 UI 显示真实的磁盘占用 */
    @Synchronized
    fun getFileSizeBytes(): Long {
        val file = logFile ?: return 0L
        return try {
            file.length() + backupFile(file).length()
        } catch (_: Exception) { 0L }
    }

    /** 上限值，供 UI 显示 */
    fun getMaxFileBytes(): Long = MAX_FILE_BYTES

    @Synchronized
    fun clear() {
        memoryCache.clear()
        val file = logFile ?: return
        try { file.delete() } catch (_: Exception) {}
        try { backupFile(file).delete() } catch (_: Exception) {}
    }

    /**
     * 写文件的活儿丢到单独一条线程上做。
     *
     * 日志会从主线程被调用（Compose 的 LaunchedEffect、界面回调等），而 appendText 是
     * 实打实的文件 IO —— 每写一行就 open/close 一次文件。放主线程上就是卡顿来源。
     * 内存缓存仍然同步更新，所以日志页看到的内容不受影响；单线程执行器保证了顺序。
     */
    private val fileWriter = java.util.concurrent.Executors.newSingleThreadExecutor { r ->
        Thread(r, "DebugLogger-writer").apply { isDaemon = true }
    }

    private fun write(level: String, message: String) {
        val time = timeFormat.format(Date())
        val line = "[$time][$level] $message"
        Log.d("AppAnalyzer", line)

        memoryCache.addLast(LogEntry(time, level, message))
        // 只保留最近 MEMORY_LINES 行在内存
        while (memoryCache.size > MEMORY_LINES) {
            memoryCache.removeFirst()
        }

        val file = logFile ?: return
        fileWriter.execute {
            // 追加写入文件；超过上限先轮转，避免无限增长
            try {
                if (file.length() > MAX_FILE_BYTES) {
                    val backup = backupFile(file)
                    backup.delete()
                    file.renameTo(backup)
                }
                file.appendText(line + "\n")
            } catch (_: Exception) {}
        }
    }
}
