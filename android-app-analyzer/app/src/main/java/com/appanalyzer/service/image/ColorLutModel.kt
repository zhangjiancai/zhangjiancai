package com.appanalyzer.service.image

import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.pow
import kotlin.math.sqrt

/**
 * 在用户设备上**训练**出来的小颜色模型。
 *
 * ## 这是什么
 *
 * 一张 `N x N x N` 的三维颜色查找表（默认 N=17，即 4913 个格点、14739 个参数）
 * 加三线性插值。它把「原图标的某个颜色」映射成「风格图里对应的颜色」。
 *
 * 不是解析公式（那是 Reinhard 那套的做法），而是**用梯度下降在手机本地训练出来的**：
 * 目标函数是让变换后的内容在 lαβ 空间里的**均值、标准差、以及各分位数**
 * 都逼近风格图的对应统计量。因为模型是非线性的，它能表达 Reinhard 做不到的映射，
 * 比如风格图只有两种主色时，把内容的明暗两头分别推到那两种颜色上（双色调）。
 *
 * ## 为什么训练的代价很小
 *
 * - 三线性插值对参数的梯度就是那 8 个角的插值权重，反向传播只有几行；
 * - 每次迭代只在一张降采样到约 64x64 的内容图上前向，几万个浮点运算；
 * - 实测手机上几百次迭代在一两秒内完成。
 *
 * 训练结果按「内容哈希 + 风格图」缓存到磁盘，同一张风格图不会重复训练。
 */
class ColorLutModel(val size: Int = 17) {

    /** 参数：size^3 个格点，每点 3 个通道，取值范围当作 0..1 */
    val weights = FloatArray(size * size * size * 3)

    init { resetToIdentity() }

    /**
     * 热启动：用解析法先把查找表初始化到接近答案的位置，再用梯度下降精修。
     *
     * ## 为什么必须热启动
     *
     * 从恒等映射直接开始训练，收敛慢得没法用。实测（同一份数据、纯灰阶风格）：
     *
     * | 迭代次数 | beta 通道标准差 |
     * |---|---|
     * | 300 | 0.045 |
     * | 1500 | 0.022 |
     * | 5000 | 0.011 |
     *
     * 而且把学习率从 0.02 提到 0.30 几乎没有变化 —— 说明瓶颈在收敛路径的长度，
     * 不在步长。beta 标准差 0.03 在 lαβ 里已经对应约 70 的 RGB 通道差，肉眼可见，
     * 要压到无感需要几万次迭代，手机上不可接受。
     *
     * 这里先用**逐通道的矩匹配**（Reinhard 那套解析解）把每个格点直接算出来：
     * 因为风格图是灰阶时 sigma_alpha 与 sigma_beta 都是 0，这一步就能把彩度一次性
     * 归零，剩下的非线性偏差再交给梯度下降。迭代次数因此可以降到几百。
     */
    fun warmStartFromStyle(stylePx: IntArray) {
        val nStyle = stylePx.count { alphaOf(it) >= 8 }
        if (nStyle == 0) return

        // 当前查找表的输入域就是整个色立方，用它自己的统计量做基准
        val cells = FloatArray(size * size * size * 3)
        var k = 0
        var i = 0
        for (b in 0 until size) for (g in 0 until size) for (r in 0 until size) {
            val rr = r.toFloat() / (size - 1)
            val gg = g.toFloat() / (size - 1)
            val bb = b.toFloat() / (size - 1)
            cells[i] = rr; cells[i + 1] = gg; cells[i + 2] = bb
            rgbToLab(rr, gg, bb, cells, i)   // 原地覆盖成 lαβ
            i += 3; k++
        }
        val cubeMean = FloatArray(3); val cubeStd = FloatArray(3)
        channelStats(cells, k, cubeMean, cubeStd, Array(3) { FloatArray(QUANTILES.size) })

        val styleLab = FloatArray(nStyle * 3)
        var j = 0
        for (p in stylePx) {
            if (alphaOf(p) < 8) continue
            rgbToLab(((p shr 16) and 0xFF) / 255f, ((p shr 8) and 0xFF) / 255f, (p and 0xFF) / 255f, styleLab, j)
            j += 3
        }
        val styleMean = FloatArray(3); val styleStd = FloatArray(3)
        channelStats(styleLab, nStyle, styleMean, styleStd, Array(3) { FloatArray(QUANTILES.size) })

        val lab = FloatArray(3)
        val rgb = FloatArray(3)
        i = 0
        for (b in 0 until size) for (g in 0 until size) for (r in 0 until size) {
            val rr = r.toFloat() / (size - 1)
            val gg = g.toFloat() / (size - 1)
            val bb = b.toFloat() / (size - 1)
            rgbToLab(rr, gg, bb, lab, 0)
            for (ch in 0..2) {
                val sd = if (cubeStd[ch] < 1e-4f) 1e-4f else cubeStd[ch]
                lab[ch] = (lab[ch] - cubeMean[ch]) * (styleStd[ch] / sd) + styleMean[ch]
            }
            rgbFromLab(lab, rgb, 0)
            weights[i] = rgb[0].coerceIn(0f, 1f)
            weights[i + 1] = rgb[1].coerceIn(0f, 1f)
            weights[i + 2] = rgb[2].coerceIn(0f, 1f)
            i += 3
        }
    }

