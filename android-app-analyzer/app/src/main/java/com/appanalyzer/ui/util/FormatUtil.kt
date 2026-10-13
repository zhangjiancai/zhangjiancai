package com.appanalyzer.ui.util

import java.util.Locale

/** 体积不可用时的占位符。不要用 0 或估算值冒充真实读数。 */
const val UNKNOWN_SIZE = "—"

/**
 * 格式化字节数。
 *
 * 显式使用 Locale.US：以前用的是 String.format 的默认 Locale，
 * 在德语/法语等环境会输出 "1,5 MB" 这种带逗号的数字，看起来像千分位分隔符。
 */
fun formatFileSize(bytes: Long): String = when {
    bytes < 0 -> UNKNOWN_SIZE
    bytes < 1024 -> "$bytes B"
    bytes < 1024 * 1024 -> String.format(Locale.US, "%.1f KB", bytes / 1024.0)
    bytes < 1024 * 1024 * 1024 -> String.format(Locale.US, "%.1f MB", bytes / (1024.0 * 1024))
    else -> String.format(Locale.US, "%.1f GB", bytes / (1024.0 * 1024 * 1024))
}

/**
 * 只有 [known] 为 true 时才显示数字，否则显示 [UNKNOWN_SIZE]。
 *
 * 用来表达「读不到」和「真的是 0」的区别：没有「使用情况访问」权限时
 * 缓存/数据读不到，显示 0 会被理解成「这个应用没有缓存」，那是错的。
 */
fun formatFileSizeOrUnknown(bytes: Long, known: Boolean): String =
    if (known) formatFileSize(bytes) else UNKNOWN_SIZE
