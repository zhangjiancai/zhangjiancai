package com.appanalyzer.service.image

import android.graphics.Bitmap
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * 本地风格。四类，对应四种完全不同的做法。
 */
enum class LocalStyle(val id: String, val label: String, val description: String) {
    LINE_ART(
        "lineart",
        "白线勾勒",
        "纯黑底 + 白色线稿，适合纯黑壁纸"
    ),
    SKEUO(
        "skeuo",
        "拟物化",
        "高光 + 浮雕 + 内阴影，做出立体质感"
    ),
    MINIMAL(
        "minimal",
        "极简色块",
        "量化成少数几种纯色，大色块拼合"
    ),
    CUSTOM(
        "custom",
        "自定义",
        "用你给的风格图，在本地训练一个小模型"
    );

    companion object {
        fun byId(id: String) = values().firstOrNull { it.id == id } ?: LINE_ART
    }
}

/**
 * 四类本地风格的实现。
 *
 * 每一类都是**对原图标做真实的像素运算**，不是贴一张预设图。
 * 具体算法见各自函数的注释。
 */
object LocalStyleRenderer {

    fun render(
        source: Bitmap,
        style: LocalStyle,
        outSize: Int = 192,
        /** MINIMAL 用：量化成几种颜色 */
        colorCount: Int = 4,
        /** CUSTOM 用：已经训练好的查找表 */
        lut: ColorLutModel? = null
    ): Bitmap {
        val base = if (source.width != outSize || source.height != outSize)
            Bitmap.createScaledBitmap(source, outSize, outSize, true) else source
        val w = base.width; val h = base.height
        val px = IntArray(w * h)
        base.getPixels(px, 0, w, 0, 0, w, h)
        if (base !== source) base.recycle()

        val out = renderPixels(px, w, h, style, colorCount, lut)

        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        bmp.setPixels(out, 0, w, 0, 0, w, h)
        return bmp
    }

    /**
     * 纯像素入口：不碰任何 Android API，因此可以直接用 JVM 单元测试验证。
     * [render] 只是包了一层 Bitmap 读写。
     */
    fun renderPixels(
        px: IntArray,
        w: Int,
        h: Int,
        style: LocalStyle,
        colorCount: Int = 4,
        lut: ColorLutModel? = null
    ): IntArray = when (style) {
        LocalStyle.LINE_ART -> lineArt(px, w, h)
        LocalStyle.SKEUO -> skeuo(px, w, h)
        LocalStyle.MINIMAL -> minimal(px, w, h, colorCount)
        LocalStyle.CUSTOM -> lut?.apply(px) ?: px.copyOf()
    }