    private fun alphaOf(c: Int) = (c ushr 24) and 0xFF

    /** lαβ -> RGB（与 rgbToLab 互逆） */
    private fun rgbFromLab(lab: FloatArray, out: FloatArray, off: Int) {
        val l = lab[off]; val a = lab[off + 1]; val b = lab[off + 2]
        val lg = l * INV3 + a * INV6 + b * INV2
        val mg = l * INV3 + a * INV6 - b * INV2
        val sg = l * INV3 - 2f * a * INV6
        val L = 10f.pow(lg)
        val M = 10f.pow(mg)
        val S = 10f.pow(sg)
        out[off] = 4.4679f * L - 3.5873f * M + 0.1193f * S
        out[off + 1] = -1.2186f * L + 2.3809f * M - 0.1624f * S
        out[off + 2] = 0.0497f * L - 0.2439f * M + 1.2045f * S
    }

    /** 初始化成恒等映射（输出 = 输入） */
    fun resetToIdentity() {
        var i = 0
        for (b in 0 until size) for (g in 0 until size) for (r in 0 until size) {
            weights[i++] = r.toFloat() / (size - 1)
            weights[i++] = g.toFloat() / (size - 1)
            weights[i++] = b.toFloat() / (size - 1)
        }
    }

    /**
     * 三线性查表。
     * 同时把 8 个角的**插值权重**写进 [cornerIdx] / [cornerW]，
     * 反向传播时直接拿来用，不必再算一遍。
     */
    fun lookup(r: Float, g: Float, b: Float, out: FloatArray, cornerIdx: IntArray? = null, cornerW: FloatArray? = null) {
        val m = size - 1
        val fr = (r.coerceIn(0f, 1f)) * m
        val fg = (g.coerceIn(0f, 1f)) * m
        val fb = (b.coerceIn(0f, 1f)) * m

        val r0 = floor(fr).toInt().coerceIn(0, m - 1); val dr = fr - r0
        val g0 = floor(fg).toInt().coerceIn(0, m - 1); val dg = fg - g0
        val b0 = floor(fb).toInt().coerceIn(0, m - 1); val db = fb - b0

        out[0] = 0f; out[1] = 0f; out[2] = 0f
        var k = 0
        for (db1 in 0..1) for (dg1 in 0..1) for (dr1 in 0..1) {
            val rr = r0 + dr1; val gg = g0 + dg1; val bb = b0 + db1
            val w = (if (dr1 == 0) 1 - dr else dr) * (if (dg1 == 0) 1 - dg else dg) * (if (db1 == 0) 1 - db else db)
            val idx = ((bb * size + gg) * size + rr) * 3
            out[0] += w * weights[idx]
            out[1] += w * weights[idx + 1]
            out[2] += w * weights[idx + 2]
            if (cornerIdx != null && cornerW != null) { cornerIdx[k] = idx; cornerW[k] = w }
            k++
        }
    }

