package com.appanalyzer.service.iconpack

import java.io.ByteArrayOutputStream

/** 一个「文件型」资源：key 是资源名（启动器按这个名字找图标），filePath 是 APK 内的路径。 */
class ResourceFileEntry(val key: String, val filePath: String)

/**
 * 一种资源类型，配上它所属的配置。
 *
 * 图标包里只用到两种：drawable（xxhdpi 密度）和 xml（默认配置）。
 * 同一个类型名只允许出现一次 —— 本编码器只支持「一个类型一个配置」的简单情形。
 */
class ResourceTypeConfig(
    val typeName: String,
    val density: Int,
    val entries: List<ResourceFileEntry>,
)

/**
 * resources.arsc 编码器 —— 纯 Kotlin/JVM 实现。
 *
 * 手机里直接产出可安装的图标包 APK，就必须自己写 resources.arsc：启动器是用
 * Resources.getIdentifier(图标名, "drawable", 图标包包名) 找图标的，没有 arsc 就找不到。
 *
 * 产物结构与 aapt2 一致（已用 aapt2 dump resources 对照验证）：
 *   ResTable_header(12)
 *   ├─ 全局值字符串池(0x0001, UTF-8)        所有 res/... 文件路径
 *   └─ ResTable_package(0x0200, 头 288 字节)
 *        ├─ 类型名字符串池(0x0001, UTF-8)    drawable / xml ...
 *        ├─ 资源名字符串池(0x0001, UTF-8)
 *        └─ 每个类型：ResTable_typeSpec(0x0202) + ResTable_type(0x0201)
 *
 * 类型 id 按类型名字典序分配（与 aapt2 一致：drawable=1、xml=2 ...）。
 * 每个文件型资源的值是 Res_value{dataType=TYPE_STRING, data=路径在全局池中的下标}。
 */
object ResourceTable {

    /** 应用包的包 id，固定 0x7f。 */
    const val PACKAGE_ID = 0x7F

    private const val CHUNK_TABLE = 0x0002
    private const val CHUNK_PACKAGE = 0x0200
    private const val CHUNK_TYPE = 0x0201
    private const val CHUNK_TYPE_SPEC = 0x0202

    /** ResTable_config 固定写 64 字节（与 build-tools 34 的 aapt2 一致），只填 density。 */
    private const val CONFIG_SIZE = 64

    /** ResTable_package 头：8 + id(4) + name(256) + 4 个 u32（含 typeIdOffset） */
    private const val PACKAGE_HEADER_SIZE = 288

    private const val TYPE_STRING = 0x03

    /** ResTable_type 里 entriesStart 之前的部分 */
    private const val TYPE_HEADER_BASE = 20

    /** 一条简单资源：ResTable_entry(8) + Res_value(8) */
    private const val ENTRY_SIZE = 16

    fun encode(packageName: String, types: List<ResourceTypeConfig>): ByteArray {
        require(packageName.isNotEmpty() && packageName.length <= 127) { "包名长度非法: $packageName" }
        val sorted = types.sortedBy { it.typeName }
        require(sorted.map { it.typeName }.distinct().size == sorted.size) { "同一个资源类型名出现了多次" }

        val keyPool = StringPoolBuilder(utf8 = true)
        val valuePool = StringPoolBuilder(utf8 = true)
        for (type in sorted) {
            for (entry in type.entries) {
                keyPool.indexOf(entry.key)
                valuePool.indexOf(entry.filePath)
            }
        }
        val typePool = StringPoolBuilder(utf8 = true)
        for (type in sorted) typePool.indexOf(type.typeName)

        val typePoolBytes = typePool.build()
        val keyPoolBytes = keyPool.build()

        val body = ByteArrayOutputStream()
        var typeIndex = 1
        for (type in sorted) {
            writeTypeSpec(body, typeIndex, type.entries.size)
            writeType(body, typeIndex, type, keyPool, valuePool)
            typeIndex++
        }
        val bodyBytes = body.toByteArray()

        val packageSize = PACKAGE_HEADER_SIZE + typePoolBytes.size + keyPoolBytes.size + bodyBytes.size
        val packageChunk = ByteArrayOutputStream(packageSize)
        writeChunkHeader(packageChunk, CHUNK_PACKAGE, PACKAGE_HEADER_SIZE, packageSize)
        writeInt(packageChunk, PACKAGE_ID)
        writePackageName(packageChunk, packageName)
        writeInt(packageChunk, PACKAGE_HEADER_SIZE)                                // typeStrings 偏移
        writeInt(packageChunk, 0)                                                  // lastPublicType
        writeInt(packageChunk, PACKAGE_HEADER_SIZE + typePoolBytes.size)           // keyStrings 偏移
        writeInt(packageChunk, 0)                                                  // lastPublicKey
        writeInt(packageChunk, 0)                                                  // typeIdOffset
        packageChunk.write(typePoolBytes, 0, typePoolBytes.size)
        packageChunk.write(keyPoolBytes, 0, keyPoolBytes.size)
        packageChunk.write(bodyBytes, 0, bodyBytes.size)
        val packageBytes = packageChunk.toByteArray()

        val valuePoolBytes = valuePool.build()
        val total = 12 + valuePoolBytes.size + packageBytes.size
        val out = ByteArrayOutputStream(total)
        writeChunkHeader(out, CHUNK_TABLE, 12, total)
        writeInt(out, 1)                       // packageCount
        out.write(valuePoolBytes, 0, valuePoolBytes.size)
        out.write(packageBytes, 0, packageBytes.size)
        return out.toByteArray()
    }

