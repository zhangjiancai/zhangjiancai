package com.appanalyzer.service.localmodel

/**
 * 一个可下载的端侧模型。
 *
 * 全部来自**魔搭 ModelScope**。实测这台机器上 huggingface.co、github.com、dl.google.com
 * 都不可达（SSL 建连失败），只有 modelscope.cn / gitee.com 能连 —— URL 写到别处功能直接不可用。
 *
 * 下载走 `/api/v1/models/{ns}/{name}/repo?Revision=master&FilePath=...` 这种形式，
 * 因为它的响应带 Content-Length，能做出真实的进度条；
 * 而 `/models/{ns}/{name}/resolve/master/...` 是 302 到 OSS 的 chunked 响应，拿不到总大小。
 */
data class ModelSpec(
    val id: String,
    val name: String,
    val description: String,
    val url: String,
    val fileName: String,
    /** 预期字节数，下载完用来校验完整性 */
    val sizeBytes: Long,
    val task: Task,
    /** 抠图模型：正方形输入边长；超分模型：输入需为 64 的倍数，这里存 0 表示按原图 */
    val inputSize: Int = 0,
    val mean: FloatArray = floatArrayOf(0.5f, 0.5f, 0.5f),
    val std: FloatArray = floatArrayOf(0.5f, 0.5f, 0.5f),
    val scale: Int = 1,
    val license: String = ""
) {
    enum class Task(val label: String) {
        MATTING("抠图/去背景"),
        SUPER_RES("超分辨率放大")
    }

    /** 数组属性手写 equals/hashCode，data class 对数组只比引用 */
    override fun equals(other: Any?) = other is ModelSpec && other.id == id
    override fun hashCode() = id.hashCode()
}

/**
 * 内置模型清单。**下载 URL 与文件大小全部实测过**（HTTP 200 + 字节数一致 + SHA256 对齐）。
 *
 * 关于端侧能做什么，必须说清楚：
 * 魔搭上**没有**可用的端侧「图生图 / 风格迁移」模型 —— AnimeGAN、CartoonGAN、AdaIN、
 * fast-neural-style 等 30 多个候选逐个试过，全部 404（模型不存在）。
 * 端侧目前现实可做的只有**抠图**和**超分**；要"用文字生成新图标"只能走云端 API 那条路。
 */
object LocalModelCatalog {

    private const val MS = "https://www.modelscope.cn/api/v1/models"
    private fun dl(ns: String, name: String, file: String) = "$MS/$ns/$name/repo?Revision=master&FilePath=$file"

    val all: List<ModelSpec> = listOf(
        ModelSpec(
            id = "modnet_q",
            name = "MODNet 量化版 · 轻量抠图",
            description = "6.3 MB，最小巧的抠图模型。原本面向人像视频抠图，用在图标上属于「能用但一般」，" +
                "适合先拿来试通流程或省流量。",
            url = dl("Xenova", "modnet", "onnx/model_quantized.onnx"),
            fileName = "modnet_quantized.onnx",
            sizeBytes = 6_632_188L,
            task = ModelSpec.Task.MATTING,
            inputSize = 512,
            mean = floatArrayOf(0.5f, 0.5f, 0.5f),
            std = floatArrayOf(0.5f, 0.5f, 0.5f),
            license = "Apache-2.0"
        ),
        ModelSpec(
            id = "rmbg14",
            name = "RMBG-1.4 · 高质量抠图",
            description = "42.3 MB，抠图效果目前最好的一档。输入固定 1024x1024，手机上会慢一些。",
            url = dl("AI-ModelScope", "RMBG-1.4", "onnx/model_quantized.onnx"),
            fileName = "rmbg14_quantized.onnx",
            sizeBytes = 44_403_226L,
            task = ModelSpec.Task.MATTING,
            inputSize = 1024,
            mean = floatArrayOf(0.5f, 0.5f, 0.5f),
            std = floatArrayOf(1.0f, 1.0f, 1.0f),
            // 许可证是 Bria 的「非商用」条款，个人用没问题，商用需要自己确认
            license = "Bria RMBG-1.4（非商用，商用请自行确认授权）"
        ),
        ModelSpec(
            id = "u2net",
            name = "U2Net · 通用显著性抠图",
            description = "167.8 MB，最通用的「显著主体」检测模型，对非人像的图标主体更合适。" +
                "文件很大，建议 Wi-Fi 下下载。",
            url = dl("AI-ModelScope", "U2Net", "u2net.onnx"),
            fileName = "u2net.onnx",
            sizeBytes = 175_997_641L,
            task = ModelSpec.Task.MATTING,
            inputSize = 320,
            mean = floatArrayOf(0.485f, 0.456f, 0.406f),
            std = floatArrayOf(0.229f, 0.224f, 0.225f),
            license = "Apache-2.0"
        ),
        ModelSpec(
            id = "swin2sr_x2",
            name = "Swin2SR · 图标放大 2 倍",
            description = "20.5 MB，把低分辨率图标放大 2 倍并补细节。输入边长必须是 64 的倍数。",
            url = dl("Xenova", "swin2SR-classical-sr-x2-64", "onnx/model_quantized.onnx"),
            fileName = "swin2sr_x2.onnx",
            sizeBytes = 21_471_413L,
            task = ModelSpec.Task.SUPER_RES,
            inputSize = 256,
            mean = floatArrayOf(0.5f, 0.5f, 0.5f),
            std = floatArrayOf(0.5f, 0.5f, 0.5f),
            scale = 2,
            license = "Apache-2.0（上游 caidas/swin2SR）"
        )
    )

    fun byId(id: String): ModelSpec? = all.find { it.id == id }
    fun ofTask(task: ModelSpec.Task): List<ModelSpec> = all.filter { it.task == task }
    val defaultMattingId: String get() = "u2net"
}