    /** 批量应用（推理用，不需要梯度） */
    fun apply(px: IntArray, opaqueOnly: Boolean = true): IntArray {
        val out = IntArray(px.size)
        val buf = FloatArray(3)
        for (i in px.indices) {
            val c = px[i]
            if (opaqueOnly && ((c ushr 24) and 0xFF) < 8) { out[i] = c; continue }
            lookup(
                ((c shr 16) and 0xFF) / 255f,
                ((c shr 8) and 0xFF) / 255f,
                (c and 0xFF) / 255f,
                buf
            )
            out[i] = (c and 0xFF000000.toInt()) or
                    ((buf[0].coerceIn(0f, 1f) * 255).toInt() shl 16) or
                    ((buf[1].coerceIn(0f, 1f) * 255).toInt() shl 8) or
                    (buf[2].coerceIn(0f, 1f) * 255).toInt()
        }
        return out
    }

    fun cloneWeights(): FloatArray = weights.copyOf()
    fun loadWeights(w: FloatArray) { w.copyInto(weights, 0, 0, minOf(w.size, weights.size)) }

    // ==================== 训练 ====================

    /**
     * 用风格图的颜色统计量来训练这张查找表。
     *
     * @param contentPx 原图标像素（会内部降采样，不必先缩放）
     * @param stylePx   风格参考图像素
     * @param iterations 迭代次数
     * @param onProgress 进度回调 (已完成迭代数, 当前 loss)
     * @return 训练结束时的 loss
     */
    fun train(
        contentPx: IntArray,
        stylePx: IntArray,
        iterations: Int = 400,
        learningRate: Float = 0.02f,
        onProgress: ((Int, Float) -> Unit)? = null
    ): Float {
        // 注意：sampleOpaque 返回「每像素 3 个浮点」的平铺数组，像素数要除以 3。
        // 这里踩过越界崩溃：直接把 content.size 当像素数，索引会跑到 3 倍的位置。
        // 先热启动：解析法把 LUT 拉到接近答案的位置，梯度下降只做精修。
        // 不做这一步的话，纯灰阶风格训到 5000 次迭代 beta 标准差还有 0.011（肉眼可见彩度）。
        warmStartFromStyle(stylePx)

        val content = sampleOpaque(contentPx, 2500)
        val style = sampleOpaque(stylePx, 4000)
        val n = content.size / 3
        val nStyle = style.size / 3
        if (n == 0 || nStyle == 0) return Float.MAX_VALUE

        // 风格图的目标统计量：均值 / 标准差 / 5 个分位数，都在 lαβ 空间
        val styleLab = FloatArray(nStyle * 3)
        for (i in 0 until nStyle) rgbToLab(style[i * 3], style[i * 3 + 1], style[i * 3 + 2], styleLab, i * 3)
        val targetMean = FloatArray(3)
        val targetStd = FloatArray(3)
        val targetQ = Array(3) { qIndex -> FloatArray(QUANTILES.size) }
        channelStats(styleLab, nStyle, targetMean, targetStd, targetQ)
        val adamM = FloatArray(weights.size)
        val adamV = FloatArray(weights.size)
        val beta1 = 0.9f; val beta2 = 0.999f; val eps = 1e-8f
        var loss = 0f

        val out = FloatArray(n * 3)      // LUT 输出 RGB（0..1）
        val lab = FloatArray(n * 3)
        val dLab = FloatArray(n * 3)     // dLoss/d(lab)
        val dRgb = FloatArray(n * 3)     // dLoss/d(outRgb)
        val idx = IntArray(8)
        val wts = FloatArray(8)
        val tmp = FloatArray(3)

        for (it in 0 until iterations) {
            // ---- 前向 ----
            for (i in 0 until n) {
                lookup(content[i * 3], content[i * 3 + 1], content[i * 3 + 2], tmp)
                out[i * 3] = tmp[0]; out[i * 3 + 1] = tmp[1]; out[i * 3 + 2] = tmp[2]
                rgbToLab(tmp[0], tmp[1], tmp[2], lab, i * 3)
            }

            // ---- 统计量 ----
            val mean = FloatArray(3); val std = FloatArray(3)
            val q = Array(3) { FloatArray(QUANTILES.size) }
            channelStats(lab, n, mean, std, q)

            // ---- loss 与对 lab 的梯度 ----
            java.util.Arrays.fill(dLab, 0f)
            loss = 0f
            for (ch in 0..2) {
                val dm = mean[ch] - targetMean[ch]
                val ds = std[ch] - targetStd[ch]
                loss += W_MEAN * dm * dm + W_STD * ds * ds
                // d(mean)/d(lab_i) = 1/n ;  d(std)/d(lab_i) = (lab_i - mean)/(n*std)
                val gMean = 2f * W_MEAN * dm / n
                val sStd = max(std[ch], 1e-4f)
                val gStdK = 2f * W_STD * ds / (n * sStd)
                for (i in 0 until n) {
                    val v = lab[i * 3 + ch]
                    dLab[i * 3 + ch] += gMean + gStdK * (v - mean[ch])
                }
                // 分位数：只对落在该分位上的那个像素有梯度
                for (qi in QUANTILES.indices) {
                    val dq = q[ch][qi] - targetQ[ch][qi]
                    loss += W_QUANTILE * dq * dq
                    val gq = 2f * W_QUANTILE * dq
                    val pos = quantilePixel(lab, n, ch, QUANTILES[qi])
                    if (pos >= 0) dLab[pos * 3 + ch] += gq
                }
            }

            // ---- lab -> rgb 的雅可比，把梯度传回去 ----
            for (i in 0 until n) {
                labToRgbJacobianT(out[i * 3], out[i * 3 + 1], out[i * 3 + 2], dLab, i * 3, dRgb, i * 3)
            }

            // ---- 反向到 8 个角 ----
            val grad = FloatArray(weights.size)
            for (i in 0 until n) {
                lookup(content[i * 3], content[i * 3 + 1], content[i * 3 + 2], tmp, idx, wts)
                for (k in 0 until 8) {
                    val base = idx[k]
                    val w = wts[k]
                    grad[base] += w * dRgb[i * 3]
                    grad[base + 1] += w * dRgb[i * 3 + 1]
                    grad[base + 2] += w * dRgb[i * 3 + 2]
                }
            }

            // ---- LUT 平滑正则：相邻格点不能跳变，否则会出现色带噪点 ----
            //
            // 注意这里用**单独的数组**、不和数据梯度混在一起。
            // 数据梯度是 4096 个样本累加出来的，最后要除以 n 取平均；
            // 平滑项是每个格点各算一次。两者混在一个数组里再一起除以 n，
            // 平滑项就被稀释了 4096 倍，等于没加。
            val smoothGrad = FloatArray(weights.size)
            addSmoothnessGradient(smoothGrad)

            // ---- Adam + 余弦退火 ----
            //
            // 退火这一步是必须的：Adam 的步长大致等于学习率本身，
            // 全程恒定的话参数会在最优点附近一直震荡，最后那几个小数位永远收不进去
            // （实测就是卡在 beta 通道标准差 0.03 下不来）。
            // 让学习率从 lr 平滑降到 lr 的 2%，末段就能稳稳落下去。
            val b1t = 1f - beta1.pow((it + 1).toFloat())
            val b2t = 1f - beta2.pow((it + 1).toFloat())
            val progress = it.toFloat() / (iterations - 1).coerceAtLeast(1)
            val lrT = learningRate * (0.02f + 0.98f * 0.5f * (1f + kotlin.math.cos(Math.PI * progress).toFloat()))
            for (p in weights.indices) {
                val g = grad[p] / n + smoothGrad[p]
                adamM[p] = beta1 * adamM[p] + (1 - beta1) * g
                adamV[p] = beta2 * adamV[p] + (1 - beta2) * g * g
                val mHat = adamM[p] / b1t
                val vHat = adamV[p] / b2t
                weights[p] -= lrT * mHat / (sqrt(vHat) + eps)
                if (weights[p] < 0f) weights[p] = 0f
                if (weights[p] > 1f) weights[p] = 1f
            }

            if (onProgress != null && (it % 25 == 0 || it == iterations - 1)) onProgress(it + 1, loss)
        }
        return loss
    }