    // ==================================================================
    // 一、白线勾勒
    //
    // 完整的 Canny 流程，只是把梯度算在 RGB 三个通道上而不是只算灰度 ——
    // 应用图标经常出现「亮度相同但颜色不同」的边界（比如红块挨着绿块），
    // 只算灰度会把这些边界整条丢掉。
    //
    //   高斯模糊去噪 -> 逐通道 Sobel -> 梯度幅值取各通道最大
    //   -> 沿梯度方向做非极大值抑制（把线细化到 1px）
    //   -> 双阈值 + 滞后连接（弱边缘只要连着强边缘就保留）
    //   -> 黑底白线
    // ==================================================================
    private fun lineArt(src: IntArray, w: Int, h: Int): IntArray {
        val n = w * h
        val blurred = gaussianBlur3(src, w, h)

        val mag = FloatArray(n)
        val dir = FloatArray(n)
        for (y in 1 until h - 1) {
            for (x in 1 until w - 1) {
                val i = y * w + x
                var best = 0f
                var bestAngle = 0f
                // 对 R/G/B 三个通道各求一次，取幅值最大的那个通道
                for (shift in intArrayOf(16, 8, 0)) {
                    var gx = 0f; var gy = 0f
                    for (ky in -1..1) for (kx in -1..1) {
                        val c = blurred[(y + ky) * w + (x + kx)]
                        val v = ((c shr shift) and 0xFF).toFloat()
                        val kxw = SOBEL_X[(ky + 1) * 3 + (kx + 1)]
                        val kyw = SOBEL_Y[(ky + 1) * 3 + (kx + 1)]
                        gx += v * kxw
                        gy += v * kyw
                    }
                    val m = sqrt(gx * gx + gy * gy)
                    if (m > best) { best = m; bestAngle = atan2(gy, gx) }
                }
                mag[i] = best
                dir[i] = bestAngle
            }
        }

        // 非极大值抑制：只有梯度方向上的局部最大值才算边缘
        val thin = FloatArray(n)
        for (y in 1 until h - 1) {
            for (x in 1 until w - 1) {
                val i = y * w + x
                val a = ((dir[i] * 180.0 / Math.PI) + 180.0) % 180.0
                val (dx, dy) = when {
                    a < 22.5 || a >= 157.5 -> 1 to 0
                    a < 67.5 -> 1 to 1
                    a < 112.5 -> 0 to 1
                    else -> -1 to 1
                }
                val m = mag[i]
                if (m >= mag[(y + dy) * w + (x + dx)] && m >= mag[(y - dy) * w + (x - dx)]) thin[i] = m
            }
        }

        // 双阈值：高阈值用 Otsu 自适应，低阈值取高阈值的 0.4 倍
        val threshold = otsu(thin)
        val high = threshold.toFloat()
        val low = threshold * 0.4f

        val out = IntArray(n) { 0xFF000000.toInt() }   // 纯黑底
        val stack = IntArray(n)
        var sp = 0
        // 强边缘直接点亮，并入栈准备连接弱边缘
        for (i in 0 until n) {
            if (thin[i] >= high && thin[i] > 0f) { out[i] = 0xFFFFFFFF.toInt(); stack[sp++] = i }
        }
        // 滞后连接：弱边缘只要和强边缘连通就保留
        while (sp > 0) {
            val i = stack[--sp]
            val x = i % w; val y = i / w
            for (ky in -1..1) for (kx in -1..1) {
                val nx = x + kx; val ny = y + ky
                if (nx < 1 || ny < 1 || nx >= w - 1 || ny >= h - 1) continue
                val j = ny * w + nx
                if (out[j] == 0xFF000000.toInt() && thin[j] >= low) {
                    out[j] = 0xFFFFFFFF.toInt()
                    stack[sp++] = j
                }
            }
        }
        return out
    }

    // ==================================================================
    // 二、拟物化（本地近似）
    //
    // 真正的拟物化需要生成模型去"画"出材质。纯算法能做到的是模拟光照：
    //   1. 提饱和度与对比度，让颜色更"厚"
    //   2. 用方向性差分求浮雕，当作法线，做一束左上打来的光 -> 亮面/暗面
    //   3. 在画面上方叠一层柔和的白色高光（近似玻璃/塑料的反光）
    //   4. 底部压暗，形成内阴影，撑出体积
    // 结果是"有厚度、有高光的立体图标"，视觉上接近拟物，但不是生成出来的材质。
    // ==================================================================
    private fun skeuo(src: IntArray, w: Int, h: Int): IntArray {
        val n = w * h
        val saturated = IntArray(n)
        for (i in 0 until n) {
            val c = src[i]
            val y = luma(c)
            saturated[i] = argb(
                (c ushr 24) and 0xFF,
                (y + (((c shr 16) and 0xFF) - y) * 1.35f).toInt(),
                (y + (((c shr 8) and 0xFF) - y) * 1.35f).toInt(),
                (y + ((c and 0xFF) - y) * 1.35f).toInt()
            )
        }
        val gray = IntArray(n) { luma(saturated[it]) }

        // 浮雕：左上为光源
        val relief = IntArray(n)
        for (y in 1 until h - 1) {
            for (x in 1 until w - 1) {
                val i = y * w + x
                val d = (gray[i - w - 1] + 2 * gray[i - w] + gray[i - w + 1]) -
                        (gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1])
                relief[i] = (128 + d / 4).coerceIn(0, 255)
            }
        }

