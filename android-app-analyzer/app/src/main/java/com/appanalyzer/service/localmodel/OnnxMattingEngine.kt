package com.appanalyzer.service.localmodel

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.graphics.Bitmap
import com.appanalyzer.service.DebugLogger
import java.io.File
import java.nio.FloatBuffer

/**
 * 端侧抠图推理（ONNX Runtime）。
 *
 * 目前接的是 u2net 系模型：输入 `1x3xNxN` 的归一化 RGB，输出 `1x1xNxN` 的前景概率图。
 * 各模型的输入边长与归一化参数由 [ModelSpec] 给出，所以换模型不用改这里。
 *
 * 推理结果被当作 alpha 通道贴回原图标，得到"抠出主体"的图标；
 * 如果给了背景图/背景色，就再把主体合成上去。
 */
object OnnxMattingEngine {

    private val env: OrtEnvironment by lazy { OrtEnvironment.getEnvironment() }

    /** 会话建立很贵（要解析计算图），按模型文件路径缓存住 */
    private val sessions = HashMap<String, OrtSession>()

    @Synchronized
    private fun sessionFor(file: File): OrtSession {
        sessions[file.absolutePath]?.let { return it }
        val opts = OrtSession.SessionOptions().apply {
            // 手机上别把线程开满，留点给 UI
            setIntraOpNumThreads(2)
        }
        val s = env.createSession(file.absolutePath, opts)
        sessions[file.absolutePath] = s
        DebugLogger.d("[本地模型] 会话已建立：输入=${s.inputNames} 输出个数=${s.outputNames.size}")
        return s
    }

    /** 按模型任务分发 */
    fun run(
        spec: ModelSpec,
        modelFile: File,
        source: Bitmap,
        outSize: Int = 192,
        background: Bitmap? = null
    ): Result<Bitmap> = when (spec.task) {
        ModelSpec.Task.MATTING -> matting(spec, modelFile, source, outSize, background)
        ModelSpec.Task.SUPER_RES -> upscale(spec, modelFile, source, outSize)
    }

    /**
     * 超分辨率：放大 [ModelSpec.scale] 倍。
     * 输入必须是 64 的倍数（SwinIR 的结构要求），所以先缩放到 [ModelSpec.inputSize]。
     */
    fun upscale(
        spec: ModelSpec,
        modelFile: File,
        source: Bitmap,
        outSize: Int = 192
    ): Result<Bitmap> = try {
        val n = spec.inputSize
        val scaled = Bitmap.createScaledBitmap(source, n, n, true)
        val pixels = IntArray(n * n)
        scaled.getPixels(pixels, 0, n, 0, 0, n, n)
        if (scaled !== source) scaled.recycle()

        val chw = FloatArray(3 * n * n)
        for (i in 0 until n * n) {
            val c = pixels[i]
            chw[i] = (((c shr 16) and 0xFF) / 255f - spec.mean[0]) / spec.std[0]
            chw[n * n + i] = (((c shr 8) and 0xFF) / 255f - spec.mean[1]) / spec.std[1]
            chw[2 * n * n + i] = ((c and 0xFF) / 255f - spec.mean[2]) / spec.std[2]
        }

        val session = sessionFor(modelFile)
        val inputName = session.inputNames.first()
        val outW = n * spec.scale
        val outH = n * spec.scale
        val outBuf = FloatArray(3 * outW * outH)

        OnnxTensor.createTensor(env, FloatBuffer.wrap(chw), longArrayOf(1, 3, n.toLong(), n.toLong())).use { tensor ->
            session.run(mapOf(inputName to tensor)).use { result ->
                val out = result.get(0) as OnnxTensor
                val fb = out.floatBuffer
                fb.get(outBuf, 0, minOf(outBuf.size, fb.remaining()))
            }
        }

        // NCHW -> ARGB，并重新缩放到目标尺寸
        val px = IntArray(outW * outH)
        val plane = outW * outH
        for (i in 0 until plane) {
            val r = ((outBuf[i] * spec.std[0] + spec.mean[0]) * 255f).toInt().coerceIn(0, 255)
            val g = ((outBuf[plane + i] * spec.std[1] + spec.mean[1]) * 255f).toInt().coerceIn(0, 255)
            val b = ((outBuf[2 * plane + i] * spec.std[2] + spec.mean[2]) * 255f).toInt().coerceIn(0, 255)
            px[i] = (0xFF shl 24) or (r shl 16) or (g shl 8) or b
        }
        val big = Bitmap.createBitmap(outW, outH, Bitmap.Config.ARGB_8888)
        big.setPixels(px, 0, outW, 0, 0, outW, outH)
        val finalBmp = Bitmap.createScaledBitmap(big, outSize, outSize, true)
        big.recycle()
        Result.success(finalBmp)
    } catch (e: Throwable) {
        DebugLogger.e("[本地模型] 超分失败", e as? Exception ?: Exception(e))
        Result.failure(e as? Exception ?: Exception(e.message))
    }