    private fun writeTypeSpec(out: ByteArrayOutputStream, id: Int, entryCount: Int) {
        writeChunkHeader(out, CHUNK_TYPE_SPEC, 16, 16 + 4 * entryCount)
        out.write(id)
        out.write(0)                 // res0
        writeShort(out, 0)           // res1
        writeInt(out, entryCount)
        repeat(entryCount) { writeInt(out, 0) }   // 每个 entry 的配置变更标志，图标包不需要
    }

    private fun writeType(
        out: ByteArrayOutputStream,
        id: Int,
        type: ResourceTypeConfig,
        keyPool: StringPoolBuilder,
        valuePool: StringPoolBuilder,
    ) {
        val entryCount = type.entries.size
        val headerSize = TYPE_HEADER_BASE + CONFIG_SIZE
        val entriesStart = headerSize + 4 * entryCount
        val size = entriesStart + ENTRY_SIZE * entryCount

        writeChunkHeader(out, CHUNK_TYPE, headerSize, size)
        out.write(id)
        out.write(0)                 // res0/flags
        writeShort(out, 0)           // res1
        writeInt(out, entryCount)
        writeInt(out, entriesStart)

        val config = ByteArray(CONFIG_SIZE)
        writeIntTo(config, 0, CONFIG_SIZE)
        if (type.density != 0) writeShortTo(config, 14, type.density)   // density 在 config 偏移 14
        out.write(config, 0, config.size)

        var offset = 0
        for (i in 0 until entryCount) {
            writeInt(out, offset)
            offset += ENTRY_SIZE
        }
        for (entry in type.entries) {
            writeShort(out, 8)                    // ResTable_entry.size
            writeShort(out, 0)                    // flags：0 = 简单值（非 bag）
            writeInt(out, keyPool.indexOf(entry.key))
            writeShort(out, 8)                    // Res_value.size
            out.write(0)                          // res0
            out.write(TYPE_STRING)
            writeInt(out, valuePool.indexOf(entry.filePath))
        }
    }

    private fun writePackageName(out: ByteArrayOutputStream, name: String) {
        for (ch in name) {
            out.write(ch.code and 0xFF)
            out.write((ch.code ushr 8) and 0xFF)
        }
        repeat(256 - name.length * 2) { out.write(0) }
    }

    private fun writeChunkHeader(out: ByteArrayOutputStream, type: Int, headerSize: Int, size: Int) {
        writeShort(out, type)
        writeShort(out, headerSize)
        writeInt(out, size)
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

    private fun writeShortTo(target: ByteArray, offset: Int, value: Int) {
        target[offset] = (value and 0xFF).toByte()
        target[offset + 1] = ((value ushr 8) and 0xFF).toByte()
    }

    private fun writeIntTo(target: ByteArray, offset: Int, value: Int) {
        target[offset] = (value and 0xFF).toByte()
        target[offset + 1] = ((value ushr 8) and 0xFF).toByte()
        target[offset + 2] = ((value ushr 16) and 0xFF).toByte()
        target[offset + 3] = ((value ushr 24) and 0xFF).toByte()
    }
}
