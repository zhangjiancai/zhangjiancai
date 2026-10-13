package com.appanalyzer.service.image

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 合成器的纯像素测试。不需要模拟器。
 *
 * 这一环是「抠图之后」缺的那一步：主体 -> 缩放进留白 + 画新背景 + 投影 + 圆角 = 新图标。
 */
class IconComposerTest {

    private fun argb(a: Int, r: Int, g: Int, b: Int) = (a shl 24) or (r shl 16) or (g shl 8) or b
    private fun alpha(c: Int) = (c ushr 24) and 0xFF
    private fun red(c: Int) = (c shr 16) and 0xFF
    private fun green(c: Int) = (c shr 8) and 0xFF
    private fun blue(c: Int) = c and 0xFF

    /** 造一个 32x32 的正方形主体，四周 8px 透明 */
    private fun makeSubject(): IntArray {
        val s = 32; val px = IntArray(s * s)
        for (y in 0 until s) for (x in 0 until s) {
            px[y * s + x] = if (x in 8..23 && y in 8..23) argb(255, 255, 80, 40) else argb(0, 0, 0, 0)
        }
        return px
    }

    private fun compose(spec: ComposeSpec, size: Int = 64) =
        IconComposer.composePixels(makeSubject(), 32, 32, null, 0, 0, spec, size)

    @Test
    fun `透明背景：主体之外应当完全透明`() {
        val spec = ComposeSpec(background = IconBackground.TRANSPARENT, subjectScale = 0.5f, cornerRadius = 0f, shadow = false)
        val out = compose(spec)
        // 主体被缩到中间 32x32（64 的一半），四个角必然在外面
        assertEquals("左上角应当是透明的", 0, alpha(out[0]))
        assertEquals("右上角应当是透明的", 0, alpha(out[63]))
        // 正中心应当是不透明的主体色
        val center = out[32 * 64 + 32]
        assertEquals("中心应当不透明", 255, alpha(center))
    }

    @Test
    fun `纯色背景：主体之外应当铺满指定颜色`() {
        val color = argb(255, 20, 140, 220)
        val spec = ComposeSpec(background = IconBackground.SOLID, colorTop = color,
            subjectScale = 0.5f, cornerRadius = 0f, shadow = false)
        val out = compose(spec)
        val corner = out[0]
        assertEquals("左上角应当是背景色", color, corner)
        assertEquals("背景必须不透明", 255, alpha(corner))
    }

    @Test
    fun `渐变背景：上端与下端应当分别是两个端点色`() {
        val top = argb(255, 255, 0, 0)
        val bottom = argb(255, 0, 0, 255)
        val spec = ComposeSpec(background = IconBackground.GRADIENT, colorTop = top, colorBottom = bottom,
            subjectScale = 0.5f, cornerRadius = 0f, shadow = false)
        val size = 64
        val out = compose(spec, size)
        // 取最左边一列（主体缩放后居中，左右边缘一定是背景）
        assertEquals("顶部应当是起始色", top, out[0])
        assertEquals("底部应当是结束色", bottom, out[(size - 1) * size])
        // 中间应当介于两者之间
        val mid = out[(size / 2) * size]
        assertTrue("中间色应当介于红蓝之间，实际 R=${red(mid)} B=${blue(mid)}",
            red(mid) in 1..254 && blue(mid) in 1..254)
    }

    @Test
    fun `留白：主体缩放越小，占的面积越小`() {
        val big = compose(ComposeSpec(background = IconBackground.SOLID, colorTop = argb(255, 0, 0, 0),
            subjectScale = 1.0f, cornerRadius = 0f, shadow = false))
        val small = compose(ComposeSpec(background = IconBackground.SOLID, colorTop = argb(255, 0, 0, 0),
            subjectScale = 0.5f, cornerRadius = 0f, shadow = false))
        // 直接比主体色像素数更直观
        val bigSubject = big.count { red(it) == 255 && green(it) == 80 }
        val smallSubject = small.count { red(it) == 255 && green(it) == 80 }
        assertTrue("scale=1.0 的主体应当比 scale=0.5 大：$bigSubject vs $smallSubject", bigSubject > smallSubject)
        assertTrue("scale=0.5 时主体不应当超过画布的四分之一，实际 $smallSubject / 4096", smallSubject < 4096 / 3)
    }

    @Test
    fun `圆角：四角应当被切掉`() {
        val spec = ComposeSpec(background = IconBackground.SOLID, colorTop = argb(255, 30, 30, 30),
            subjectScale = 0.5f, cornerRadius = 0.3f, shadow = false)
        val size = 64
        val out = compose(spec, size)
        assertEquals("左上角应当被圆角切掉", 0, alpha(out[0]))
        assertEquals("右下角应当被圆角切掉", 0, alpha(out[size * size - 1]))
        assertEquals("正中心不应受影响", 255, alpha(out[size / 2 * size + size / 2]))
        // 圆角半径 0 时四角应当保留
        val square = compose(ComposeSpec(background = IconBackground.SOLID, colorTop = argb(255, 30, 30, 30),
            subjectScale = 0.5f, cornerRadius = 0f, shadow = false), size)
        assertEquals("半径 0 时左上角应当保留", 255, alpha(square[0]))
    }

