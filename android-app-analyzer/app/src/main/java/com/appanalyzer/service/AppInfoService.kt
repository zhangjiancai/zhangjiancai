package com.appanalyzer.service

import android.app.AppOpsManager
import android.app.usage.StorageStatsManager
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.os.Build
import android.os.Process
import android.os.storage.StorageManager
import android.provider.Settings
import android.util.Base64
import com.appanalyzer.data.model.AiClassifyResult
import com.appanalyzer.data.model.AppInfo
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID
// Log replaced by DebugLogger

class AppInfoService(private val context: Context) {

    private val packageManager: PackageManager = context.packageManager
    private val prefsManager = PreferencesManager(context)
    private val deepSeekService = DeepSeekService(prefsManager)

    fun hasStorageStatsPermission(): Boolean {
        val appOps = context.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
        val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            appOps.unsafeCheckOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                Process.myUid(),
                context.packageName
            )
        } else {
            @Suppress("DEPRECATION")
            appOps.checkOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                Process.myUid(),
                context.packageName
            )
        }
        return mode == AppOpsManager.MODE_ALLOWED
    }

    fun getPermissionSettingsIntent() = Settings.ACTION_USAGE_ACCESS_SETTINGS

    // 一次性查询所有 Launcher 包名，避免每个 App 都单独查询
    private val launcherPackages: Set<String> by lazy {
        try {
            val launcherIntent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
            val resolveInfos = packageManager.queryIntentActivities(launcherIntent, 0)
            resolveInfos.map { it.activityInfo.packageName }.toSet()
        } catch (e: Exception) {
            emptySet()
        }
    }

    /**
     * 小尺寸图标的内存缓存。
     *
     * 列表滚动时同一个应用会被反复请求图标，每次都要走
     * getApplicationIcon -> 绘制到 Bitmap -> PNG 压缩 -> Base64，纯属浪费。
     * 只缓存 <=128 的（64px 的 Base64 大约 2~6 KB，300 条也就 1 MB 上下）；
     * 512px 那种一张几百 KB 的不缓存，避免把内存吃满。
     */
    private val iconCache = android.util.LruCache<String, String>(300)

    /**
     * 读取应用图标并转成 Base64 PNG。
     *
     * @param size 输出边长。列表展示用 64 就够；**做图生图时必须用 512**——
     *             通义万相要求输入图分辨率在 512~4096 之间，64x64 会被直接拒绝。
     */
    fun loadAppIcon(packageName: String, size: Int = 64, quality: Int = 80): String? {
        val cacheKey = if (size <= 128) "$packageName@${size}q$quality" else null
        if (cacheKey != null) iconCache.get(cacheKey)?.let { return it }

        return try {
            val drawable = packageManager.getApplicationIcon(packageName)
            val bitmap = drawableToBitmap(drawable, size, size)
            val stream = ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.PNG, quality, stream)
            val result = Base64.encodeToString(stream.toByteArray(), Base64.NO_WRAP)
            bitmap.recycle()
            if (cacheKey != null) iconCache.put(cacheKey, result)
            result
        } catch (e: Exception) { null }
    }

    /**
     * 取应用在桌面上的启动组件名，形如 `com.tencent.mm/com.tencent.mm.ui.LauncherUI`。
     * 图标包的 appfilter.xml 需要它来做「组件 → 图标」的映射。
     */
    fun getLauncherComponent(packageName: String): String? {
        return try {
            packageManager.getLaunchIntentForPackage(packageName)?.component?.flattenToString()
        } catch (e: Exception) { null }
    }

    private fun drawableToBitmap(d: android.graphics.drawable.Drawable, w: Int, h: Int): Bitmap {
        if (d is android.graphics.drawable.BitmapDrawable && d.bitmap != null) {
            return Bitmap.createScaledBitmap(d.bitmap, w, h, true)
        }
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val c = android.graphics.Canvas(bmp)
        d.setBounds(0, 0, w, h)
        d.draw(c)
        return bmp
    }

    fun getAllInstalledApps(): List<AppInfo> {
        val packages = packageManager.getInstalledPackages(
            PackageManager.GET_PERMISSIONS
        )
        val hasPermission = hasStorageStatsPermission()

        return packages.mapNotNull { packageInfo ->
            try {
                val appInfo = packageInfo.applicationInfo ?: return@mapNotNull null
                val isSystemApp = (appInfo.flags and ApplicationInfo.FLAG_SYSTEM) != 0

                val sizes = measureAppSizes(appInfo, hasPermission)

                AppInfo(
                    packageName = packageInfo.packageName,
                    appName = appInfo.loadLabel(packageManager).toString(),
                    versionName = packageInfo.versionName ?: "Unknown",
                    versionCode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                        packageInfo.longVersionCode
                    } else {
                        @Suppress("DEPRECATION")
                        packageInfo.versionCode.toLong()
                    },
                    isSystemApp = isSystemApp,
                    installTime = packageInfo.firstInstallTime,
                    updateTime = packageInfo.lastUpdateTime,
                    appSize = sizes.appSize,
                    cacheSize = sizes.cacheSize,
                    dataSize = sizes.dataSize,
                    codeSize = sizes.appSize,
                    targetSdkVersion = appInfo.targetSdkVersion,
                    minSdkVersion = appInfo.minSdkVersion,
                    category = smartClassify(packageInfo, appInfo),
                    hasSizeDetail = sizes.detailed
                )
            } catch (e: Exception) {
                null
            }
        }.sortedByDescending { it.appSize }
    }

    /** 单个应用的真实体积读数。读不到的字段一律为 0，绝不用公式推测。 */
    private data class AppSizes(
        val appSize: Long,
        val dataSize: Long,
        val cacheSize: Long,
        /** cache/data 是否为真实测量值；false 时 UI 必须显示「—」 */
        val detailed: Boolean
    )

    /**
     * 测量单个应用的真实体积。
     *
     * ⚠️ 这里曾经用 apkSize*0.2（缓存）和 apkSize*1.0（数据）之类的公式「估算」体积，
     * 而 File(dataDir) 在 Android 上对其他应用根本不可读、必然返回 0，那些公式于是成了
     * 唯一的数据来源 —— 未授权时统计页显示的总占用比真实值虚高近 3 倍。那是伪造数据，
     * 已整体删除。
     *
     * 现在的契约很硬：**只写真读数**。读不到就写 0 并令 detailed=false，
     * 由 UI 显示「—」并提示需要授权，而不是拿一个看起来很像真的数字糊弄用户。
     */
    private fun measureAppSizes(appInfo: ApplicationInfo, hasPermission: Boolean): AppSizes {
        val apkOnly = apkFileSize(appInfo)
        if (!hasPermission) {
            // 没有「使用情况访问」权限时，系统不允许读取别的应用的数据目录，
            // 唯一能拿到真值的就是 APK 文件本身的字节数。
            return AppSizes(appSize = apkOnly, dataSize = 0L, cacheSize = 0L, detailed = false)
        }
        return try {
            val stats = queryStorageStats(appInfo.uid)
            if (stats == null) {
                AppSizes(apkOnly, 0L, 0L, detailed = false)
            } else {
                AppSizes(
                    // appSize 用 APK 文件的直接 stat 值，不用 stats.appBytes。
                    //
                    // 实测（Android 14 / API 36 模拟器，258 个应用）：
                    //   StorageStats.getAppBytes() 只统计默认卷（/data）上的代码，
                    //   **不含预装在只读分区（/product）上的 APK**。
                    //   于是 Photos(实际 168.4MB)、YouTube(139.0MB)、Gmail(174.0MB)、
                    //   Maps(107.7MB)、GMS(190.2MB) 全被算成几十 MB 甚至几 MB，
                    //   应用本体总和从真实的 2.68GB 缩水到 0.2GB。
                    //   而 File(sourceDir).length() 是直接读文件大小，与分区无关，永远是真值。
                    appSize = apkOnly,
                    // ⚠️ StorageStats.getDataBytes() 的官方文档写明它已包含
                    // getCacheDir()/getCodeCacheDir()，也就是已经含缓存；这里必须减掉，
                    // 否则 appSize+dataSize+cacheSize 会把缓存重复计算一遍。
                    // （数据目录固定位于 /data，所以这一项不存在上面的分区问题。）
                    dataSize = (stats.dataBytes - stats.cacheBytes).coerceAtLeast(0L),
                    cacheSize = stats.cacheBytes,
                    detailed = true
                )
            }
        } catch (e: Exception) {
            DebugLogger.w("读取 ${appInfo.packageName} 体积失败: ${e.message}")
            AppSizes(apkOnly, 0L, 0L, detailed = false)
        }
    }

    /** APK 本体字节数（含 split APK），始终是真实读数 */
    private fun apkFileSize(appInfo: ApplicationInfo): Long {
        var size = 0L
        try { appInfo.sourceDir?.let { size += File(it).length() } } catch (_: Exception) { }
        try { appInfo.splitSourceDirs?.forEach { size += File(it).length() } } catch (_: Exception) { }
        return size
    }

    /** 需要 PACKAGE_USAGE_STATS 权限；无权限时系统会抛 SecurityException，由调用方兜住 */
    private fun queryStorageStats(uid: Int): android.app.usage.StorageStats? {
        val manager = context.getSystemService(Context.STORAGE_STATS_SERVICE) as? StorageStatsManager
            ?: return null
        return manager.queryStatsForUid(StorageManager.UUID_DEFAULT, uid)
    }

    // ==================== 智能分类 ====================

    /**
     * 从 Android 对象里取出原始数据，交给纯逻辑的 [AppClassifier] 判断。
     *
     * 分类规则本身已经搬到 AppClassifier —— 那边不依赖任何 Android 类型，
     * 因此可以直接单元测试（原来这段是 private + 吃 PackageInfo，纯 JVM 测不了）。
     * 这里只负责取值。
     */
    private fun smartClassify(packageInfo: PackageInfo, appInfo: ApplicationInfo): String {
        val builtIn = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            appInfo.category
        } else {
            AppClassifier.NO_BUILT_IN_CATEGORY
        }
        return AppClassifier.classify(
            packageName = packageInfo.packageName,
            appName = appInfo.loadLabel(packageManager).toString(),
            permissions = packageInfo.requestedPermissions?.toList() ?: emptyList(),
            builtInCategory = builtIn,
            isSystemApp = (appInfo.flags and ApplicationInfo.FLAG_SYSTEM) != 0,
            hasLauncherIntent = packageInfo.packageName in launcherPackages
        )
    }
    private fun hasLauncherIntent(packageName: String): Boolean {
        return packageName in launcherPackages
    }

    fun hasAI(): Boolean = deepSeekService.hasApiKey()

    /**
     * 使用 AI 对所有应用分类——只发送应用名。
     *
     * 之所以按应用名而不是包名匹配：AI 拿到的输入就只有应用名。代价是**同名应用
     * 必然共享同一个分类**（AI 无从区分），因此映射条数 ≠ 已分类应用数。
     * 调用方请用 [applyAiCategories] 落地，它会把这个口径算清楚。
     *
     * @return 应用显示名 -> 分类 的映射
     */
    suspend fun enhanceWithAI(apps: List<AppInfo>, forceRefresh: Boolean = false): Map<String, String> {
        if (!deepSeekService.hasApiKey()) {
            DebugLogger.w("⚠️ AI分类: 未配置API Key，跳过")
            return emptyMap()
        }

        DebugLogger.d("═══ AI分类: ${apps.size} 个应用, force=$forceRefresh ═══")

        // 缓存检查
        val pkgNames = apps.map { it.packageName }
        val currentHash = prefsManager.computeAppHash(pkgNames)
        val cachedHash = prefsManager.getCachedHash()

        if (!forceRefresh && currentHash == cachedHash && currentHash.isNotEmpty()) {
            val cached = prefsManager.getCachedCategories()
            if (cached.isNotEmpty()) {
                DebugLogger.d("✅ 缓存命中(Hash=$currentHash): ${cached.size} 条")
                return cached
            }
        }

        // 需要重新分类
        DebugLogger.d(if (forceRefresh) "🔄 强制刷新,忽略缓存" else "📝 应用列表有变化(Hash旧=$cachedHash 新=$currentHash),重新分类")

        val appNames = apps.map { it.appName }
        val result = deepSeekService.classifyWithCustomTags(appNames)

        return result.fold(
            onSuccess = { aiResults ->
                val byName = aiResults.associate { it.appName to it.category }
                val covered = apps.count { byName.containsKey(it.appName) }
                DebugLogger.d("AI分类完成: ${byName.size} 个不重名条目，覆盖 $covered/${apps.size} 个应用")
                val dist = byName.values.groupingBy { it }.eachCount()
                dist.forEach { (cat, count) -> DebugLogger.d("  $cat: $count 个(不重名)") }
                // 保存缓存
                prefsManager.saveHash(currentHash)
                prefsManager.saveCategories(byName)
                DebugLogger.d("💾 缓存已保存(Hash=$currentHash)")
                byName
            },
            onFailure = { e ->
                DebugLogger.e("❌ AI分类失败: ${e.message}", e)
                // 失败时返回旧缓存
                val cached = prefsManager.getCachedCategories()
                if (cached.isNotEmpty()) DebugLogger.w("⚠️ 降级使用旧缓存: ${cached.size}条")
                cached
            }
        )
    }

    /**
     * 把 AI 分类结果落到应用列表上。
     *
     * @return (更新后的列表, 真正拿到分类的应用个数)。
     *         第二个值才是可以理直气壮显示给用户的「已分类 N 个应用」。
     */
    fun applyAiCategories(apps: List<AppInfo>, categories: Map<String, String>): Pair<List<AppInfo>, Int> {
        if (categories.isEmpty()) return apps to 0
        var applied = 0
        val updated = apps.map { app ->
            val cat = categories[app.appName]
            if (cat != null) { applied++; app.copy(category = cat) } else app
        }
        return updated to applied
    }

    // 这里原来还有一份 formatFileSize，和 ui/util/FormatUtil.kt 里的完全重复
    // （而且同样没指定 Locale）。全项目没有任何地方调用它，已删除，
    // 格式化统一走 FormatUtil.formatFileSize。
}

