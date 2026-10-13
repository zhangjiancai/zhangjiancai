package com.appanalyzer.service.iconpack

import java.io.ByteArrayOutputStream

/**
 * 二进制 XML（AXML）里一个属性的值。
 *
 * 对应 AOSP 的 Res_value.dataType，这里只实现图标包 manifest / res-xml 真正会用到的四种：
 * 字符串、十进制整数、布尔、资源引用。
 */
sealed class XmlValue {
    /** 字符串。写进 AXML 时 rawValue 与 typed value 都指向同一个字符串池下标（aapt2 就是这么干的）。 */
    data class Text(val value: String) : XmlValue()

    /** android:versionCode="1" 这类整数，dataType = TYPE_INT_DEC。 */
    data class Decimal(val value: Int) : XmlValue()

    /** android:exported="true" 这类布尔，dataType = TYPE_INT_BOOLEAN，true 写作 0xFFFFFFFF。 */
    data class Bool(val value: Boolean) : XmlValue()

    /** @drawable/xxx 这类资源引用，data 是 0xPPTTEEEE 形式的资源 id。 */
    data class Reference(val id: Int) : XmlValue()
}

/**
 * 二进制 XML 的一个属性。
 *
 * @param namespace  属性所属命名空间；null 表示无命名空间（例如 manifest 的 package 属性）
 * @param resourceId framework 属性 id（android.R.attr.*）。
 *                   带 android 命名空间的属性**必须**给出：它会被写进 AXML 的 resource map 区块，
 *                   而系统解析 manifest 时是拿 attr id 去匹配的（obtainAttributes），漏了就读不到属性。
 */
class XmlAttribute(
    val namespace: String?,
    val name: String,
    val value: XmlValue,
    val resourceId: Int = 0,
)

/** 二进制 XML 的一个元素。命名空间只支持「无」和 android 两种。 */
class XmlElement(
    val name: String,
    val attributes: List<XmlAttribute> = emptyList(),
    val children: List<XmlElement> = emptyList(),
)

/**
 * AXML（Android 二进制 XML）编码器 —— 纯 Kotlin/JVM 实现，不依赖任何 Android 类，可在单元测试里跑。
 *
 * 为什么要手写：图标包 APK 要在手机里直接生成，而手机上既没有 aapt2 也没有别的资源编译器，
 * 只能自己按 AOSP 的二进制格式
 * （frameworks/base/libs/androidfw/include/androidfw/ResourceTypes.h）把
 * AndroidManifest.xml 与 res/xml 下的那些 XML 编出来。
 *
 * 产物结构与 aapt2 一致：
 *   XML 根区块(8)
 *   ├─ 字符串池区块(0x0001)：UTF-8（flags = 0x100）
 *   ├─ resource map 区块(0x0180)：按字符串池下标给出属性 id
 *   ├─ START_NAMESPACE(0x0100) / END_NAMESPACE(0x0101)
 *   └─ START_ELEMENT(0x0102) / END_ELEMENT(0x0103) 节点（节点头 16 字节）
 */
object BinaryXml {

    const val ANDROID_NS = "http://schemas.android.com/apk/res/android"
    private const val ANDROID_PREFIX = "android"

    /** 区块类型（AOSP ResChunk_header.type） */
    private const val CHUNK_STRING_POOL = 0x0001
    private const val CHUNK_XML = 0x0003
    private const val CHUNK_XML_START_NAMESPACE = 0x0100
    private const val CHUNK_XML_END_NAMESPACE = 0x0101
    private const val CHUNK_XML_START_ELEMENT = 0x0102
    private const val CHUNK_XML_END_ELEMENT = 0x0103
    private const val CHUNK_XML_RESOURCE_MAP = 0x0180

    /** Res_value.dataType */
    private const val TYPE_REFERENCE = 0x01
    private const val TYPE_STRING = 0x03
    private const val TYPE_INT_DEC = 0x10
    private const val TYPE_INT_BOOLEAN = 0x12

    private const val NO_INDEX = -1

    /** 节点区块固定头：ResChunk_header(8) + lineNumber(4) + comment(4) */
    private const val NODE_HEADER_SIZE = 16

    /** START_ELEMENT 里 ResXMLTree_attrExt 的大小 */
    private const val ATTR_EXT_SIZE = 20

    /** 单个属性：ns(4) + name(4) + rawValue(4) + Res_value(8) */
    private const val ATTRIBUTE_SIZE = 20

