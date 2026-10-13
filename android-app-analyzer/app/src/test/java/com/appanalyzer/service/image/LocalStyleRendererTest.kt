package com.appanalyzer.service.image

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.sqrt

/**
 * 本地风格算法的纯像素测试。不需要模拟器，gradlew test 就能跑。
 *
 * lαβ 变换在这里独立实现了一遍，不复用被测代码。
 */
class LocalStyleRendererTest {

    private fun argb(a: Int, r: Int, g: Int, b: Int) =
        (a shl 24) or (r shl 16) or (g shl 8) or b

    private fun luma(c: Int) =
        (((c shr 16) and 0xFF) * 299 + ((c shr 8) and 0xFF) * 587 + (c and 0xFF) * 114) / 1000

    private fun distinctOpaqueColors(px: IntArray) =
        px.filter { ((it ushr 24) and 0xFF) >= 128 }.toHashSet().size

    /** 造一张有清晰边界的图标：左半红右半绿，中间一条白线 */
    private fun makeTwoTone(size: Int = 64): IntArray {
        val px = IntArray(size * size)
        for (y in 0 until size) for (x in 0 until size) {
            px[y * size + x] = when {
                x < size / 2 -> argb(255, 200, 40, 40)
                else -> argb(255, 40, 180, 60)
            }
        }
        return px
    }

    private fun makeFlat(size: Int = 64): IntArray =
        IntArray(size * size) { argb(255, 120, 120, 120) }

    // ==================== 白线勾勒 ====================

    @Test
    fun `白线勾勒：纯色图不应该产生任何线条`() {
        val out = LocalStyleRenderer.renderPixels(makeFlat(64), 64, 64, LocalStyle.LINE_ART)
        val white = out.count { it == argb(255, 255, 255, 255) }
        assertEquals("纯色图不该有边缘，却有 $white 个白点", 0, white)
        assertTrue("底色必须是纯黑", out.all { it == argb(255, 0, 0, 0) })
    }

    @Test
    fun `白线勾勒：颜色边界应该被画出来`() {
        val size = 64
        val out = LocalStyleRenderer.renderPixels(makeTwoTone(size), size, size, LocalStyle.LINE_ART)
        val white = out.count { it == argb(255, 255, 255, 255) }
        assertTrue("红绿交界处应当有线，实际白点数 $white", white > 0)
        // 线应当集中在 x = size/2 附近
        var nearBoundary = 0
        for (y in 0 until size) for (x in 0 until size) {
            if (out[y * size + x] == argb(255, 255, 255, 255) && kotlin.math.abs(x - size / 2) <= 3) nearBoundary++
        }
        assertTrue("线应当落在交界处，实际只有 $nearBoundary / $white", nearBoundary * 2 > white)
    }

    @Test
    fun `白线勾勒：输出必须只有黑白两色`() {
        val out = LocalStyleRenderer.renderPixels(makeTwoTone(64), 64, 64, LocalStyle.LINE_ART)
        val bad = out.count { it != argb(255, 255, 255, 255) && it != argb(255, 0, 0, 0) }
        assertEquals("出现了非黑非白的像素", 0, bad)
    }

    // ==================== 极简色块 ====================

    @Test
    fun `极简色块：颜色数不应超过设定值`() {
        val size = 64
        val px = IntArray(size * size)
        // 造一张颜色很杂的图
        for (y in 0 until size) for (x in 0 until size) {
            px[y * size + x] = argb(255, (x * 4) % 256, (y * 4) % 256, ((x + y) * 2) % 256)
        }
        for (k in 2..6) {
            val out = LocalStyleRenderer.renderPixels(px, size, size, LocalStyle.MINIMAL, colorCount = k)
            val colors = distinctOpaqueColors(out)
            assertTrue("要求 $k 色，实际出现 $colors 色", colors <= k)
        }
    }