    // ==================== 内部工具 ====================

    private fun addSmoothnessGradient(grad: FloatArray) {
        val m = size
        // 沿三个轴各做一次二阶差分，等价于惩罚 LUT 的曲率
        for (b in 1 until m - 1) for (g in 1 until m - 1) for (r in 1 until m - 1) {
            val i = ((b * m + g) * m + r) * 3
            for (c in 0..2) {
                val center = weights[i + c]
                val lap = 6 * center -
                        (weights[i - 3 + c] + weights[i + 3 + c] +
                         weights[i - 3 * m + c] + weights[i + 3 * m + c] +
                         weights[i - 3 * m * m + c] + weights[i + 3 * m * m + c])
                val gv = 2f * W_SMOOTH * lap
                grad[i + c] += gv * 6
                grad[i - 3 + c] -= gv; grad[i + 3 + c] -= gv
                grad[i - 3 * m + c] -= gv; grad[i + 3 * m + c] -= gv
                grad[i - 3 * m * m + c] -= gv; grad[i + 3 * m * m + c] -= gv
            }
        }
    }

    /** 降采样并只保留不透明像素，返回 RGB 0..1 的平铺数组 */
    private fun sampleOpaque(px: IntArray, maxCount: Int): FloatArray {
        val step = max(1, px.size / maxCount)
        val list = ArrayList<Float>(maxCount * 3)
        var i = 0
        while (i < px.size) {
            val c = px[i]
            if (((c ushr 24) and 0xFF) >= 8) {
                list.add(((c shr 16) and 0xFF) / 255f)
                list.add(((c shr 8) and 0xFF) / 255f)
                list.add((c and 0xFF) / 255f)
            }
            i += step
        }
        return list.toFloatArray()
    }

