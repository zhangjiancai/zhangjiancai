package com.appanalyzer.service.image

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import android.net.Uri
import com.appanalyzer.service.DebugLogger
import java.io.File

/** 一张风格参考图 */
data class StyleRef(
    val id: String,
    val name: String,
    val file: File,
    val builtIn: Boolean = false
)

/**
 * 风格参考图库。
 *
 * 用户从相册导入任意图片当作「风格基准」，之后所有图标都按这张图的风格去迁移。
 * 另外内置几张程序生成的参考图，保证没导入任何图时也能直接开箱使用
 * （它们是真的图片、有真实的色彩统计，不是假的预设开关）。
 */
class StyleLibrary(private val context: Context) {

    private val dir: File by lazy { File(context.filesDir, "styles").also { it.mkdirs() } }

    companion object {
        /** 内置参考图的 id -> 显示名 */
        private val BUILT_INS = linkedMapOf(
            "builtin_dusk" to "暮色",
            "builtin_mint" to "薄荷",
            "builtin_amber" to "暖阳",
            "builtin_neon" to "霓虹夜",
            "builtin_morandi" to "莫兰迪",
            "builtin_film" to "黑白胶片"
        )
    }

    fun list(): List<StyleRef> {
        val user = dir.listFiles { f -> f.isFile && f.name.startsWith("user_") }
            ?.sortedByDescending { it.lastModified() }
            ?.map { StyleRef(it.nameWithoutExtension, it.nameWithoutExtension.removePrefix("user_"), it, false) }
            ?: emptyList()
        val builtIn = BUILT_INS.mapNotNull { (id, label) ->
            val f = File(dir, "$id.png")
            if (f.exists()) StyleRef(id, label, f, true) else null
        }
        return user + builtIn
    }

    fun byId(id: String): StyleRef? = list().find { it.id == id }

    /** 首次运行时生成内置参考图（256x256 PNG，体积很小） */
    fun ensureBuiltIns() {
        BUILT_INS.keys.forEach { id ->
            val f = File(dir, "$id.png")
            if (!f.exists()) {
                try {
                    // Bitmap 不是 Closeable，不能用 use{}，手写 try/finally
                    val bmp = renderBuiltIn(id)
                    try {
                        f.outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 90, it) }
                    } finally {
                        bmp.recycle()
                    }
                } catch (e: Exception) {
                    DebugLogger.w("生成内置风格图 $id 失败: ${e.message}")
                }
            }
        }
    }

    /** 从相册导入一张图作为风格参考 */
    fun importFromUri(uri: Uri): StyleRef? {
        return try {
            val input = context.contentResolver.openInputStream(uri) ?: return null
            val bmp = input.use { android.graphics.BitmapFactory.decodeStream(it) } ?: return null
            // 统一缩到 256x256 存下来，省空间也够取统计量
            val small = Bitmap.createScaledBitmap(bmp, 256, 256, true)
            if (small !== bmp) bmp.recycle()
            val id = "user_" + System.currentTimeMillis()
            val f = File(dir, "$id.png")
            f.outputStream().use { small.compress(Bitmap.CompressFormat.PNG, 92, it) }
            small.recycle()
            StyleRef(id, "我的风格", f, false)
        } catch (e: Exception) {
            DebugLogger.e("导入风格图失败: ${e.message}", e)
            null
        }
    }

    fun rename(ref: StyleRef, newName: String): StyleRef? {
        return try {
            val newId = "user_" + newName.replace(Regex("[^\\p{L}\\p{N}_-]"), "_")
            val nf = File(dir, "$newId.png")
            if (nf.exists()) nf.delete()
            ref.file.renameTo(nf)
            StyleRef(newId, newName, nf, false)
        } catch (e: Exception) { null }
    }

    fun delete(ref: StyleRef): Boolean {
        if (ref.builtIn) return false
        return try { ref.file.delete() } catch (e: Exception) { false }
    }

    fun loadBitmap(ref: StyleRef): Bitmap? = try {
        android.graphics.BitmapFactory.decodeFile(ref.file.absolutePath)
    } catch (e: Exception) { null }

    fun loadBitmap(id: String): Bitmap? = byId(id)?.let { loadBitmap(it) }

    // ==================== 内置参考图的程序化生成 ====================

    private fun renderBuiltIn(id: String): Bitmap {
        val s = 256
        val bmp = Bitmap.createBitmap(s, s, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)

        fun vGradient(colors: IntArray) {
            paint.shader = LinearGradient(0f, 0f, 0f, s.toFloat(), colors, null, Shader.TileMode.CLAMP)
            canvas.drawRect(0f, 0f, s.toFloat(), s.toFloat(), paint)
            paint.shader = null
        }
        fun dGradient(colors: IntArray) {
            paint.shader = LinearGradient(0f, 0f, s.toFloat(), s.toFloat(), colors, null, Shader.TileMode.CLAMP)
            canvas.drawRect(0f, 0f, s.toFloat(), s.toFloat(), paint)
            paint.shader = null
        }
        fun blocks(colors: IntArray, cols: Int, rows: Int) {
            val cw = s.toFloat() / cols
            val ch = s.toFloat() / rows
            for (r in 0 until rows) for (c in 0 until cols) {
                paint.color = colors[(r * cols + c) % colors.size]
                canvas.drawRect(c * cw, r * ch, (c + 1) * cw, (r + 1) * ch, paint)
            }
        }

        when (id) {
            // 深蓝紫 -> 品红，暗调冷色
            "builtin_dusk" -> vGradient(intArrayOf(0xFF141A33.toInt(), 0xFF3B2A6B.toInt(), 0xFF9C3F7A.toInt(), 0xFFE8794A.toInt()))
            // 青绿 -> 米白，明亮清爽
            "builtin_mint" -> dGradient(intArrayOf(0xFF0F5F5C.toInt(), 0xFF4FB3A0.toInt(), 0xFFBFE8D9.toInt(), 0xFFF6FBF4.toInt()))
            // 橙黄 -> 深棕，浓郁暖调
            "builtin_amber" -> vGradient(intArrayOf(0xFF2A1A0C.toInt(), 0xFF8A4B14.toInt(), 0xFFD98A2B.toInt(), 0xFFF5D08A.toInt()))
            // 近黑底 + 高饱和霓虹色块
            "builtin_neon" -> {
                canvas.drawColor(0xFF0A0A18.toInt())
                blocks(intArrayOf(0xFF00E5FF.toInt(), 0xFFFF2D95.toInt(), 0xFF7C4DFF.toInt(), 0xFF00FFA3.toInt()), 4, 4)
                paint.alpha = 90
                canvas.drawColor(0xFF0A0A18.toInt())
                paint.alpha = 255
            }
            // 低饱和高级灰
            "builtin_morandi" -> blocks(
                intArrayOf(0xFFB9B0A5.toInt(), 0xFF9AA79B.toInt(), 0xFFA8A2B0.toInt(), 0xFFC7B7A3.toInt(),
                           0xFF8E9AA6.toInt(), 0xFFBFB3B0.toInt(), 0xFFA3AFA2.toInt(), 0xFFAAA0A8.toInt()), 4, 2
            )
            // 灰阶 + 轻微条纹，模拟胶片
            else -> {
                vGradient(intArrayOf(0xFF101010.toInt(), 0xFF5A5A5A.toInt(), 0xFFBDBDBD.toInt(), 0xFFF2F2F2.toInt()))
                paint.color = 0x22000000
                var x = 0
                while (x < s) { canvas.drawRect(x.toFloat(), 0f, x + 2f, s.toFloat(), paint); x += 6 }
            }
        }
        return bmp
    }
}
