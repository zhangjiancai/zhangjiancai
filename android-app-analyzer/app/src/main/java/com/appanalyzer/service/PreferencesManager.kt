package com.appanalyzer.service

import android.content.Context
import android.content.SharedPreferences
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import java.security.MessageDigest

class PreferencesManager(context: Context) {

    private val prefs: SharedPreferences =
        context.getSharedPreferences("app_analyzer_prefs", Context.MODE_PRIVATE)
    private val gson = Gson()

    companion object {
        const val KEY_DEEPSEEK_API = "deepseek_api_key"
        const val KEY_APP_HASH = "app_list_hash"
        const val KEY_CACHE = "ai_category_cache"

        // ---- 图标生成（图生图）相关 ----
        const val KEY_IMG_PROVIDER = "img_provider_id"
        const val KEY_IMG_FEATURES = "img_extra_features"
        // ---- 本地风格 ----
        /** 四类风格之一：lineart / skeuo / minimal / custom */
        const val KEY_LOCAL_STYLE = "local_style_id"
        /** 极简色块的量化档数 */
        const val KEY_MINIMAL_COLORS = "minimal_color_count"
        /** 自定义风格用的参考图 */
        const val KEY_STYLE_REF = "style_ref_id"
        /** 迁移强度 0..1（原图与风格结果之间的混合比例） */
        const val KEY_STYLE_STRENGTH = "style_strength"
        /** 训练查找表的迭代次数 */
        const val KEY_TRAIN_ITERATIONS = "lut_train_iterations"

        /** 图标页紧凑模式：一行只留图标 + 名称 + 大小 */
        const val KEY_COMPACT_MODE = "compact_mode"

        /** 三级管线：抠图之后先给主体做风格化，再合成 */
        const val KEY_STYLIZE_SUBJECT = "stylize_subject"

        // ---- 抠图之后的合成参数 ----
        const val KEY_COMPOSE_BG = "compose_background"
        const val KEY_COMPOSE_COLOR_TOP = "compose_color_top"
        const val KEY_COMPOSE_COLOR_BOTTOM = "compose_color_bottom"
        const val KEY_COMPOSE_SCALE = "compose_subject_scale"
        const val KEY_COMPOSE_CORNER = "compose_corner_radius"
        const val KEY_COMPOSE_SHADOW = "compose_shadow"
        const val KEY_COMPOSE_SHADOW_ALPHA = "compose_shadow_alpha"
        // ---- 端侧模型 ----
        const val KEY_LOCAL_MODEL = "local_model_id"
        /** 每个服务商各存一份 key / 模型名 / 网关地址，互不干扰 */
        fun keyOf(providerId: String) = "img_key_$providerId"
        fun modelOf(providerId: String) = "img_model_$providerId"
        fun baseUrlOf(providerId: String) = "img_baseurl_$providerId"
    }

    /**
     * 只从本机 SharedPreferences 读取密钥。
     *
     * 以前这里会回退到 BuildConfig.DEEPSEEK_API_KEY —— 也就是把密钥编译进 APK，
     * 任何人反编译即可取走。该回退路径已删除：密钥只能由用户在「设置」页填写。
     */
    fun getApiKey(): String = prefs.getString(KEY_DEEPSEEK_API, null)?.trim().orEmpty()

    fun setApiKey(key: String) { prefs.edit().putString(KEY_DEEPSEEK_API, key.trim()).apply() }
    fun hasApiKey(): Boolean = getApiKey().isNotBlank()

    // ============== AI 分类缓存 ==============

    /** 计算应用列表Hash（用于判断是否有变化） */
    fun computeAppHash(packageNames: List<String>): String {
        val sorted = packageNames.sorted().joinToString(",")
        val md = MessageDigest.getInstance("MD5")
        return md.digest(sorted.toByteArray()).joinToString("") { "%02x".format(it) }
    }

    /** 获取上次缓存的Hash */
    fun getCachedHash(): String = prefs.getString(KEY_APP_HASH, "") ?: ""

