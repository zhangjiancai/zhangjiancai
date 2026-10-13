package com.appanalyzer.service

import com.appanalyzer.data.model.AppInfo
import com.appanalyzer.testutil.NoConstructorFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * AppInfoService 里**不依赖 Android 框架**的那部分逻辑：AI 分类结果的落地。
 *
 * 为什么要绕这么一圈：AppInfoService 的构造函数要求 Context，并在构造时读
 * context.packageManager。单元测试用的 android.jar 是桩实现，方法一调用就抛
 * "not mocked"，所以直接 new 不出来。而 applyAiCategories 只做列表和 Map 的搬运，
 * 一个字段都不碰 —— 于是用 NoConstructorFactory 跳过构造函数拿实例来测它。
 * **没有改动任何 app/src/main 下的源码。**
 *
 * 未能覆盖（原因见交付报告）：
 * - smartClassify 是 private，且内部要调 ApplicationInfo.loadLabel(PackageManager)、
 *   PackageManager.queryIntentActivities、Build.VERSION.SDK_INT —— 纯 JVM 下必然 not mocked；
 * - getAllInstalledApps / loadAppIcon / hasStorageStatsPermission / hasAI 都要 Context；
 * - enhanceWithAI 依赖 DeepSeekService（网络）与 SharedPreferences。
 */
class AppInfoServiceTest {

    private val service: AppInfoService = NoConstructorFactory.allocate(AppInfoService::class.java)

    private fun app(name: String, pkg: String = "com.test." + name, category: String = "其他") = AppInfo(
        packageName = pkg,
        appName = name,
        versionName = "1.0",
        versionCode = 1L,
        isSystemApp = false,
        installTime = 0L,
        updateTime = 0L,
        appSize = 0L,
        cacheSize = 0L,
        dataSize = 0L,
        codeSize = 0L,
        targetSdkVersion = 34,
        minSdkVersion = 26,
        category = category
    )

    @Test
    fun `空分类表：不做任何改动，已分类数是 0`() {
        val apps = listOf(app("微信"), app("相机"))
        val (result, applied) = service.applyAiCategories(apps, emptyMap())
        assertEquals("没有拿到任何分类结果时，已分类数必须是 0", 0, applied)
        assertEquals("列表内容不能因为传了空 Map 而变化", apps, result)
    }

    @Test
    fun `命中的应用替换分类，未命中的应用保持原分类`() {
        val apps = listOf(app("微信", category = "其他"), app("相机", category = "拍照摄影"))
        val (result, applied) = service.applyAiCategories(apps, mapOf("微信" to "社交"))
        assertEquals("只有「微信」命中，已分类数应当是 1", 1, applied)
        assertEquals("命中的应用分类要换成 AI 给的分类", "社交", result[0].category)
        assertEquals("未命中的应用必须保留原来的启发式分类", "拍照摄影", result[1].category)
        assertEquals("只有 category 变，其余字段必须原样", apps[0].copy(category = "社交"), result[0])
        assertEquals("未命中的应用应当原样返回", apps[1], result[1])
    }

    @Test
    fun `不会就地修改传进来的原始列表和原始对象`() {
        val wechat = app("微信", category = "其他")
        val apps = listOf(wechat)
        val (result, _) = service.applyAiCategories(apps, mapOf("微信" to "社交"))
        assertNotSame("必须返回新的列表对象，调用方手里的旧列表不能被偷偷改掉", apps, result)
        assertEquals("返回的才带新分类", "社交", result[0].category)
        assertEquals("原始对象不能被就地改掉", "其他", wechat.category)
        assertEquals("原始列表里的元素分类也不能变", "其他", apps[0].category)
    }

    @Test
    fun `同名应用共享同一条映射：已分类数按应用个数算`() {
        // AI 只拿到应用名，同名应用必然同分类，所以两条记录一个名字也要都算已分类
        val apps = listOf(app("微信", pkg = "com.tencent.mm"), app("微信", pkg = "com.tencent.mm.clone"))
        val (result, applied) = service.applyAiCategories(apps, mapOf("微信" to "社交"))
        assertEquals("两个同名应用都要计入已分类", 2, applied)
        assertTrue("两个同名应用都要拿到分类", result.all { it.category == "社交" })
    }

    @Test
    fun `已分类数按命中的应用算，不按映射条数算`() {
        val apps = listOf(app("微信"), app("相机"))
        val categories = mapOf(
            "微信" to "社交",
            "相机" to "拍照摄影",
            "这个应用根本没装" to "游戏"
        )
        val (_, applied) = service.applyAiCategories(apps, categories)
        assertEquals("映射里有 3 条，但只有 2 个应用命中，展示给用户的必须是 2", 2, applied)
    }
}
