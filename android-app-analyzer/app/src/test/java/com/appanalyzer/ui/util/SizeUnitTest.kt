package com.appanalyzer.ui.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Locale

/**
 * 体积单位枚举的纯 JVM 测试。
 *
 * 与 FormatUtil.formatFileSize 的关键差别（源码里就是这样，测试如实记录）：
 * - SizeUnit 按「用户选定的单位」换算，不做自动降级；
 * - 负数不做兜底，会原样带负号输出；
 * - GB 档保留两位小数，其余档保留一位。
 */
class SizeUnitTest {

    private val kb = 1024L
    private val mb = 1024L * 1024
    private val gb = 1024L * 1024 * 1024

    @Test
    fun `枚举的名字、标签与除数一一对应`() {
        assertEquals("单位数量应当是 4 个", 4, SizeUnit.values().size)
        assertEquals("B 的除数必须是 1", 1L, SizeUnit.B.divisor)
        assertEquals("KB 的除数必须是 1024", 1024L, SizeUnit.KB.divisor)
        assertEquals("MB 的除数必须是 1024*1024", mb, SizeUnit.MB.divisor)
        assertEquals("GB 的除数必须是 1024^3", gb, SizeUnit.GB.divisor)
        SizeUnit.values().forEach { u ->
            assertEquals(u.name + " 的标签应当与枚举名一致", u.name, u.label)
        }
    }

    @Test
    fun `B 档按整数输出，不做单位换算`() {
        assertEquals("0 字节是 0 B", "0 B", SizeUnit.B.format(0))
        assertEquals("选了 B 档就不换算：1024 字节仍然是 1024 B", "1024 B", SizeUnit.B.format(1024))
        assertEquals("1MB 用 B 显示就是 1048576 B", "1048576 B", SizeUnit.B.format(mb))
        assertEquals("B 档没有未知值概念，负数原样输出", "-5 B", SizeUnit.B.format(-5))
    }

    @Test
    fun `KB 档保留一位小数`() {
        assertEquals("KB 档的 0 是 0.0 KB", "0.0 KB", SizeUnit.KB.format(0))
        assertEquals("1024 字节 = 1.0 KB", "1.0 KB", SizeUnit.KB.format(kb))
        assertEquals("1536 字节 = 1.5 KB", "1.5 KB", SizeUnit.KB.format(1536))
        assertEquals("负数原样带负号（不做未知值兜底）", "-1.0 KB", SizeUnit.KB.format(-kb))
    }

    @Test
    fun `MB 档保留一位小数`() {
        assertEquals("MB 档的 0 是 0.0 MB", "0.0 MB", SizeUnit.MB.format(0))
        assertEquals("1MB", "1.0 MB", SizeUnit.MB.format(mb))
        assertEquals("512KB = 0.5 MB", "0.5 MB", SizeUnit.MB.format(512 * kb))
        assertEquals("1536KB = 1.5 MB", "1.5 MB", SizeUnit.MB.format(1536 * kb))
    }

    @Test
    fun `GB 档保留两位小数`() {
        assertEquals("GB 档的 0 是 0.00 GB", "0.00 GB", SizeUnit.GB.format(0))
        assertEquals("1GB 必须显示成 1.00 GB（两位小数）", "1.00 GB", SizeUnit.GB.format(gb))
        assertEquals("1536MB = 1.50 GB", "1.50 GB", SizeUnit.GB.format(1536L * mb))
        assertEquals("1280MB = 1.25 GB", "1.25 GB", SizeUnit.GB.format(1280L * mb))
        assertEquals("负数原样带负号", "-1.00 GB", SizeUnit.GB.format(-gb))
    }

    @Test
    fun `超大数不会溢出`() {
        assertEquals("Long.MAX_VALUE 按 GB 显示", "8589934592.00 GB", SizeUnit.GB.format(Long.MAX_VALUE))
        assertEquals("Long.MAX_VALUE 按 B 显示就是原值",
            Long.MAX_VALUE.toString() + " B", SizeUnit.B.format(Long.MAX_VALUE))
    }

    @Test
    fun `德语等区域设置下小数点仍然是点号`() {
        val original = Locale.getDefault()
        try {
            Locale.setDefault(Locale.GERMANY)
            assertEquals("KB 档不能变成 1,5 KB", "1.5 KB", SizeUnit.KB.format(1536))
            assertEquals("GB 档不能变成 1,50 GB", "1.50 GB", SizeUnit.GB.format(1536L * mb))
        } finally {
            Locale.setDefault(original)
        }
    }

    @Test
    fun `每个枚举值的 format 都不会返回空串`() {
        SizeUnit.values().forEach { u ->
            assertTrue(u.name + ".format(0) 不能返回空串", u.format(0).isNotEmpty())
            assertTrue(u.name + ".format(0) 必须带上单位标签", u.format(0).endsWith(" " + u.label))
        }
    }
}
