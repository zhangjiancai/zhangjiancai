package com.appanalyzer.service

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.util.Base64
import java.io.File

/**
 * 生成结果落盘 + 原图缓存 + 尺寸归一化，另外提供一组**文字提示词预设**。
 *
 * 注意职责划分：
 * - **本地算法**（风格参考图 + 原图标 -> 新图标）不在这里，在
 *   [com.appanalyzer.service.image.StyleTransfer]，由
 *   [com.appanalyzer.service.imagegen.ImageGenService] 调度。
 * - [promptPresets] 只服务于 **API / 本地大模型**那条路径：它们是一段段文字描述，
 *   方便用户一键填进提示词输入框，本身不参与任何图像运算。
 */
class IconReplaceService(private val context: Context) {

    // ⚠️ 这里必须是 by lazy，不能写成 get() = ...
    // get() 属性每次读取都会重新执行一遍 getExternalFilesDir()（要过一遍 StorageManager）
    // 外加一次 mkdirs()。图标页要给全部应用回填生成结果，258 个应用就是 500 多次文件系统
    // 调用 —— 实测光这一项就吃掉 11 秒，是整个应用切页面卡顿的主因。
    private val iconsRoot: File by lazy {
        (context.getExternalFilesDir("icons") ?: context.filesDir).also { it.mkdirs() }
    }

    private val storageDir: File by lazy {
        File(iconsRoot, "generated").also { it.mkdirs() }
    }

    private val sourceDir: File by lazy {
        File(iconsRoot, "source").also { it.mkdirs() }
    }

    /**
     * 一条文字提示词预设。
     *
     * [instruction] 会被拼进发给图像模型的提示词里 —— 这是**真正会被发出去**的文字
     * （早期版本里叫 promptTemplate，写得很像要调 AI，却没有任何代码引用它，等于摆设）。
     */
    data class PromptPreset(
        val id: String,
        val name: String,
        val description: String,
        val instruction: String,
        val colors: List<Long> = listOf(0xFF2196F3, 0xFF4CAF50, 0xFFFF9800, 0xFFE91E63)
    )

    val promptPresets = listOf(
        PromptPreset(
            "minimal", "极简", "纯色底 + 单色符号",
            "使用单一纯色背景，把主体简化成一个干净的几何符号，去掉所有渐变、纹理和细碎细节，边角圆润"
        ),
        PromptPreset(
            "flat", "扁平", "扁平色块，鲜明对比",
            "使用 2-3 种高对比度的纯色色块构成画面，去掉渐变、阴影和立体感，线条简洁"
        ),
        PromptPreset(
            "glass", "毛玻璃", "半透明磨砂质感",
            "半透明的磨砂玻璃层叠效果，柔和的背景模糊，圆角矩形轮廓，光影细腻通透"
        ),
        PromptPreset(
            "neon", "霓虹", "深色底 + 发光线条",
            "深色（近黑或深蓝）背景，主体由发光的霓虹线条勾勒，带明显的辉光扩散效果，色彩电光感强"
        ),
        PromptPreset(
            "pixel", "像素", "8-bit 复古像素",
            "低分辨率方块化图形，明显的马赛克颗粒，复古游戏机配色，不要抗锯齿的平滑边缘（8-bit 像素风）"
        ),
        PromptPreset(
            "gradient", "渐变", "流畅多色渐变",
            "使用双色或多色的流畅渐变作为主视觉，轮廓简洁现代，可直接用渐变本身构成主体"
        ),
        PromptPreset(
            "mono", "单色", "黑白灰极简",
            "只使用黑、白、灰三种色阶，去掉所有彩色，靠形状和对比度表达主体，干净利落"
        ),
        PromptPreset(
            "3d", "3D立体", "等距视角立体块",
            "等距视角，主体有体积感和厚度，配柔和的方向性阴影和高光，材质细腻有质感",
            listOf(0xFF5C6BC0, 0xFF7C4DFF, 0xFF00BCD4, 0xFFFF4081)
        )
    )

    /** 取预设；id 不存在时回退到第一个（列表恒非空，但仍显式处理） */
    fun getPreset(id: String): PromptPreset = promptPresets.find { it.id == id } ?: promptPresets.first()