    /**
     * 把一棵 XML 树编成 AXML 字节。
     *
     * @throws IllegalArgumentException 出现 android 以外的命名空间，或 android 属性没给 resourceId
     */
    fun encode(root: XmlElement): ByteArray {
        // AXML 的 resource map 是「按下标一一对应字符串池」的，所以带 id 的属性名必须排在池子最前面，
        // 且顺序与 resource map 完全一致。先扫一遍把它们的顺序定下来。
        val attributeIds = LinkedHashMap<String, Int>()
        collectAttributeIds(root, attributeIds)

        val pool = StringPoolBuilder(utf8 = true)
        for (name in attributeIds.keys) pool.indexOf(name)

        val nodes = ByteArrayOutputStream()

        val prefixIndex = pool.indexOf(ANDROID_PREFIX)
        val uriIndex = pool.indexOf(ANDROID_NS)
        writeNodeHeader(nodes, CHUNK_XML_START_NAMESPACE, NODE_HEADER_SIZE + 8)
        writeInt(nodes, prefixIndex)
        writeInt(nodes, uriIndex)

        writeElement(nodes, root, pool, uriIndex)

        writeNodeHeader(nodes, CHUNK_XML_END_NAMESPACE, NODE_HEADER_SIZE + 8)
        writeInt(nodes, prefixIndex)
        writeInt(nodes, uriIndex)

        val poolBytes = pool.build()
        val resourceMapSize = 8 + 4 * attributeIds.size
        val total = 8 + poolBytes.size + resourceMapSize + nodes.size()

        val out = ByteArrayOutputStream(total)
        writeChunkHeader(out, CHUNK_XML, 8, total)
        out.write(poolBytes, 0, poolBytes.size)

        writeChunkHeader(out, CHUNK_XML_RESOURCE_MAP, 8, resourceMapSize)
        for (id in attributeIds.values) writeInt(out, id)

        val nodeBytes = nodes.toByteArray()
        out.write(nodeBytes, 0, nodeBytes.size)
        return out.toByteArray()
    }

    /** 递归收集带资源 id 的属性名（首次出现顺序），并校验 resourceId 不为 0。 */
    private fun collectAttributeIds(element: XmlElement, into: LinkedHashMap<String, Int>) {
        for (attribute in element.attributes) {
            val ns = attribute.namespace ?: continue
            require(ns == ANDROID_NS) { "不支持的命名空间: $ns（只支持 $ANDROID_NS）" }
            require(attribute.resourceId != 0) {
                "android:${attribute.name} 缺少 framework 属性 id，AXML 的 resource map 需要它"
            }
            if (!into.containsKey(attribute.name)) into[attribute.name] = attribute.resourceId
        }
        for (child in element.children) collectAttributeIds(child, into)
    }

    private fun writeElement(
        out: ByteArrayOutputStream,
        element: XmlElement,
        pool: StringPoolBuilder,
        androidNsIndex: Int,
    ) {
        val count = element.attributes.size
        writeNodeHeader(
            out, CHUNK_XML_START_ELEMENT,
            NODE_HEADER_SIZE + ATTR_EXT_SIZE + ATTRIBUTE_SIZE * count,
        )
        writeInt(out, NO_INDEX)                      // 元素本身不带命名空间
        writeInt(out, pool.indexOf(element.name))
        writeShort(out, ATTR_EXT_SIZE)               // attributeStart（相对 attrExt 起点）
        writeShort(out, ATTRIBUTE_SIZE)              // attributeSize
        writeShort(out, count)
        writeShort(out, 0)                           // idIndex
        writeShort(out, 0)                           // classIndex
        writeShort(out, 0)                           // styleIndex

        for (attribute in element.attributes) {
            val nsIndex = when (attribute.namespace) {
                null -> NO_INDEX
                ANDROID_NS -> androidNsIndex
                else -> throw IllegalArgumentException("不支持的命名空间: ${attribute.namespace}")
            }
            writeInt(out, nsIndex)
            writeInt(out, pool.indexOf(attribute.name))
            when (val value = attribute.value) {
                is XmlValue.Text -> {
                    val index = pool.indexOf(value.value)
                    writeInt(out, index)             // rawValue 与 typed value 同指一个字符串
                    writeResValue(out, TYPE_STRING, index)
                }
                is XmlValue.Decimal -> {
                    writeInt(out, NO_INDEX)
                    writeResValue(out, TYPE_INT_DEC, value.value)
                }
                is XmlValue.Bool -> {
                    writeInt(out, NO_INDEX)
                    writeResValue(out, TYPE_INT_BOOLEAN, if (value.value) -1 else 0)
                }
                is XmlValue.Reference -> {
                    writeInt(out, NO_INDEX)
                    writeResValue(out, TYPE_REFERENCE, value.id)
                }
            }
        }

        for (child in element.children) writeElement(out, child, pool, androidNsIndex)

        writeNodeHeader(out, CHUNK_XML_END_ELEMENT, NODE_HEADER_SIZE + 8)
        writeInt(out, NO_INDEX)
        writeInt(out, pool.indexOf(element.name))
    }

