package com.appanalyzer.service.iconpack

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** resources.arsc 编码器的单元测试：编码 → 独立解析器读回 → 核对类型/配置/取值。 */
class ResourceTableTest {

    private fun sampleTypes(): List<ResourceTypeConfig> = listOf(
        ResourceTypeConfig(
            "drawable", 480,
            listOf(
                ResourceFileEntry("ic_launcher", "res/drawable-xxhdpi-v4/ic_launcher.png"),
                ResourceFileEntry("ic_com_tencent_mm", "res/drawable-xxhdpi-v4/ic_com_tencent_mm.png"),
                ResourceFileEntry("ic_com_example_app", "res/drawable-xxhdpi-v4/ic_com_example_app.png"),
            ),
        ),
        ResourceTypeConfig(
            "xml", 0,
            listOf(
                ResourceFileEntry("appfilter", "res/xml/appfilter.xml"),
                ResourceFileEntry("drawable", "res/xml/drawable.xml"),
            ),
        ),
    )

    /** 表头 12 字节、包 id 0x7f、包名与 manifest 里的包名一致（启动器按包名查资源）。 */
    @Test
    fun tableHeaderAndPackageName() {
        val parsed = TestArscParser.parse(ResourceTable.encode("com.appanalyzer.iconpack", sampleTypes()))
        assertEquals(0x7F, parsed.packageId)
        assertEquals("com.appanalyzer.iconpack", parsed.packageName)
    }

    /** 类型 id 按类型名字典序分配：drawable=1、xml=2（与 aapt2 一致）。 */
    @Test
    fun typeIdsAssignedBySortedTypeName() {
        val parsed = TestArscParser.parse(ResourceTable.encode("com.appanalyzer.iconpack", sampleTypes()))
        assertEquals(listOf("drawable", "xml"), parsed.types.map { it.name })
        assertEquals(1, parsed.type("drawable")!!.id)
        assertEquals(2, parsed.type("xml")!!.id)
    }

    /** 图标放 drawable-xxhdpi-v4，配置里的 density 必须写 480；res/xml 则是默认配置。 */
    @Test
    fun drawableIsXxhdpiAndXmlIsDefaultConfig() {
        val parsed = TestArscParser.parse(ResourceTable.encode("com.appanalyzer.iconpack", sampleTypes()))
        assertEquals(480, parsed.type("drawable")!!.density)
        assertEquals(0, parsed.type("xml")!!.density)
    }

    /** 文件型资源的值是 TYPE_STRING，指向全局池里的 APK 内路径 —— 缺了它启动器就取不到图。 */
    @Test
    fun fileResourcesPointAtPathsInsideApk() {
        val parsed = TestArscParser.parse(ResourceTable.encode("com.appanalyzer.iconpack", sampleTypes()))
        val drawable = parsed.type("drawable")!!
        assertEquals(
            listOf("ic_launcher", "ic_com_tencent_mm", "ic_com_example_app"),
            drawable.entries.map { it.key },
        )
        assertEquals(0x03, drawable.entries[0].dataType)
        assertEquals("res/drawable-xxhdpi-v4/ic_launcher.png", drawable.entries[0].value)
        assertEquals("res/drawable-xxhdpi-v4/ic_com_example_app.png", drawable.entries[2].value)

        val xml = parsed.type("xml")!!
        assertEquals(listOf("appfilter", "drawable"), xml.entries.map { it.key })
        assertEquals("res/xml/appfilter.xml", xml.entries[0].value)
    }

    /** 全局值字符串池里就是所有文件路径（顺序 = 遍历顺序）。 */
    @Test
    fun globalValuePoolHoldsEveryFilePath() {
        val parsed = TestArscParser.parse(ResourceTable.encode("com.appanalyzer.iconpack", sampleTypes()))
        assertEquals(
            listOf(
                "res/drawable-xxhdpi-v4/ic_launcher.png",
                "res/drawable-xxhdpi-v4/ic_com_tencent_mm.png",
                "res/drawable-xxhdpi-v4/ic_com_example_app.png",
                "res/xml/appfilter.xml",
                "res/xml/drawable.xml",
            ),
            parsed.valueStrings,
        )
    }

    @Test
    fun duplicateTypeNameIsRejected() {
        try {
            ResourceTable.encode(
                "com.appanalyzer.iconpack",
                listOf(
                    ResourceTypeConfig("drawable", 480, emptyList()),
                    ResourceTypeConfig("drawable", 0, emptyList()),
                ),
            )
            fail("应该抛异常")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("多次"))
        }
    }

    @Test
    fun tooLongPackageNameIsRejected() {
        try {
            ResourceTable.encode("a".repeat(128), emptyList())
            fail("应该抛异常")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("包名"))
        }
    }
}
