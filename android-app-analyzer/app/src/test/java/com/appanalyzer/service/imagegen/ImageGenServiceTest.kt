package com.appanalyzer.service.imagegen

import com.appanalyzer.service.PreferencesManager
import com.appanalyzer.service.localmodel.LocalModelCatalog
import com.appanalyzer.testutil.NoConstructorFactory
import com.appanalyzer.testutil.newPreferencesManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ImageGenService 里**只依赖偏好设置**的那部分：提示词拼接、服务商配置、引擎判断。
 *
 * 为什么绕一圈：它的构造函数要求 PreferencesManager / IconReplaceService / StyleLibrary /
 * LocalModelManager / StyleModelStore，这些都要 Context，纯 JVM 下 new 不出来。
 * 被测试的这些方法只读 prefs 一个字段，所以用 NoConstructorFactory 跳过构造函数，
 * 再把一个「内存版 SharedPreferences」的 PreferencesManager 注进去。
 * **没有改动任何 app/src/main 下的源码。**
 *
 * 未能覆盖（原因见交付报告）：generate / generateLocal / generateLocalModel / blend
 * 依赖 Bitmap、ONNX、网络；currentStyleRef / warmUpModel 依赖 StyleLibrary、StyleModelStore。
 */
class ImageGenServiceTest {

    private fun serviceWith(values: Map<String, Any?>): ImageGenService {
        val svc = NoConstructorFactory.allocate(ImageGenService::class.java)
        NoConstructorFactory.setField(svc, "prefs", newPreferencesManager(values))
        return svc
    }

    private fun serviceOf(providerId: String): ImageGenService =
        serviceWith(mapOf(PreferencesManager.KEY_IMG_PROVIDER to providerId))

    private val fixedTail = "画面要求：正方形构图，主体居中，四周留出安全边距；" +
        "画面中不要出现任何文字、字母或数字；不要加外边框和额外圆角遮罩；" +
        "确保缩小到桌面图标尺寸（约 48-192 像素）后依然清晰可辨。"

    // ==================== buildPrompt ====================

    @Test
    fun `没有风格描述时用默认句式，固定要求逐字拼接`() {
        val prompt = serviceOf(GeminiImageProvider.id).buildPrompt("微信", "", "")
        val expected = "这是手机应用「微信」的图标。" +
            "请保持主体可辨识，为它设计一个更精致的新图标。" + fixedTail
        assertEquals("提示词必须逐字等于源码里拼好的那一段", expected, prompt)
    }

    @Test
    fun `有风格描述时替换默认句式，并且去掉首尾空白`() {
        val prompt = serviceOf(GeminiImageProvider.id).buildPrompt("相机", "  赛博朋克霓虹  ", "")
        val expected = "这是手机应用「相机」的图标。" +
            "请保持主体可辨识，把它改造成这样的风格：赛博朋克霓虹。" + fixedTail
        assertEquals("风格描述应当被 trim 后嵌进「把它改造成这样的风格：X。」", expected, prompt)
        assertFalse("有风格描述时不能再出现默认句式", prompt.contains("为它设计一个更精致的新图标"))
    }

    @Test
    fun `纯空白的风格描述等同于没填`() {
        val blank = serviceOf(GeminiImageProvider.id).buildPrompt("相机", "   \n\t ", "")
        val none = serviceOf(GeminiImageProvider.id).buildPrompt("相机", "", "")
        assertEquals("全空白字符串必须走默认句式", none, blank)
        assertTrue("应当出现默认句式", blank.contains("为它设计一个更精致的新图标。"))
    }

    @Test
    fun `额外要求 trim 后拼在最后`() {
        val prompt = serviceOf(GeminiImageProvider.id).buildPrompt("相机", "", "  加一点金色  ")
        assertTrue("额外要求必须紧跟在固定要求之后：" + prompt, prompt.endsWith(fixedTail + "额外要求：加一点金色"))
    }