    /**
     * 抠图。
     *
     * @param background 背景：null 表示透明；否则主体会被合成到这张图上（会缩放到图标尺寸）
     * @return 处理后的图标；失败返回 Result.failure
     */
    fun matting(
        spec: ModelSpec,
        modelFile: File,
        source: Bitmap,
        outSize: Int = 192,
        background: Bitmap? = null,
        backgroundColor: Int? = null
    ): Result<Bitmap> = try {
        val n = spec.inputSize
        // ---- 预处理：缩放到 NxN，按 ImageNet 风格归一化 ----
        val scaled = Bitmap.createScaledBitmap(source, n, n, true)
        val pixels = IntArray(n * n)
        scaled.getPixels(pixels, 0, n, 0, 0, n, n)
        if (scaled !== source) scaled.recycle()

        val chw = FloatArray(3 * n * n)
        for (i in 0 until n * n) {
            val c = pixels[i]
            val r = ((c shr 16) and 0xFF) / 255f
            val g = ((c shr 8) and 0xFF) / 255f
            val b = (c and 0xFF) / 255f
            chw[i] = (r - spec.mean[0]) / spec.std[0]
            chw[n * n + i] = (g - spec.mean[1]) / spec.std[1]
            chw[2 * n * n + i] = (b - spec.mean[2]) / spec.std[2]
        }

        val session = sessionFor(modelFile)
        val inputName = session.inputNames.first()
        val mask = FloatArray(n * n)

        OnnxTensor.createTensor(env, FloatBuffer.wrap(chw), longArrayOf(1, 3, n.toLong(), n.toLong())).use { tensor ->
            session.run(mapOf(inputName to tensor)).use { result ->
                // u2net 会输出 7 个不同尺度的结果，第一个（d0）就是最终融合结果
                val out = result.get(0) as OnnxTensor
                val fb = out.floatBuffer
                val count = minOf(mask.size, fb.remaining())
                fb.get(mask, 0, count)
            }
        }

        // 输出范围可能是 0..1 也可能是 logits，按最小值/最大值判断一下量纲
        var mn = Float.MAX_VALUE
        var mx = -Float.MAX_VALUE
        for (v in mask) { if (v < mn) mn = v; if (v > mx) mx = v }
        if (mn < 0f || mx > 1.0001f) {
            // 当成 logits，做一次 sigmoid
            for (i in mask.indices) mask[i] = 1f / (1f + Math.exp(-mask[i].toDouble()).toFloat())
        }

        val out = compose(source, mask, n, outSize, background, backgroundColor)
        Result.success(out)
    } catch (e: Throwable) {
        DebugLogger.e("[本地模型] 推理失败", e as? Exception ?: Exception(e))
        Result.failure(e as? Exception ?: Exception(e.message))
    }

    /** 把 mask 当 alpha 贴回原图，可选合成背景 */
    private fun compose(
        source: Bitmap,
        mask: FloatArray,
        maskSize: Int,
        outSize: Int,
        background: Bitmap?,
        backgroundColor: Int?
    ): Bitmap {
        val base = Bitmap.createScaledBitmap(source, outSize, outSize, true)
        val src = IntArray(outSize * outSize)
        base.getPixels(src, 0, outSize, 0, 0, outSize, outSize)
        if (base !== source) base.recycle()

        val bgPixels = IntArray(outSize * outSize)
        when {
            background != null -> {
                val b = Bitmap.createScaledBitmap(background, outSize, outSize, true)
                b.getPixels(bgPixels, 0, outSize, 0, 0, outSize, outSize)
                if (b !== background) b.recycle()
            }
            backgroundColor != null -> java.util.Arrays.fill(bgPixels, backgroundColor)
        }

        val result = IntArray(outSize * outSize)
        for (y in 0 until outSize) {
            for (x in 0 until outSize) {
                val di = y * outSize + x
                // 最近邻采样 mask
                val mx = x * maskSize / outSize
                val my = y * maskSize / outSize
                val a = mask[my * maskSize + mx].coerceIn(0f, 1f)
                val s = src[di]
                val sr = (s shr 16) and 0xFF
                val sg = (s shr 8) and 0xFF
                val sb = s and 0xFF
                if (background == null && backgroundColor == null) {
                    // 透明背景：只改 alpha
                    result[di] = ((a * 255).toInt() shl 24) or (sr shl 16) or (sg shl 8) or sb
                } else {
                    // 合成：主体按 a 覆盖在背景上
                    val bp = bgPixels[di]
                    val br = (bp shr 16) and 0xFF
                    val bg = (bp shr 8) and 0xFF
                    val bb = bp and 0xFF
                    val r = (sr * a + br * (1 - a)).toInt()
                    val g = (sg * a + bg * (1 - a)).toInt()
                    val bl = (sb * a + bb * (1 - a)).toInt()
                    result[di] = (0xFF shl 24) or (r shl 16) or (g shl 8) or bl
                }
            }
        }

        val out = Bitmap.createBitmap(outSize, outSize, Bitmap.Config.ARGB_8888)
        out.setPixels(result, 0, outSize, 0, 0, outSize, outSize)
        return out
    }

    @Synchronized
    fun releaseAll() {
        sessions.values.forEach { try { it.close() } catch (_: Exception) {} }
        sessions.clear()
    }
}
