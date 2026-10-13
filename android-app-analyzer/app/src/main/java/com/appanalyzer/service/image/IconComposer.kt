package com.appanalyzer.service.image

import android.graphics.Bitmap
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sqrt

/** 合成时用的背景类型 */
enum class IconBackground(val id: String, val label: String) {
    TRANSPARENT("none", "透明"),
    SOLID("solid", "纯色"),
    GRADIENT("gradient", "渐变"),
    STYLE_IMAGE("style", "风格图");

    companion object {
        fun byId(id: String) = values().firstOrNull { it.id == id } ?: TRANSPARENT
    }
}

/**
 * 合成参数。
 *
 * @param background   背景类型
 * @param colorTop     纯色/渐变的起始色（ARGB）
 * @param colorBottom  渐变的结束色
 * @param subjectScale 主体占画布的比例，0.5~1.0。留白让图标看起来更"透气"
 * @param cornerRadius 圆角半径，按画布边长的比例，0~0.5
 * @param shadow       是否给主体加投影
 * @param shadowAlpha  投影浓度 0~1
 */
data class ComposeSpec(
    val background: IconBackground = IconBackground.TRANSPARENT,
    val colorTop: Int = 0xFF2B2B33.toInt(),
    val colorBottom: Int = 0xFF14141A.toInt(),
    val subjectScale: Float = 0.72f,
    val cornerRadius: Float = 0.22f,
    val shadow: Boolean = true,
    val shadowAlpha: Float = 0.35f
)

/**
 * 把抠出来的主体**合成为一张新图标**。
 *
 * ## 为什么需要这一步
 *
 * 端侧抠图模型的输出只是一张「背景被去掉的原图标」，它本身**不是新图标**。
 * 抠图之后必须再合成一次，才谈得上"生成"：
 *
 *     原图标 --[抠图模型]--> 主体(带 alpha)
 *            --[本文件]--> 缩放到留白内 + 画新背景 + 投阴影 + 切圆角 = 新图标
 *
 * 全部是纯像素运算，不依赖 Android 绘图 API，因此可以直接单元测试。
 */
object IconComposer {

    fun compose(
        subject: Bitmap,
        styleBackground: Bitmap?,
        spec: ComposeSpec,
        size: Int = 192
    ): Bitmap {
        val sw = subject.width; val sh = subject.height
        val sp = IntArray(sw * sh)
        subject.getPixels(sp, 0, sw, 0, 0, sw, sh)

        var bp: IntArray? = null
        var bw = 0; var bh = 0
        if (spec.background == IconBackground.STYLE_IMAGE && styleBackground != null) {
            bw = styleBackground.width; bh = styleBackground.height
            bp = IntArray(bw * bh)
            styleBackground.getPixels(bp, 0, bw, 0, 0, bw, bh)
        }

        val out = composePixels(sp, sw, sh, bp, bw, bh, spec, size)
        val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        bmp.setPixels(out, 0, size, 0, 0, size, size)
        return bmp
    }

