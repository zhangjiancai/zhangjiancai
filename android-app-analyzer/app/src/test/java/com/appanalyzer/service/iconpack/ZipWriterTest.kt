package com.appanalyzer.service.iconpack

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.util.zip.ZipFile

/** ZIP 写入器：标准读取器能不能读、CRC 对不对、数据有没有对齐。 */
class ZipWriterTest {

    @get:Rule
    val temp = TemporaryFolder()

    private fun sample(): ByteArray = ZipWriter().write(
        listOf(
            ZipWriter.Entry("AndroidManifest.xml", ByteArray(37) { it.toByte() }),
            ZipWriter.Entry("resources.arsc", ByteArray(1000) { (it * 7).toByte() }),
            ZipWriter.Entry("res/drawable-xxhdpi-v4/ic_a.png", ByteArray(13) { 1 }),
            ZipWriter.Entry("assets/appfilter.xml", "<resources/>".toByteArray()),
        ),
    )

    @Test
    fun readableByJavaUtilZip() {
        val file = temp.newFile("test.zip")
        file.writeBytes(sample())
        ZipFile(file).use { zip ->
            assertEquals(4, zip.size())
            assertEquals(
                "<resources/>",
                zip.getInputStream(zip.getEntry("assets/appfilter.xml")).readBytes().decodeToString(),
            )
            assertEquals(37, zip.getEntry("AndroidManifest.xml").size)
        }
    }

    /** Android 11+ 要求未压缩的 resources.arsc 4 字节对齐，所有条目一起对齐最省事。 */
    @Test
    fun everyEntryIsFourByteAligned() {
        val inspector = ZipInspector(sample())
        assertEquals(4, inspector.entries.size)
        for (entry in inspector.entries) {
            assertEquals("${entry.name} 的数据偏移没有 4 字节对齐", 0, entry.dataOffset % 4)
        }
        assertEquals("resources.arsc 应该是 STORED", 0, inspector.entry("resources.arsc")!!.method)
        assertTrue(inspector.verifyCrc("resources.arsc"))
    }

    /** 逐个长度试一遍：补位不能把后面的条目顶歪。 */
    @Test
    fun paddingNeverBreaksAlignment() {
        for (length in 1..40) {
            val bytes = ZipWriter().write(
                listOf(
                    ZipWriter.Entry("a", ByteArray(length)),
                    ZipWriter.Entry("b", ByteArray(length + 1)),
                    ZipWriter.Entry("c", ByteArray(length + 2)),
                ),
            )
            for (entry in ZipInspector(bytes).entries) {
                assertEquals("长度 $length 时 ${entry.name} 没对齐", 0, entry.dataOffset % 4)
            }
        }
    }

    @Test
    fun supportsLargerAlignment() {
        val bytes = ZipWriter().write(
            listOf(
                ZipWriter.Entry("a", ByteArray(3)),
                ZipWriter.Entry("b", ByteArray(5), alignment = 4096),
            ),
        )
        assertEquals(0, ZipInspector(bytes).entry("b")!!.dataOffset % 4096)
    }

    @Test
    fun sameInputProducesSameBytes() {
        assertTrue(sample().contentEquals(sample()))
    }

    @Test
    fun entryDataIsStoredVerbatim() {
        val file = temp.newFile("data.zip")
        val payload = ByteArray(777) { (it % 251).toByte() }
        file.writeBytes(ZipWriter().write(listOf(ZipWriter.Entry("x/y.bin", payload))))
        assertTrue(ZipInspector.of(file).data("x/y.bin").contentEquals(payload))
    }
}