    @Test
    fun `纯空白的额外要求不追加那一段`() {
        val withBlank = serviceOf(GeminiImageProvider.id).buildPrompt("相机", "", "   ")
        val without = serviceOf(GeminiImageProvider.id).buildPrompt("相机", "", "")
        assertEquals("空白额外要求应当被忽略", without, withBlank)
        assertFalse("不能出现「额外要求：」这一段：" + withBlank, withBlank.contains("额外要求："))
    }

    @Test
    fun `超过服务商上限时保留开头三分之二和结尾三分之一`() {
        val limit = WanxImageEditProvider.promptLimit
        val extra = "x".repeat(2000)
        val full = serviceOf(GeminiImageProvider.id).buildPrompt("微信", "", extra)
        assertTrue("构造出来的全文必须真的超过上限才能测截断：" + full.length + " vs " + limit, full.length > limit)

        val truncated = serviceOf(WanxImageEditProvider.id).buildPrompt("微信", "", extra)
        assertEquals(
            "截断后长度必须是 limit*2/3 + limit/3 = " + (limit * 2 / 3 + limit / 3),
            limit * 2 / 3 + limit / 3, truncated.length
        )
        assertEquals(
            "必须是「保留开头 2/3 + 保留结尾 1/3」",
            full.take(limit * 2 / 3) + full.takeLast(limit / 3), truncated
        )
        assertTrue("最关键的用户自定义要求必须还在结尾：..." + truncated.takeLast(40),
            truncated.endsWith("x".repeat(limit / 3)))
    }

    @Test
    fun `刚好等于上限时一个字都不截`() {
        val limit = WanxImageEditProvider.promptLimit
        val base = serviceOf(GeminiImageProvider.id).buildPrompt("微信", "", "").length + "额外要求：".length
        assertTrue("默认提示词加固定后缀必须短于上限，否则这个用例构造不出来：" + base, base < limit)
        val extra = "x".repeat(limit - base)
        val full = serviceOf(GeminiImageProvider.id).buildPrompt("微信", "", extra)
        assertEquals("构造出来的全文必须正好等于上限 " + limit, limit, full.length)
        assertEquals("等于上限时（源码判断是 >）必须原样保留",
            full, serviceOf(WanxImageEditProvider.id).buildPrompt("微信", "", extra))
    }

    @Test
    fun `超过上限一个字符就截断`() {
        val limit = WanxImageEditProvider.promptLimit
        val base = serviceOf(GeminiImageProvider.id).buildPrompt("微信", "", "").length + "额外要求：".length
        val extra = "x".repeat(limit - base + 1)
        val full = serviceOf(GeminiImageProvider.id).buildPrompt("微信", "", extra)
        assertEquals("构造出来的全文必须是上限 +1", limit + 1, full.length)
        val truncated = serviceOf(WanxImageEditProvider.id).buildPrompt("微信", "", extra)
        assertFalse("超出一个字符就必须截断", truncated == full)
        assertEquals("截断后的长度固定是 limit*2/3 + limit/3",
            limit * 2 / 3 + limit / 3, truncated.length)
    }

    @Test
    fun `没声明上限（0）或服务商未知时不截断`() {
        val extra = "y".repeat(5000)
        val seedEdit = serviceOf(SeedEditProvider.id).buildPrompt("微信", "", extra)
        assertEquals("SeedEdit 的 promptLimit=0，必须原样保留", 0, SeedEditProvider.promptLimit)
        assertTrue("超长提示词必须原样保留", seedEdit.endsWith("额外要求：" + extra))
        assertEquals("未知服务商拿不到上限，也必须原样保留",
            seedEdit, serviceOf("no_such_provider").buildPrompt("微信", "", extra))
    }

    // ==================== 引擎与配置 ====================