    /** 保存Hash */
    fun saveHash(hash: String) { prefs.edit().putString(KEY_APP_HASH, hash).apply() }

    /** 读取缓存的分类结果: Map<应用名, 分类> */
    fun getCachedCategories(): Map<String, String> {
        val json = prefs.getString(KEY_CACHE, null) ?: return emptyMap()
        return try {
            val type = object : TypeToken<Map<String, String>>() {}.type
            gson.fromJson(json, type) ?: emptyMap()
        } catch (e: Exception) { emptyMap() }
    }

    /** 保存分类结果 */
    fun saveCategories(categories: Map<String, String>) {
        prefs.edit().putString(KEY_CACHE, gson.toJson(categories)).apply()
    }

    /** 清除缓存 */
    fun clearCache() { prefs.edit().remove(KEY_APP_HASH).remove(KEY_CACHE).apply() }

    // ============== 图标生成（图生图）设置 ==============

    /**
     * 当前选中的生图引擎 id。
     * 默认是本地算法绘制 —— 没配任何 key 时也能用，且不会偷偷联网。
     */
    fun getImageProviderId(): String =
        prefs.getString(KEY_IMG_PROVIDER, com.appanalyzer.service.imagegen.ImageGenProviders.LOCAL_ID)
            ?: com.appanalyzer.service.imagegen.ImageGenProviders.LOCAL_ID

    fun setImageProviderId(id: String) { prefs.edit().putString(KEY_IMG_PROVIDER, id).apply() }

    /** 某个服务商的 API Key（各存各的，换服务商不用重新填） */
    fun getImageApiKey(providerId: String): String =
        prefs.getString(keyOf(providerId), null)?.trim().orEmpty()

    fun setImageApiKey(providerId: String, key: String) {
        prefs.edit().putString(keyOf(providerId), key.trim()).apply()
    }

    /** 模型名；没填过就返回空串，由调用方回退到 provider 的默认值 */
    fun getImageModel(providerId: String): String =
        prefs.getString(modelOf(providerId), null)?.trim().orEmpty()

    fun setImageModel(providerId: String, model: String) {
        prefs.edit().putString(modelOf(providerId), model.trim()).apply()
    }

    /** 自定义网关地址；留空则用 provider 默认地址 */
    fun getImageBaseUrl(providerId: String): String =
        prefs.getString(baseUrlOf(providerId), null)?.trim().orEmpty()

    fun setImageBaseUrl(providerId: String, url: String) {
        prefs.edit().putString(baseUrlOf(providerId), url.trim()).apply()
    }

    /** 用户自定义的图标特征描述，会拼进提示词 */
    fun getImageFeatures(): String = prefs.getString(KEY_IMG_FEATURES, null)?.trim().orEmpty()
    fun setImageFeatures(text: String) { prefs.edit().putString(KEY_IMG_FEATURES, text.trim()).apply() }

    // ============== 本地风格 ==============

    /** 四类风格中的哪一类，默认「白线勾勒」 */
    fun getLocalStyleId(): String = prefs.getString(KEY_LOCAL_STYLE, null)?.trim().orEmpty()
        .ifBlank { com.appanalyzer.service.image.LocalStyle.LINE_ART.id }

    fun setLocalStyleId(id: String) { prefs.edit().putString(KEY_LOCAL_STYLE, id.trim()).apply() }

    /** 极简色块量化成几种颜色，默认 4 */
    fun getMinimalColors(): Int = prefs.getInt(KEY_MINIMAL_COLORS, 4).coerceIn(2, 8)
    fun setMinimalColors(n: Int) { prefs.edit().putInt(KEY_MINIMAL_COLORS, n.coerceIn(2, 8)).apply() }

    /** 选中的风格参考图 id（自定义风格用）。空串表示还没选，由 StyleLibrary 回退到内置图。 */
    fun getStyleRefId(): String = prefs.getString(KEY_STYLE_REF, null)?.trim().orEmpty()
    fun setStyleRefId(id: String) { prefs.edit().putString(KEY_STYLE_REF, id.trim()).apply() }

