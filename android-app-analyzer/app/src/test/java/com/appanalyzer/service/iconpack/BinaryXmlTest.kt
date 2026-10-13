package com.appanalyzer.service.iconpack

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * AXML 编码器的单元测试：编码 → 用**另一份独立实现的解析器**读回来 → 逐项核对。
 *
 * 另写一份解析器的意义：如果共用读取逻辑，写错偏移也会「自洽地读回来」，等于没测。
 */
class BinaryXmlTest {

    private val android = BinaryXml.ANDROID_NS

    private val ATTR_LABEL = 0x01010001
    private val ATTR_ICON = 0x01010002
    private val ATTR_NAME = 0x01010003
    private val ATTR_HAS_CODE = 0x0101000C
    private val ATTR_EXPORTED = 0x01010010
    private val ATTR_VERSION_CODE = 0x0101021B
    private val ATTR_VERSION_NAME = 0x0101021C

    private fun sample(): XmlElement = XmlElement(
        "manifest",
        listOf(
            XmlAttribute(null, "package", XmlValue.Text("com.appanalyzer.iconpack")),
            XmlAttribute(android, "versionCode", XmlValue.Decimal(7), ATTR_VERSION_CODE),
            XmlAttribute(android, "versionName", XmlValue.Text("1.2.3"), ATTR_VERSION_NAME),
        ),
        listOf(
            XmlElement(
                "application",
                listOf(
                    XmlAttribute(android, "hasCode", XmlValue.Bool(false), ATTR_HAS_CODE),
                    XmlAttribute(android, "label", XmlValue.Text("图标包 名字"), ATTR_LABEL),
                    XmlAttribute(android, "icon", XmlValue.Reference(0x7F010000), ATTR_ICON),
                ),
                listOf(
                    XmlElement(
                        "activity",
                        listOf(
                            XmlAttribute(android, "name", XmlValue.Text("android.app.Activity"), ATTR_NAME),
                            XmlAttribute(android, "exported", XmlValue.Bool(true), ATTR_EXPORTED),
                        ),
                        listOf(
                            XmlElement(
                                "intent-filter",
                                emptyList(),
                                listOf(
                                    XmlElement(
                                        "action",
                                        listOf(
                                            XmlAttribute(
                                                android, "name",
                                                XmlValue.Text("org.adw.launcher.THEMES"), ATTR_NAME,
                                            ),
                                        ),
                                    ),
                                ),
                            ),
                        ),
                    ),
                ),
            ),
        ),
    )

    /** 根区块头必须是 type=RES_XML_TYPE(0x0003)、headerSize=8、size=文件长度。 */
    @Test
    fun rootChunkHeaderFollowsAospLayout() {
        val bytes = BinaryXml.encode(sample())
        assertEquals("区块类型应为 RES_XML_TYPE", 0x0003, u16(bytes, 0))
        assertEquals("XML 根区块头应为 8 字节", 8, u16(bytes, 2))
        assertEquals("根区块大小应等于整个文件", bytes.size, u32(bytes, 4).toInt())
    }

    /** 字符串池用 UTF-8（flags = 0x100），且重复出现的字符串只存一份。 */
    @Test
    fun stringPoolIsUtf8AndDeduplicated() {
        val bytes = BinaryXml.encode(sample())
        val poolStart = u16(bytes, 2)
        assertEquals(0x0001, u16(bytes, poolStart))
        assertEquals("应使用 UTF-8 字符串池", 0x100, u32(bytes, poolStart + 16))
        assertEquals("styleCount 应为 0", 0, u32(bytes, poolStart + 12))

        val strings = TestAxmlParser.parseStringPool(bytes, poolStart)
        assertEquals("android.app.Activity 被用了两次，但只能存一份", 1, strings.count { it == "android.app.Activity" })
        assertTrue(strings.contains("org.adw.launcher.THEMES"))
        assertTrue(strings.contains("图标包 名字"))
    }

    /** resource map 区块的下标必须与字符串池前若干项一一对应 —— 系统就是靠它认 android:xxx 的。 */
    @Test
    fun resourceMapMapsPoolIndexToFrameworkAttrId() {
        val parsed = TestAxmlParser.parse(BinaryXml.encode(sample()))
        val expected = mapOf(
            "versionCode" to ATTR_VERSION_CODE,
            "versionName" to ATTR_VERSION_NAME,
            "hasCode" to ATTR_HAS_CODE,
            "label" to ATTR_LABEL,
            "icon" to ATTR_ICON,
            "name" to ATTR_NAME,
            "exported" to ATTR_EXPORTED,
        )
        assertEquals(expected.size, parsed.resourceMap.size)
        for ((index, id) in parsed.resourceMap.withIndex()) {
            val attrName = parsed.strings[index]
            assertEquals("下标 $index 的资源 id 不对", expected[attrName], id)
        }
    }