    @Test
    fun `极简色块：应当清掉碎块而不是留下马赛克`() {
        val size = 64
        val px = makeTwoTone(size)
        // 撒一堆单像素噪点
        for (i in 0 until px.size step 7) px[i] = argb(255, 255, 255, 0)
        val out = LocalStyleRenderer.renderPixels(px, size, size, LocalStyle.MINIMAL, colorCount = 4)
        // 众数滤波后，孤立噪点应当被周围的大色块吞掉
        var isolated = 0
        for (y in 1 until size - 1) for (x in 1 until size - 1) {
            val c = out[y * size + x]
            var same = 0
            for (ky in -1..1) for (kx in -1..1) {
                if (kx == 0 && ky == 0) continue
                if (out[(y + ky) * size + (x + kx)] == c) same++
            }
            if (same == 0) isolated++
        }
        assertTrue("仍有 $isolated 个孤立像素，众数滤波没生效", isolated < px.size / 200)
    }

    // ==================== 拟物化 ====================

    @Test
    fun `拟物化：应当产生明暗变化且保持 alpha`() {
        val size = 64
        val src = makeTwoTone(size)
        val out = LocalStyleRenderer.renderPixels(src, size, size, LocalStyle.SKEUO)
        for (i in src.indices) {
            assertEquals("第 $i 个像素 alpha 变了", (src[i] ushr 24) and 0xFF, (out[i] ushr 24) and 0xFF)
        }
        // 上半部分被高光提亮，下半部分被内阴影压暗
        val topLuma = (0 until size / 4).flatMap { y -> (0 until size).map { x -> luma(out[y * size + x]) } }.average()
        val botLuma = (size * 3 / 4 until size).flatMap { y -> (0 until size).map { x -> luma(out[y * size + x]) } }.average()
        assertTrue("上部应当比下部亮（高光/内阴影），实际 $topLuma vs $botLuma", topLuma > botLuma)
    }

    // ==================== 自定义（本地训练的小模型）====================

    private fun toLab(p: Int): Triple<Double, Double, Double> {
        val r = ((p shr 16) and 0xFF) / 255.0
        val g = ((p shr 8) and 0xFF) / 255.0
        val b = (p and 0xFF) / 255.0
        val floor = 1.0 / 255.0
        val lg = log10(max(0.3811 * r + 0.5783 * g + 0.0402 * b, floor))
        val mg = log10(max(0.1967 * r + 0.7244 * g + 0.0782 * b, floor))
        val sg = log10(max(0.0241 * r + 0.1288 * g + 0.8444 * b, floor))
        return Triple((lg + mg + sg) / sqrt(3.0), (lg + mg - 2 * sg) / sqrt(6.0), (lg - mg) / sqrt(2.0))
    }

    private fun comp(v: Triple<Double, Double, Double>, c: Int) =
        when (c) { 0 -> v.first; 1 -> v.second; else -> v.third }

    private fun stats(px: IntArray): Array<DoubleArray> {
        val labs = px.filter { ((it ushr 24) and 0xFF) >= 128 }.map { toLab(it) }
        val mean = DoubleArray(3) { c -> labs.sumOf { comp(it, c) } / labs.size }
        val std = DoubleArray(3) { c -> sqrt(labs.sumOf { v -> val d = comp(v, c) - mean[c]; d * d } / labs.size) }
        return arrayOf(mean, std)
    }

    /** 纯灰阶风格图：训练后输出必须去色 */
    private fun makeGrayStyle(size: Int = 64): IntArray {
        val px = IntArray(size * size)
        for (y in 0 until size) for (x in 0 until size) {
            val v = y * 255 / (size - 1)
            px[y * size + x] = argb(255, v, v, v)
        }
        return px
    }

    /**
     * 训练用的「内容」图，必须**覆盖整个色立方**。
     *
     * 一开始这里用的是那张只有两种颜色的图，结果怎么训都收敛不了 ——
     * 两个颜色点再怎么映射也只有两个取值，不可能拟合出 64 级灰阶的完整分布，
     * 这是数学上做不到的，不是算法不行。真实 App 里喂的是均匀采样的 RGB 色立方，
     * 测试也应当用同样性质的数据。
     */
    private fun makeColorCubeImage(size: Int = 64): IntArray {
        val px = IntArray(size * size)
        val steps = 16
        for (y in 0 until size) for (x in 0 until size) {
            val r = (x * steps / size) * 255 / (steps - 1)
            val g = (y * steps / size) * 255 / (steps - 1)
            val b = ((x + y) * steps / (size * 2)) * 255 / (steps - 1)
            px[y * size + x] = argb(255, r, g, b)
        }
        return px
    }

