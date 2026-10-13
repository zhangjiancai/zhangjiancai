package com.appanalyzer.service.localmodel

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 端侧模型清单的完整性测试。
 *
 * 这个清单是纯 Kotlin 数据，不碰 android.*。这里只断言「结构必须成立」的硬约束
 * （id 唯一、地址是魔搭直链、任务划分完整、超分输入是 64 的倍数……），
 * 不断言具体模型数量和顺序 —— 加模型是正常迭代，不该让测试挂掉。
 */
class LocalModelCatalogTest {

    private val all = LocalModelCatalog.all

    @Test
    fun `清单不能为空，每个模型的文字字段都要有`() {
        assertTrue("模型清单不能是空的，否则端侧模型整条路径都不可用", all.isNotEmpty())
        all.forEach { m ->
            assertTrue("id 不能为空", m.id.isNotBlank())
            assertTrue(m.id + " 的 name 不能为空", m.name.isNotBlank())
            assertTrue(m.id + " 的 description 不能为空", m.description.isNotBlank())
            assertTrue(m.id + " 的 fileName 不能为空", m.fileName.isNotBlank())
            assertTrue(m.id + " 的 url 不能为空", m.url.isNotBlank())
        }
    }

    @Test
    fun `id 不重复，且都能按 id 原样找回`() {
        val ids = all.map { it.id }
        assertEquals("模型 id 不能重复：" + ids, ids.size, ids.toSet().size)
        all.forEach { m ->
            assertSame("byId(" + m.id + ") 必须返回清单里的同一个对象", m, LocalModelCatalog.byId(m.id))
        }
    }

    @Test
    fun `查不到的 id 返回 null 而不是抛异常`() {
        assertNull("不存在的 id 应当返回 null", LocalModelCatalog.byId("no_such_model"))
        assertNull("空串 id 应当返回 null", LocalModelCatalog.byId(""))
        assertNull("大小写不同的 id 不应当被当成同一个模型", LocalModelCatalog.byId("U2NET"))
    }

    @Test
    fun `下载地址必须是魔搭的 https 直链并带上文件名`() {
        all.forEach { m ->
            assertTrue(m.id + " 的下载地址必须是 https：" + m.url, m.url.startsWith("https://"))
            assertTrue(
                m.id + " 的下载地址必须指向 modelscope.cn（实测其它域名在这台机器上不可达）：" + m.url,
                m.url.contains("modelscope.cn")
            )
            assertTrue(
                m.id + " 的下载地址必须带 FilePath 参数（否则拿不到 Content-Length，做不出进度条）：" + m.url,
                m.url.contains("FilePath=")
            )
            // 注意：URL 里的 FilePath 是**模型仓库内的路径**（如 onnx/model_quantized.onnx），
            // fileName 是我们**本地落盘**用的名字（如 modnet_quantized.onnx），
            // 两者按设计就不同名，不能断言 url.contains(fileName)。
            // 这里断言真正该保证的两件事：FilePath 指向一个 .onnx 文件，
            // 且本地落盘名也是 .onnx（否则后面的推理加载会对不上）。
            val filePath = m.url.substringAfter("FilePath=")
            assertTrue(
                m.id + " 的 FilePath 必须指向 .onnx 文件，实际：" + filePath,
                filePath.endsWith(".onnx")
            )
            assertTrue(
                m.id + " 的本地落盘名必须以 .onnx 结尾，实际：" + m.fileName,
                m.fileName.endsWith(".onnx")
            )
        }
    }

    @Test
    fun `每个模型都有正的预期字节数，且文件名是 onnx`() {
        all.forEach { m ->
            assertTrue(m.id + " 的预期字节数必须为正，否则下载完整性校验形同虚设：" + m.sizeBytes, m.sizeBytes > 0)
            assertTrue(m.id + " 的文件名应当以 .onnx 结尾：" + m.fileName, m.fileName.endsWith(".onnx"))
        }
    }

    @Test
    fun `任务类型只有抠图和超分，ofTask 是完整划分`() {
        val matting = LocalModelCatalog.ofTask(ModelSpec.Task.MATTING)
        val superRes = LocalModelCatalog.ofTask(ModelSpec.Task.SUPER_RES)
        assertTrue("至少要有一个抠图模型，否则抠图功能整条路径不可用", matting.isNotEmpty())
        assertEquals(
            "ofTask 的结果必须正好覆盖全部模型（两类不重叠也不遗漏）：抠图 " + matting.size + " + 超分 " + superRes.size,
            all.size, matting.size + superRes.size
        )
        assertTrue("ofTask(MATTING) 里不能混进别的任务",
            matting.all { it.task == ModelSpec.Task.MATTING })
        assertTrue("ofTask(SUPER_RES) 里不能混进别的任务",
            superRes.all { it.task == ModelSpec.Task.SUPER_RES })
    }

    @Test
    fun `抠图模型必须给出正方形输入边长`() {
        LocalModelCatalog.ofTask(ModelSpec.Task.MATTING).forEach { m ->
            assertTrue(m.id + " 是抠图模型，inputSize 必须是正的方形边长：" + m.inputSize, m.inputSize > 0)
        }
    }

    @Test
    fun `超分模型的输入边长必须是 64 的倍数`() {
        LocalModelCatalog.ofTask(ModelSpec.Task.SUPER_RES).forEach { m ->
            assertTrue(
                m.id + " 的 inputSize 要么为 0（按原图），要么是 64 的倍数：" + m.inputSize,
                m.inputSize == 0 || m.inputSize % 64 == 0
            )
            assertTrue(m.id + " 是超分模型，scale 必须 >= 2：" + m.scale, m.scale >= 2)
        }
    }

    @Test
    fun `归一化参数都是三分量且 std 不含 0`() {
        all.forEach { m ->
            assertEquals(m.id + " 的 mean 必须是 3 个通道", 3, m.mean.size)
            assertEquals(m.id + " 的 std 必须是 3 个通道", 3, m.std.size)
            assertTrue(m.id + " 的 std 不能有 0（会除零）：" + m.std.toList(), m.std.all { it != 0f })
        }
    }

    @Test
    fun `默认抠图模型必须指向清单里真实存在的抠图模型`() {
        val id = LocalModelCatalog.defaultMattingId
        assertTrue("defaultMattingId 不能为空", id.isNotBlank())
        val spec = LocalModelCatalog.byId(id)
        assertNotNull("defaultMattingId=" + id + " 必须能在清单里找到", spec)
        assertEquals(
            "默认模型必须是抠图模型，否则用户第一次进端侧面板会下错模型",
            ModelSpec.Task.MATTING, spec?.task
        )
    }

    @Test
    fun `ModelSpec 的相等性只按 id 判定（源码手写了 equals）`() {
        val a = LocalModelCatalog.byId("modnet_q")
        assertNotNull("清单里应当有 modnet_q，否则这个用例的前提不成立", a)
        val b = a!!.copy(mean = floatArrayOf(1f, 2f, 3f), std = floatArrayOf(4f, 5f, 6f), sizeBytes = 1L, name = "换个名字")
        assertEquals("同 id 的两个 ModelSpec 必须相等（数组字段只比引用，源码才手写了 equals）", a, b)
        assertEquals("同 id 的 hashCode 必须一致，否则放进 Map/HashSet 会丢", a.hashCode(), b.hashCode())
        assertEquals("hashCode 必须就是 id 的 hashCode", a.id.hashCode(), a.hashCode())
        val c = LocalModelCatalog.byId("u2net")
        assertFalse("id 不同的 ModelSpec 不能相等", a == c)
    }
}
