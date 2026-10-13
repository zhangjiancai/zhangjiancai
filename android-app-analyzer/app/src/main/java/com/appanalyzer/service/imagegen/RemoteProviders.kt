package com.appanalyzer.service.imagegen

import android.util.Base64
import com.google.gson.Gson
import com.google.gson.JsonObject
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

private val gson = Gson()

/** 把 http 客户端下载回来的图片转成 Base64 */
private fun bytesToBase64(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)

private fun downloadAsBase64(url: String): ImageGenOutcome {
    return try {
        val req = Request.Builder().url(url).get().build()
        val resp = ImageGenHttp.client.newCall(req).execute()
        val bytes = resp.body?.bytes()
        if (!resp.isSuccessful || bytes == null) {
            ImageGenOutcome.Failure("结果图片下载失败", resp.code, null)
        } else {
            ImageGenOutcome.Success(bytesToBase64(bytes))
        }
    } catch (e: Exception) {
        ImageGenOutcome.Failure("结果图片下载失败: ${e.message}")
    }
}

// =====================================================================
// 阿里云百炼 · 通义万相（图像编辑）
// 官方文档: https://help.aliyun.com/zh/model-studio/wanx-image-edit-api-reference
// 流程是异步的：先创建任务拿 task_id，再轮询任务状态拿结果 URL。
// =====================================================================
object WanxImageEditProvider : ImageGenProvider {
    override val id = "wanx"
    override val displayName = "阿里云百炼 · 通义万相（图像编辑）"
    override val defaultBaseUrl = "https://dashscope.aliyuncs.com"
    override val defaultModel = "wanx2.1-imageedit"
    override val keyHint = "百炼控制台的 API Key，形如 sk-xxxx"
    override val modelHint = "wanx2.1-imageedit"
    override val applyUrl = "https://bailian.console.aliyun.com/"
    /** 文档：prompt 最长 800 个字符，超出自动截断 */
    override val promptLimit = 800

    private const val TAG = "万相"