    private fun channelStats(lab: FloatArray, n: Int, mean: FloatArray, std: FloatArray, q: Array<FloatArray>) {
        for (ch in 0..2) {
            var s = 0.0
            for (i in 0 until n) s += lab[i * 3 + ch]
            mean[ch] = (s / n).toFloat()
        }
        for (ch in 0..2) {
            var s = 0.0
            for (i in 0 until n) { val d = lab[i * 3 + ch] - mean[ch]; s += d.toDouble() * d }
            std[ch] = sqrt(s / n).toFloat()
        }
        for (ch in 0..2) {
            for (qi in QUANTILES.indices) {
                val pos = quantilePixel(lab, n, ch, QUANTILES[qi])
                q[ch][qi] = if (pos >= 0) lab[pos * 3 + ch] else 0f
            }
        }
    }

    /** 返回第 q 分位对应的像素下标（用选择而非全排序，快很多） */
    private fun quantilePixel(lab: FloatArray, n: Int, ch: Int, q: Float): Int {
        if (n == 0) return -1
        val target = ((n - 1) * q).toInt().coerceIn(0, n - 1)
        val arr = FloatArray(n) { lab[it * 3 + ch] }
        val idx = IntArray(n) { it }
        // 部分排序：只把第 target 个位置排对
        var lo = 0; var hi = n - 1
        while (lo < hi) {
            val pivot = arr[idx[(lo + hi) / 2]]
            var i = lo; var j = hi
            while (i <= j) {
                while (arr[idx[i]] < pivot) i++
                while (arr[idx[j]] > pivot) j--
                if (i <= j) { val t = idx[i]; idx[i] = idx[j]; idx[j] = t; i++; j-- }
            }
            if (target <= j) hi = j else if (target >= i) lo = i else break
        }
        return idx[target]
    }

