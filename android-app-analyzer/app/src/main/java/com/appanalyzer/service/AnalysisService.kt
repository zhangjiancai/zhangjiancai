package com.appanalyzer.service

import com.appanalyzer.data.model.AppInfo
import com.appanalyzer.data.model.StatisticsInfo

class AnalysisService {

    fun calculateStatistics(apps: List<AppInfo>): StatisticsInfo {
        if (apps.isEmpty()) {
            return StatisticsInfo(
                totalApps = 0,
                systemApps = 0,
                userApps = 0,
                totalSize = 0L,
                averageSize = 0L,
                maxSize = 0L,
                maxAppName = "",
                minSize = 0L,
                minAppName = "",
                totalCache = 0L,
                totalData = 0L,
                hasSizeDetail = false
            )
        }

        val systemApps = apps.count { it.isSystemApp }
        val userApps = apps.size - systemApps

        // totalSize = appSize + cacheSize + dataSize。
        // 这三个字段互不重叠：AppInfoService 已经从 StorageStats.dataBytes 里
        // 减掉了 cacheBytes（官方文档明确 dataBytes 含 cache），所以这里相加不会重复计算。
        // 无权限时 cacheSize/dataSize 恒为 0，totalSize 就等于各应用 APK 的真实体积之和。
        val totalSize = apps.sumOf { it.appSize + it.cacheSize + it.dataSize }
        // 缓存/数据是否为真值，取决于是否拿到了「使用情况访问」权限
        val hasDetail = apps.any { it.hasSizeDetail }
        val averageSize = totalSize / apps.size

        // 修复：用 totalSize 找最大/最小，不是 appSize
        val maxApp = apps.maxByOrNull { it.appSize + it.cacheSize + it.dataSize }!!
        val minApp = apps.filter { it.appSize + it.cacheSize + it.dataSize > 0 }
            .minByOrNull { it.appSize + it.cacheSize + it.dataSize } ?: apps[0]

        val totalCache = apps.sumOf { it.cacheSize }
        val totalData = apps.sumOf { it.dataSize }

        return StatisticsInfo(
            totalApps = apps.size,
            systemApps = systemApps,
            userApps = userApps,
            totalSize = totalSize,
            averageSize = averageSize,
            maxSize = maxApp.appSize + maxApp.cacheSize + maxApp.dataSize,
            maxAppName = maxApp.appName,
            minSize = minApp.appSize + minApp.cacheSize + minApp.dataSize,
            minAppName = minApp.appName,
            totalCache = totalCache,
            totalData = totalData,
            hasSizeDetail = hasDetail
        )
    }

    fun calculateSizeDistribution(apps: List<AppInfo>): Map<String, Int> {
        val distribution = mutableMapOf<String, Int>()

        apps.forEach { app ->
            // 修复：用 totalSize 不是 appSize
            val total = app.appSize + app.cacheSize + app.dataSize
            val sizeCategory = when {
                total < 10 * 1024 * 1024 -> "0-10MB"
                total < 50 * 1024 * 1024 -> "10-50MB"
                total < 100 * 1024 * 1024 -> "50-100MB"
                total < 500 * 1024 * 1024 -> "100-500MB"
                else -> ">500MB"
            }
            distribution[sizeCategory] = (distribution[sizeCategory] ?: 0) + 1
        }

        return distribution
    }
}
