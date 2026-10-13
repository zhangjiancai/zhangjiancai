package com.appanalyzer.service.iconpack

import java.io.ByteArrayOutputStream
import java.io.File
import java.util.zip.CRC32
import java.util.zip.Deflater

/**
 * 测试用的小工具：PNG 生成、ZIP 结构解析、以及**独立实现**的 AXML / resources.arsc 解析器。
 *
 * 解析器是刻意另写一份的：如果测试直接复用被测代码里的读取逻辑，编码写错了也会「自洽地读回来」，
 * 等于没测。这里按 AOSP 的二进制格式从头解析，任何偏移/长度写错都会立刻暴露。
 */

/** 生成一张真实的 PNG（纯 JVM，用 Deflater 压 IDAT）。 */
object TestPng {

    fun solid(width: Int, height: Int, rgb: Int, seed: Int = 0): ByteArray {
        val raw = ByteArray(height * (1 + width * 3))
        var p = 0
        for (y in 0 until height) {
            raw[p++] = 0                                  // filter type 0
            for (x in 0 until width) {
                raw[p++] = ((rgb shr 16) and 0xFF).toByte()
                raw[p++] = ((rgb shr 8) and 0xFF).toByte()
                raw[p++] = ((rgb + x + y + seed) and 0xFF).toByte()
            }
        }
        val compressed = ByteArrayOutputStream()
        val deflater = Deflater(Deflater.BEST_SPEED)
        deflater.setInput(raw)
        deflater.finish()
        val buffer = ByteArray(8192)
        while (!deflater.finished()) {
            val n = deflater.deflate(buffer)
            compressed.write(buffer, 0, n)
        }
        deflater.end()

        val out = ByteArrayOutputStream()
        out.write(byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))
        val ihdr = ByteArrayOutputStream()
        ihdr.write(int32(width)); ihdr.write(int32(height))
        ihdr.write(8)          // bit depth
        ihdr.write(2)          // color type: truecolor
        ihdr.write(0); ihdr.write(0); ihdr.write(0)
        out.write(chunk("IHDR", ihdr.toByteArray()))
        out.write(chunk("IDAT", compressed.toByteArray()))
        out.write(chunk("IEND", ByteArray(0)))
        return out.toByteArray()
    }

    private fun chunk(type: String, data: ByteArray): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(int32(data.size))
        val typeBytes = type.toByteArray(Charsets.US_ASCII)
        out.write(typeBytes)
        out.write(data)
        val crc = CRC32()
        crc.update(typeBytes)
        crc.update(data)
        out.write(int32(crc.value.toInt()))
        return out.toByteArray()
    }

    private fun int32(value: Int) = byteArrayOf(
        (value ushr 24).toByte(), (value ushr 16).toByte(), (value ushr 8).toByte(), value.toByte(),
    )

}

/** ZIP 里一个条目的信息（含数据起始偏移，用来检查对齐）。 */
class ZipEntryInfo(
    val name: String,
    val method: Int,
    val size: Int,
    val crc: Long,
    val dataOffset: Int,
)

/** 按中央目录自己解析 ZIP —— 只为了拿到数据偏移（java.util.zip 不提供）。 */
class ZipInspector(private val bytes: ByteArray) {

    val entries: List<ZipEntryInfo> = parse()

    fun entry(name: String): ZipEntryInfo? = entries.firstOrNull { it.name == name }

    fun data(name: String): ByteArray {
        val e = entry(name) ?: throw AssertionError("ZIP 里没有条目: $name")
        require(e.method == 0) { "$name 不是 STORED，本测试只处理 STORED" }
        return bytes.copyOfRange(e.dataOffset, e.dataOffset + e.size)
    }

    private fun parse(): List<ZipEntryInfo> {
        var eocd = -1
        for (i in bytes.size - 22 downTo 0) {
            if (u32(i) == 0x06054b50L) { eocd = i; break }
        }
        check(eocd >= 0) { "找不到 EOCD，不是合法 ZIP" }
        val count = u16(eocd + 10)
        var p = u32(eocd + 16).toInt()
        val result = ArrayList<ZipEntryInfo>()
        repeat(count) {
            check(u32(p) == 0x02014b50L) { "中央目录项签名不对 @$p" }
            val method = u16(p + 10)
            val crc = u32(p + 16)
            val size = u32(p + 24).toInt()
            val nameLen = u16(p + 28)
            val extraLen = u16(p + 30)
            val commentLen = u16(p + 32)
            val localOffset = u32(p + 42).toInt()
            val name = String(bytes, p + 46, nameLen, Charsets.UTF_8)
            val localNameLen = u16(localOffset + 26)
            val localExtraLen = u16(localOffset + 28)
            val dataOffset = localOffset + 30 + localNameLen + localExtraLen
            result.add(ZipEntryInfo(name, method, size, crc, dataOffset))
            p += 46 + nameLen + extraLen + commentLen
        }
        return result
    }