    override suspend fun generate(config: ImageGenConfig, request: ImageGenRequest): ImageGenOutcome =
        withContext(Dispatchers.IO) {
            val base = config.baseUrl.trimEnd('/')
            try {
                val payload = mapOf(
                    "model" to config.model,
                    "input" to mapOf(
                        // description_edit = 指令编辑，官方推荐用于「通过指令修改图像内容」
                        "function" to "description_edit",
                        "prompt" to request.prompt,
                        "base_image_url" to request.dataUri
                    ),
                    "parameters" to mapOf("n" to 1)
                )
                val bodyJson = gson.toJson(payload)
                ImageGenHttp.log(TAG, "创建任务 model=${config.model} promptLen=${request.prompt.length} imgKB=${request.sourceImageBase64.length / 1024}")
                // 把实际发出去的请求体记进日志（图片那一大坨 base64 截断），
                // 第一次配 key 时如果报参数错误，对照官方文档一眼就能看出差在哪。
                ImageGenHttp.log(TAG, "请求体: " + bodyJson
                    .replace(Regex("(base64,)[A-Za-z0-9+/=]{40,}"), "$1<...base64省略...>")
                    .take(900))

                val createReq = Request.Builder()
                    .url("$base/api/v1/services/aigc/image2image/image-synthesis")
                    .addHeader("Authorization", "Bearer ${config.apiKey}")
                    .addHeader("Content-Type", "application/json")
                    // 官方要求：本接口只支持异步，必须显式开启
                    .addHeader("X-DashScope-Async", "enable")
                    .post(ImageGenHttp.jsonBody(bodyJson))
                    .build()

                val createResp = ImageGenHttp.client.newCall(createReq).execute()
                val createText = createResp.body?.string().orEmpty()
                if (!createResp.isSuccessful) {
                    ImageGenHttp.log(TAG, "创建任务失败 HTTP ${createResp.code}: ${createText.take(300)}")
                    return@withContext ImageGenOutcome.Failure("创建任务失败", createResp.code, createText)
                }

                val taskId = try {
                    gson.fromJson(createText, JsonObject::class.java)
                        ?.getAsJsonObject("output")?.get("task_id")?.asString
                } catch (_: Exception) { null }

                if (taskId.isNullOrBlank()) {
                    return@withContext ImageGenOutcome.Failure("创建任务成功但没拿到 task_id", createResp.code, createText)
                }
                ImageGenHttp.log(TAG, "任务已创建 task_id=$taskId，开始轮询")

                // ---- 轮询任务结果 ----
                val deadline = System.currentTimeMillis() + 5 * 60 * 1000L
                while (System.currentTimeMillis() < deadline) {
                    delay(2500)
                    val q = Request.Builder()
                        .url("$base/api/v1/tasks/$taskId")
                        .addHeader("Authorization", "Bearer ${config.apiKey}")
                        .get().build()
                    val qr = ImageGenHttp.client.newCall(q).execute()
                    val qt = qr.body?.string().orEmpty()
                    if (!qr.isSuccessful) {
                        ImageGenHttp.log(TAG, "查询失败 HTTP ${qr.code}: ${qt.take(200)}")
                        return@withContext ImageGenOutcome.Failure("查询任务失败", qr.code, qt)
                    }
                    val out = try { gson.fromJson(qt, JsonObject::class.java)?.getAsJsonObject("output") } catch (_: Exception) { null }
                    val status = out?.get("task_status")?.asString ?: "UNKNOWN"
                    when (status) {
                        "SUCCEEDED" -> {
                            val url = try {
                                out?.getAsJsonArray("results")?.firstOrNull()
                                    ?.asJsonObject?.get("url")?.asString
                            } catch (_: Exception) { null }
                            ImageGenHttp.log(TAG, "任务成功，结果 URL=${url?.take(80)}")
                            return@withContext if (url.isNullOrBlank()) {
                                ImageGenOutcome.Failure("任务成功但结果里没有图片 URL", null, qt)
                            } else downloadAsBase64(url)
                        }
                        "FAILED", "CANCELED", "UNKNOWN" -> {
                            val code = try { gson.fromJson(qt, JsonObject::class.java)?.get("code")?.asString } catch (_: Exception) { null }
                            val msg = try { gson.fromJson(qt, JsonObject::class.java)?.get("message")?.asString } catch (_: Exception) { null }
                            ImageGenHttp.log(TAG, "任务$status code=$code msg=$msg")
                            return@withContext ImageGenOutcome.Failure("任务$status: ${msg ?: code ?: "未知原因"}", null, qt)
                        }
                        else -> { /* PENDING / RUNNING 继续等 */ }
                    }
                }
                ImageGenOutcome.Failure("等待超时（5 分钟）")
            } catch (e: Exception) {
                ImageGenHttp.log(TAG, "异常: ${e.message}")
                ImageGenOutcome.Failure("请求异常: ${e.message}")
            }
        }
}

// =====================================================================
// 火山引擎方舟 · 豆包 SeedEdit 3.0（图生图）
// 端点: POST {base}/api/v3/images/generations
// =====================================================================
object SeedEditProvider : ImageGenProvider {
    override val id = "seededit"
    override val displayName = "火山引擎方舟 · 豆包 SeedEdit（图生图）"
    override val defaultBaseUrl = "https://ark.cn-beijing.volces.com"
    override val defaultModel = "doubao-seededit-3-0-i2i-250628"
    override val keyHint = "火山方舟控制台的 API Key"
    override val modelHint = "doubao-seededit-3-0-i2i-250628（或你在方舟上创建的推理接入点 ID）"
    override val applyUrl = "https://console.volcengine.com/ark"
    override val promptLimit = 0

    private const val TAG = "SeedEdit"

