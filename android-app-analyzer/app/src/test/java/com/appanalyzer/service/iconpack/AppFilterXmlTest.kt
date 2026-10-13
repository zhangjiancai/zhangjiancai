package com.appanalyzer.service.iconpack

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import javax.xml.parsers.DocumentBuilderFactory

/** appfilter.xml / drawable.xml 生成逻辑的单元测试（生成结果会真的丢给 XML 解析器验证合法性）。 */
class AppFilterXmlTest {

    @Test
    fun packageNameBecomesValidResourceName() {
        assertEquals("ic_com_tencent_mm", AppFilterXml.drawableNameOf("com.tencent.mm"))
        assertEquals("ic_com_example_app", AppFilterXml.drawableNameOf("com.example.app"))
        assertEquals("ic_abc_123", AppFilterXml.drawableNameOf("abc.123"))
    }

    @Test
    fun illegalCharactersBecomeUnderscore() {
        assertEquals("ic_com_a_b", AppFilterXml.drawableNameOf("com.a-b"))
        assertEquals("ic_com_a_b", AppFilterXml.drawableNameOf("com.a.b"))
        assertEquals("ic_a_b_c", AppFilterXml.drawableNameOf("a.b.c."))
        assertTrue(AppFilterXml.drawableNameOf("1.2").startsWith("ic_"))
    }

    /** 同一个图标写两条：完整组件名 + 包名/.Activity 缩写（提高不同启动器的命中率）。 */
    @Test
    fun eachIconGetsFullAndShortComponentMapping() {
        val text = AppFilterXml.buildAppFilter(
            listOf(
                IconMapping(
                    "com.tencent.mm/com.tencent.mm.ui.LauncherUI",
                    "com.tencent.mm",
                    "ic_com_tencent_mm",
                ),
            ),
        )
        val items = parseItems(text)
        assertEquals(2, items.size)
        assertEquals("ComponentInfo{com.tencent.mm/com.tencent.mm.ui.LauncherUI}", items[0]["component"])
        assertEquals("ComponentInfo{com.tencent.mm/.ui.LauncherUI}", items[1]["component"])
        assertEquals("ic_com_tencent_mm", items[0]["drawable"])
        assertEquals("ic_com_tencent_mm", items[1]["drawable"])
    }

    @Test
    fun activityOutsidePackageGetsSingleMapping() {
        val text = AppFilterXml.buildAppFilter(
            listOf(IconMapping("com.foo/com.bar.MainActivity", "com.foo", "ic_com_foo")),
        )
        assertEquals(1, parseItems(text).size)
    }

    @Test
    fun xmlSpecialCharactersAreEscaped() {
        val text = AppFilterXml.buildAppFilter(
            listOf(IconMapping("com.a<b>&\"c/com.a<b>.Main", "com.a<b>&\"c", "ic_com_a")),
        )
        assertTrue(text.contains("&lt;"))
        assertTrue(text.contains("&amp;"))
        assertTrue(text.contains("&quot;"))
        assertEquals(1, parseItems(text).size)
    }

    @Test
    fun drawableListIsSortedAndHasOneItemPerIcon() {
        val text = AppFilterXml.buildDrawableList(listOf("ic_b", "ic_a", "ic_c"))
        assertEquals(listOf("ic_a", "ic_b", "ic_c"), parseItems(text).map { it["drawable"] })
    }

    @Test
    fun emptyListStillProducesValidXml() {
        assertEquals(0, parseItems(AppFilterXml.buildAppFilter(emptyList())).size)
        assertEquals(0, parseItems(AppFilterXml.buildDrawableList(emptyList())).size)
    }

    private fun parseItems(xml: String): List<Map<String, String>> {
        val document = DocumentBuilderFactory.newInstance().newDocumentBuilder()
            .parse(ByteArrayInputStream(xml.toByteArray(Charsets.UTF_8)))
        val nodes = document.getElementsByTagName("item")
        val result = ArrayList<Map<String, String>>()
        for (i in 0 until nodes.length) {
            val attributes = nodes.item(i).attributes
            val map = HashMap<String, String>()
            for (j in 0 until attributes.length) {
                map[attributes.item(j).nodeName] = attributes.item(j).nodeValue
            }
            result.add(map)
        }
        return result
    }
}