    private fun u16(offset: Int): Int =
        (bytes[offset].toInt() and 0xFF) or ((bytes[offset + 1].toInt() and 0xFF) shl 8)

    private fun u32(offset: Int): Long =
        (bytes[offset].toLong() and 0xFF) or
            ((bytes[offset + 1].toLong() and 0xFF) shl 8) or
            ((bytes[offset + 2].toLong() and 0xFF) shl 16) or
            ((bytes[offset + 3].toLong() and 0xFF) shl 24)

    /** 顺带验证一遍 CRC（自己算，不依赖 java.util.zip）。 */
    fun verifyCrc(name: String): Boolean {
        val e = entry(name) ?: return false
        val crc = CRC32()
        crc.update(data(name))
        return crc.value == e.crc
    }

    companion object {
        fun of(file: File): ZipInspector = ZipInspector(file.readBytes())
    }
}

// ---------------------------------------------------------------------------
// AXML 解析（独立实现）
// ---------------------------------------------------------------------------

class ParsedAttribute(
    val namespace: String?,
    val name: String,
    val resourceId: Int,
    val dataType: Int,
    /** dataType == TYPE_STRING 时的字符串值 */
    val stringValue: String?,
    val intValue: Int,
)

class ParsedNode(
    val name: String,
    val attributes: List<ParsedAttribute>,
    val children: List<ParsedNode>,
) {
    fun attribute(name: String): ParsedAttribute? = attributes.firstOrNull { it.name == name }
    fun child(name: String): ParsedNode? = children.firstOrNull { it.name == name }
}

class ParsedXml(
    val strings: List<String>,
    val resourceMap: List<Int>,
    val root: ParsedNode,
)

object TestAxmlParser {

    private const val CHUNK_STRING_POOL = 0x0001
    private const val CHUNK_XML = 0x0003
    private const val CHUNK_XML_START_NAMESPACE = 0x0100
    private const val CHUNK_XML_END_NAMESPACE = 0x0101
    private const val CHUNK_XML_START_ELEMENT = 0x0102
    private const val CHUNK_XML_END_ELEMENT = 0x0103
    private const val CHUNK_XML_RESOURCE_MAP = 0x0180

