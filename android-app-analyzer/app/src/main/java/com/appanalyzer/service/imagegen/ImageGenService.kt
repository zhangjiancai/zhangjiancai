package com.appanalyzer.service.imagegen

import com.appanalyzer.service.DebugLogger
import com.appanalyzer.service.IconReplaceService
import com.appanalyzer.service.PreferencesManager
import com.appanalyzer.service.image.ColorLutModel
import com.appanalyzer.service.image.ComposeSpec
import com.appanalyzer.service.image.IconBackground
import com.appanalyzer.service.image.IconComposer
import com.appanalyzer.service.image.LocalStyle
import com.appanalyzer.service.image.LocalStyleRenderer
import com.appanalyzer.service.image.StyleLibrary
import com.appanalyzer.service.image.StyleModelStore
import com.appanalyzer.service.localmodel.LocalModelCatalog
import com.appanalyzer.service.localmodel.LocalModelManager
import com.appanalyzer.service.localmodel.ModelSpec
import com.appanalyzer.service.localmodel.OnnxMattingEngine
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** 一次生成的最终结果 */
sealed class IconGenResult {
    data class Success(val imageBase64: String, val engineId: String) : IconGenResult()
    data class Failure(val message: String, val detail: String? = null) : IconGenResult()
}

/**
 * 图标生成的总调度。
 *
 * 两条完全不同的路径，输入输出按这个约定：
 *
 * - **本地算法**：`风格参考图 + 原图标 -> 新图标`。用户提供一张风格基准图，
 *   之后所有图标都按这张图的风格迁移（Reinhard 色彩迁移 / 调色板 / 渐变映射）。
 * - **API 与本地大模型**：`文字 + 可选风格参考图 + 原图标 -> 新图标`。
 */
