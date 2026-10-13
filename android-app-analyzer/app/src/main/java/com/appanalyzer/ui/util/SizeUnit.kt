package com.appanalyzer.ui.util

import java.util.Locale

enum class SizeUnit(val label: String, val divisor: Long) {
    B("B", 1),
    KB("KB", 1024),
    MB("MB", 1024 * 1024),
    GB("GB", 1024 * 1024 * 1024);

    fun format(bytes: Long): String {
        return when (this) {
            B -> "$bytes B"
            // 同样显式指定 Locale.US，避免德语环境出现 "1,5 MB"
            KB -> String.format(Locale.US, "%.1f KB", bytes / divisor.toDouble())
            MB -> String.format(Locale.US, "%.1f MB", bytes / divisor.toDouble())
            GB -> String.format(Locale.US, "%.2f GB", bytes / divisor.toDouble())
        }
    }
}