    fun parse(bytes: ByteArray): ParsedXml {
        check(u16(bytes, 0) == CHUNK_XML) { "不是 AXML：根区块类型 = ${u16(bytes, 0)}" }
        check(u32(bytes, 4).toInt() == bytes.size) { "AXML 根区块大小与实际不符" }

        var p = u16(bytes, 2)
        check(u16(bytes, p) == CHUNK_STRING_POOL) { "第一个区块不是字符串池" }
        val strings = parseStringPool(bytes, p)
        p += u32(bytes, p + 4).toInt()

        var resourceMap = emptyList<Int>()
        if (u16(bytes, p) == CHUNK_XML_RESOURCE_MAP) {
            val count = (u32(bytes, p + 4).toInt() - u16(bytes, p + 2)) / 4
            resourceMap = (0 until count).map { u32(bytes, p + u16(bytes, p + 2) + it * 4).toInt() }
            p += u32(bytes, p + 4).toInt()
        }

        val stack = ArrayDeque<ParsedNode>()
        var root: ParsedNode? = null
        val finished = HashMap<ParsedNode, MutableList<ParsedNode>>()

        while (p + 8 <= bytes.size) {
            val type = u16(bytes, p)
            val size = u32(bytes, p + 4).toInt()
            when (type) {
                CHUNK_XML_START_NAMESPACE, CHUNK_XML_END_NAMESPACE -> Unit
                CHUNK_XML_START_ELEMENT -> {
                    val nameIndex = i32(bytes, p + 20)
                    val attributeStart = u16(bytes, p + 24)
                    val attributeSize = u16(bytes, p + 26)
                    val attributeCount = u16(bytes, p + 28)
                    val attributes = ArrayList<ParsedAttribute>()
                    for (i in 0 until attributeCount) {
                        val a = p + 16 + attributeStart + i * attributeSize
                        val nsIndex = i32(bytes, a)
                        val attrNameIndex = i32(bytes, a + 4)
                        val dataType = bytes[a + 15].toInt() and 0xFF
                        val data = i32(bytes, a + 16)
                        attributes.add(
                            ParsedAttribute(
                                namespace = if (nsIndex >= 0) strings[nsIndex] else null,
                                name = strings[attrNameIndex],
                                resourceId = if (attrNameIndex < resourceMap.size) resourceMap[attrNameIndex] else 0,
                                dataType = dataType,
                                stringValue = if (dataType == 0x03) strings[data] else null,
                                intValue = data,
                            ),
                        )
                    }
                    val node = ParsedNode(strings[nameIndex], attributes, ArrayList())
                    finished[node] = ArrayList()
                    stack.lastOrNull()?.let { finished.getValue(it).add(node) }
                    stack.addLast(node)
                    if (root == null) root = node
                }
                CHUNK_XML_END_ELEMENT -> {
                    val node = stack.removeLast()
                    val children = finished.getValue(node)
                    val rebuilt = ParsedNode(node.name, node.attributes, children)
                    // 用重建的节点替换父节点里的占位（保持顺序）
                    finished.remove(node)
                    if (stack.isNotEmpty()) {
                        val parentChildren = finished.getValue(stack.last())
                        parentChildren[parentChildren.indexOf(node)] = rebuilt
                    } else {
                        root = rebuilt
                    }
                }
                else -> throw AssertionError("未知的 AXML 区块类型: 0x${type.toString(16)}")
            }
            if (size == 0) break
            p += size
        }
        return ParsedXml(strings, resourceMap, root ?: throw AssertionError("AXML 里没有根元素"))
    }

    fun parseStringPool(bytes: ByteArray, start: Int): List<String> {
        val headerSize = u16(bytes, start + 2)
        val count = u32(bytes, start + 8).toInt()
        val flags = u32(bytes, start + 16).toInt()
        val stringsStart = u32(bytes, start + 20).toInt()
        val utf8 = (flags and 0x100) != 0
        val result = ArrayList<String>(count)
        for (i in 0 until count) {
            var q = start + stringsStart + u32(bytes, start + headerSize + i * 4).toInt()
            if (utf8) {
                val length = bytes[q].toInt() and 0xFF; q++
                // 两字节长度：这里只需要跳过额外的那个字节，值本身用不上（UTF-8 取的是字节长度）
                if (length and 0x80 != 0) q++
                var byteLength = bytes[q].toInt() and 0xFF; q++
                if (byteLength and 0x80 != 0) {
                    byteLength = ((byteLength and 0x7F) shl 8) or (bytes[q].toInt() and 0xFF); q++
                }
                result.add(String(bytes, q, byteLength, Charsets.UTF_8))
            } else {
                var length = u16(bytes, q); q += 2
                if (length and 0x8000 != 0) {
                    length = ((length and 0x7FFF) shl 16) or u16(bytes, q); q += 2
                }
                result.add(String(bytes, q, length * 2, Charsets.UTF_16LE))
            }
        }
        return result
    }

    private fun u16(b: ByteArray, o: Int) = (b[o].toInt() and 0xFF) or ((b[o + 1].toInt() and 0xFF) shl 8)

    private fun i32(b: ByteArray, o: Int) = (b[o].toInt() and 0xFF) or
        ((b[o + 1].toInt() and 0xFF) shl 8) or
        ((b[o + 2].toInt() and 0xFF) shl 16) or
        ((b[o + 3].toInt() and 0xFF) shl 24)

    private fun u32(b: ByteArray, o: Int) = i32(b, o).toLong() and 0xFFFFFFFFL
}

// ---------------------------------------------------------------------------
// resources.arsc 解析（独立实现）
// ---------------------------------------------------------------------------

class ParsedResourceEntry(val key: String, val dataType: Int, val value: String)

class ParsedResourceType(
    val id: Int,
    val name: String,
    val density: Int,
    val entries: List<ParsedResourceEntry>,
)

class ParsedResourceTable(
    val packageName: String,
    val packageId: Int,
    val valueStrings: List<String>,
    val types: List<ParsedResourceType>,
) {
    fun type(name: String): ParsedResourceType? = types.firstOrNull { it.name == name }
}