    @Test
    fun `投影：主体下方应当变暗`() {
        val bg = argb(255, 200, 200, 200)
        val withShadow = compose(ComposeSpec(background = IconBackground.SOLID, colorTop = bg,
            subjectScale = 0.5f, cornerRadius = 0f, shadow = true, shadowAlpha = 0.6f))
        val noShadow = compose(ComposeSpec(background = IconBackground.SOLID, colorTop = bg,
            subjectScale = 0.5f, cornerRadius = 0f, shadow = false))
        // 主体的**不透明**区域：素材里有色方块在 8..23，缩放到 box=32 后仍是 8..23，
        // 加上 offset=16 => 输出里是第 24..39 行。
        // 投影是「主体 alpha 下移 dy=2 再模糊 radius=2」，所以落在第 22..45 行，
        // 其中 24..39 被主体自身盖住，**真正看得见的是第 40..45 行**。
        var darker = 0
        for (y in 40..45) for (x in 16..47) {
            if (red(withShadow[y * 64 + x]) < red(noShadow[y * 64 + x])) darker++
        }
        assertTrue("主体下方应当有像素被投影压暗，实际 $darker 个", darker > 20)
    }

    @Test
    fun `主体像素必须精确落在居中位置`() {
        val spec = ComposeSpec(background = IconBackground.SOLID, colorTop = argb(255, 0, 0, 0),
            subjectScale = 0.5f, cornerRadius = 0f, shadow = false)
        val size = 64
        val out = compose(spec, size)
        // box = 32，offset = 16，所以主体覆盖 16..47
        val inside = out[32 * size + 32]
        assertEquals("中心像素应当是主体色", 255, red(inside))
        assertEquals("中心像素应当是主体色", 80, green(inside))
        assertEquals("紧贴主体外侧应当是背景色", 0, red(out[32 * size + 15]))
    }

    @Test
    fun `风格图背景：应当铺满且不失真`() {
        // 造一张 8x8 的纯青色风格图
        val styleColor = argb(255, 0, 200, 180)
        val style = IntArray(64) { styleColor }
        val out = IconComposer.composePixels(makeSubject(), 32, 32, style, 8, 8,
            ComposeSpec(background = IconBackground.STYLE_IMAGE, subjectScale = 0.5f, cornerRadius = 0f, shadow = false), 64)
        assertEquals("角落应当取自风格图", styleColor, out[0])
    }

    @Test
    fun `风格图缺失时应当退回纯色而不是崩溃`() {
        val fallback = argb(255, 11, 22, 33)
        val out = IconComposer.composePixels(makeSubject(), 32, 32, null, 0, 0,
            ComposeSpec(background = IconBackground.STYLE_IMAGE, colorTop = fallback,
                subjectScale = 0.5f, cornerRadius = 0f, shadow = false), 64)
        assertEquals("没有风格图时应当用 colorTop 兜底", fallback, out[0])
    }

    @Test
    fun `alpha 混合必须正确`() {
        // 用一张**完全不透明**的主体：输出应当处处是主体色，背景一点都透不出来。
        // 用带透明区的素材测这个会得到误导性结果（那 900/4096 就是这么来的）。
        val solidSubject = IntArray(32 * 32) { argb(255, 255, 80, 40) }
        val out = IconComposer.composePixels(solidSubject, 32, 32, null, 0, 0,
            ComposeSpec(background = IconBackground.SOLID, colorTop = argb(255, 0, 0, 0),
                subjectScale = 1.0f, cornerRadius = 0f, shadow = false), 64)
        var match = 0
        for (c in out) if (red(c) == 255 && green(c) == 80 && blue(c) == 40 && alpha(c) == 255) match++
        assertTrue("不透明主体应当完全盖住背景，实际只有 $match / ${out.size} 匹配", match == out.size)
    }

    @Test
    fun `半透明主体应当与背景正确混合`() {
        val half = IntArray(32 * 32) { argb(128, 255, 255, 255) }
        val out = IconComposer.composePixels(half, 32, 32, null, 0, 0,
            ComposeSpec(background = IconBackground.SOLID, colorTop = argb(255, 0, 0, 0),
                subjectScale = 1.0f, cornerRadius = 0f, shadow = false), 64)
        val c = out[32 * 64 + 32]
        assertEquals("结果应当不透明", 255, alpha(c))
        assertTrue("50% 白叠黑应当约等于 128，实际 ${red(c)}", red(c) in 124..132)
    }
}
