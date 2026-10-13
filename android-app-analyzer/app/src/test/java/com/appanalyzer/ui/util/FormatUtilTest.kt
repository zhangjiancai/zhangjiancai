package com.appanalyzer.ui.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Locale

/**
 * 体积格式化的纯 JVM 测试。重点覆盖：0、负数、未知值、刚好 1024 的整数倍、超大数。
 *
 * 这个文件同时是「德语环境下会不会输出 1,5 MB」的回归测试：源码特意用了 Locale.US。
 */
class FormatUtilTest {

    private val kb = 1024L
    private val mb = 1024L * 1024
    private val gb = 1024L * 1024 * 1024

    // ==================== formatFileSize ====================

    @Test
    fun `0 字节是合法读数，必须显示 0 B 而不是占位符`() {
        assertEquals("0 字节必须原样显示成 0 B（不能显示成未知占位符）", "0 B", formatFileSize(0))
    }

    @Test
    fun `负数视为未知读数，显示占位符`() {
        assertEquals("-1 字节应当显示未知占位符", UNKNOWN_SIZE, formatFileSize(-1))
        assertEquals("Long.MIN_VALUE 应当显示未知占位符", UNKNOWN_SIZE, formatFileSize(Long.MIN_VALUE))
    }

    @Test
    fun `小于 1024 字节按整数 B 输出`() {
        assertEquals("1 字节应当是 1 B", "1 B", formatFileSize(1))
        assertEquals("1023 字节应当是 1023 B", "1023 B", formatFileSize(1023))
    }

    @Test
    fun `1024 的整数倍正好进入下一个单位`() {
        assertEquals("1024 字节正好是 1.0 KB", "1.0 KB", formatFileSize(kb))
        assertEquals("1MB-1 字节仍然按 KB 显示", "1024.0 KB", formatFileSize(mb - 1))
        assertEquals("1MB 正好是 1.0 MB", "1.0 MB", formatFileSize(mb))
        assertEquals("1GB-1 字节仍然按 MB 显示", "1024.0 MB", formatFileSize(gb - 1))
        assertEquals("1GB 正好是 1.0 GB", "1.0 GB", formatFileSize(gb))
        assertEquals("2GB 应当是 2.0 GB", "2.0 GB", formatFileSize(2 * gb))
    }

    @Test
    fun `保留一位小数并四舍五入`() {
        assertEquals("1536 字节 = 1.5 KB", "1.5 KB", formatFileSize(1536))
        assertEquals("1025 字节 = 1.0009 KB，保留一位是 1.0 KB", "1.0 KB", formatFileSize(1025))
        assertEquals("12345 字节 = 12.055 KB，四舍五入是 12.1 KB", "12.1 KB", formatFileSize(12345))
        assertEquals("1536 KB = 1.5 MB", "1.5 MB", formatFileSize(1536 * kb))
        assertEquals("500 MB", "500.0 MB", formatFileSize(500 * mb))
        assertEquals("2560 MB = 2.5 GB", "2.5 GB", formatFileSize(2560L * mb))
    }

    @Test
    fun `超大数不会溢出，也不会变成科学计数法`() {
        val s = formatFileSize(Long.MAX_VALUE)
        assertEquals("Long.MAX_VALUE 应当按 GB 显示成 8589934592.0 GB", "8589934592.0 GB", s)
        assertFalse("不能出现科学计数法，实际是 " + s, s.contains("E") || s.contains("e"))
    }

    @Test
    fun `德语等区域设置下小数点仍然是点号`() {
        val original = Locale.getDefault()
        try {
            Locale.setDefault(Locale.GERMANY)
            assertEquals("德语环境必须是 1.5 MB，出现 1,5 MB 说明又用回了默认 Locale", "1.5 MB", formatFileSize(1536 * kb))
            assertEquals("KB 档同样必须是点号", "12.1 KB", formatFileSize(12345))
            assertEquals("GB 档同样必须是点号", "1.5 GB", formatFileSize(1536 * gb / 1024))
        } finally {
            Locale.setDefault(original)
        }
    }

    // ==================== formatFileSizeOrUnknown ====================

    @Test
    fun `known=true 时才显示数字`() {
        assertEquals("known=true 且有真实读数时显示格式化结果", "1.0 KB", formatFileSizeOrUnknown(kb, true))
        assertEquals("known=true 且读数真的是 0 时必须显示 0 B", "0 B", formatFileSizeOrUnknown(0, true))
    }

    @Test
    fun `known=false 时任何字节数都显示占位符`() {
        assertEquals("known=false 时 0 字节也必须显示占位符（不能假装这个应用没有缓存）",
            UNKNOWN_SIZE, formatFileSizeOrUnknown(0, false))
        assertEquals("known=false 时非零字节数显示占位符", UNKNOWN_SIZE, formatFileSizeOrUnknown(123456, false))
        assertEquals("known=false 时负数显示占位符", UNKNOWN_SIZE, formatFileSizeOrUnknown(-1, false))
    }

    @Test
    fun `known=true 但读数异常为负数时仍然显示占位符`() {
        assertEquals("负数不是可信读数，即使 known=true 也要显示占位符",
            UNKNOWN_SIZE, formatFileSizeOrUnknown(-1, true))
    }

    @Test
    fun `未知占位符不能长得像真实读数`() {
        assertEquals("占位符常量应当是全角破折号", "—", UNKNOWN_SIZE)
        assertTrue("占位符不能是空串，否则界面上会以为没渲染出来", UNKNOWN_SIZE.isNotEmpty())
        assertFalse("占位符不能含数字，否则会被误读成真实体积", UNKNOWN_SIZE.any { it.isDigit() })
    }
}