    /** 强度 0..1，默认 0.9（留一点原图的味道） */
    fun getStyleStrength(): Float = prefs.getFloat(KEY_STYLE_STRENGTH, 0.9f)
    fun setStyleStrength(v: Float) { prefs.edit().putFloat(KEY_STYLE_STRENGTH, v.coerceIn(0f, 1f)).apply() }

    /** 本地训练的迭代次数，默认 400（手机上约 1~2 秒） */
    fun getTrainIterations(): Int = prefs.getInt(KEY_TRAIN_ITERATIONS, 400).coerceIn(50, 2000)
    fun setTrainIterations(n: Int) { prefs.edit().putInt(KEY_TRAIN_ITERATIONS, n.coerceIn(50, 2000)).apply() }

    // ============== 界面偏好 ==============

    fun getCompactMode(): Boolean = prefs.getBoolean(KEY_COMPACT_MODE, false)
    fun setCompactMode(v: Boolean) { prefs.edit().putBoolean(KEY_COMPACT_MODE, v).apply() }

    /**
     * 是否启用三级管线：抠图 -> **主体风格化** -> 合成。
     *
     * 默认关闭。开启后抠出来的主体会先按当前选中的本地风格处理一遍
     * （比如做成白线勾勒、极简色块），再贴到新背景上。
     */
    fun getStylizeSubject(): Boolean = prefs.getBoolean(KEY_STYLIZE_SUBJECT, false)
    fun setStylizeSubject(v: Boolean) { prefs.edit().putBoolean(KEY_STYLIZE_SUBJECT, v).apply() }

    // ============== 抠图后的合成 ==============

    fun getComposeBackground(): String =
        prefs.getString(KEY_COMPOSE_BG, null)?.trim().orEmpty()
            .ifBlank { com.appanalyzer.service.image.IconBackground.SOLID.id }

    fun getComposeColorTop(): Int = prefs.getInt(KEY_COMPOSE_COLOR_TOP, 0xFF2B2B33.toInt())
    fun getComposeColorBottom(): Int = prefs.getInt(KEY_COMPOSE_COLOR_BOTTOM, 0xFF14141A.toInt())
    fun getComposeSubjectScale(): Float = prefs.getFloat(KEY_COMPOSE_SCALE, 0.72f).coerceIn(0.3f, 1f)
    fun getComposeCorner(): Float = prefs.getFloat(KEY_COMPOSE_CORNER, 0.22f).coerceIn(0f, 0.5f)
    fun getComposeShadow(): Boolean = prefs.getBoolean(KEY_COMPOSE_SHADOW, true)
    fun getComposeShadowAlpha(): Float = prefs.getFloat(KEY_COMPOSE_SHADOW_ALPHA, 0.35f).coerceIn(0f, 1f)

    fun saveCompose(spec: com.appanalyzer.service.image.ComposeSpec) {
        prefs.edit()
            .putString(KEY_COMPOSE_BG, spec.background.id)
            .putInt(KEY_COMPOSE_COLOR_TOP, spec.colorTop)
            .putInt(KEY_COMPOSE_COLOR_BOTTOM, spec.colorBottom)
            .putFloat(KEY_COMPOSE_SCALE, spec.subjectScale)
            .putFloat(KEY_COMPOSE_CORNER, spec.cornerRadius)
            .putBoolean(KEY_COMPOSE_SHADOW, spec.shadow)
            .putFloat(KEY_COMPOSE_SHADOW_ALPHA, spec.shadowAlpha)
            .apply()
    }

    // ============== 端侧模型 ==============

    /** 选中的端侧模型 id；空串表示还没选 */
    fun getLocalModelId(): String =
        prefs.getString(KEY_LOCAL_MODEL, null)?.trim().orEmpty()
            .ifBlank { com.appanalyzer.service.localmodel.LocalModelCatalog.defaultMattingId }

    fun setLocalModelId(id: String) { prefs.edit().putString(KEY_LOCAL_MODEL, id.trim()).apply() }
}
