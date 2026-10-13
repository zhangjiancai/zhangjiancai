package com.appanalyzer.data.model

data class StatisticsInfo(
    val totalApps: Int,
    val systemApps: Int,
    val userApps: Int,
    val totalSize: Long,
    val averageSize: Long,
    val maxSize: Long,
    val maxAppName: String,
    val minSize: Long,
    val minAppName: String,
    val totalCache: Long,
    val totalData: Long,
    /**
     * 缓存/数据是否为真实测量值。
     *
     * 没有「使用情况访问」权限时为 false：此时 [totalCache]/[totalData] 恒为 0，
     * UI 必须显示「—」并提示授权，绝不能显示 0 或估算值。
     */
    val hasSizeDetail: Boolean = false
)