object TestArscParser {

    private const val CHUNK_TABLE = 0x0002
    private const val CHUNK_PACKAGE = 0x0200
    private const val CHUNK_TYPE = 0x0201
    private const val CHUNK_TYPE_SPEC = 0x0202

    fun parse(bytes: ByteArray): ParsedResourceTable {
        check(u16(bytes, 0) == CHUNK_TABLE) { "不是资源表" }
        check(u32(bytes, 4).toInt() == bytes.size) { "资源表大小与实际不符" }
        val typeStringsPool = LinkedHashMap<Int, String>()

        var p = u16(bytes, 2)
        val valueStrings = TestAxmlParser.parseStringPool(bytes, p)
        p += u32(bytes, p + 4).toInt()
        check(u16(bytes, p) == CHUNK_PACKAGE) { "没有 package 区块" }

        val packageId = u32(bytes, p + 8).toInt()
        val packageName = StringBuilder()
        for (i in 0 until 128) {
            val c = u16(bytes, p + 12 + i * 2)
            if (c == 0) break
            packageName.append(c.toChar())
        }
        val typeStringsOffset = u32(bytes, p + 268).toInt()
        val keyStringsOffset = u32(bytes, p + 276).toInt()
        check(u32(bytes, p + 284).toInt() == 0) { "package.typeIdOffset 应为 0" }

        val typeNames = TestAxmlParser.parseStringPool(bytes, p + typeStringsOffset)
        val keyNames = TestAxmlParser.parseStringPool(bytes, p + keyStringsOffset)

        val entriesByType = LinkedHashMap<Int, MutableList<ParsedResourceEntry>>()
        val densityByType = LinkedHashMap<Int, Int>()
        val packageEnd = p + u32(bytes, p + 4).toInt()
        var q = p + u16(bytes, p + 2)
        while (q < packageEnd) {
            val chunkType = u16(bytes, q)
            val chunkSize = u32(bytes, q + 4).toInt()
            when (chunkType) {
                CHUNK_TYPE_SPEC -> Unit
                CHUNK_TYPE -> {
                    val id = bytes[q + 8].toInt() and 0xFF
                    val entryCount = u32(bytes, q + 12).toInt()
                    val entriesStart = u32(bytes, q + 16).toInt()
                    val headerSize = u16(bytes, q + 2)
                    val density = u16(bytes, q + 20 + 14)
                    densityByType[id] = density
                    val list = entriesByType.getOrPut(id) { ArrayList() }
                    for (i in 0 until entryCount) {
                        val entryOffset = u32(bytes, q + headerSize + i * 4).toInt()
                        if (entryOffset == -1) continue
                        val e = q + entriesStart + entryOffset
                        val entrySize = u16(bytes, e)
                        val keyIndex = u32(bytes, e + 4).toInt()
                        val valueOffset = e + entrySize
                        val valueSize = u16(bytes, valueOffset)
                        check(valueSize == 8) { "Res_value.size 应为 8，实际 $valueSize" }
                        val dataType = bytes[valueOffset + 3].toInt() and 0xFF
                        val data = u32(bytes, valueOffset + 4).toInt()
                        val value = if (dataType == 0x03) valueStrings[data] else "$data"
                        list.add(ParsedResourceEntry(keyNames[keyIndex], dataType, value))
                    }
                }
            }
            if (chunkSize == 0) break
            q += chunkSize
        }

        for ((id, name) in typeNames.withIndex()) {
            typeStringsPool[id + 1] = name
        }
        val types = typeStringsPool.map { (id, name) ->
            ParsedResourceType(id, name, densityByType[id] ?: 0, entriesByType[id] ?: emptyList())
        }
        return ParsedResourceTable(packageName.toString(), packageId, valueStrings, types)
    }

    private fun u16(b: ByteArray, o: Int) = (b[o].toInt() and 0xFF) or ((b[o + 1].toInt() and 0xFF) shl 8)

    private fun u32(b: ByteArray, o: Int) = ((b[o].toInt() and 0xFF).toLong()) or
        ((b[o + 1].toInt() and 0xFF).toLong() shl 8) or
        ((b[o + 2].toInt() and 0xFF).toLong() shl 16) or
        ((b[o + 3].toInt() and 0xFF).toLong() shl 24)
}