    /** 纯像素入口 */
    fun composePixels(
        subject: IntArray, sw: Int, sh: Int,
        stylePx: IntArray?, styleW: Int, styleH: Int,
        spec: ComposeSpec,
        size: Int
    ): IntArray {
        val out = IntArray(size * size)

        // ---- 1. 背景层 ----
        when (spec.background) {
            IconBackground.TRANSPARENT -> { /* 留空，alpha = 0 */ }
            IconBackground.SOLID -> {
                for (i in out.indices) out[i] = spec.colorTop
            }
            IconBackground.GRADIENT -> {
                for (y in 0 until size) {
                    val t = y.toFloat() / (size - 1).coerceAtLeast(1)
                    val c = lerpArgb(spec.colorTop, spec.colorBottom, t)
                    for (x in 0 until size) out[y * size + x] = c
                }
            }
            IconBackground.STYLE_IMAGE -> {
                if (stylePx != null && styleW > 0 && styleH > 0) {
                    // 等比缩放铺满（cover），避免拉伸变形
                    for (y in 0 until size) for (x in 0 until size) {
                        val sx = (x.toLong() * styleW / size).toInt().coerceIn(0, styleW - 1)
                        val sy = (y.toLong() * styleH / size).toInt().coerceIn(0, styleH - 1)
                        out[y * size + x] = stylePx[sy * styleW + sx]
                    }
                } else {
                    for (i in out.indices) out[i] = spec.colorTop
                }
            }
        }

        // ---- 2. 把主体缩放进「留白」区域 ----
        val scale = spec.subjectScale.coerceIn(0.3f, 1f)
        val box = (size * scale).roundToInt().coerceAtLeast(1)
        val offset = (size - box) / 2
        val scaled = IntArray(box * box)
        for (y in 0 until box) for (x in 0 until box) {
            // 最近邻 + 双线性混合的折中：用双线性，边缘更干净
            val fx = (x + 0.5f) * sw / box - 0.5f
            val fy = (y + 0.5f) * sh / box - 0.5f
            scaled[y * box + x] = bilinear(subject, sw, sh, fx, fy)
        }

        // ---- 3. 投影：主体 alpha 偏移 + 模糊 + 压暗，画在主体下面 ----
        if (spec.shadow) {
            val dy = max(1, (box * 0.05f).roundToInt())
            val blur = max(1, (box * 0.06f).roundToInt())
            val alphaMap = FloatArray(box * box)
            for (i in scaled.indices) alphaMap[i] = ((scaled[i] ushr 24) and 0xFF) / 255f
            val blurred = boxBlur(alphaMap, box, box, blur)
            val a0 = spec.shadowAlpha.coerceIn(0f, 1f)
            for (y in 0 until box) for (x in 0 until box) {
                val a = (blurred[y * box + x] * a0 * 255).toInt().coerceIn(0, 255)
                if (a <= 2) continue
                val px = offset + x
                val py = offset + y + dy
                if (px < 0 || py < 0 || px >= size || py >= size) continue
                val idx = py * size + px
                out[idx] = over(out[idx], (a shl 24) or 0x000000)
            }
        }

        // ---- 4. 主体叠上去 ----
        for (y in 0 until box) for (x in 0 until box) {
            val c = scaled[y * box + x]
            val a = (c ushr 24) and 0xFF
            if (a == 0) continue
            val px = offset + x; val py = offset + y
            if (px < 0 || py < 0 || px >= size || py >= size) continue
            val idx = py * size + px
            out[idx] = over(out[idx], c)
        }

        // ---- 5. 圆角遮罩 ----
        val r = (size * spec.cornerRadius.coerceIn(0f, 0.5f))
        if (r > 0.5f) applyRoundMask(out, size, r)

        return out
    }

    /** src 叠在 dst 之上（两者都是非预乘 ARGB） */
    private fun over(dst: Int, src: Int): Int {
        val sa = ((src ushr 24) and 0xFF) / 255f
        if (sa >= 0.999f) return src
        if (sa <= 0f) return dst
        val da = ((dst ushr 24) and 0xFF) / 255f
        val oa = sa + da * (1 - sa)
        if (oa <= 0f) return 0
        fun ch(shift: Int): Int {
            val s = ((src shr shift) and 0xFF) / 255f
            val d = ((dst shr shift) and 0xFF) / 255f
            return (((s * sa + d * da * (1 - sa)) / oa) * 255).roundToInt().coerceIn(0, 255)
        }
        return (((oa * 255).roundToInt().coerceIn(0, 255)) shl 24) or (ch(16) shl 16) or (ch(8) shl 8) or ch(0)
    }

    private fun lerpArgb(a: Int, b: Int, t: Float): Int {
        fun ch(s: Int) = ((((a shr s) and 0xFF) + (((b shr s) and 0xFF) - ((a shr s) and 0xFF)) * t).roundToInt()).coerceIn(0, 255)
        return (ch(24) shl 24) or (ch(16) shl 16) or (ch(8) shl 8) or ch(0)
    }