class ImageGenService(
    private val prefs: PreferencesManager,
    private val iconService: IconReplaceService,
    private val styleLibrary: StyleLibrary,
    private val modelManager: LocalModelManager,
    private val styleModelStore: StyleModelStore
) {

    fun currentEngineId(): String = prefs.getImageProviderId()

    fun isLocalEngine(): Boolean = currentEngineId() == ImageGenProviders.LOCAL_ID

    fun isLocalModelEngine(): Boolean = currentEngineId() == ImageGenProviders.LOCAL_MODEL_ID

    /** 当前选中的端侧模型 */
    fun currentModel() = LocalModelCatalog.byId(prefs.getLocalModelId())

    /** 本地风格迁移永远可用；本地模型要下载完才可用 */
    fun isModelReady(): Boolean = currentModel()?.let { modelManager.isReady(it) } ?: false

    fun currentProvider(): ImageGenProvider? = ImageGenProviders.byId(currentEngineId())

    /** 当前引擎是否可用（本地引擎永远算可用） */
    fun isReady(): Boolean {
        if (isLocalEngine()) return true
        if (isLocalModelEngine()) return isModelReady()
        val p = currentProvider() ?: return false
        return prefs.getImageApiKey(p.id).isNotBlank()
    }

    fun configFor(provider: ImageGenProvider): ImageGenConfig = ImageGenConfig(
        providerId = provider.id,
        apiKey = prefs.getImageApiKey(provider.id),
        baseUrl = prefs.getImageBaseUrl(provider.id).ifBlank { provider.defaultBaseUrl },
        model = prefs.getImageModel(provider.id).ifBlank { provider.defaultModel }
    )

    // ==================== 本地路径 ====================

    /** 当前选中的风格参考图；没选过就回退到第一张内置图 */
    fun currentStyleRef(): com.appanalyzer.service.image.StyleRef? {
        val id = prefs.getStyleRefId()
        return (if (id.isNotBlank()) styleLibrary.byId(id) else null) ?: styleLibrary.list().firstOrNull()
    }

    /** 当前选中的四类风格之一 */
    fun currentLocalStyle(): LocalStyle = LocalStyle.byId(prefs.getLocalStyleId())

    /**
     * 提前把「自定义」风格的模型训练好（用户点「开始训练」时调用）。
     * 训练只跟风格图有关，跟具体图标无关，所以一次训练全部图标通用。
     */
    fun warmUpModel(
        ref: com.appanalyzer.service.image.StyleRef?,
        onProgress: ((Int, Int, Float) -> Unit)? = null
    ): Boolean {
        val r = ref ?: return false
        return styleModelStore.getOrTrain(
            styleFile = r.file,
            iterations = currentTrainIterations(),
            onProgress = onProgress
        ) != null
    }

    /** 当前风格模型是否已经训练好（有缓存） */
    fun isModelReady(ref: com.appanalyzer.service.image.StyleRef?): Boolean {
        val r = ref ?: return false
        return styleModelStore.exists(styleModelStore.keyFor(r.file, 17))
    }

    fun currentStrength(): Float = prefs.getStyleStrength()

    /** 极简色块的量化档数 */
    fun currentMinimalColors(): Int = prefs.getMinimalColors()

    /** 训练迭代次数 */
    fun currentTrainIterations(): Int = prefs.getTrainIterations()

    // ==================== 提示词 ====================

    /**
     * 拼装发给图像模型的提示词。
     *
     * 输入：应用名 + 文字风格描述（用户填的，或从预设里点的）+ 额外特征。
     * 只用于 API / 本地大模型这条路径；本地算法不用提示词，它用的是风格参考图。
     */
    fun buildPrompt(appName: String, styleDescription: String, extraFeatures: String): String {
        val sb = StringBuilder()
        sb.append("这是手机应用「").append(appName).append("」的图标。")
        if (styleDescription.isNotBlank()) {
            sb.append("请保持主体可辨识，把它改造成这样的风格：").append(styleDescription.trim()).append("。")
        } else {
            sb.append("请保持主体可辨识，为它设计一个更精致的新图标。")
        }
        sb.append("画面要求：正方形构图，主体居中，四周留出安全边距；")
        sb.append("画面中不要出现任何文字、字母或数字；不要加外边框和额外圆角遮罩；")
        sb.append("确保缩小到桌面图标尺寸（约 48-192 像素）后依然清晰可辨。")
        if (extraFeatures.isNotBlank()) {
            sb.append("额外要求：").append(extraFeatures.trim())
        }
        val limit = currentProvider()?.promptLimit ?: 0
        val text = sb.toString()
        return if (limit > 0 && text.length > limit) {
            // 服务端会自行截断，这里主动截断以免把「额外要求」这段最具体的信息丢掉：
            // 保留开头（风格定义）和结尾（用户自定义要求）。
            text.take(limit * 2 / 3) + text.takeLast(limit / 3)
        } else text
    }

    // ==================== 生成 ====================

    /**
     * 生成一个图标。
     *
     * @param sourceBase64  原图标
     * @param styleId       落盘用的文件名后缀，区分不同风格下的产物
     * @param styleDescription 文字风格描述（仅 AI 路径使用）
     * @param extraFeatures 额外特征描述（仅 AI 路径使用）
     * @param useStyleRef   AI 路径是否同时把风格参考图也传给模型（仅部分服务商支持）
     */
    suspend fun generate(
        appName: String,
        packageName: String,
        styleId: String,
        sourceBase64: String?,
        styleDescription: String,
        extraFeatures: String,
        useStyleRef: Boolean = true
    ): IconGenResult = withContext(Dispatchers.IO) {
        val engineId = currentEngineId()

        if (engineId == ImageGenProviders.LOCAL_ID) {
            return@withContext generateLocal(packageName, styleId, engineId, sourceBase64)
        }

        // ---- 端侧模型（抠图 / 超分）----
        if (engineId == ImageGenProviders.LOCAL_MODEL_ID) {
            return@withContext generateLocalModel(packageName, styleId, engineId, sourceBase64)
        }

        // ---- API / 本地大模型 ----
        val provider = ImageGenProviders.byId(engineId)
            ?: return@withContext IconGenResult.Failure("未知的服务商: $engineId")
        val config = configFor(provider)
        if (config.apiKey.isBlank()) {
            return@withContext IconGenResult.Failure("还没有填写 ${provider.displayName} 的 API Key")
        }
        if (sourceBase64.isNullOrBlank()) {
            return@withContext IconGenResult.Failure("拿不到原始图标，无法进行图生图")
        }

        val prompt = buildPrompt(appName, styleDescription, extraFeatures)
        // 只有支持多图输入的服务商才附带风格参考图，否则传了也没用
        val styleRefBase64 = if (useStyleRef && provider.maxReferenceImages > 1) {
            currentStyleRef()?.let { ref ->
                styleLibrary.loadBitmap(ref)?.let { iconService.encode(it).also { _ -> it.recycle() } }
            }
        } else null

        DebugLogger.d(
            "[图标生成] ${provider.displayName} | $appName | 提示词 ${prompt.length} 字" +
                (if (styleRefBase64 != null) " | 附带风格参考图" else "")
        )

        val request = ImageGenRequest(
            sourceImageBase64 = sourceBase64,
            prompt = prompt,
            styleImageBase64 = styleRefBase64
        )
        when (val outcome = provider.generate(config, request)) {
            is ImageGenOutcome.Success -> {
                val normalized = iconService.normalizeIcon(outcome.imageBase64, 192) ?: outcome.imageBase64
                iconService.saveIcon(packageName, styleId, engineId, normalized)
                IconGenResult.Success(normalized, engineId)
            }
            is ImageGenOutcome.Failure -> {
                DebugLogger.w("[图标生成] 失败: ${outcome.describe()}")
                IconGenResult.Failure(outcome.message, outcome.rawResponse)
            }
        }
    }

    /**
     * 端侧模型推理。
     *
     * 目前模型清单里是**抠图**和**超分**两类 ——
     * 魔搭上没有可用的端侧「图生图/风格迁移」模型（AnimeGAN / CartoonGAN / AdaIN /
     * fast-neural-style 等 30 多个候选全部不存在），所以"用文字生成新图标"只能走云端 API。
     *
     * 抠图时如果用户选了风格参考图，会把主体合成到这张风格图上 —— 这样
     * 「可选风格参考图 + 原图标」两个输入就都用上了。
     */
    private fun generateLocalModel(
        packageName: String,
        styleId: String,
        engineId: String,
        sourceBase64: String?
    ): IconGenResult {
        val spec = currentModel()
            ?: return IconGenResult.Failure("还没有选择端侧模型")
        if (!modelManager.isReady(spec)) {
            val msg = "模型「${spec.name}」还没下载完（当前选中 ${spec.id}），请先在「端侧模型」面板里下载"
            DebugLogger.w("[本地模型] $msg")
            return IconGenResult.Failure(msg)
        }
        if (sourceBase64.isNullOrBlank()) {
            return IconGenResult.Failure("拿不到原始图标，无法处理")
        }
        val src = iconService.decode(sourceBase64)
            ?: return IconGenResult.Failure("原图解码失败")

        // 抠图模型先得到「背景被去掉的主体」，之后交给合成器做成新图标。
        // 超分模型不需要抠图，直接放大。
        val isMatting = spec.task == ModelSpec.Task.MATTING

        val result = OnnxMattingEngine.run(
            spec = spec,
            modelFile = modelManager.fileOf(spec),
            source = src,
            outSize = 192,
            background = null          // 抠图输出保持透明，背景交给下面的合成步骤画
        )

        return result.fold(
            onSuccess = { cutout ->
                val finalBmp = if (!isMatting) {
                    cutout
                } else {
                    // ★ 三级管线的中间一级（可选）：抠出来的主体先按当前本地风格处理一遍。
                    //   比如风格选「白线勾勒」，主体就变成线稿，再合成到新背景上。
                    val stylized = if (prefs.getStylizeSubject()) {
                        val st = currentLocalStyle()
                        val lut = if (st == LocalStyle.CUSTOM) {
                            currentStyleRef()?.let { ref ->
                                styleModelStore.getOrTrain(ref.file, iterations = currentTrainIterations())
                            }
                        } else null
                        val s = LocalStyleRenderer.render(
                            source = cutout,
                            style = st,
                            outSize = 192,
                            colorCount = currentMinimalColors(),
                            lut = lut
                        )
                        cutout.recycle()
                        s
                    } else cutout

                    // ★ 这一步就是「抠完图之后」缺的那一环：
                    //   主体 -> 缩放进留白 + 画新背景 + 投阴影 + 切圆角 = 新图标
                    val styleBg = if (currentCompose().background == IconBackground.STYLE_IMAGE)
                        currentStyleRef()?.let { styleLibrary.loadBitmap(it) } else null
                    val composed = IconComposer.compose(stylized, styleBg, currentCompose(), 192)
                    styleBg?.recycle()
                    stylized.recycle()
                    composed
                }
                src.recycle()

                val b64 = iconService.encode(finalBmp)
                finalBmp.recycle()
                iconService.saveIcon(packageName, styleId, engineId, b64)
                DebugLogger.d("[本地模型] ${spec.name} -> ${if (isMatting) "抠图 + 合成" else "超分"} 完成")
                IconGenResult.Success(b64, engineId)
            },
            onFailure = { e ->
                src.recycle()
                IconGenResult.Failure("端侧模型推理失败: ${e.message}")
            }
        )
    }

    /** 当前合成参数 */
    fun currentCompose(): ComposeSpec = ComposeSpec(
        background = IconBackground.byId(prefs.getComposeBackground()),
        colorTop = prefs.getComposeColorTop(),
        colorBottom = prefs.getComposeColorBottom(),
        subjectScale = prefs.getComposeSubjectScale(),
        cornerRadius = prefs.getComposeCorner(),
        shadow = prefs.getComposeShadow(),
        shadowAlpha = prefs.getComposeShadowAlpha()
    )

    fun saveCompose(spec: ComposeSpec) = prefs.saveCompose(spec)

    /**
     * 本地风格迁移：风格参考图 + 原图标 -> 新图标。
     *
     * 风格图的取法：先用用户选中的，没有就用第一张内置参考图。
     * 一张风格图会被应用到**所有**图标上 —— 这正是「我输入一种风格的基础图片，
     * 后面的图标都按照这个风格去搞」。
     */
    private fun generateLocal(
        packageName: String,
        styleId: String,
        engineId: String,
        sourceBase64: String?,
        onTrainProgress: ((Int, Int, Float) -> Unit)? = null
    ): IconGenResult {
        if (sourceBase64.isNullOrBlank()) {
            return IconGenResult.Failure("拿不到原始图标，无法处理")
        }
        val srcBitmap = iconService.decode(sourceBase64)
            ?: return IconGenResult.Failure("原图解码失败")

        val style = currentLocalStyle()

        // 自定义风格需要：一张风格参考图 + 一个在本机训练出来的查找表
        var lut: ColorLutModel? = null
        if (style == LocalStyle.CUSTOM) {
            val ref = currentStyleRef()
                ?: run {
                    srcBitmap.recycle()
                    return IconGenResult.Failure("自定义风格需要一张风格参考图，请先在风格库里选一张或从相册导入")
                }
            lut = styleModelStore.getOrTrain(
                styleFile = ref.file,
                iterations = currentTrainIterations(),
                onProgress = onTrainProgress
            )
            if (lut == null) {
                srcBitmap.recycle()
                return IconGenResult.Failure("风格模型训练失败（风格图「${ref.name}」读不出来？）")
            }
        }

        return try {
            val out = LocalStyleRenderer.render(
                source = srcBitmap,
                style = style,
                outSize = 192,
                colorCount = currentMinimalColors(),
                lut = lut
            )
            // 强度：原图与风格结果之间线性混合。三种内置风格默认满强度，
            // 自定义风格留一点原图味道通常更好看。
            val strength = currentStrength()
            val finalBitmap = if (strength >= 0.999f) out else blend(srcBitmap, out, strength)
            if (finalBitmap !== out) out.recycle()

            val b64 = iconService.encode(finalBitmap)
            finalBitmap.recycle()
            iconService.saveIcon(packageName, styleId, engineId, b64)
            IconGenResult.Success(b64, engineId)
        } catch (e: Exception) {
            DebugLogger.e("[本地风格] 失败", e)
            IconGenResult.Failure("本地风格处理失败: ${e.message}")
        } finally {
            srcBitmap.recycle()
        }
    }

    /** 按强度把风格结果和原图混合 */
    private fun blend(original: android.graphics.Bitmap, styled: android.graphics.Bitmap, t: Float): android.graphics.Bitmap {
        val w = styled.width; val h = styled.height
        val a = IntArray(w * h); val b = IntArray(w * h)
        original.getPixels(a, 0, w, 0, 0, w, h)
        styled.getPixels(b, 0, w, 0, 0, w, h)
        val out = IntArray(w * h)
        for (i in out.indices) {
            val c0 = a[i]; val c1 = b[i]
            val alpha = (c1 ushr 24) and 0xFF
            out[i] = (alpha shl 24) or
                    ((((c0 shr 16) and 0xFF) + (((c1 shr 16) and 0xFF) - ((c0 shr 16) and 0xFF)) * t).toInt() shl 16) or
                    ((((c0 shr 8) and 0xFF) + (((c1 shr 8) and 0xFF) - ((c0 shr 8) and 0xFF)) * t).toInt() shl 8) or
                    ((c0 and 0xFF) + ((c1 and 0xFF) - (c0 and 0xFF)) * t).toInt()
        }
        val bmp = android.graphics.Bitmap.createBitmap(w, h, android.graphics.Bitmap.Config.ARGB_8888)
        bmp.setPixels(out, 0, w, 0, 0, w, h)
        return bmp
    }
}
