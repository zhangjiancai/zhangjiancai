package com.appanalyzer.data.model

/**
 * DeepSeek API 请求/响应模型
 */
data class DeepSeekRequest(
    val model: String = "deepseek-chat",
    val messages: List<Message>,
    val temperature: Double = 0.3,
    val max_tokens: Int = 2048
)

data class Message(
    val role: String,
    val content: String
)

data class DeepSeekResponse(
    val id: String? = null,
    val choices: List<Choice> = emptyList(),
    val error: DeepSeekError? = null
)

data class Choice(
    val index: Int = 0,
    val message: Message? = null
)

data class DeepSeekError(
    val message: String? = null,
    val type: String? = null
)

/**
 * AI 分类结果。
 *
 * 注意 [appName] 是**应用的显示名**，不是包名：AI 只拿到应用名（包名既不
 * 可读也浪费 token），所以同名应用会共享同一个分类。
 * 这个字段曾经被命名为 packageName，误导性极强，已改名。
 */
data class AiClassifyResult(
    val appName: String,
    val category: String,
    val confidence: String  // "高" / "中" / "低"
)
