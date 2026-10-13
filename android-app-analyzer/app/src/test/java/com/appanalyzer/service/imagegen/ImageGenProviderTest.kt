package com.appanalyzer.service.imagegen

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 生图服务商注册表的纯 JVM 测试：常量、id 合法性、查表与展示名回退。
 *
 * 这些对象只在 generate() 里碰网络和 android.util.Base64，静态信息全是纯 Kotlin，
 * 所以能在 JVM 上直接断言。
 */
class ImageGenProviderTest {

    @Test
    fun `两个本地引擎的 id 常量是固定值（改掉会让已存的偏好设置失配）`() {
        assertEquals("本地风格迁移的 id 必须是 local", "local", ImageGenProviders.LOCAL_ID)
        assertEquals("端侧模型的 id 必须是 localmodel", "localmodel", ImageGenProviders.LOCAL_MODEL_ID)
    }

    @Test
    fun `allIds 覆盖两个本地引擎和全部远程服务商，且不重复`() {
        val ids = ImageGenProviders.allIds
        assertEquals(
            "allIds 应当 = 2 个本地引擎 + " + ImageGenProviders.remote.size + " 个远程服务商",
            2 + ImageGenProviders.remote.size, ids.size
        )
        assertEquals("allIds 不能有重复项：" + ids, ids.size, ids.toSet().size)
        assertTrue("allIds 必须包含本地风格迁移：" + ids, ids.contains(ImageGenProviders.LOCAL_ID))
        assertTrue("allIds 必须包含端侧模型：" + ids, ids.contains(ImageGenProviders.LOCAL_MODEL_ID))
        ImageGenProviders.remote.forEach { p ->
            assertTrue("allIds 必须包含远程服务商 " + p.id + "：" + ids, ids.contains(p.id))
        }
        assertTrue("所有 id 都不能是空串：" + ids, ids.all { it.isNotBlank() })
    }

    @Test
    fun `远程服务商至少有一个，id 合法且不重复`() {
        assertTrue("至少要有一个远程服务商，否则「用文字生成图标」这条路不可用", ImageGenProviders.remote.isNotEmpty())
        val ids = ImageGenProviders.remote.map { it.id }
        assertEquals("远程服务商 id 不能重复：" + ids, ids.size, ids.toSet().size)
        ids.forEach { id ->
            assertTrue(
                "id 只能用小写字母/数字/连字符（它会被拼进 SharedPreferences 的 key）：" + id,
                Regex("^[a-z0-9][a-z0-9_-]*$").matches(id)
            )
        }
    }

    @Test
    fun `每个服务商的展示信息都完整，地址是 https 且不带结尾斜杠`() {
        ImageGenProviders.remote.forEach { p ->
            assertTrue(p.id + " 的 displayName 不能为空", p.displayName.isNotBlank())
            assertTrue(p.id + " 的 defaultModel 不能为空", p.defaultModel.isNotBlank())
            assertTrue(p.id + " 的 keyHint 不能为空", p.keyHint.isNotBlank())
            assertTrue(p.id + " 的 modelHint 不能为空", p.modelHint.isNotBlank())
            assertTrue(p.id + " 的 applyUrl 必须是 https 链接：" + p.applyUrl, p.applyUrl.startsWith("https://"))
            assertTrue(p.id + " 的 defaultBaseUrl 必须是 https 地址：" + p.defaultBaseUrl,
                p.defaultBaseUrl.startsWith("https://"))
            assertFalse(
                p.id + " 的 defaultBaseUrl 不该带结尾斜杠（拼接处都靠 trimEnd('/') 兜底）：" + p.defaultBaseUrl,
                p.defaultBaseUrl.endsWith("/")
            )
            assertTrue(p.id + " 的 promptLimit 不能是负数：" + p.promptLimit, p.promptLimit >= 0)
            assertTrue(p.id + " 的 maxReferenceImages 至少为 1：" + p.maxReferenceImages, p.maxReferenceImages >= 1)
        }
    }

