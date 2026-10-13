package com.appanalyzer.service.iconpack

import java.io.ByteArrayOutputStream
import java.util.zip.CRC32

/**
 * 极简 ZIP 写入器：只写 STORED（不压缩）条目，但可以控制每个条目数据的对齐。
 *
 * 为什么自己写而不是用 java.util.zip.ZipOutputStream：
 *  1. ZipOutputStream 无法控制条目数据的起始偏移，而 Android 11+ 要求
 *     未压缩的 resources.arsc **必须 4 字节对齐**，否则装机直接失败；
 *  2. 图标包里的 PNG 本身已经是压缩数据，再 deflate 一遍纯属浪费时间与内存。
 *
 * 对齐靠 ZIP 的「扩展字段（extra field）」补零实现，与 zipalign 的做法一致
 * （zipalign 用 id 0xD935 的扩展字段做填充，这里照抄）。
 */
class ZipWriter {

    /** 一个待写入的条目。data 会原样存进 ZIP（method = 0，STORED）。 */
    class Entry(
        val name: String,
        val data: ByteArray,
        val alignment: Int = 4,
    )

    fun write(entries: List<Entry>): ByteArray {
        val out = ByteArrayOutputStream()
        val central = ByteArrayOutputStream()
        val count = entries.size

        for (entry in entries) {
            val nameBytes = entry.name.toByteArray(Charsets.UTF_8)
            val crc = CRC32().apply { update(entry.data) }.value
            val localOffset = out.size()
            val padding = paddingFor(localOffset + 30 + nameBytes.size, entry.alignment)

            writeInt(out, 0x04034b50)
            writeShort(out, 20)              // version needed to extract
            writeShort(out, 0x0800)          // general purpose flags：文件名是 UTF-8
            writeShort(out, 0)               // method = STORED
            writeShort(out, DOS_TIME)
            writeShort(out, DOS_DATE)
            writeInt(out, crc.toInt())
            writeInt(out, entry.data.size)
            writeInt(out, entry.data.size)
            writeShort(out, nameBytes.size)
            writeShort(out, padding)
            out.write(nameBytes, 0, nameBytes.size)
            if (padding > 0) writeAlignmentPadding(out, padding)
            out.write(entry.data, 0, entry.data.size)

            writeInt(central, 0x02014b50)
            writeShort(central, 20)          // version made by
            writeShort(central, 20)          // version needed
            writeShort(central, 0x0800)
            writeShort(central, 0)
            writeShort(central, DOS_TIME)
            writeShort(central, DOS_DATE)
            writeInt(central, crc.toInt())
            writeInt(central, entry.data.size)
            writeInt(central, entry.data.size)
            writeShort(central, nameBytes.size)
            writeShort(central, 0)           // extra length
            writeShort(central, 0)           // comment length
            writeShort(central, 0)           // disk number start
            writeShort(central, 0)           // internal attributes
            writeInt(central, 0)             // external attributes
            writeInt(central, localOffset)
            central.write(nameBytes, 0, nameBytes.size)
        }

        val centralBytes = central.toByteArray()
        val centralOffset = out.size()
        out.write(centralBytes, 0, centralBytes.size)
        writeInt(out, 0x06054b50)
        writeShort(out, 0)
        writeShort(out, 0)
        writeShort(out, count)
        writeShort(out, count)
        writeInt(out, centralBytes.size)
        writeInt(out, centralOffset)
        writeShort(out, 0)
        return out.toByteArray()
    }

    /**
     * 需要补多少字节才能让数据起始位置对齐。
     *
     * 对齐本身要占 4 字节的扩展字段头，所以补 1~3 字节时只能再多补一整轮对齐单位
     * （和 zipalign 的行为一致：宁可多补，也不能写一个非法的扩展字段）。
     */
    private fun paddingFor(dataOffset: Int, alignment: Int): Int {
        if (alignment <= 1) return 0
        val remainder = dataOffset % alignment
        if (remainder == 0) return 0
        var padding = alignment - remainder
        if (padding in 1..3) padding += alignment
        return padding
    }

    /** 写一个 id = 0xD935 的填充扩展字段（zipalign 用的就是这个 id），总长度正好 padding 字节。 */
    private fun writeAlignmentPadding(out: ByteArrayOutputStream, padding: Int) {
        out.write(0x35)
        out.write(0xD9)
        val payload = padding - 4
        out.write(payload and 0xFF)
        out.write((payload ushr 8) and 0xFF)
        repeat(payload) { out.write(0) }
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

    companion object {
        /** 固定时间戳（2009-01-01 00:00:00）—— 让同样的输入产出同样的 APK。 */
        private const val DOS_DATE = ((2009 - 1980) shl 9) or (1 shl 5) or 1
        private const val DOS_TIME = 0
    }
}