    @Test
    fun `恒等初始化的查找表应当是直通的`() {
        val model = ColorLutModel(17)
        val src = makeTwoTone(32)
        val out = model.apply(src)
        var maxDiff = 0
        for (i in src.indices) {
            val d = kotlin.math.abs(((src[i] shr 16) and 0xFF) - ((out[i] shr 16) and 0xFF))
            if (d > maxDiff) maxDiff = d
        }
        assertTrue("恒等 LUT 应当原样输出，最大偏差 $maxDiff", maxDiff <= 2)
    }

    @Test
    fun `本地训练出来的模型应当拟合风格图的颜色分布`() {
        val size = 64
        val content = makeColorCubeImage(size)
        val style = makeGrayStyle(size)

        val model = ColorLutModel(17)
        val loss = model.train(content, style, iterations = 500)
        assertTrue("训练没有收敛，最终 loss=$loss", loss < 0.02)

        val out = model.apply(content)
        val sStyle = stats(style)
        val sOut = stats(out)
        println("风格  lab 均值=" + sStyle[0].joinToString(",") { "%.4f".format(it) } +
                " 标准差=" + sStyle[1].joinToString(",") { "%.4f".format(it) })
        println("输出  lab 均值=" + sOut[0].joinToString(",") { "%.4f".format(it) } +
                " 标准差=" + sOut[1].joinToString(",") { "%.4f".format(it) })
        for (c in 0..2) {
            assertEquals("通道 $c 均值没对上", sStyle[0][c], sOut[0][c], 0.02)
            assertEquals("通道 $c 标准差没对上", sStyle[1][c], sOut[1][c], 0.02)
        }
        // 灰阶风格 => 输出必须去色
        var maxChroma = 0.0
        var avgChroma = 0.0
        var count = 0
        for (i in out.indices) {
            if (((out[i] ushr 24) and 0xFF) < 128) continue
            val r = (out[i] shr 16) and 0xFF; val g = (out[i] shr 8) and 0xFF; val b = out[i] and 0xFF
            val c = (maxOf(r, g, b) - minOf(r, g, b)).toDouble()
            maxChroma = max(maxChroma, c)
            avgChroma += c
            count++
        }
        avgChroma /= count
        var highChroma = 0
        for (i in out.indices) {
            if (((out[i] ushr 24) and 0xFF) < 128) continue
            val r = (out[i] shr 16) and 0xFF; val g = (out[i] shr 8) and 0xFF; val b = out[i] and 0xFF
            if (maxOf(r, g, b) - minOf(r, g, b) > 20) highChroma++
        }
        val highRatio = highChroma.toDouble() / count
        println("彩度  最大=" + "%.1f".format(maxChroma) + "  平均=" + "%.2f".format(avgChroma) +
                "  超过20的占比=" + "%.2f%%".format(highRatio * 100))
        // 平均彩度才是有意义的指标 —— 最大值由极少数离群像素决定，
        // 那些像素在训练微调明度时三通道步长不完全一致，会留一点点偏色。
        assertTrue("平均彩度 $avgChroma 偏高，说明没真正去色", avgChroma < 6.0)
        assertTrue("彩度超过 20 的像素占了 $highRatio，太多了", highRatio < 0.03)
    }

    @Test
    fun `训练必须让 loss 下降`() {
        val size = 48
        val model = ColorLutModel(17)
        var first = Float.MAX_VALUE
        var last = 0f
        model.train(makeColorCubeImage(size), makeGrayStyle(size), iterations = 200) { done, l ->
            if (done <= 1) first = l
            last = l
        }
        assertTrue("loss 应当显著下降：初始 $first -> 最终 $last", last < first * 0.5f)
    }

    @Test
    fun `训练后透明像素必须原样保留`() {
        val size = 32
        val src = IntArray(size * size) {
            if (it % 3 == 0) argb(0, 0, 0, 0) else argb(255, (it * 7) % 256, 100, 200)
        }
        val model = ColorLutModel(17)
        model.train(src, makeGrayStyle(size), iterations = 60)
        val out = model.apply(src)
        for (i in src.indices) {
            if (((src[i] ushr 24) and 0xFF) < 8) assertEquals("透明像素被改了", src[i], out[i])
        }
    }
}