    override suspend fun generate(config: ImageGenConfig, request: ImageGenRequest): ImageGenOutcome =
        withContext(Dispatchers.IO) {
            val base = config.baseUrl.trimEnd('/')
            try {
                val payload = mapOf(
                    "model" to config.model,
                    "prompt" to request.prompt,
                    // 方舟的 image 字段接受 URL 或 data URI
                    "image" to request.dataUri,
                    "response_format" to "b64_json",
                    // SeedEdit 的尺寸用 adaptive（跟随输入图比例），图标是正方形正好
                    "size" to "adaptive",
                    "watermark" to false
                )
                val bodyJson = gson.toJson(payload)
                ImageGenHttp.log(TAG, "生成 model=${config.model} promptLen=${request.prompt.length}")

                val req = Request.Builder()
                    .url("$base/api/v3/images/generations")
                    .addHeader("Authorization", "Bearer ${config.apiKey}")
                    .addHeader("Content-Type", "application/json")
                    .post(ImageGenHttp.jsonBody(bodyJson))
                    .build()

                val resp = ImageGenHttp.client.newCall(req).execute()
                val text = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) {
                    ImageGenHttp.log(TAG, "HTTP ${resp.code}: ${text.take(300)}")
                    return@withContext ImageGenOutcome.Failure("生成失败", resp.code, text)
                }
                val root = try { gson.fromJson(text, JsonObject::class.java) } catch (_: Exception) { null }
                val first = try { root?.getAsJsonArray("data")?.firstOrNull()?.asJsonObject } catch (_: Exception) { null }
                val b64 = try { first?.get("b64_json")?.asString } catch (_: Exception) { null }
                if (!b64.isNullOrBlank()) return@withContext ImageGenOutcome.Success(b64)
                val url = try { first?.get("url")?.asString } catch (_: Exception) { null }
                if (!url.isNullOrBlank()) return@withContext downloadAsBase64(url)
                ImageGenOutcome.Failure("响应里没有图片数据", resp.code, text)
            } catch (e: Exception) {
                ImageGenHttp.log(TAG, "异常: ${e.message}")
                ImageGenOutcome.Failure("请求异常: ${e.message}")
            }
        }
}

// =====================================================================
// Google Gemini 图像模型（gemini-2.5-flash-image，俗称 nano banana）
// 端点: POST {base}/v1beta/models/{model}:generateContent?key=API_KEY
// =====================================================================
object GeminiImageProvider : ImageGenProvider {
    override val id = "gemini"
    override val displayName = "Google Gemini 图像模型"
    override val defaultBaseUrl = "https://generativelanguage.googleapis.com"
    override val defaultModel = "gemini-2.5-flash-image"
    override val keyHint = "Google AI Studio 的 API Key"
    override val modelHint = "gemini-2.5-flash-image"
    override val applyUrl = "https://aistudio.google.com/apikey"
    override val promptLimit = 0
    /** Gemini 的 contents.parts 可以放多张图，所以能同时收原图标和风格参考图 */
    override val maxReferenceImages = 2

    private const val TAG = "Gemini"

    override suspend fun generate(config: ImageGenConfig, request: ImageGenRequest): ImageGenOutcome =
        withContext(Dispatchers.IO) {
            val base = config.baseUrl.trimEnd('/')
            try {
                // 先把原图标放进去；如果用户另外给了风格参考图，再追加一张。
                // 顺序上文字在前，然后依次是「原图标」「风格参考图」——
                // 提示词里已经说明了这两张图各自的角色。
                val inputParts = mutableListOf<Map<String, Any>>()
                inputParts.add(mapOf("text" to request.prompt))
                inputParts.add(
                    mapOf(
                        "inline_data" to mapOf(
                            "mime_type" to request.sourceMimeType,
                            "data" to request.sourceImageBase64
                        )
                    )
                )
                request.styleImageBase64?.let { styleB64 ->
                    inputParts.add(
                        mapOf(
                            "inline_data" to mapOf(
                                "mime_type" to request.sourceMimeType,
                                "data" to styleB64
                            )
                        )
                    )
                    ImageGenHttp.log(TAG, "附带风格参考图 ${styleB64.length / 1024} KB")
                }
                val payload = mapOf("contents" to listOf(mapOf("parts" to inputParts)))
                val bodyJson = gson.toJson(payload)
                ImageGenHttp.log(TAG, "生成 model=${config.model}，输入图 ${inputParts.size - 1} 张")

                val req = Request.Builder()
                    .url("$base/v1beta/models/${config.model}:generateContent")
                    .addHeader("x-goog-api-key", config.apiKey)
                    .addHeader("Content-Type", "application/json")
                    .post(ImageGenHttp.jsonBody(bodyJson))
                    .build()

                val resp = ImageGenHttp.client.newCall(req).execute()
                val text = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) {
                    ImageGenHttp.log(TAG, "HTTP ${resp.code}: ${text.take(300)}")
                    return@withContext ImageGenOutcome.Failure("生成失败", resp.code, text)
                }
                val root = try { gson.fromJson(text, JsonObject::class.java) } catch (_: Exception) { null }
                val parts = try {
                    root?.getAsJsonArray("candidates")?.firstOrNull()
                        ?.asJsonObject?.getAsJsonObject("content")
                        ?.getAsJsonArray("parts")
                } catch (_: Exception) { null }
                if (parts != null) {
                    for (p in parts) {
                        val inline = try { p.asJsonObject.getAsJsonObject("inlineData") } catch (_: Exception) { null }
                        val data = try { inline?.get("data")?.asString } catch (_: Exception) { null }
                        if (!data.isNullOrBlank()) return@withContext ImageGenOutcome.Success(data)
                    }
                }
                ImageGenOutcome.Failure("响应里没有图片数据（可能被安全策略拦截）", resp.code, text)
            } catch (e: Exception) {
                ImageGenHttp.log(TAG, "异常: ${e.message}")
                ImageGenOutcome.Failure("请求异常: ${e.message}")
            }
        }
}