    /** 双线性采样；越界按边缘钳制 */
    private fun bilinear(px: IntArray, w: Int, h: Int, fx: Float, fy: Float): Int {
        val x0 = fx.toInt(); val y0 = fy.toInt()
        val dx = fx - x0; val dy = fy - y0
        val x1 = x0 + 1; val y1 = y0 + 1
        fun at(x: Int, y: Int): Int {
            val cx = x.coerceIn(0, w - 1); val cy = y.coerceIn(0, h - 1)
            return px[cy * w + cx]
        }
        val c00 = at(x0, y0); val c10 = at(x1, y0); val c01 = at(x0, y1); val c11 = at(x1, y1)
        fun blend(s: Int): Int {
            val v00 = (c00 shr s) and 0xFF; val v10 = (c10 shr s) and 0xFF
            val v01 = (c01 shr s) and 0xFF; val v11 = (c11 shr s) and 0xFF
            val top = v00 + (v10 - v00) * dx
            val bot = v01 + (v11 - v01) * dx
            return (top + (bot - top) * dy).roundToInt().coerceIn(0, 255)
        }
        return (blend(24) shl 24) or (blend(16) shl 16) or (blend(8) shl 8) or blend(0)
    }

    /** 可分离盒式模糊，跑两遍近似高斯 */
    private fun boxBlur(src: FloatArray, w: Int, h: Int, radius: Int): FloatArray {
        var cur = src
        repeat(2) {
            cur = blurPass(cur, w, h, radius, true)
            cur = blurPass(cur, w, h, radius, false)
        }
        return cur
    }

    private fun blurPass(src: FloatArray, w: Int, h: Int, r: Int, horizontal: Boolean): FloatArray {
        val out = FloatArray(src.size)
        val len = if (horizontal) w else h
        val lines = if (horizontal) h else w
        for (l in 0 until lines) {
            var sum = 0f
            var count = 0
            // 初始窗口
            for (k in -r..r) {
                val i = k.coerceIn(0, len - 1)
                sum += if (horizontal) src[l * w + i] else src[i * w + l]
                count++
            }
            for (p in 0 until len) {
                val v = sum / count
                if (horizontal) out[l * w + p] = v else out[p * w + l] = v
                // 滑动窗口
                val addIdx = (p + r + 1).coerceIn(0, len - 1)
                val subIdx = (p - r).coerceIn(0, len - 1)
                sum += (if (horizontal) src[l * w + addIdx] else src[addIdx * w + l]) -
                        (if (horizontal) src[l * w + subIdx] else src[subIdx * w + l])
            }
        }
        return out
    }

    /** 圆角遮罩：四角之外按距离羽化，边缘不会锯齿 */
    private fun applyRoundMask(px: IntArray, size: Int, r: Float) {
        val maxV = size - 1
        for (y in 0 until size) for (x in 0 until size) {
            // 到最近圆角圆心的距离
            val cx = when {
                x < r -> r
                x > maxV - r -> maxV - r
                else -> x.toFloat()
            }
            val cy = when {
                y < r -> r
                y > maxV - r -> maxV - r
                else -> y.toFloat()
            }
            val d = sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy))
            // 边缘 1.5px 内做线性羽化，之外全透明
            val a = ((r - d) / 1.5f).coerceIn(0f, 1f)
            if (a >= 0.999f) continue
            val i = y * size + x
            val old = (px[i] ushr 24) and 0xFF
            px[i] = ((old * a).roundToInt().coerceIn(0, 255) shl 24) or (px[i] and 0x00FFFFFF)
        }
    }

    /** 算一下合成图的"非透明占比"，UI 上用来判断主体有没有太小 */
    fun coverage(px: IntArray): Float =
        px.count { ((it ushr 24) and 0xFF) > 16 }.toFloat() / px.size
}