    private fun writeResValue(out: ByteArrayOutputStream, dataType: Int, data: Int) {
        writeShort(out, 8)   // Res_value.size
        out.write(0)         // res0
        out.write(dataType)
        writeInt(out, data)
    }

    private fun writeChunkHeader(out: ByteArrayOutputStream, type: Int, headerSize: Int, size: Int) {
        writeShort(out, type)
        writeShort(out, headerSize)
        writeInt(out, size)
    }

    /** ResXMLTree_node 头：区块头(8) + lineNumber(4) + comment(4)；comment 固定 0xFFFFFFFF。 */
    private fun writeNodeHeader(out: ByteArrayOutputStream, type: Int, size: Int) {
        writeChunkHeader(out, type, NODE_HEADER_SIZE, size)
        writeInt(out, 1)             // lineNumber：只用于报错信息
        writeInt(out, -1)            // comment
    }

    private fun writeShort(out: ByteArrayOutputStream, value: Int) {
        out.write(value and 0xFF)
        out.write((value ushr 8) and 0xFF)
    }

    private fun writeInt(out: ByteArrayOutputStream, value: Int) {
        out.write(value and 0xFF)
        out.write((value ushr 8) and 0xFF)
        out.write((value ushr 16) and 0xFF)
        out.write((value ushr 24) and 0xFF)
    }
}

/**
 * AOSP 的 ResStringPool 构建器（UTF-8 或 UTF-16）。
 *
 * 布局：区块头(28) + 字符串偏移数组 + 字符串数据（整段补 0 到 4 字节对齐）。
 * UTF-8 模式下每个字符串前面有两个「1~2 字节变长长度」：先是 UTF-16 字符数，再是字节数。
 */
class StringPoolBuilder(private val utf8: Boolean = true) {

    private val indices = LinkedHashMap<String, Int>()
    private val offsets = ArrayList<Int>()
    private val data = ByteArrayOutputStream()

    /** 返回字符串在池中的下标，不存在则追加（保持首次出现的顺序）。 */
    fun indexOf(value: String): Int {
        indices[value]?.let { return it }
        val index = indices.size
        indices[value] = index
        offsets.add(data.size())
        if (utf8) writeUtf8(value) else writeUtf16(value)
        return index
    }

    fun size(): Int = indices.size

    fun build(): ByteArray {
        val count = indices.size
        val stringsStart = 28 + 4 * count
        val rawSize = data.size()
        val paddedSize = (rawSize + 3) and 3.inv()
        val total = stringsStart + paddedSize

        val out = ByteArrayOutputStream(total)
        writeShort(out, 0x0001)                     // RES_STRING_POOL_TYPE
        writeShort(out, 28)
        writeInt(out, total)
        writeInt(out, count)                        // stringCount
        writeInt(out, 0)                            // styleCount
        writeInt(out, if (utf8) 0x00000100 else 0x00000000)
        writeInt(out, stringsStart)
        writeInt(out, 0)                            // stylesStart
        for (offset in offsets) writeInt(out, offset)
        val bytes = data.toByteArray()
        out.write(bytes, 0, bytes.size)
        repeat(paddedSize - rawSize) { out.write(0) }
        return out.toByteArray()
    }

    private fun writeUtf8(value: String) {
        val bytes = value.toByteArray(Charsets.UTF_8)
        writeLength8(value.length)      // UTF-16 长度
        writeLength8(bytes.size)        // 字节长度
        data.write(bytes)
        data.write(0)
    }

    private fun writeUtf16(value: String) {
        writeShort(data, value.length)
        for (ch in value) writeShort(data, ch.code)
        writeShort(data, 0)
        // aapt2 会把每个 UTF-16 字符串补齐到 4 字节
        while (data.size() % 4 != 0) data.write(0)
    }

    private fun writeLength8(length: Int) {
        if (length > 0x7F) {
            data.write(0x80 or (length ushr 8))
            data.write(length and 0xFF)
        } else {
            data.write(length)
        }
    }

    private fun writeShort(out: ByteArrayOutputStream, value: Int) {
        out.write(value and 0xFF)
        out.write((value ushr 8) and 0xFF)
    }

    private fun writeInt(out: ByteArrayOutputStream, value: Int) {
        out.write(value and 0xFF)
        out.write((value ushr 8) and 0xFF)
        out.write((value ushr 16) and 0xFF)
        out.write((value ushr 24) and 0xFF)
    }
}