        return IntArray(n) { i ->
            val c = saturated[i]
            val x = i % w; val y = i / w
            // 浮雕当作明暗调制
            val light = 0.78f + 0.44f * (relief[i] / 255f)
            // 上方高光：从顶部往下衰减的白色叠加
            val gloss = if (y < h * 0.45f) (1f - y / (h * 0.45f)) * 0.30f else 0f
            // 底部内阴影
            val shade = if (y > h * 0.75f) ((y - h * 0.75f) / (h * 0.25f)) * 0.22f else 0f

            var r = ((c shr 16) and 0xFF) * light
            var g = ((c shr 8) and 0xFF) * light
            var b = (c and 0xFF) * light
            // 高光用 screen 混合，暗部用 multiply
            r = r + (255 - r) * gloss
            g = g + (255 - g) * gloss
            b = b + (255 - b) * gloss
            r *= (1f - shade); g *= (1f - shade); b *= (1f - shade)

            argb((c ushr 24) and 0xFF, r.roundToInt(), g.roundToInt(), b.roundToInt())
        }
    }

    // ==================================================================
    // 三、极简色块
    //
    //   k-means 求 N 个主色 -> 每像素吸附到最近的主色 -> 众数滤波清掉碎块
    //
    // 第三步是关键：只做量化会留下大量 1~2 个像素的噪点，
    // 看起来是"马赛克"而不是"色块"。众数滤波把小块并进周围的大块，
    // 才得到干净的纯色块拼合。
    // ==================================================================
    private fun minimal(src: IntArray, w: Int, h: Int, colorCount: Int): IntArray {
        val k = colorCount.coerceIn(2, 8)
        val palette = kMeans(src, k)
        val quantized = IntArray(src.size) { i ->
            if (((src[i] ushr 24) and 0xFF) < 8) src[i] else nearest(src[i], palette)
        }

        // 众数滤波：3x3 窗口里出现最多的那个颜色说了算
        val out = IntArray(quantized.size)
        val counts = HashMap<Int, Int>(16)
        for (y in 0 until h) {
            for (x in 0 until w) {
                val i = y * w + x
                if (((quantized[i] ushr 24) and 0xFF) < 8) { out[i] = quantized[i]; continue }
                counts.clear()
                for (ky in -1..1) for (kx in -1..1) {
                    val nx = x + kx; val ny = y + ky
                    if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
                    val c = quantized[ny * w + nx]
                    if (((c ushr 24) and 0xFF) < 8) continue
                    counts[c] = (counts[c] ?: 0) + 1
                }
                out[i] = counts.maxByOrNull { it.value }?.key ?: quantized[i]
            }
        }
        return out
    }

    private fun nearest(c: Int, palette: IntArray): Int {
        var best = palette[0]; var bestD = Long.MAX_VALUE
        val r = (c shr 16) and 0xFF; val g = (c shr 8) and 0xFF; val b = c and 0xFF
        for (p in palette) {
            val dr = (r - ((p shr 16) and 0xFF)).toLong()
            val dg = (g - ((p shr 8) and 0xFF)).toLong()
            val db = (b - (p and 0xFF)).toLong()
            val d = dr * dr + dg * dg + db * db
            if (d < bestD) { bestD = d; best = p }
        }
        return best
    }

    private fun kMeans(px: IntArray, k: Int, iterations: Int = 12): IntArray {
        val sample = px.filter { ((it ushr 24) and 0xFF) >= 8 }
        if (sample.size < k) return IntArray(k) { sample.getOrElse(it) { 0xFF888888.toInt() } }
        val step = max(1, sample.size / 4000)
        val pts = ArrayList<Int>(4000)
        var i = 0
        while (i < sample.size) { pts.add(sample[i]); i += step }

        val centers = IntArray(k) { pts[it * pts.size / k] }
        val assign = IntArray(pts.size) { -1 }
        repeat(iterations) {
            for (p in pts.indices) {
                var best = 0; var bestD = Long.MAX_VALUE
                val r = (pts[p] shr 16) and 0xFF; val g = (pts[p] shr 8) and 0xFF; val b = pts[p] and 0xFF
                for (c in 0 until k) {
                    val dr = (r - ((centers[c] shr 16) and 0xFF)).toLong()
                    val dg = (g - ((centers[c] shr 8) and 0xFF)).toLong()
                    val db = (b - (centers[c] and 0xFF)).toLong()
                    val d = dr * dr + dg * dg + db * db
                    if (d < bestD) { bestD = d; best = c }
                }
                assign[p] = best
            }
            val sr = LongArray(k); val sg = LongArray(k); val sb = LongArray(k); val cnt = IntArray(k)
            for (p in pts.indices) {
                val c = assign[p]
                sr[c] = sr[c] + ((pts[p] shr 16) and 0xFF).toLong()
                sg[c] = sg[c] + ((pts[p] shr 8) and 0xFF).toLong()
                sb[c] = sb[c] + (pts[p] and 0xFF).toLong()
                cnt[c]++
            }
            for (c in 0 until k) if (cnt[c] > 0) {
                centers[c] = argb(255, (sr[c] / cnt[c]).toInt(), (sg[c] / cnt[c]).toInt(), (sb[c] / cnt[c]).toInt())
            }
        }
        return centers
    }

    // ==================== 通用工具 ====================

    private fun gaussianBlur3(src: IntArray, w: Int, h: Int): IntArray {
        val out = IntArray(src.size)
        val kernel = intArrayOf(1, 2, 1, 2, 4, 2, 1, 2, 1)
        for (y in 0 until h) for (x in 0 until w) {
            var sr = 0; var sg = 0; var sb = 0; var sa = 0
            for (ky in -1..1) for (kx in -1..1) {
                val nx = (x + kx).coerceIn(0, w - 1)
                val ny = (y + ky).coerceIn(0, h - 1)
                val c = src[ny * w + nx]
                val kv = kernel[(ky + 1) * 3 + (kx + 1)]
                sr += ((c shr 16) and 0xFF) * kv
                sg += ((c shr 8) and 0xFF) * kv
                sb += (c and 0xFF) * kv
                sa += ((c ushr 24) and 0xFF) * kv
            }
            out[y * w + x] = argb(sa / 16, sr / 16, sg / 16, sb / 16)
        }
        return out
    }

    /** 用 Otsu 在浮点幅值图上求阈值（先量化到 256 级） */
    private fun otsu(values: FloatArray): Int {
        var maxV = 0f
        for (v in values) if (v > maxV) maxV = v
        if (maxV <= 0f) return 1
        val hist = IntArray(256)
        for (v in values) hist[((v / maxV) * 255).toInt().coerceIn(0, 255)]++
        val total = values.size
        var sum = 0.0
        for (i in 0..255) sum += i.toDouble() * hist[i]
        var sumB = 0.0; var wB = 0; var best = 0.0; var threshold = 127
        for (i in 0..255) {
            wB += hist[i]
            if (wB == 0) continue
            val wF = total - wB
            if (wF == 0) break
            sumB += i.toDouble() * hist[i]
            val mB = sumB / wB
            val mF = (sum - sumB) / wF
            val between = wB.toDouble() * wF * (mB - mF) * (mB - mF)
            if (between > best) { best = between; threshold = i }
        }
        // 用 0.55 倍做一点收紧，宁可少画也不要画满噪点
        return ((threshold / 255f) * maxV * 0.55f).toInt().coerceAtLeast(1)
    }

    private fun luma(c: Int) =
        (((c shr 16) and 0xFF) * 299 + ((c shr 8) and 0xFF) * 587 + (c and 0xFF) * 114) / 1000

    private fun argb(a: Int, r: Int, g: Int, b: Int) =
        (clamp(a) shl 24) or (clamp(r) shl 16) or (clamp(g) shl 8) or clamp(b)

    private fun clamp(v: Int) = if (v < 0) 0 else if (v > 255) 255 else v

    private val SOBEL_X = intArrayOf(-1, 0, 1, -2, 0, 2, -1, 0, 1)
    private val SOBEL_Y = intArrayOf(-1, -2, -1, 0, 0, 0, 1, 2, 1)
}
