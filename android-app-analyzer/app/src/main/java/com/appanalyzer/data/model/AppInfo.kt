package com.appanalyzer.data.model

data class AppInfo(
    val packageName: String,
    val appName: String,
    val versionName: String,
    val versionCode: Long,
    val isSystemApp: Boolean,
    val installTime: Long,
    val updateTime: Long,
    val appSize: Long,
    val cacheSize: Long,
    val dataSize: Long,
    val codeSize: Long,
    val targetSdkVersion: Int,
    val minSdkVersion: Int,
    val category: String,
    val iconBase64: String? = null,  // 应用图标 Base64 编码，默认null（按需加载）
    /**
     * 缓存/数据大小是否为真实测量值。
     *
     * 仅在获得「使用情况访问」权限、且 StorageStatsManager 查询成功时为 true。
     * 为 false 时 cacheSize/dataSize 一律为 0，UI 必须显示「—」而不是 0 或估算值。
     */
    val hasSizeDetail: Boolean = false
)
