package com.appanalyzer.service.image

import android.content.Context
import com.appanalyzer.service.DebugLogger
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.security.MessageDigest

/**
 * 训练好的风格模型（查找表）的存放与调度。
 *
 * 一张风格图训练一次就够了，参数按「风格图内容哈希 + LUT 尺寸」缓存到磁盘，
 * 之后再遇到同一张风格图直接读回来，不必重训。
 */
class StyleModelStore(private val context: Context) {

    private val dir: File by lazy { File(context.filesDir, "style_models").also { it.mkdirs() } }

    /** 用文件内容哈希做 key —— 换一张图必然换 key，同名不同内容也不会串 */
    fun keyFor(styleFile: File, size: Int): String {
        val md = MessageDigest.getInstance("SHA-256")
        md.update(styleFile.readBytes())
        md.update("|lut$size".toByteArray())
        return md.digest().joinToString("") { "%02x".format(it) }.take(24)
    }

    private fun fileFor(key: String) = File(dir, "lut_$key.bin")

    fun exists(key: String) = fileFor(key).exists()

    fun load(key: String, size: Int): ColorLutModel? {
        val f = fileFor(key)
        if (!f.exists()) return null
        return try {
            DataInputStream(f.inputStream().buffered()).use { input ->
                val n = input.readInt()
                if (n != size) return null
                val model = ColorLutModel(size)
                val arr = FloatArray(n * n * n * 3)
                for (i in arr.indices) arr[i] = input.readFloat()
                model.loadWeights(arr)
                model
            }
        } catch (e: Exception) {
            DebugLogger.w("读取风格模型失败: ${e.message}")
            null
        }
    }

    fun save(key: String, model: ColorLutModel) {
        try {
            DataOutputStream(fileFor(key).outputStream().buffered()).use { out ->
                out.writeInt(model.size)
                for (v in model.weights) out.writeFloat(v)
            }
        } catch (e: Exception) {
            DebugLogger.w("保存风格模型失败: ${e.message}")
        }
    }

    /**
     * 训练时喂给模型的「内容」样本。
     *
     * 这里刻意**不用哪一个具体的图标**，而是均匀采样整个 RGB 色立方，
     * 另外把灰阶轴（r=g=b）加倍加权 —— 图标里灰、白、黑占比很高。
     *
     * 好处是：一张风格图只需要训练**一次**，学出来的查找表是一个
     * 「任意颜色 -> 风格化颜色」的完整映射，之后所有图标直接套用，
     * 既不用每个图标各训一遍，训练也可以在用户点「开始训练」时提前做完。
     */
    private fun colorCubeSamples(steps: Int = 16): IntArray {
        val list = ArrayList<Int>(steps * steps * steps + steps * 2)
        for (b in 0 until steps) for (g in 0 until steps) for (r in 0 until steps) {
            list.add(
                (0xFF shl 24) or
                        ((r * 255 / (steps - 1)) shl 16) or
                        ((g * 255 / (steps - 1)) shl 8) or
                        (b * 255 / (steps - 1))
            )
        }
        // 灰阶轴额外加一遍
        for (i in 0 until steps) {
            val v = i * 255 / (steps - 1)
            list.add((0xFF shl 24) or (v shl 16) or (v shl 8) or v)
        }
        return list.toIntArray()
    }

    /**
     * 取模型：有缓存就用缓存，没有就在**本机训练**一个。
     *
     * @param onProgress (已完成迭代, 总迭代, 当前 loss)
     */
    fun getOrTrain(
        styleFile: File,
        size: Int = 17,
        iterations: Int = 400,
        onProgress: ((Int, Int, Float) -> Unit)? = null
    ): ColorLutModel? {
        val key = keyFor(styleFile, size)
        load(key, size)?.let {
            DebugLogger.d("[风格模型] 命中缓存 $key")
            return it
        }

        val styleBmp = android.graphics.BitmapFactory.decodeFile(styleFile.absolutePath)
            ?: return null
        val stylePx = IntArray(styleBmp.width * styleBmp.height)
        styleBmp.getPixels(stylePx, 0, styleBmp.width, 0, 0, styleBmp.width, styleBmp.height)
        styleBmp.recycle()

        DebugLogger.d("[风格模型] 开始本地训练：$iterations 次迭代，LUT $size^3")
        val t0 = System.currentTimeMillis()
        val model = ColorLutModel(size)
        val loss = model.train(colorCubeSamples(), stylePx, iterations) { done, l ->
            onProgress?.invoke(done, iterations, l)
        }
        DebugLogger.d("[风格模型] 训练完成，耗时 ${System.currentTimeMillis() - t0} ms，最终 loss=$loss")
        save(key, model)
        return model
    }

    fun clearAll() { dir.listFiles()?.forEach { it.delete() } }

    fun totalBytes(): Long = dir.listFiles()?.sumOf { it.length() } ?: 0L
}
