package com.appanalyzer.service.imagegen

import com.appanalyzer.service.DebugLogger
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/**
 * 一次「图生图」请求。
 *
 * [sourceImageBase64] 是原图标的 PNG 字节经 Base64 编码后的字符串（**不含** data URI 前缀）。
 */
data class ImageGenRequest(
    val sourceImageBase64: String,
    val prompt: String,
    /**
     * 可选的风格参考图。
     *
     * 只有 [ImageGenProvider.maxReferenceImages] > 1 的服务商才收得到它；
     * 单图接口（通义万相 / SeedEdit）会忽略，UI 里也据此给出提示。
     */
    val styleImageBase64: String? = null,
    val sourceMimeType: String = "image/png"
) {
    /**
     * data URI 形式。
     *
     * 通义万相的 base_image_url 官方说明是「输入图像的 URL 或 Base64 编码数据」，
     * DashScope 系列接口惯用的就是这种 data:image/png;base64,xxx 形式；
     * 火山方舟的 image 字段同样接受 data URI。
     * 手机上的图片没有公网 URL，只能走 Base64，所以这是唯一可行的传法。
     */
    val dataUri: String get() = "data:$sourceMimeType;base64,$sourceImageBase64"

    /** 风格参考图的 data URI，没有则为 null */
    val styleDataUri: String?
        get() = styleImageBase64?.let { "data:$sourceMimeType;base64,$it" }
}

/** 统一的生成结果 */
sealed class ImageGenOutcome {
    data class Success(
        val imageBase64: String,
        val mimeType: String = "image/png"
    ) : ImageGenOutcome()

    /**
     * 失败。
     *
     * 特意把 HTTP 状态码和**原始响应体片段**一起带出来：这些服务第一次配 key 时最容易
     * 出问题（key 错、模型没开通、余额不足、图片格式不符），把原文透出去用户自己就能定位，
     * 而不是只看到一句「生成失败」。
     */
    data class Failure(
        val message: String,
        val httpCode: Int? = null,
        val rawResponse: String? = null
    ) : ImageGenOutcome() {
        fun describe(): String = buildString {
            append(message)
            httpCode?.let { append("（HTTP $it）") }
            rawResponse?.takeIf { it.isNotBlank() }?.let { append("\n原始响应: ${it.take(400)}") }
        }
    }
}

/** 调用某个服务商所需的全部配置 */
data class ImageGenConfig(
    val providerId: String,
    val apiKey: String,
    val baseUrl: String,
    val model: String
)

/**
 * 生图服务商适配接口。
 *
 * 之所以抽象成接口：DeepSeek 只有文本模型，做图生图必须外接别家（通义万相 / 豆包 SeedEdit /
 * Gemini / OpenAI…）。用户手上有哪家的 key 就用哪家，不该让整个功能绑死在一个服务上。
 */
interface ImageGenProvider {
    val id: String
    val displayName: String
    val defaultBaseUrl: String
    val defaultModel: String

    /** 设置页展示的提示文字 */
    val keyHint: String
    val modelHint: String
    val applyUrl: String

    /** 提示词字符上限（超过服务端会截断），0 表示未说明 */
    val promptLimit: Int

    /**
     * 这个服务商一次最多能收几张输入图。
     * 1 = 只能收原图标；2 = 还能同时收一张风格参考图。
     */
    val maxReferenceImages: Int get() = 1

    suspend fun generate(config: ImageGenConfig, request: ImageGenRequest): ImageGenOutcome
}

/**
 * 所有 provider 共用同一个 OkHttpClient。
 * （前面刚踩过的坑：每个对象各建一个 client 会各带一套线程池和连接池。）
 */
internal object ImageGenHttp {
    val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()

    fun jsonBody(json: String): RequestBody =
        json.toRequestBody("application/json; charset=utf-8".toMediaType())

    fun log(tag: String, message: String) = DebugLogger.d("[$tag] $message")
}

object ImageGenProviders {

    /** 本地风格迁移：风格参考图 + 原图标 -> 新图标，不联网。 */
    const val LOCAL_ID = "local"

    /** 本地大模型：在手机上跑 ONNX 模型（目前是抠图），模型按需下载。 */
    const val LOCAL_MODEL_ID = "localmodel"

    val remote: List<ImageGenProvider> = listOf(
        WanxImageEditProvider,
        SeedEditProvider,
        GeminiImageProvider,
        OpenAiImageProvider
    )

    /** 设置页里的完整列表：本地风格迁移 + 本地模型 + 各远程服务 */
    val allIds: List<String> = listOf(LOCAL_ID, LOCAL_MODEL_ID) + remote.map { it.id }

    fun byId(id: String): ImageGenProvider? = remote.find { it.id == id }

    fun displayNameOf(id: String): String = when (id) {
        LOCAL_ID -> "本地风格迁移（不联网）"
        LOCAL_MODEL_ID -> "本地模型（端侧 ONNX，按需下载）"
        else -> byId(id)?.displayName ?: id
    }
}