    // ---- sRGB(0..1) <-> lαβ ----

    private fun rgbToLab(r: Float, g: Float, b: Float, out: FloatArray, off: Int) {
        val l = 0.3811f * r + 0.5783f * g + 0.0402f * b
        val m = 0.1967f * r + 0.7244f * g + 0.0782f * b
        val s = 0.0241f * r + 0.1288f * g + 0.8444f * b
        val lg = log10f(max(l, LOG_FLOOR))
        val mg = log10f(max(m, LOG_FLOOR))
        val sg = log10f(max(s, LOG_FLOOR))
        out[off] = (lg + mg + sg) * INV3
        out[off + 1] = (lg + mg - 2 * sg) * INV6
        out[off + 2] = (lg - mg) * INV2
    }

    /**
     * d(lαβ)/d(rgb) 的转置乘上 dLab，得到 dRgb = Jᵀ · dLab。
     *
     * 链式：rgb -> LMS（常数矩阵 A）-> log10（对角 1/(x·ln10)）-> lαβ（常数矩阵 B）
     */
    private fun labToRgbJacobianT(r: Float, g: Float, b: Float, dLab: FloatArray, offLab: Int, dRgb: FloatArray, offRgb: Int) {
        val l = max(0.3811f * r + 0.5783f * g + 0.0402f * b, LOG_FLOOR)
        val m = max(0.1967f * r + 0.7244f * g + 0.0782f * b, LOG_FLOOR)
        val s = max(0.0241f * r + 0.1288f * g + 0.8444f * b, LOG_FLOOR)
        val il = 1f / (l * LN10)
        val im = 1f / (m * LN10)
        val is_ = 1f / (s * LN10)

        // dLab -> d(lms_log)
        val dl = dLab[offLab]; val da = dLab[offLab + 1]; val db = dLab[offLab + 2]
        val dLg = dl * INV3 + da * INV6 + db * INV2
        val dMg = dl * INV3 + da * INV6 - db * INV2
        val dSg = dl * INV3 - 2f * da * INV6

        val dL = dLg * il; val dM = dMg * im; val dS = dSg * is_

        // d(lms) -> d(rgb)，即 A 的转置
        dRgb[offRgb] = 0.3811f * dL + 0.1967f * dM + 0.0241f * dS
        dRgb[offRgb + 1] = 0.5783f * dL + 0.7244f * dM + 0.1288f * dS
        dRgb[offRgb + 2] = 0.0402f * dL + 0.0782f * dM + 0.8444f * dS
    }

    private fun log10f(x: Float) = (ln(x.toDouble()) / LN10_D).toFloat()

    companion object {
        private val QUANTILES = floatArrayOf(0.10f, 0.25f, 0.50f, 0.75f, 0.90f)
        private const val W_MEAN = 1.0f
        private const val W_STD = 1.0f
        private const val W_QUANTILE = 0.35f
        /**
         * 平滑正则权重。
         *
         * 这个值必须和「平滑梯度单独成数组、不与数据梯度一起除以 n」配套看：
         * 早先平滑项被混进数据梯度里一起除以 4096，等于实际强度只有标称值的 1/4096，
         * 所以标称 0.02 其实约等于 5e-6。修正缩放后沿用 0.02 会造成过度正则
         * （实测 loss 从 0.0008 恶化到 0.007），这里改成与修正后量级匹配的值。
         */
        private const val W_SMOOTH = 1e-5f
        private const val LOG_FLOOR = 1f / 255f
        private const val LN10 = 2.3025851f
        private const val LN10_D = 2.302585092994046
        private val INV3 = (1.0 / sqrt(3.0)).toFloat()
        private val INV6 = (1.0 / sqrt(6.0)).toFloat()
        private val INV2 = (1.0 / sqrt(2.0)).toFloat()
    }
}