// =====================================================================
// OpenAI gpt-image-1（图生图 / 图像编辑）
// 端点: POST {base}/v1/images/edits  （multipart/form-data）
// =====================================================================
object OpenAiImageProvider : ImageGenProvider {
    override val id = "openai"
    override val displayName = "OpenAI gpt-image-1"
    override val defaultBaseUrl = "https://api.openai.com"
    override val defaultModel = "gpt-image-1"
    override val keyHint = "OpenAI 的 API Key，形如 sk-..."
    override val modelHint = "gpt-image-1"
    override val applyUrl = "https://platform.openai.com/api-keys"
    override val promptLimit = 32000
    /** /v1/images/edits 支持 image[] 传多张输入图 */
    override val maxReferenceImages = 2

    private const val TAG = "OpenAI"

    override suspend fun generate(config: ImageGenConfig, request: ImageGenRequest): ImageGenOutcome =
        withContext(Dispatchers.IO) {
            val base = config.baseUrl.trimEnd('/')
            try {
                val imageBytes = Base64.decode(request.sourceImageBase64, Base64.DEFAULT)
                val styleBytes = request.styleImageBase64?.let { Base64.decode(it, Base64.DEFAULT) }
                val builder = MultipartBody.Builder().setType(MultipartBody.FORM)
                    .addFormDataPart("model", config.model)
                    .addFormDataPart("prompt", request.prompt)
                    .addFormDataPart("n", "1")
                    .addFormDataPart("size", "1024x1024")
                // 传两张图时必须用 image[] 这个数组字段；只有一张时用 image 即可
                if (styleBytes != null) {
                    builder.addFormDataPart("image[]", "icon.png", imageBytes.toRequestBody("image/png".toMediaType()))
                    builder.addFormDataPart("image[]", "style.png", styleBytes.toRequestBody("image/png".toMediaType()))
                } else {
                    builder.addFormDataPart("image", "icon.png", imageBytes.toRequestBody("image/png".toMediaType()))
                }
                val multipart = builder.build()

                ImageGenHttp.log(
                    TAG,
                    "生成 model=${config.model} imgKB=${imageBytes.size / 1024}" +
                        (if (styleBytes != null) " + 风格参考图 ${styleBytes.size / 1024} KB" else "")
                )

                val req = Request.Builder()
                    .url("$base/v1/images/edits")
                    .addHeader("Authorization", "Bearer ${config.apiKey}")
                    .post(multipart)
                    .build()

                val resp = ImageGenHttp.client.newCall(req).execute()
                val text = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) {
                    ImageGenHttp.log(TAG, "HTTP ${resp.code}: ${text.take(300)}")
                    return@withContext ImageGenOutcome.Failure("生成失败", resp.code, text)
                }
                val root = try { gson.fromJson(text, JsonObject::class.java) } catch (_: Exception) { null }
                val first = try { root?.getAsJsonArray("data")?.firstOrNull()?.asJsonObject } catch (_: Exception) { null }
                val b64 = try { first?.get("b64_json")?.asString } catch (_: Exception) { null }
                if (!b64.isNullOrBlank()) return@withContext ImageGenOutcome.Success(b64)
                val url = try { first?.get("url")?.asString } catch (_: Exception) { null }
                if (!url.isNullOrBlank()) return@withContext downloadAsBase64(url)
                ImageGenOutcome.Failure("响应里没有图片数据", resp.code, text)
            } catch (e: Exception) {
                ImageGenHttp.log(TAG, "异常: ${e.message}")
                ImageGenOutcome.Failure("请求异常: ${e.message}")
            }
        }
}