    /** 编出来的字节用独立解析器读回来，应该还原成完全一样的树。 */
    @Test
    fun encodedTreeRoundTripsThroughIndependentParser() {
        val parsed = TestAxmlParser.parse(BinaryXml.encode(sample()))
        val root = parsed.root
        assertEquals("manifest", root.name)
        assertEquals("com.appanalyzer.iconpack", root.attribute("package")?.stringValue)
        assertNull("无命名空间的属性不应该有命名空间", root.attribute("package")?.namespace)

        val versionCode = root.attribute("versionCode")
        assertNotNull(versionCode)
        assertEquals(android, versionCode!!.namespace)
        assertEquals(ATTR_VERSION_CODE, versionCode.resourceId)
        assertEquals("十进制整数类型应为 0x10", 0x10, versionCode.dataType)
        assertEquals(7, versionCode.intValue)

        val application = root.child("application")!!
        assertEquals(0x12, application.attribute("hasCode")!!.dataType)
        assertEquals("hasCode=false 应写成 0", 0, application.attribute("hasCode")!!.intValue)
        assertEquals("图标包 名字", application.attribute("label")!!.stringValue)
        assertEquals(0x01, application.attribute("icon")!!.dataType)
        assertEquals(0x7F010000, application.attribute("icon")!!.intValue)

        val activity = application.child("activity")!!
        assertEquals("android.app.Activity", activity.attribute("name")!!.stringValue)
        assertEquals("exported=true 应写成 0xFFFFFFFF", -1, activity.attribute("exported")!!.intValue)

        val action = activity.child("intent-filter")!!.child("action")!!
        assertEquals("org.adw.launcher.THEMES", action.attribute("name")!!.stringValue)
    }

    /** START_ELEMENT 区块大小 = 16(节点头) + 20(attrExt) + 20×属性数，attributeStart/Size 固定 20。 */
    @Test
    fun startElementChunkSizeMatchesAospFormula() {
        val bytes = BinaryXml.encode(sample())
        val strings = TestAxmlParser.parseStringPool(bytes, u16(bytes, 2))
        val sizes = HashMap<String, Int>()
        var p = u16(bytes, 2)
        p += u32(bytes, p + 4).toInt()
        p += u32(bytes, p + 4).toInt()
        while (p + 8 <= bytes.size) {
            val type = u16(bytes, p)
            val size = u32(bytes, p + 4).toInt()
            if (type == 0x0102) {
                val name = strings[i32(bytes, p + 20)]
                val count = u16(bytes, p + 28)
                sizes[name] = size
                assertEquals("attributeStart 应为 20", 20, u16(bytes, p + 24))
                assertEquals("attributeSize 应为 20", 20, u16(bytes, p + 26))
                assertEquals("$name 的区块大小不对", 36 + 20 * count, size)
            }
            if (size == 0) break
            p += size
        }
        assertEquals(setOf("manifest", "application", "activity", "intent-filter", "action"), sizes.keys)
    }

    /** res/xml 下的 appfilter.xml 这类文档没有任何 android 属性，resource map 必须是空的（aapt2 也是空的）。 */
    @Test
    fun documentWithoutAndroidAttributesHasEmptyResourceMap() {
        val doc = XmlElement(
            "resources",
            emptyList(),
            listOf(
                XmlElement(
                    "item",
                    listOf(
                        XmlAttribute(null, "component", XmlValue.Text("ComponentInfo{a/b}")),
                        XmlAttribute(null, "drawable", XmlValue.Text("ic_a")),
                    ),
                ),
            ),
        )
        val parsed = TestAxmlParser.parse(BinaryXml.encode(doc))
        assertTrue("没有带 id 的属性时 resource map 应为空", parsed.resourceMap.isEmpty())
        val item = parsed.root.child("item")!!
        assertEquals("ComponentInfo{a/b}", item.attribute("component")?.stringValue)
        assertNull(item.attribute("component")?.namespace)
    }

    /** android 命名空间属性没给 resourceId 时必须直接报错，而不是静默写出一个系统读不到的清单。 */
    @Test
    fun androidAttributeWithoutResourceIdFailsFast() {
        val broken = XmlElement(
            "manifest",
            listOf(XmlAttribute(android, "label", XmlValue.Text("x"))),
        )
        try {
            BinaryXml.encode(broken)
            fail("应该抛异常")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("framework"))
        }
    }

    private fun u16(b: ByteArray, o: Int) = (b[o].toInt() and 0xFF) or ((b[o + 1].toInt() and 0xFF) shl 8)

    private fun u32(b: ByteArray, o: Int): Long = u16(b, o).toLong() or (u16(b, o + 2).toLong() shl 16)

    private fun i32(b: ByteArray, o: Int) = u32(b, o).toInt()
}
