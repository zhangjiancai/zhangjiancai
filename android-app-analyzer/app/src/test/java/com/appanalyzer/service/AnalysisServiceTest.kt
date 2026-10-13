package com.appanalyzer.service

import com.appanalyzer.data.model.AppInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * AnalysisService 的纯 JVM 测试：统计汇总与体积分布。
 *
 * 这个类不碰 android.*，所以不需要模拟器/Robolectric。
 * 期望值全部按源码里的口径手算：单个应用体积 = appSize + cacheSize + dataSize。
 */
class AnalysisServiceTest {

    private val service = AnalysisService()

    private val mb = 1024L * 1024

    private fun app(
        name: String,
        appSize: Long = 0L,
        cacheSize: Long = 0L,
        dataSize: Long = 0L,
        isSystem: Boolean = false,
        hasDetail: Boolean = false
    ) = AppInfo(
        packageName = "com.test." + name,
        appName = name,
        versionName = "1.0",
        versionCode = 1L,
        isSystemApp = isSystem,
        installTime = 0L,
        updateTime = 0L,
        appSize = appSize,
        cacheSize = cacheSize,
        dataSize = dataSize,
        codeSize = appSize,
        targetSdkVersion = 34,
        minSdkVersion = 26,
        category = "其他",
        hasSizeDetail = hasDetail
    )

    // ==================== calculateStatistics ====================

    @Test
    fun `空列表：全部统计值为 0，名称是空串，不抛异常`() {
        val s = service.calculateStatistics(emptyList())
        assertEquals("空列表的 totalApps 必须是 0", 0, s.totalApps)
        assertEquals("空列表的 systemApps 必须是 0", 0, s.systemApps)
        assertEquals("空列表的 userApps 必须是 0", 0, s.userApps)
        assertEquals("空列表的 totalSize 必须是 0", 0L, s.totalSize)
        assertEquals("空列表的 averageSize 必须是 0（不能除以 0 崩溃）", 0L, s.averageSize)
        assertEquals("空列表的 maxSize 必须是 0", 0L, s.maxSize)
        assertEquals("空列表的 maxAppName 必须是空串", "", s.maxAppName)
        assertEquals("空列表的 minSize 必须是 0", 0L, s.minSize)
        assertEquals("空列表的 minAppName 必须是空串", "", s.minAppName)
        assertEquals("空列表的 totalCache 必须是 0", 0L, s.totalCache)
        assertEquals("空列表的 totalData 必须是 0", 0L, s.totalData)
        assertFalse("空列表的 hasSizeDetail 必须是 false", s.hasSizeDetail)
    }

    @Test
    fun `系统应用与用户应用的数量应当互补`() {
        val apps = listOf(
            app("系统1", isSystem = true),
            app("系统2", isSystem = true),
            app("用户1"),
            app("用户2"),
            app("用户3")
        )
        val s = service.calculateStatistics(apps)
        assertEquals("总数应当是 5", 5, s.totalApps)
        assertEquals("系统应用应当是 2 个", 2, s.systemApps)
        assertEquals("用户应用应当是 3 个 = 总数 - 系统应用", 3, s.userApps)
    }

    @Test
    fun `totalSize 是三项体积之和，缓存与数据各自单独汇总`() {
        val apps = listOf(
            app("A", appSize = 100, cacheSize = 10, dataSize = 1),
            app("B", appSize = 200, cacheSize = 20, dataSize = 2)
        )
        val s = service.calculateStatistics(apps)
        assertEquals("totalSize 应当是 (100+10+1)+(200+20+2)=333", 333L, s.totalSize)
        assertEquals("totalCache 应当是 10+20=30", 30L, s.totalCache)
        assertEquals("totalData 应当是 1+2=3", 3L, s.totalData)
    }

    @Test
    fun `averageSize 用总体积整除应用个数，向下取整`() {
        val apps = listOf(app("A", appSize = 3), app("B", appSize = 4), app("C", appSize = 4))
        val s = service.calculateStatistics(apps)
        assertEquals("totalSize 应当是 11", 11L, s.totalSize)
        assertEquals("11 / 3 应当向下取整成 3，而不是四舍五入成 4", 3L, s.averageSize)
    }

    @Test
    fun `最大应用按总体积取，而不是只看 APK 体积`() {
        // A 的 APK 更大，但 B 的数据目录更大 —— 最大值必须落在 B 上
        val apps = listOf(
            app("A", appSize = 1000),
            app("B", appSize = 10, dataSize = 5000)
        )
        val s = service.calculateStatistics(apps)
        assertEquals("maxSize 应当是 B 的 10+5000=5010", 5010L, s.maxSize)
        assertEquals("maxAppName 应当是 B", "B", s.maxAppName)
    }

    @Test
    fun `最小应用会跳过体积为 0 的条目`() {
        val apps = listOf(
            app("零体积"),
            app("大", appSize = 5000),
            app("小", appSize = 7)
        )
        val s = service.calculateStatistics(apps)
        assertEquals("minSize 应当取到唯一的非零最小值 7", 7L, s.minSize)
        assertEquals("minAppName 应当是体积非零的「小」，不能是 0 体积的条目", "小", s.minAppName)
    }