    // ============== 结果落盘 ==============
    // 文件名带上「引擎」：同一个应用同一个风格，本地算法画的图和 AI 生成的图是两回事，
    // 共用文件名会互相覆盖。

    private fun iconFile(packageName: String, styleId: String, engineId: String) =
        File(storageDir, "${packageName}__${styleId}__$engineId.png")

    fun getSavedIcon(packageName: String, styleId: String, engineId: String): String? {
        val file = iconFile(packageName, styleId, engineId)
        return if (file.exists()) {
            try {
                Base64.encodeToString(file.readBytes(), Base64.NO_WRAP)
            } catch (e: Exception) {
                DebugLogger.w("读取已保存图标失败 $packageName: ${e.message}")
                null
            }
        } else null
    }

    /**
     * 一次列出当前「风格 + 引擎」下所有已生成图标的包名集合。
     *
     * 逐个数 258 次 File.exists() 实测要 620ms（每次都是对应用外部私有目录的一次 stat）。
     * 改成列一次目录再在内存里比对，降到个位数毫秒。
     */
    fun listGeneratedPackages(styleId: String, engineId: String): Set<String> {
        val suffix = "__${styleId}__$engineId.png"
        return try {
            storageDir.listFiles()
                ?.filter { it.isFile && it.name.endsWith(suffix) }
                ?.mapTo(HashSet()) { it.name.removeSuffix(suffix) }
                ?: emptySet()
        } catch (e: Exception) {
            DebugLogger.w("列举已生成图标失败: ${e.message}")
            emptySet()
        }
    }

    fun saveIcon(packageName: String, styleId: String, engineId: String, base64: String) {
        val bytes = Base64.decode(base64, Base64.DEFAULT)
        iconFile(packageName, styleId, engineId).writeBytes(bytes)
    }

    /** 原始图标（用作图生图的输入图），存在单独目录 */
    private fun sourceFile(packageName: String) = File(sourceDir, "src_$packageName.png")

    fun saveSourceIcon(packageName: String, base64: String) {
        try {
            sourceFile(packageName).writeBytes(Base64.decode(base64, Base64.DEFAULT))
        } catch (e: Exception) { DebugLogger.w("保存原始图标失败: ${e.message}") }
    }

    fun loadSourceIcon(packageName: String): String? {
        val f = sourceFile(packageName)
        return if (f.exists()) try {
            Base64.encodeToString(f.readBytes(), Base64.NO_WRAP)
        } catch (e: Exception) { null } else null
    }

    /**
     * 把生成的图缩放到统一尺寸（图标包统一用 192x192，即 xxhdpi）。
     * 各家模型返回的尺寸不一致，不归一化会导致图标包里大小参差。
     */
    fun normalizeIcon(base64: String, size: Int = 192): String? {
        return try {
            val bytes = Base64.decode(base64, Base64.DEFAULT)
            val src = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return null
            val dst = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(dst)
            val paint = Paint().apply {
                isAntiAlias = true
                isFilterBitmap = true
            }
            canvas.drawBitmap(
                src,
                android.graphics.Rect(0, 0, src.width, src.height),
                RectF(0f, 0f, size.toFloat(), size.toFloat()),
                paint
            )
            if (src != dst) src.recycle()
            val out = java.io.ByteArrayOutputStream()
            dst.compress(Bitmap.CompressFormat.PNG, 100, out)
            dst.recycle()
            Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        } catch (e: Exception) {
            DebugLogger.w("图标归一化失败: ${e.message}")
            null
        }
    }

    fun clearAllGenerated() {
        storageDir.listFiles()?.forEach { it.delete() }
    }

    // 本地算法已经整体搬到 service/image/StyleTransfer.kt（风格参考图驱动），
    // 这里不再有"按 styleId 画图"的入口。

    /** Base64 PNG -> Bitmap */
    fun decode(base64: String): Bitmap? = try {
        val bytes = Base64.decode(base64, Base64.DEFAULT)
        android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
    } catch (e: Exception) { null }

    /** Bitmap -> Base64 PNG */
    fun encode(bitmap: Bitmap): String {
        val stream = java.io.ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)
        return Base64.encodeToString(stream.toByteArray(), Base64.NO_WRAP)
    }
}