package com.appanalyzer.service

import com.appanalyzer.data.model.AiClassifyResult
import com.appanalyzer.data.model.DeepSeekRequest
import com.appanalyzer.data.model.DeepSeekResponse
import com.appanalyzer.data.model.Message
import com.google.gson.Gson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

class DeepSeekService(
    private val prefsManager: PreferencesManager,
    /**
     * 可选的一次性密钥覆盖，仅用于「设置」页的连通性测试。
     *
     * 以前测试连接的做法是 new 一个 PreferencesManager 并直接 setApiKey()，
     * 也就是**点一下「测试连接」就把密钥写进了本机存储**——用户再点「取消」也收不回来。
     * 现在测试用的密钥只存在于这个字段里，不落盘。
     */
    private val keyOverride: String? = null
) {

    private val baseUrl = "https://api.deepseek.com/v1/chat/completions"
    private val gson = Gson()
    private val client = OkHttpClient.Builder().connectTimeout(30, TimeUnit.SECONDS).readTimeout(120, TimeUnit.SECONDS).writeTimeout(30, TimeUnit.SECONDS).build()

    private fun resolveKey(): String =
        keyOverride?.takeIf { it.isNotBlank() } ?: prefsManager.getApiKey()

    fun hasApiKey(): Boolean = resolveKey().isNotBlank()

    suspend fun testConnection(): Result<String> = withContext(Dispatchers.IO) {
        try {
            DebugLogger.d("═══ DeepSeek 连通性测试 ═══")
            val r = DeepSeekRequest(messages = listOf(Message("user", "回复OK")), max_tokens = 10)
            val c = callApi(r).choices.firstOrNull()?.message?.content ?: "无响应"
            DebugLogger.d("✅ 连通: $c")
            Result.success(c.trim())
        } catch (e: Exception) { DebugLogger.e("❌ 测试失败: ${e.message}", e); Result.failure(e) }
    }

    // ============== 拟物化图标描述 ==============

    /**
     * 把一个应用名扩写成一段**详细的拟物化图标描述**，直接可以喂给生图模型。
     *
     * 为什么需要这一步：生图模型（万相 / SeedEdit / Gemini / gpt-image-1）对
     * 「把微信图标做成拟物化」这种一句话的理解非常泛，出来的东西千篇一律。
     * 先让 DeepSeek 把「拟物化」拆成具体的材质、光源、透视、配色、背景，
     * 再交给生图模型，出图质量差别很大。
     *
     * 提示词里刻意要求它只输出描述本身、不要解释、不要 markdown —— 输出会被
     * 直接当作生图提示词使用，带上「好的，以下是……」这类废话会污染结果。
     *
     * @param appName   应用名（如「微信」）
     * @param category  应用分类（如「社交」），可为空
     * @param extraHint 用户额外要求，可为空
     */
    suspend fun generateSkeuoPrompt(
        appName: String,
        category: String = "",
        extraHint: String = ""
    ): Result<String> = withContext(Dispatchers.IO) {
        try {
            val sysPrompt = "你是资深拟物化（skeuomorphism）图标设计师，擅长把抽象概念转化为" +
                "可以交给图像生成模型执行的、极其具体的视觉描述。"

            val userPrompt = buildString {
                append("为「").append(appName).append("」这个应用设计一枚**拟物化风格**的图标。\n")
                if (category.isNotBlank()) append("它的分类是：").append(category).append("\n")
                if (extraHint.isNotBlank()) append("额外要求：").append(extraHint).append("\n")
                append("\n")
                append("请输出一段中文描述，必须具体到可以直接生成图像：\n")
                append("1. 主体造型：图标中央是什么具体物件，什么形态，什么角度（正视/俯视/45度）\n")
                append("2. 材质与质感：金属 / 玻璃 / 皮革 / 木材 / 陶瓷 / 亚克力，表面是拉丝、磨砂还是高光\n")
                append("3. 光影：光源方向、高光位置、投影与内阴影、环境反射\n")
                append("4. 配色：主色、辅助色，给出具体色相描述\n")
                append("5. 背景与底托：圆角矩形底板的材质、厚度、边缘处理\n")
                append("6. 细节装饰：缝线、螺钉、刻度、纹理等能体现真实感的细节\n")
                append("\n")
                append("要求：\n")
                append("- 控制在 150~250 字\n")
                append("- **只输出这段描述本身**，不要任何开场白、不要解释、不要 markdown 标记\n")
                append("- 不要出现抽象词，全部写成看得见的东西\n")
            }

            DebugLogger.d("┌─ [拟物化描述] 请求 DeepSeek：" + appName)
            val request = DeepSeekRequest(
                messages = listOf(Message("system", sysPrompt), Message("user", userPrompt)),
                temperature = 0.8,
                max_tokens = 600
            )
            val content = callApi(request).choices.firstOrNull()?.message?.content
                ?: return@withContext Result.failure(Exception("DeepSeek 没有返回内容"))

            // 清掉模型偶尔带上的 markdown 围栏与多余空行
            val cleaned = content
                .replace(Regex("^" + "`" + "`" + "`" + "[a-zA-Z]*\\s*"), "")
                .replace(Regex("\\s*" + "`" + "`" + "`" + "$"), "")
                .lines()
                .map { it.trim() }
                .filter { it.isNotBlank() }
                .joinToString("\n")
                .trim()

            DebugLogger.d("│ 📥 返回 " + cleaned.length + " 字")
            DebugLogger.d("└─────────────────────────────────────")
            if (cleaned.isBlank()) Result.failure(Exception("DeepSeek 返回了空描述"))
            else Result.success(cleaned)
        } catch (e: Exception) {
            DebugLogger.e("❌ 拟物化描述生成失败: " + e.message, e)
            Result.failure(e)
        }
    }

    // ============== 两步分类流程 ==============

    suspend fun classifyWithCustomTags(appNames: List<String>): Result<List<AiClassifyResult>> = withContext(Dispatchers.IO) {
        try {
            DebugLogger.d("═══════════════════════════════════════")
            DebugLogger.d("🤖 AI自定义分类: ${appNames.size}个应用")

            // Step 1: AI定义标签
            val categories = suggestCategories(appNames)
            val finalCats = if (categories.size >= 2) categories else
                listOf("社交", "视频", "游戏", "购物", "办公", "音乐", "工具", "系统", "其他")
            DebugLogger.d("📋 最终标签(${finalCats.size}个): ${finalCats.joinToString(", ")}")

            // Step 2: 批量分类
            // 去重：同名应用在 AI 眼里无法区分，重复发送只会浪费 token，
            // 也会让「已分类数量」这个统计口径变得含糊。
            val uniqueNames = appNames.distinct()
            if (uniqueNames.size != appNames.size) {
                DebugLogger.d("ℹ️ 应用名去重: ${appNames.size} 个应用 → ${uniqueNames.size} 个不重名")
            }
            val allResults = mutableListOf<AiClassifyResult>()
            val batchSize = 50
            for (i in uniqueNames.indices step batchSize) {
                val batch = uniqueNames.subList(i, minOf(i + batchSize, uniqueNames.size))
                DebugLogger.d("── 批次 ${i/batchSize + 1}: ${batch.size}个 ──")
                allResults.addAll(classifyWithTags(batch, finalCats))
            }
            DebugLogger.d("🏁 分类完成: ${allResults.size}/${uniqueNames.size}(不重名应用)")
            Result.success(allResults)
        } catch (e: Exception) { DebugLogger.e("❌ 异常: ${e.message}", e); Result.failure(e) }
    }

    /** Step 1: AI分析应用名，自定义分类标签 */
    private suspend fun suggestCategories(appNames: List<String>): List<String> {
        val sample = if (appNames.size > 200) appNames.take(200) else appNames
        val namesStr = sample.joinToString(", ")

        val sysPrompt = "你是Android应用分类专家。根据应用名称定义分类标签。"
        val prompt = "分析这些应用名称，根据类型、功能、用途，创建合理的分类标签体系。\n$namesStr\n\n要求：\n1. 输出10-20个标签\n2. 用逗号分隔\n3. 只输出标签，不要解释\n\n标签示例：社交通讯, 影音娱乐, 购物消费, 办公效率, 系统工具, 学习教育, 其他"

        DebugLogger.d("┌─ [Step1] 请求AI定义分类标签 ────────")
        DebugLogger.d("│ 样本: ${sample.size}个应用名")
        DebugLogger.d("│ System: $sysPrompt")
        DebugLogger.d("│ Prompt: ${prompt.take(500)}")

        val request = DeepSeekRequest(messages = listOf(Message("system", sysPrompt), Message("user", prompt)), temperature = 0.3, max_tokens = 300)
        val content = callApi(request).choices.firstOrNull()?.message?.content ?: return emptyList()

        DebugLogger.d("│ 📥 AI返回标签: $content")
        DebugLogger.d("└─────────────────────────────────────")

        val tags = content.replace("\n", ",").split(",", "，", "、")
            .map { it.trim().replace(Regex("[^\\u4e00-\\u9fa5a-zA-Z0-9]"), "") }
            .filter { it.length in 2..12 && it !in listOf("分类", "标签", "应用") }
            .distinct().take(20)
        if (tags.size < 2) {
            val lines = content.lines().map { it.trim() }.filter { it.length in 2..12 }
            if (lines.size >= 2) return lines.take(20)
        }
        DebugLogger.d("📋 解析出${tags.size}个标签: ${tags.joinToString(",")}")
        return tags
    }

    /** Step 2: 用标签分类 */
    private suspend fun classifyWithTags(appNames: List<String>, categories: List<String>): List<AiClassifyResult> {
        val namesStr = appNames.joinToString(", ")
        val catsStr = categories.joinToString(", ")
        val sysPrompt = "你根据应用名称选择标签。只输出 名称|标签 格式。无法判断填[其他]。"
        val prompt = "标签: $catsStr\n应用: $namesStr\n格式每行: 名称|标签"

        DebugLogger.d("│ 📤 [Step2] 分类: ${appNames.size}个, 标签: $catsStr")

        val request = DeepSeekRequest(messages = listOf(Message("system", sysPrompt), Message("user", prompt)), temperature = 0.1, max_tokens = 4096)
        val content = callApi(request).choices.firstOrNull()?.message?.content ?: return emptyList()

        DebugLogger.d("│ 📥 [Step2] 响应(${content.length}字): ${content.take(2000)}")
        return parseResults(content, appNames.toSet(), categories.toSet())
    }

    // ============== 解析 ==============

    private fun parseResults(response: String, knownNames: Set<String>, validCats: Set<String>): List<AiClassifyResult> {
        val results = mutableListOf<AiClassifyResult>()
        val matched = mutableSetOf<String>()
        val allCats = validCats + "其他"

        response.lines().forEach { line ->
            val t = line.trim(); if (t.isEmpty() || !t.contains("|")) return@forEach
            val parts = t.split("|").map { it.trim() }; if (parts.size < 2) return@forEach
            val name = parts[0]; if (name !in knownNames) { DebugLogger.w("⚠️ 跳过: $name"); return@forEach }
            val cat = parts[1]
            matched.add(name)
            results.add(AiClassifyResult(appName = name, category = if (cat in allCats) cat else "其他", confidence = "中"))
        }
        val unmatched = knownNames - matched
        DebugLogger.d("│ 解析: 匹配${results.size}, 未匹配${unmatched.size}")
        if (unmatched.isNotEmpty()) DebugLogger.w("│ 未匹配: ${unmatched.take(15).joinToString()}")
        return results
    }

    // ============== API调用 ==============

    private suspend fun callApi(request: DeepSeekRequest): DeepSeekResponse {
        val key = resolveKey(); if (key.isBlank()) throw Exception("未配置API Key")
        val start = System.currentTimeMillis()
        val json = gson.toJson(request)
        val http = Request.Builder().url(baseUrl).addHeader("Authorization", "Bearer $key").addHeader("Content-Type", "application/json").post(json.toRequestBody("application/json".toMediaType())).build()
        val r = client.newCall(http).execute()
        val elapsed = System.currentTimeMillis() - start
        val body = r.body?.string() ?: throw Exception("Empty")
        DebugLogger.d("⏱ HTTP ${r.code}, ${elapsed}ms, ${body.length}B")
        if (!r.isSuccessful) {
            val err = try { gson.fromJson(body, DeepSeekResponse::class.java).error?.message } catch (_: Exception) { "HTTP ${r.code}" }
            throw Exception(err ?: "HTTP ${r.code}")
        }
        return gson.fromJson(body, DeepSeekResponse::class.java)
    }
}