    @Test
    fun `全部体积为 0 时最小应用回退到列表第一个`() {
        val apps = listOf(app("第一个"), app("第二个"), app("第三个"))
        val s = service.calculateStatistics(apps)
        assertEquals("没有任何非零条目时 minSize 只能是 0", 0L, s.minSize)
        assertEquals("没有任何非零条目时 minAppName 回退到列表第一个", "第一个", s.minAppName)
    }

    @Test
    fun `hasSizeDetail 只要有任意一个应用是真实读数就为 true`() {
        val mixed = listOf(app("A"), app("B", hasDetail = true))
        assertTrue(
            "只要有一个应用拿到真实读数，hasSizeDetail 就该是 true",
            service.calculateStatistics(mixed).hasSizeDetail
        )
        val none = listOf(app("A"), app("B"))
        assertFalse(
            "全部是未授权/读不到时 hasSizeDetail 必须是 false",
            service.calculateStatistics(none).hasSizeDetail
        )
    }

    @Test
    fun `单个应用：平均、最大、最小都等于它自己`() {
        val s = service.calculateStatistics(listOf(app("独苗", appSize = 100, cacheSize = 20, dataSize = 3)))
        assertEquals("totalSize 应当是 123", 123L, s.totalSize)
        assertEquals("只有一个应用时 averageSize 就是它自己", 123L, s.averageSize)
        assertEquals("maxSize 应当是 123", 123L, s.maxSize)
        assertEquals("minSize 应当是 123", 123L, s.minSize)
        assertEquals("maxAppName 应当是「独苗」", "独苗", s.maxAppName)
        assertEquals("minAppName 应当是「独苗」", "独苗", s.minAppName)
    }

    // ==================== calculateSizeDistribution ====================

    private fun distributionOf(apps: List<AppInfo>) = service.calculateSizeDistribution(apps)

    private val knownBuckets = setOf("0-10MB", "10-50MB", "50-100MB", "100-500MB", ">500MB")

    @Test
    fun `空列表的分布是空 Map`() {
        val d = distributionOf(emptyList())
        assertTrue("空列表应当返回空 Map，实际是 " + d, d.isEmpty())
    }

    @Test
    fun `分档边界：刚好等于阈值时进入下一档`() {
        val d = distributionOf(
            listOf(
                app("零", appSize = 0),
                app("差一字节到10MB", appSize = 10 * mb - 1),
                app("正好10MB", appSize = 10 * mb),
                app("差一字节到50MB", appSize = 50 * mb - 1),
                app("正好50MB", appSize = 50 * mb),
                app("差一字节到100MB", appSize = 100 * mb - 1),
                app("正好100MB", appSize = 100 * mb),
                app("差一字节到500MB", appSize = 500 * mb - 1),
                app("正好500MB", appSize = 500 * mb)
            )
        )
        assertEquals("0-10MB 档应当有 2 个（0 和 10MB-1）", 2, d["0-10MB"] ?: 0)
        assertEquals("10-50MB 档应当有 2 个（10MB 和 50MB-1）", 2, d["10-50MB"] ?: 0)
        assertEquals("50-100MB 档应当有 2 个（50MB 和 100MB-1）", 2, d["50-100MB"] ?: 0)
        assertEquals("100-500MB 档应当有 2 个（100MB 和 500MB-1）", 2, d["100-500MB"] ?: 0)
        assertEquals(">500MB 档应当有 1 个（正好 500MB）", 1, d[">500MB"] ?: 0)
        assertEquals("各档计数之和必须等于应用总数 9", 9, d.values.sum())
        assertTrue("出现了预期之外的档位：" + d.keys, knownBuckets.containsAll(d.keys))
    }

    @Test
    fun `分档看的是总体积：APK 很小但数据很大时进大档`() {
        val d = distributionOf(listOf(app("数据大户", appSize = mb, dataSize = 600 * mb)))
        assertEquals("1MB APK + 600MB 数据应当落在 >500MB", 1, d[">500MB"] ?: 0)
        assertFalse("不能再出现在 0-10MB 档（只看 appSize 就会算错）", d.containsKey("0-10MB"))
    }

    @Test
    fun `负数与超大体积都会被计入，计数总和始终等于应用数`() {
        val apps = listOf(
            app("负数（异常读数）", appSize = -1),
            app("1TB", appSize = 1024L * mb * 1024),
            app("普通", appSize = 30 * mb)
        )
        val d = distributionOf(apps)
        assertEquals("负数体积按源码的 < 10MB 判断归入 0-10MB", 1, d["0-10MB"] ?: 0)
        assertEquals("1TB 归入 >500MB", 1, d[">500MB"] ?: 0)
        assertEquals("30MB 归入 10-50MB", 1, d["10-50MB"] ?: 0)
        assertEquals("所有档位计数之和必须等于应用总数 3", 3, d.values.sum())
    }
}