    @Test
    fun `引擎判断只认固定的两个本地 id`() {
        val local = serviceOf(ImageGenProviders.LOCAL_ID)
        assertEquals("currentEngineId 必须原样返回偏好设置里的值",
            ImageGenProviders.LOCAL_ID, local.currentEngineId())
        assertTrue("local 是本地风格引擎", local.isLocalEngine())
        assertFalse("local 不是端侧模型引擎", local.isLocalModelEngine())

        val localModel = serviceOf(ImageGenProviders.LOCAL_MODEL_ID)
        assertFalse("localmodel 不是本地风格引擎", localModel.isLocalEngine())
        assertTrue("localmodel 是端侧模型引擎", localModel.isLocalModelEngine())

        val remote = serviceOf(WanxImageEditProvider.id)
        assertFalse("远程服务商两个本地判断都必须是 false",
            remote.isLocalEngine() || remote.isLocalModelEngine())
    }

    @Test
    fun `本地引擎永远可用，远程服务商要有 key 才算可用`() {
        assertTrue("本地风格不联网，永远算可用", serviceOf(ImageGenProviders.LOCAL_ID).isReady())
        assertFalse("没填 key 的远程服务商不可用", serviceOf(WanxImageEditProvider.id).isReady())
        assertFalse("未知服务商不可用", serviceOf("no_such_provider").isReady())

        val withKey = serviceWith(
            mapOf(
                PreferencesManager.KEY_IMG_PROVIDER to WanxImageEditProvider.id,
                PreferencesManager.keyOf(WanxImageEditProvider.id) to "sk-test"
            )
        )
        assertTrue("填了 key 的远程服务商可用", withKey.isReady())
    }

    @Test
    fun `configFor 缺省时回退到服务商默认值`() {
        val provider = WanxImageEditProvider
        val config = serviceOf(provider.id).configFor(provider)
        assertEquals("providerId 必须回填成服务商自己的 id", provider.id, config.providerId)
        assertEquals("没填过 key 时是空串（不能瞎猜）", "", config.apiKey)
        assertEquals("没填过地址时回退到 defaultBaseUrl", provider.defaultBaseUrl, config.baseUrl)
        assertEquals("没填过模型时回退到 defaultModel", provider.defaultModel, config.model)
    }

    @Test
    fun `configFor 用偏好设置里的值，并去掉首尾空白`() {
        val provider = WanxImageEditProvider
        val config = serviceWith(
            mapOf(
                PreferencesManager.KEY_IMG_PROVIDER to provider.id,
                PreferencesManager.keyOf(provider.id) to "  sk-abc  ",
                PreferencesManager.baseUrlOf(provider.id) to "  https://my.gateway  ",
                PreferencesManager.modelOf(provider.id) to "  my-model  "
            )
        ).configFor(provider)
        assertEquals("key 应当被 trim", "sk-abc", config.apiKey)
        assertEquals("自定义网关地址应当被 trim 后使用", "https://my.gateway", config.baseUrl)
        assertEquals("自定义模型名应当被 trim 后使用", "my-model", config.model)
    }

    @Test
    fun `currentModel 按偏好设置取端侧模型，缺省用默认抠图模型`() {
        assertEquals(
            "没选过时用清单里的默认抠图模型",
            LocalModelCatalog.defaultMattingId,
            serviceOf(ImageGenProviders.LOCAL_MODEL_ID).currentModel()?.id
        )
        val chosen = serviceWith(
            mapOf(
                PreferencesManager.KEY_IMG_PROVIDER to ImageGenProviders.LOCAL_MODEL_ID,
                PreferencesManager.KEY_LOCAL_MODEL to "modnet_q"
            )
        )
        assertEquals("选过就用选中的那个", "modnet_q", chosen.currentModel()?.id)
        val broken = serviceWith(
            mapOf(
                PreferencesManager.KEY_IMG_PROVIDER to ImageGenProviders.LOCAL_MODEL_ID,
                PreferencesManager.KEY_LOCAL_MODEL to "no_such_model"
            )
        )
        assertNull("配置里是个不存在的模型时要返回 null，不能崩", broken.currentModel())
    }
}