    @Test
    fun `byId 只认远程服务商，本地引擎交给调用方单独判断`() {
        assertNull("local 不是远程服务商，byId 必须返回 null", ImageGenProviders.byId(ImageGenProviders.LOCAL_ID))
        assertNull("localmodel 不是远程服务商，byId 必须返回 null",
            ImageGenProviders.byId(ImageGenProviders.LOCAL_MODEL_ID))
        assertNull("未知 id 返回 null", ImageGenProviders.byId("no_such_provider"))
        assertNull("空 id 返回 null", ImageGenProviders.byId(""))
        ImageGenProviders.remote.forEach { p ->
            assertSame("byId(" + p.id + ") 必须返回同一个对象", p, ImageGenProviders.byId(p.id))
        }
    }

    @Test
    fun `displayNameOf 对本地引擎给中文说明，对未知 id 原样返回`() {
        assertEquals("本地风格迁移（不联网）", ImageGenProviders.displayNameOf(ImageGenProviders.LOCAL_ID))
        assertEquals("本地模型（端侧 ONNX，按需下载）", ImageGenProviders.displayNameOf(ImageGenProviders.LOCAL_MODEL_ID))
        ImageGenProviders.remote.forEach { p ->
            assertEquals("远程服务商应当返回它自己的 displayName", p.displayName, ImageGenProviders.displayNameOf(p.id))
        }
        assertEquals(
            "未知 id 必须原样返回，用户才看得出配置坏了",
            "no_such_provider", ImageGenProviders.displayNameOf("no_such_provider")
        )
    }

    // ==================== 请求与结果的数据类 ====================

    @Test
    fun `ImageGenRequest 的 dataUri 拼接`() {
        val req = ImageGenRequest(sourceImageBase64 = "AAAA", prompt = "p")
        assertEquals("默认 mime 是 image/png", "image/png", req.sourceMimeType)
        assertEquals("dataUri 必须是 data:image/png;base64, 前缀 + 原始 base64",
            "data:image/png;base64,AAAA", req.dataUri)
        assertNull("没有风格参考图时 styleDataUri 必须是 null", req.styleDataUri)
        assertEquals("提示词原样保存", "p", req.prompt)

        val withStyle = req.copy(styleImageBase64 = "BBBB", sourceMimeType = "image/jpeg")
        assertEquals("mime 换成 jpeg 后 dataUri 前缀要跟着变",
            "data:image/jpeg;base64,AAAA", withStyle.dataUri)
        assertEquals("风格参考图同样用 data URI", "data:image/jpeg;base64,BBBB", withStyle.styleDataUri)
    }

    @Test
    fun `Failure describe：状态码与原始响应都要带给用户`() {
        assertEquals("只有 message 时原样输出", "生成失败", ImageGenOutcome.Failure("生成失败").describe())
        assertEquals("有 HTTP 状态码时追加在中文括号里",
            "生成失败（HTTP 401）", ImageGenOutcome.Failure("生成失败", 401).describe())
        assertEquals("原始响应换行附在后面",
            "生成失败（HTTP 500）\n原始响应: boom",
            ImageGenOutcome.Failure("生成失败", 500, "boom").describe())
        assertEquals("空白原始响应不追加", "生成失败",
            ImageGenOutcome.Failure("生成失败", null, "   ").describe())
        assertEquals("原始响应截到 400 字符，避免日志爆掉",
            "err\n原始响应: " + "x".repeat(400),
            ImageGenOutcome.Failure("err", null, "x".repeat(500)).describe())
    }

    @Test
    fun `Success 默认是 png`() {
        val ok = ImageGenOutcome.Success("b64")
        assertEquals("base64 原样保存", "b64", ok.imageBase64)
        assertEquals("默认 mimeType 是 image/png", "image/png", ok.mimeType)
    }
}
