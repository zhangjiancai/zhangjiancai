package com.appanalyzer.ui.screens

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.appanalyzer.data.model.AppInfo
import com.appanalyzer.service.AppInfoService
import com.appanalyzer.service.DebugLogger
import com.appanalyzer.service.IconPackExporter
import com.appanalyzer.service.IconReplaceService
import com.appanalyzer.service.PreferencesManager
import com.appanalyzer.service.iconpack.IconPackBuilderDialog
import com.appanalyzer.service.iconpack.IconPackTutorialCard
import com.appanalyzer.service.image.ComposeSpec
import com.appanalyzer.service.image.IconBackground
import com.appanalyzer.service.image.LocalStyle
import com.appanalyzer.service.image.LocalStyleRenderer
import com.appanalyzer.service.image.StyleLibrary
import com.appanalyzer.service.image.StyleModelStore
import com.appanalyzer.service.image.StyleRef
import com.appanalyzer.service.imagegen.IconGenResult
import com.appanalyzer.service.imagegen.ImageGenProviders
import com.appanalyzer.service.imagegen.ImageGenService
import com.appanalyzer.service.localmodel.LocalModelCatalog
import com.appanalyzer.service.localmodel.LocalModelManager
import com.appanalyzer.service.localmodel.ModelSpec
import com.appanalyzer.ui.icons.AppIcons
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlin.math.roundToInt

/**
 * 图标页里的一行。
 *
 * 刻意**不保存原图**：512x512 的原图在真正要生成时才去取。
 * 早先是在进入页面时给前 50 个应用各做一次「取图标 -> 缩放 512 -> PNG 压缩 -> 写盘 -> Base64」，
 * 好几秒，是切页面卡顿的根源，也顺带把列表卡在了 50 个。
 */
data class AppIconEntry(
    val packageName: String,
    val appName: String,
    val generatedBase64: String? = null,
    val status: String = STATUS_PENDING,
    val error: String? = null
) {
    companion object {
        const val STATUS_PENDING = "pending"
        const val STATUS_DONE = "done"
        const val STATUS_FAILED = "failed"
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun IconReplaceScreen(apps: List<AppInfo>, appService: AppInfoService) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    val iconService = remember { IconReplaceService(context) }
    val prefs = remember { PreferencesManager(context) }
    val styleLibrary = remember { StyleLibrary(context) }
    val modelManager = remember { LocalModelManager(context) }
    val styleModelStore = remember { StyleModelStore(context) }
    val genService = remember { ImageGenService(prefs, iconService, styleLibrary, modelManager, styleModelStore) }
    val exporter = remember { IconPackExporter(context) }

    // 首次进入时生成内置风格参考图
    LaunchedEffect(Unit) { withContext(Dispatchers.IO) { styleLibrary.ensureBuiltIns() } }

    var entries by remember { mutableStateOf<List<AppIconEntry>>(emptyList()) }
    var isBatchRunning by remember { mutableStateOf(false) }
    var progressText by remember { mutableStateOf("") }
    var showOriginal by remember { mutableStateOf(false) }

    var engineId by remember { mutableStateOf(genService.currentEngineId()) }
    var showApiDialog by remember { mutableStateOf(false) }
    var showStyleLibrary by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }

    // ---- 本地风格的配置 ----
    var allStyles by remember { mutableStateOf<List<StyleRef>>(emptyList()) }
    var styleRef by remember { mutableStateOf<StyleRef?>(null) }
    var localStyle by remember { mutableStateOf(genService.currentLocalStyle()) }
    var strength by remember { mutableStateOf(genService.currentStrength()) }
    var minimalColors by remember { mutableStateOf(genService.currentMinimalColors()) }
    // 本地训练小模型的进度（只对「自定义」有意义）
    var training by remember { mutableStateOf(false) }
    var trainDone by remember { mutableStateOf(0) }
    var trainTotal by remember { mutableStateOf(1) }
    var trainLoss by remember { mutableStateOf(0f) }

    // ---- 界面偏好 ----
    // 紧凑模式现在是**全局**的：在 MainActivity 里通过缩放 LocalDensity 统一生效，
    // 所有页面的 dp/sp 一起缩小。这里只读控制器，不再自己持有一份状态
    //（原来只改了图标页的行高，用户反馈「做的不全，要全局紧凑」）。
    val compactController = com.appanalyzer.ui.util.LocalCompactModeController.current
    val compactMode = compactController.enabled
    /** 批量生成是否跳过已完成的 */
    var skipDone by remember { mutableStateOf(true) }
    // 在手机里直接打包图标包 APK 的说明/执行对话框
    var showIconPackBuilder by remember { mutableStateOf(false) }

    // ---- 端侧模型 ----
    var localModelId by remember { mutableStateOf(genService.currentModel()?.id ?: "") }
    // 抠图之后的合成参数（背景/留白/投影/圆角）
    var composeSpec by remember { mutableStateOf(genService.currentCompose()) }
    var downloadingId by remember { mutableStateOf<String?>(null) }
    var downloadProgress by remember { mutableStateOf(0f) }

    // ---- AI 路径的配置 ----
    var promptText by remember { mutableStateOf(prefs.getImageFeatures()) }
    var stylizeSubject by remember { mutableStateOf(prefs.getStylizeSubject()) }
    var skeuoLoading by remember { mutableStateOf(false) }
    var skeuoError by remember { mutableStateOf<String?>(null) }
    var presetId by remember { mutableStateOf("") }
    var useStyleRefForAi by remember { mutableStateOf(true) }
    var batchScope by remember { mutableStateOf(20) }

    /** 重载风格库并保证当前选中项有效 */
    suspend fun refreshStyles() {
        val list = withContext(Dispatchers.IO) { styleLibrary.list() }
        allStyles = list
        val cur = styleRef
        styleRef = when {
            cur != null && list.any { it.id == cur.id } -> list.first { it.id == cur.id }
            else -> list.firstOrNull()
        }
        styleRef?.let { prefs.setStyleRefId(it.id) }
    }
    LaunchedEffect(Unit) { refreshStyles() }

    /**
     * 当前风格对应的「落盘标识」。
     *
     * 本地引擎：由「四类风格 + 参考图 + 量化档数」决定 —— 换风格、换参考图、换档数
     *          就是另一套产物，不该和上一套混在一起（强度变化不参与标识，重新生成会覆盖）。
     *          「白线勾勒 / 拟物化」不需要参考图，所以标识里不带 ref。
     * AI 引擎：用提示词预设 id，没选预设就是 custom。
     */
    val currentStyleId: String = if (genService.isLocalEngine()) {
        when (localStyle) {
            LocalStyle.LINE_ART -> "local_lineart"
            LocalStyle.SKEUO -> "local_skeuo"
            LocalStyle.MINIMAL -> "local_minimal${minimalColors}"
            LocalStyle.CUSTOM -> {
                val ref = styleRef
                if (ref == null) "local_custom_none" else "local_custom_${ref.id}"
            }
        }
    } else if (genService.isLocalModelEngine()) {
        "model_${localModelId.ifBlank { "none" }}"
    } else {
        presetId.ifBlank { "custom" }
    }

    suspend fun restoreSaved(styleId: String, engine: String) {
        val current = entries
        if (current.isEmpty()) return
        val restored = withContext(Dispatchers.IO) {
            val generated = iconService.listGeneratedPackages(styleId, engine)
            current.map { entry ->
                if (entry.packageName in generated) {
                    val saved = iconService.getSavedIcon(entry.packageName, styleId, engine)
                    if (saved != null) entry.copy(generatedBase64 = saved, status = AppIconEntry.STATUS_DONE, error = null)
                    else entry.copy(generatedBase64 = null, status = AppIconEntry.STATUS_PENDING, error = null)
                } else {
                    entry.copy(generatedBase64 = null, status = AppIconEntry.STATUS_PENDING, error = null)
                }
            }
        }
        entries = restored
    }

    val appsReady = apps.isNotEmpty()
    LaunchedEffect(appsReady) {
        if (!appsReady) return@LaunchedEffect
        entries = apps.map { AppIconEntry(packageName = it.packageName, appName = it.appName) }
    }

    // 唯一的回填触发点（早先是两个 LaunchedEffect 各跑一遍 restoreSaved，白做一倍文件系统工作）
    val hasEntries = entries.isNotEmpty()
    LaunchedEffect(hasEntries, currentStyleId, engineId) {
        if (!hasEntries) return@LaunchedEffect
        val t0 = System.currentTimeMillis()
        restoreSaved(currentStyleId, engineId)
        DebugLogger.d("⏱ 图标页：回填 ${entries.size} 个条目的生成结果耗时 ${System.currentTimeMillis() - t0} ms")
    }

    /**
     * 组装导出用的数据。
     *
     * 「导出图标包 zip」和「在手机里打包 APK」用的是**同一份**数据，
     * 所以抽成一个函数，避免两处各写一遍、将来改一处漏一处。
     * 启动器组件名只在真正要导出的这一刻才查（省掉进页面时 258 次 PackageManager 调用）。
     */
    suspend fun buildExportPayload(): List<IconPackExporter.Entry> = withContext(Dispatchers.IO) {
        entries.filter { it.generatedBase64 != null }.mapNotNull { e ->
            val component = appService.getLauncherComponent(e.packageName) ?: return@mapNotNull null
            IconPackExporter.Entry(
                component = component,
                packageName = e.packageName,
                appName = e.appName,
                pngBytes = android.util.Base64.decode(e.generatedBase64, android.util.Base64.DEFAULT)
            )
        }
    }

    /** 原图按需取：先看磁盘缓存，没有才现取并落盘 */
    suspend fun loadSource(packageName: String): String? = withContext(Dispatchers.IO) {
        iconService.loadSourceIcon(packageName) ?: run {
            val fresh = appService.loadAppIcon(packageName, size = 512, quality = 90)
            if (fresh != null) iconService.saveSourceIcon(packageName, fresh)
            fresh
        }
    }

    suspend fun generateOne(entry: AppIconEntry): AppIconEntry {
        val source = loadSource(entry.packageName)
        return when (val r = genService.generate(
            appName = entry.appName,
            packageName = entry.packageName,
            styleId = currentStyleId,
            sourceBase64 = source,
            styleDescription = promptText,
            extraFeatures = "",
            useStyleRef = useStyleRefForAi
        )) {
            is IconGenResult.Success ->
                entry.copy(generatedBase64 = r.imageBase64, status = AppIconEntry.STATUS_DONE, error = null)
            is IconGenResult.Failure ->
                entry.copy(status = AppIconEntry.STATUS_FAILED, error = r.message)
        }
    }

    /**
     * 批量跑一轮。
     *
     * @param regenerate true = 不管有没有生成过都重做（「重新生成」按钮）；
     *                   false = 按 skipDone 决定要不要跳过已完成的（「批量生成」按钮）
     *
     * 以前批量生成**总是**跳过已完成的，全部完成时只丢一句「所选范围内都生成过了」，
     * 于是生成完一轮之后想重做就没路了 —— 用户实测卡在这里。
     */
    suspend fun runBatch(regenerate: Boolean) {
        if (isBatchRunning) return
        isBatchRunning = true
        message = null
        val pool = if (batchScope < 0) entries else entries.take(batchScope)
        val target = if (regenerate || !skipDone) pool
                     else pool.filter { it.status != AppIconEntry.STATUS_DONE }
        if (target.isEmpty()) {
            message = when {
                pool.isEmpty() -> "所选范围里没有应用"
                regenerate -> "所选范围里没有可重做的应用"
                else -> "所选范围内都生成过了。想重做就关掉「跳过已生成」，或直接点「重新生成」。"
            }
            isBatchRunning = false
            return
        }
        try {
            val sem = Semaphore(3)
            var finished = 0
            progressText = "0/" + target.size
            val results = coroutineScope {
                target.map { entry ->
                    async(Dispatchers.IO) {
                        val r = sem.withPermit { generateOne(entry) }
                        synchronized(Unit) { finished++; progressText = finished.toString() + "/" + target.size }
                        r
                    }
                }.awaitAll()
            }
            val byPkg = results.associateBy { it.packageName }
            entries = entries.map { byPkg[it.packageName] ?: it }
            val failed = results.count { it.status == AppIconEntry.STATUS_FAILED }
            message = if (failed == 0) "完成 " + target.size + " 个"
                      else "完成 " + target.size + " 个，其中 " + failed + " 个失败"
        } catch (e: Exception) {
            DebugLogger.e("批量生成失败", e)
            message = "批量生成中断：" + e.message
        } finally {
            isBatchRunning = false
            progressText = ""
        }
    }

    // 相册选风格图
    val pickStyle = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) {
            scope.launch {
                val ref = withContext(Dispatchers.IO) { styleLibrary.importFromUri(uri) }
                if (ref != null) {
                    prefs.setStyleRefId(ref.id)
                    styleRef = ref
                    refreshStyles()
                    message = "已导入风格图"
                } else {
                    message = "这张图读不出来，换一张试试"
                }
            }
        }
    }

    // ⚠️ 整个页面必须是**一个 LazyColumn**。
    //
    // 以前这里是最外层 Column + 固定高度的子项，面板一展开就占掉 400~600dp，
    // 下面那个 fillMaxSize 的 LazyColumn 高度被挤到接近 0 —— 列表既看不见也滚不动，
    // 而且整页本身不可滚动，用户只能把面板收起来才能看到应用列表。
    //
    // 改成一个 LazyColumn 之后：面板展开时只是这一项变高，整页一起滚，
    // 任何一块内容都不可能再"吃掉"别人的空间。
    LazyColumn(
        modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background),
        contentPadding = PaddingValues(bottom = 12.dp)
    ) {
        item(key = "header") {
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text("图标生成", fontSize = 15.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.width(8.dp))
                Text(
                    text = when {
                        genService.isLocalEngine() -> "风格参考图 + 原图标 → 新图标（不联网）"
                        genService.isLocalModelEngine() -> "抠图去背景 → 合成新图标"
                        else -> "文字描述 + 可选参考图 → 新图标"
                    },
                    fontSize = 10.sp, color = Color.Gray, maxLines = 1
                )
            }
        }

        // ===== 引擎 =====
        item(key = "engine") { Card(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
        ) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    if (genService.isLocalEngine()) AppIcons.Brush else AppIcons.AutoAwesome,
                    null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp)
                )
                Spacer(Modifier.width(6.dp))
                Text("生成引擎", fontSize = 10.sp, color = Color.Gray)
                Spacer(Modifier.width(6.dp))
                Text(
                    ImageGenProviders.displayNameOf(engineId),
                    fontSize = 12.sp, fontWeight = FontWeight.Bold, maxLines = 1,
                    overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f)
                )
                TextButton(
                    onClick = { showApiDialog = true },
                    contentPadding = PaddingValues(horizontal = 10.dp, vertical = 0.dp),
                    modifier = Modifier.height(30.dp)
                ) { Text("更换", fontSize = 12.sp) }
            }
        } }

        // 面板：展开时只是这一项变高，整页照常滚动
        item(key = "panel") {
        if (genService.isLocalModelEngine()) {
            LocalModelPanel(
                manager = modelManager,
                selectedId = localModelId,
                downloadingId = downloadingId,
                progress = downloadProgress,
                styleRef = styleRef,
                compose = composeSpec,
                stylizeSubject = stylizeSubject,
                localStyleLabel = localStyle.label,
                onOpenStyleLibrary = { showStyleLibrary = true },
                onComposeChange = { composeSpec = it; genService.saveCompose(it) },
                onStylizeChange = { stylizeSubject = it; prefs.setStylizeSubject(it) },
                onSelect = { spec ->
                    localModelId = spec.id
                    prefs.setLocalModelId(spec.id)
                },
                onDownload = { spec ->
                    scope.launch {
                        downloadingId = spec.id
                        downloadProgress = 0f
                        val res = modelManager.download(spec) { done, total ->
                            if (total > 0) downloadProgress = (done.toFloat() / total).coerceIn(0f, 1f)
                        }
                        downloadingId = null
                        message = res.fold(
                            onSuccess = { "「${spec.name}」下载完成" },
                            onFailure = { "下载失败：${it.message}" }
                        )
                        if (res.isSuccess) {
                            // 下载完就把它设为当前模型并**持久化**。
                            // 之前只更新了内存状态，而引擎是通过 prefs 读当前模型的，
                            // 于是回退到默认的 U2Net（没下载），生成被静默拒绝。
                            localModelId = spec.id
                            prefs.setLocalModelId(spec.id)
                        }
                    }
                },
                onDelete = { spec ->
                    scope.launch {
                        withContext(Dispatchers.IO) { modelManager.delete(spec) }
                        message = "已删除「${spec.name}」"
                    }
                }
            )
        } else if (genService.isLocalEngine()) {
            LocalStylePanel(
                styleRef = styleRef,
                styleLibrary = styleLibrary,
                style = localStyle,
                strength = strength,
                minimalColors = minimalColors,
                training = training,
                trainDone = trainDone,
                trainTotal = trainTotal,
                trainLoss = trainLoss,
                onPickFromGallery = { pickStyle.launch("image/*") },
                onOpenLibrary = { showStyleLibrary = true },
                onStyleChange = { localStyle = it; prefs.setLocalStyleId(it.id) },
                onStrengthChange = { strength = it; prefs.setStyleStrength(it) },
                onMinimalColorsChange = { minimalColors = it; prefs.setMinimalColors(it) },
                onTrain = {
                    scope.launch {
                        training = true; trainDone = 0; trainTotal = prefs.getTrainIterations()
                        val ok = runCatching {
                            withContext(Dispatchers.IO) {
                                ImageGenService(prefs, iconService, styleLibrary, modelManager, styleModelStore)
                                    .warmUpModel(styleRef) { done, total, loss ->
                                        trainDone = done; trainTotal = total; trainLoss = loss
                                    }
                            }
                        }.getOrNull()
                        training = false
                        message = if (ok == true) "风格模型训练完成，可以开始批量生成"
                                  else "训练失败：需要先选一张风格参考图"
                    }
                }
            )
        } else {
            AiPromptPanel(
                promptText = promptText,
                onPromptChange = { promptText = it; prefs.setImageFeatures(it) },
                presets = iconService.promptPresets,
                presetId = presetId,
                onPresetPick = { p ->
                    presetId = p.id
                    promptText = p.instruction
                    prefs.setImageFeatures(p.instruction)
                },
                styleRef = styleRef,
                onOpenLibrary = { showStyleLibrary = true },
                useStyleRef = useStyleRefForAi,
                onUseStyleRefChange = { useStyleRefForAi = it },
                providerSupportsStyleRef = (genService.currentProvider()?.maxReferenceImages ?: 1) > 1,
                onGenerateSkeuoPrompt = {
                    scope.launch {
                        skeuoLoading = true
                        skeuoError = null
                        val res = withContext(Dispatchers.IO) {
                            com.appanalyzer.service.DeepSeekService(prefs)
                                .generateSkeuoPrompt(appName = "应用图标", category = "")
                        }
                        skeuoLoading = false
                        res.fold(
                            onSuccess = {
                                promptText = it
                                prefs.setImageFeatures(it)
                                presetId = ""
                                message = "DeepSeek 已生成拟物化描述，确认后即可批量生成"
                            },
                            onFailure = { skeuoError = "生成失败：${it.message}" }
                        )
                    }
                },
                skeuoLoading = skeuoLoading,
                skeuoError = skeuoError,
                deepSeekReady = prefs.hasApiKey()
            )
        }
        }

        // ===== 操作栏 =====
        val doneCount = entries.count { it.status == AppIconEntry.STATUS_DONE }
        val failedCount = entries.count { it.status == AppIconEntry.STATUS_FAILED }
        item(key = "actions") {
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text("已生成 $doneCount / ${entries.size}", fontSize = 11.sp, color = Color.Gray)
                if (failedCount > 0) {
                    Spacer(Modifier.width(6.dp))
                    Text("$failedCount 个失败", fontSize = 11.sp, color = Color(0xFFE53935))
                }
                Spacer(Modifier.weight(1f))
                // 全局紧凑：整个应用所有页面一起缩小（在 MainActivity 里缩放 LocalDensity）
                Text("紧凑", fontSize = 10.sp, color = Color.Gray, maxLines = 1)
                Spacer(Modifier.width(4.dp))
                Switch(
                    checked = compactMode,
                    onCheckedChange = { compactController.setEnabled(it) },
                    modifier = Modifier.height(24.dp).scale(0.7f)
                )
                TextButton(
                    onClick = { showOriginal = !showOriginal },
                    contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp),
                    modifier = Modifier.height(30.dp)
                ) { Text(if (showOriginal) "看生成图" else "看原图", fontSize = 11.sp) }
            }
        }

        item(key = "batch") {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text("批量范围", fontSize = 11.sp, color = Color.Gray)
            listOf(10 to "10", 20 to "20", 50 to "50", -1 to "全部").forEach { (n, label) ->
                FilterChip(
                    selected = batchScope == n,
                    onClick = { batchScope = n },
                    label = { Text(label, fontSize = 10.sp, maxLines = 1) },
                    modifier = Modifier.height(28.dp)
                )
            }
            Spacer(Modifier.weight(1f))

            // 「跳过已生成」开关。
            // 以前批量生成**总是**跳过已完成的，全部完成时只丢一句「所选范围内都生成过了」，
            // 生成完一轮之后想重做就没路了。关掉这个开关就是全部重做。
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("跳过已生成", fontSize = 10.sp, color = Color.Gray, maxLines = 1)
                Spacer(Modifier.width(2.dp))
                Switch(
                    checked = skipDone,
                    onCheckedChange = { skipDone = it },
                    modifier = Modifier.height(22.dp).scale(0.65f)
                )
            }

            Button(
                onClick = { scope.launch { runBatch(regenerate = false) } },
                enabled = !isBatchRunning && entries.isNotEmpty() && genService.isReady(),
                contentPadding = PaddingValues(horizontal = 12.dp),
                modifier = Modifier.height(32.dp)
            ) {
                if (isBatchRunning) {
                    CircularProgressIndicator(modifier = Modifier.size(13.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(6.dp))
                }
                Text(
                    if (isBatchRunning) "生成中 $progressText" else "批量生成",
                    fontSize = 11.sp, maxLines = 1
                )
            }

            // 明确的「重新生成」按钮：不管有没有生成过，范围内全部重做一遍
            OutlinedButton(
                onClick = { scope.launch { runBatch(regenerate = true) } },
                enabled = !isBatchRunning && entries.isNotEmpty() && genService.isReady(),
                contentPadding = PaddingValues(horizontal = 12.dp),
                modifier = Modifier.height(32.dp)
            ) {
                Icon(Icons.Default.Refresh, null, modifier = Modifier.size(14.dp))
                Spacer(Modifier.width(4.dp))
                Text("重新生成", fontSize = 11.sp, maxLines = 1)
            }
        }

        if (!genService.isReady()) {
            Text(
                "当前引擎还没有配置 API Key，点上方「更换」去填写。",
                fontSize = 11.sp, color = Color(0xFFFF9800),
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)
            )
        }

        // ===== 导出 =====
        val exportable = entries.filter { it.generatedBase64 != null }
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            OutlinedButton(
                onClick = {
                    scope.launch {
                        message = null
                        try {
                            val payload = buildExportPayload()
                            if (payload.isEmpty()) {
                                message = "没有可导出的图标（这些应用没有启动入口，无法做图标映射）"
                            } else {
                                val res = withContext(Dispatchers.IO) { exporter.export(payload, "App Analyzer Icons", "") }
                                message = "已导出 ${res.iconCount} 个图标（${res.bytes / 1024} KB）\n${res.location}"
                            }
                        } catch (e: Exception) {
                            DebugLogger.e("导出图标包失败", e)
                            message = "导出失败: ${e.message}"
                        }
                    }
                },
                enabled = exportable.isNotEmpty()
            ) {
                Icon(AppIcons.FolderZip, null, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(6.dp))
                Text("导出 zip (${exportable.size})", fontSize = 12.sp)
            }

            // 在手机里直接打包成可安装的图标包 APK，不再需要电脑
            OutlinedButton(
                onClick = { showIconPackBuilder = true },
                enabled = exportable.isNotEmpty(),
                contentPadding = PaddingValues(horizontal = 10.dp),
                modifier = Modifier.padding(start = 6.dp)
            ) {
                Icon(AppIcons.Android, null, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(6.dp))
                Text("打包成 APK", fontSize = 12.sp)
            }
        }
        }

        // 图标包是什么、怎么用、支持哪些启动器 —— 折叠说明，不占地方
        item(key = "iconpack_tutorial") {
            Box(Modifier.padding(horizontal = 12.dp, vertical = 2.dp)) {
                IconPackTutorialCard()
            }
        }

        message?.let { msg ->
            item(key = "message") {
                Text(msg, fontSize = 11.sp, color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp))
            }
        }

        if (isBatchRunning) {
            item(key = "progress") {
                LinearProgressIndicator(modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp))
            }
        }

        // ===== 列表（全部应用，图标按需懒加载）=====
        // 注意：这里**直接**作为外层 LazyColumn 的 items，不再嵌套第二层 LazyColumn。
        // 嵌套的写法在面板展开时会被挤成 0 高度 —— 那正是「列表滚不动」的根因。
        if (entries.isEmpty()) {
            item(key = "empty") {
                Column(
                    modifier = Modifier.fillMaxWidth().padding(vertical = 48.dp),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Text("没有可加载的应用", color = Color.Gray)
                    Spacer(Modifier.height(4.dp))
                    Text("请先在「列表」页完成加载", color = Color.Gray, fontSize = 12.sp)
                }
            }
        } else {
            itemsIndexed(entries, key = { _, e -> e.packageName }) { _, entry ->
                AppIconRow(
                    entry = entry,
                    showOriginal = showOriginal,
                    compact = compactMode,
                    appService = appService,
                    onGenerate = {
                        scope.launch {
                            val updated = generateOne(entry)
                            entries = entries.map { if (it.packageName == entry.packageName) updated else it }
                        }
                    }
                )
            }
        }
    }

    if (showIconPackBuilder) {
        var payload by remember { mutableStateOf<List<IconPackExporter.Entry>?>(null) }
        LaunchedEffect(Unit) { payload = buildExportPayload() }
        val p = payload
        if (p == null) {
            // 还在解析启动器组件（258 次 PackageManager 查询），先转个圈
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        } else {
            IconPackBuilderDialog(
                entries = p,
                packName = "App Analyzer Icons",
                onDismiss = { showIconPackBuilder = false },
                onFinished = { location ->
                    showIconPackBuilder = false
                    message = "图标包已生成：$location"
                }
            )
        }
    }

    if (showApiDialog) {
        ImageApiDialog(
            prefs = prefs,
            currentEngineId = engineId,
            onDismiss = { showApiDialog = false },
            onSaved = { newEngine ->
                engineId = newEngine
                showApiDialog = false
                scope.launch { restoreSaved(currentStyleId, newEngine) }
            }
        )
    }

    if (showStyleLibrary) {
        StyleLibraryDialog(
            styles = allStyles,
            selectedId = styleRef?.id,
            onImport = { pickStyle.launch("image/*") },
            onDelete = { ref ->
                scope.launch {
                    withContext(Dispatchers.IO) { styleLibrary.delete(ref) }
                    refreshStyles()
                }
            },
            onSelect = { ref ->
                styleRef = ref
                prefs.setStyleRefId(ref.id)
                showStyleLibrary = false
            },
            styleLibrary = styleLibrary,
            onDismiss = { showStyleLibrary = false }
        )
    }
}

// =====================================================================
// 端侧模型面板（按需下载）
// =====================================================================

@Composable
private fun LocalModelPanel(
    manager: LocalModelManager,
    selectedId: String,
    downloadingId: String?,
    progress: Float,
    styleRef: StyleRef?,
    compose: ComposeSpec,
    stylizeSubject: Boolean,
    localStyleLabel: String,
    onOpenStyleLibrary: () -> Unit,
    onSelect: (ModelSpec) -> Unit,
    onDownload: (ModelSpec) -> Unit,
    onDelete: (ModelSpec) -> Unit,
    onComposeChange: (ComposeSpec) -> Unit,
    onStylizeChange: (Boolean) -> Unit
) {
    // 面板必须可折叠：展开时内容很高，会把下方的应用列表挤成 0 高度，
    // 结果就是列表滚不动、生成按钮也点不到（实测踩到过）。
    var expanded by remember { mutableStateOf(false) }
    LaunchedEffect(downloadingId) { }

    Card(modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth().clickable { expanded = !expanded },
                verticalAlignment = Alignment.CenterVertically
            ) {
                Icon(AppIcons.Storage, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Column(Modifier.weight(1f)) {
                    Text("端侧模型（按需下载）", fontSize = 13.sp, fontWeight = FontWeight.Bold)
                    Text(
                        "已下载 ${LocalModelCatalog.all.count { manager.isReady(it) }}/${LocalModelCatalog.all.size}" +
                            (downloadingId?.let { " · 正在下载" } ?: ""),
                        fontSize = 10.sp, color = Color.Gray
                    )
                }
                Icon(if (expanded) AppIcons.ExpandLess else AppIcons.ExpandMore, null, tint = Color.Gray)
            }

            if (expanded) {

            Spacer(Modifier.height(4.dp))
            Text(
                "模型不打包进 APK，用到哪个才下哪个，下完存在应用私有目录、随时可删。" +
                    "端侧目前只有抠图和超分两类 —— 魔搭上没有可用的端侧图生图/风格迁移模型" +
                    "（AnimeGAN、CartoonGAN、AdaIN 等 30 多个候选全都不存在），" +
                    "所以「用文字生成新图标」得走云端 API。",
                fontSize = 10.sp, color = Color.Gray
            )
            Spacer(Modifier.height(8.dp))

            // 抠图之后必须再合成一次才是"新图标"。没有这一步的话，
            // 端侧模型输出的只是「背景被去掉的原图标」，谈不上生成。
            ComposePanel(
                compose = compose,
                onChange = onComposeChange,
                stylizeSubject = stylizeSubject,
                onStylizeChange = onStylizeChange,
                localStyleLabel = localStyleLabel
            )

            Spacer(Modifier.height(10.dp))
            Text("选择模型", fontSize = 11.sp, fontWeight = FontWeight.Medium, color = Color.Gray)

            LocalModelCatalog.all.forEach { spec ->
                val ready = manager.isReady(spec)
                val isSelected = spec.id == selectedId
                val downloading = downloadingId == spec.id
                Row(
                    modifier = Modifier.fillMaxWidth()
                        .clip(RoundedCornerShape(8.dp))
                        .background(if (isSelected) MaterialTheme.colorScheme.primaryContainer else Color.Transparent)
                        .clickable(enabled = ready) { onSelect(spec) }
                        .padding(vertical = 6.dp, horizontal = 4.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    RadioButton(selected = isSelected, onClick = { if (ready) onSelect(spec) }, enabled = ready)
                    Column(Modifier.weight(1f)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(spec.name, fontSize = 12.sp, fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Normal)
                            Spacer(Modifier.width(6.dp))
                            Surface(
                                shape = RoundedCornerShape(4.dp),
                                color = MaterialTheme.colorScheme.surfaceVariant
                            ) {
                                Text(spec.task.label, fontSize = 9.sp, modifier = Modifier.padding(horizontal = 4.dp, vertical = 1.dp))
                            }
                        }
                        Text(
                            "${spec.sizeBytes / 1024 / 1024} MB" +
                                (if (spec.license.isNotBlank()) " · ${spec.license}" else ""),
                            fontSize = 9.sp, color = Color.Gray
                        )
                        Text(spec.description, fontSize = 9.sp, color = Color.Gray, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        if (downloading) {
                            Spacer(Modifier.height(4.dp))
                            LinearProgressIndicator(
                                progress = { progress },
                                modifier = Modifier.fillMaxWidth().height(4.dp)
                            )
                            Text("${(progress * 100).toInt()}%", fontSize = 9.sp, color = Color.Gray)
                        }
                    }
                    Spacer(Modifier.width(6.dp))
                    when {
                        downloading -> CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                        ready -> IconButton(onClick = { onDelete(spec) }, modifier = Modifier.size(32.dp)) {
                            Icon(Icons.Default.Delete, "删除", tint = Color.Gray, modifier = Modifier.size(18.dp))
                        }
                        else -> TextButton(onClick = { onDownload(spec) }, enabled = downloadingId == null) {
                            Text("下载", fontSize = 11.sp)
                        }
                    }
                }
            }

            Spacer(Modifier.height(6.dp))
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
                Row(Modifier.padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(AppIcons.Palette, null, modifier = Modifier.size(16.dp), tint = MaterialTheme.colorScheme.primary)
                    Spacer(Modifier.width(6.dp))
                    Column(Modifier.weight(1f)) {
                        Text("抠图后的背景", fontSize = 11.sp, fontWeight = FontWeight.Medium)
                        Text(
                            styleRef?.let { "用风格参考图「${it.name}」当背景" } ?: "透明背景（去选一张风格图可换成该图当背景）",
                            fontSize = 9.sp, color = Color.Gray
                        )
                    }
                    TextButton(onClick = onOpenStyleLibrary) { Text("选择", fontSize = 11.sp) }
                }
            }
            }
        }
    }
}

// =====================================================================
// 抠图之后的合成设置
// =====================================================================
// =====================================================================
// 抠图之后的合成设置
// =====================================================================

/**
 * 抠图只解决了「去掉背景」，这一步才决定新图标长什么样：
 * 换什么背景、主体留多少白、有没有投影、圆角多大。
 */
@Composable
private fun ComposePanel(
    compose: ComposeSpec,
    onChange: (ComposeSpec) -> Unit,
    stylizeSubject: Boolean,
    onStylizeChange: (Boolean) -> Unit,
    localStyleLabel: String
) {
    var sub by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth().clickable { sub = !sub },
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text("合成设置", fontSize = 11.sp, fontWeight = FontWeight.Medium, color = Color.Gray)
            Spacer(Modifier.width(6.dp))
            Text(compose.background.label, fontSize = 10.sp, color = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.weight(1f))
            Icon(if (sub) AppIcons.ExpandLess else AppIcons.ExpandMore, null, tint = Color.Gray, modifier = Modifier.size(16.dp))
        }
        if (sub) {

        Spacer(Modifier.height(4.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            IconBackground.values().forEach { bg ->
                FilterChip(
                    selected = compose.background == bg,
                    onClick = { onChange(compose.copy(background = bg)) },
                    label = { Text(bg.label, fontSize = 10.sp) },
                    modifier = Modifier.height(28.dp)
                )
            }
        }

        if (compose.background == IconBackground.SOLID || compose.background == IconBackground.GRADIENT) {
            Spacer(Modifier.height(6.dp))
            Text("背景色", fontSize = 11.sp, fontWeight = FontWeight.Medium)
            Spacer(Modifier.height(4.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                BACKGROUND_PRESETS.forEach { preset ->
                    val selected = compose.colorTop == preset.second && compose.colorBottom == preset.third
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        modifier = Modifier.clickable {
                            onChange(compose.copy(colorTop = preset.second, colorBottom = preset.third))
                        }
                    ) {
                        Box(
                            modifier = Modifier.size(30.dp).clip(RoundedCornerShape(8.dp))
                                .background(
                                    if (compose.background == IconBackground.GRADIENT)
                                        Brush.verticalGradient(listOf(Color(preset.second), Color(preset.third)))
                                    else Brush.linearGradient(listOf(Color(preset.second), Color(preset.second)))
                                )
                                .border(
                                    width = if (selected) 2.dp else 1.dp,
                                    color = if (selected) MaterialTheme.colorScheme.primary else Color.Gray.copy(alpha = 0.3f),
                                    shape = RoundedCornerShape(8.dp)
                                )
                        )
                        Text(preset.first, fontSize = 8.sp,
                            color = if (selected) MaterialTheme.colorScheme.primary else Color.Gray)
                    }
                }
            }
        }

        Spacer(Modifier.height(6.dp))
        CompactSlider("主体大小", compose.subjectScale, 0.4f, 1f) { onChange(compose.copy(subjectScale = it)) }
        CompactSlider("圆角", compose.cornerRadius, 0f, 0.5f) { onChange(compose.copy(cornerRadius = it)) }
        CompactSlider("投影浓度", compose.shadowAlpha, 0f, 0.8f, compose.shadow) { onChange(compose.copy(shadowAlpha = it)) }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Checkbox(
                checked = compose.shadow,
                onCheckedChange = { onChange(compose.copy(shadow = it)) },
                modifier = Modifier.size(28.dp)
            )
            Text("给主体加投影", fontSize = 11.sp)
        }

        // 三级管线：抠图 -> 主体风格化 -> 合成
        HorizontalDivider(Modifier.padding(vertical = 4.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Checkbox(
                checked = stylizeSubject,
                onCheckedChange = onStylizeChange,
                modifier = Modifier.size(28.dp)
            )
            Column(Modifier.weight(1f)) {
                Text("抠出来的主体也做风格化", fontSize = 11.sp)
                Text(
                    if (stylizeSubject) "当前用「$localStyleLabel」处理主体（在下面的「本地风格」里改）"
                    else "开启后：抠图 → 主体按本地风格处理 → 再合成（三级管线）",
                    fontSize = 9.sp, color = Color.Gray
                )
            }
        }
        }
    }
}

@Composable
private fun CompactSlider(
    label: String,
    value: Float,
    min: Float,
    max: Float,
    enabled: Boolean = true,
    onChange: (Float) -> Unit
) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
        Text(label, fontSize = 10.sp, modifier = Modifier.width(52.dp),
            color = if (enabled) Color.Unspecified else Color.Gray)
        Slider(
            value = value,
            onValueChange = onChange,
            valueRange = min..max,
            enabled = enabled,
            modifier = Modifier.weight(1f).height(28.dp)
        )
        Text("${(value * 100).toInt()}%", fontSize = 10.sp, color = Color.Gray, modifier = Modifier.width(34.dp))
    }
}

// 背景配色预设：名字、起始色、结束色
private val BACKGROUND_PRESETS = listOf(
    Triple("石墨", 0xFF2B2B33.toInt(), 0xFF14141A.toInt()),
    Triple("白", 0xFFFFFFFF.toInt(), 0xFFE8E8EE.toInt()),
    Triple("夜空", 0xFF1B2A4A.toInt(), 0xFF0B1020.toInt()),
    Triple("暖砂", 0xFFF7E8D0.toInt(), 0xFFE0C9A6.toInt()),
    Triple("薄荷", 0xFFD9F5E8.toInt(), 0xFFA8E6CF.toInt())
)
// =====================================================================
// 本地风格面板
// =====================================================================

@Composable
private fun LocalStylePanel(
    styleRef: StyleRef?,
    styleLibrary: StyleLibrary,
    style: LocalStyle,
    strength: Float,
    minimalColors: Int,
    training: Boolean,
    trainDone: Int,
    trainTotal: Int,
    trainLoss: Float,
    onPickFromGallery: () -> Unit,
    onOpenLibrary: () -> Unit,
    onStyleChange: (LocalStyle) -> Unit,
    onStrengthChange: (Float) -> Unit,
    onMinimalColorsChange: (Int) -> Unit,
    onTrain: () -> Unit
) {
    // 注意：asImageBitmap() 是包装而非拷贝，之后**不能** recycle 这张 bitmap，
    // 否则 Compose 真正绘制时会读到已回收的内存。
    val thumb by produceState<ImageBitmap?>(null, styleRef?.id) {
        val ref = styleRef
        value = if (ref == null) null else withContext(Dispatchers.IO) {
            styleLibrary.loadBitmap(ref)?.let { bmp ->
                val small = Bitmap.createScaledBitmap(bmp, 96, 96, true)
                if (small !== bmp) bmp.recycle()
                small.asImageBitmap()
            }
        }
    }

    var expanded by remember { mutableStateOf(false) }
    Card(modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
        Column(Modifier.padding(12.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth().clickable { expanded = !expanded },
                verticalAlignment = Alignment.CenterVertically
            ) {
                Icon(AppIcons.Palette, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text("本地风格", fontSize = 13.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                Text(style.label, fontSize = 10.sp, color = Color.Gray)
                Spacer(Modifier.width(4.dp))
                Icon(if (expanded) AppIcons.ExpandLess else AppIcons.ExpandMore, null, tint = Color.Gray)
            }
            Spacer(Modifier.height(8.dp))

            // 四类风格，做法完全不同，不是预设滤镜
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                LocalStyle.values().forEach { s ->
                    FilterChip(
                        selected = style == s,
                        onClick = { onStyleChange(s) },
                        label = { Text(s.label, fontSize = 11.sp) },
                        modifier = Modifier.height(30.dp)
                    )
                }
            }
            Text(style.description, fontSize = 10.sp, color = Color.Gray)

            if (expanded) {

            // ---- 自定义风格：需要一张参考图 + 在本机训练一个小模型 ----
            if (style == LocalStyle.CUSTOM) {
                Spacer(Modifier.height(10.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier.size(64.dp).clip(RoundedCornerShape(10.dp))
                        .background(Color(0xFFEDEDED))
                        .border(1.dp, Color.Gray.copy(alpha = 0.25f), RoundedCornerShape(10.dp)),
                    contentAlignment = Alignment.Center
                ) {
                    val img = thumb
                    if (img != null) {
                        Image(img, "风格参考图", Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
                    } else {
                        Icon(AppIcons.Palette, null, tint = Color.Gray, modifier = Modifier.size(24.dp))
                    }
                }
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(styleRef?.name ?: "未选择", fontSize = 13.sp, fontWeight = FontWeight.Medium)
                    Text(
                        if (styleRef?.builtIn == true) "内置参考图" else "我的图片",
                        fontSize = 10.sp, color = Color.Gray
                    )
                    Spacer(Modifier.height(6.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        OutlinedButton(onClick = onPickFromGallery, modifier = Modifier.height(32.dp)) {
                            Text("从相册导入", fontSize = 11.sp)
                        }
                        OutlinedButton(onClick = onOpenLibrary, modifier = Modifier.height(32.dp)) {
                            Text("风格库", fontSize = 11.sp)
                        }
                    }
                }
            }
                Spacer(Modifier.height(8.dp))
                LinearProgressIndicator(
                    progress = if (trainTotal <= 0) 0f else trainDone.toFloat() / trainTotal,
                    modifier = Modifier.fillMaxWidth().height(6.dp)
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    if (training) "本地训练中 $trainDone/$trainTotal  ·  loss ${"%.4f".format(trainLoss)}"
                    else "点「开始训练」在本机训练一个小模型（17x17x17 的颜色查找表，约 1.5 万参数）。\n" +
                        "训练只跟风格图有关，一张图训练一次，所有图标通用。",
                    fontSize = 10.sp, color = Color.Gray
                )
                Spacer(Modifier.height(8.dp))
                Button(
                    onClick = onTrain,
                    enabled = !training,
                    modifier = Modifier.height(34.dp)
                ) {
                    Text(if (training) "训练中…" else "开始训练", fontSize = 12.sp)
                }
            }

            // ---- 极简色块：量化档数 ----
            if (style == LocalStyle.MINIMAL) {
                Spacer(Modifier.height(10.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("颜色数", fontSize = 12.sp, fontWeight = FontWeight.Medium)
                    Spacer(Modifier.width(8.dp))
                    Slider(
                        value = minimalColors.toFloat(),
                        onValueChange = { onMinimalColorsChange(it.roundToInt()) },
                        valueRange = 2f..8f,
                        steps = 5,
                        modifier = Modifier.weight(1f)
                    )
                    Spacer(Modifier.width(8.dp))
                    Text("${minimalColors} 色", fontSize = 11.sp, color = Color.Gray)
                }
            }

            Spacer(Modifier.height(6.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("强度", fontSize = 12.sp, fontWeight = FontWeight.Medium)
                Spacer(Modifier.width(8.dp))
                Slider(
                    value = strength,
                    onValueChange = onStrengthChange,
                    valueRange = 0f..1f,
                    modifier = Modifier.weight(1f)
                )
                Spacer(Modifier.width(8.dp))
                Text("${(strength * 100).toInt()}%", fontSize = 11.sp, color = Color.Gray)
            }
            }
        }
    }
}

// =====================================================================
// AI 提示词面板
// =====================================================================

@Composable
private fun AiPromptPanel(
    promptText: String,
    onPromptChange: (String) -> Unit,
    presets: List<IconReplaceService.PromptPreset>,
    presetId: String,
    onPresetPick: (IconReplaceService.PromptPreset) -> Unit,
    styleRef: StyleRef?,
    onOpenLibrary: () -> Unit,
    useStyleRef: Boolean,
    onUseStyleRefChange: (Boolean) -> Unit,
    providerSupportsStyleRef: Boolean,
    /** 「让 DeepSeek 写拟物化描述」：把抽象风格拆成材质/光影/配色的具体描述 */
    onGenerateSkeuoPrompt: () -> Unit,
    skeuoLoading: Boolean,
    skeuoError: String?,
    deepSeekReady: Boolean
) {
    var expanded by remember { mutableStateOf(true) }
    Card(modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
        Column(Modifier.padding(12.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth().clickable { expanded = !expanded },
                verticalAlignment = Alignment.CenterVertically
            ) {
                Icon(AppIcons.Tune, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Column(Modifier.weight(1f)) {
                    Text("风格描述（文字）", fontSize = 13.sp, fontWeight = FontWeight.Bold)
                    if (!expanded) {
                        Text(
                            promptText.ifBlank { "未填写" },
                            fontSize = 10.sp, color = Color.Gray, maxLines = 1, overflow = TextOverflow.Ellipsis
                        )
                    }
                }
                Icon(if (expanded) AppIcons.ExpandLess else AppIcons.ExpandMore, null, tint = Color.Gray)
            }
            if (expanded) {
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = promptText,
                onValueChange = { onPromptChange(it); },
                modifier = Modifier.fillMaxWidth(),
                placeholder = { Text("例如：圆角方形底、深色背景、主体用发光的霓虹线条勾勒", fontSize = 12.sp) },
                minLines = 2, maxLines = 5
            )
            Spacer(Modifier.height(6.dp))
            Text("快捷预设", fontSize = 11.sp, color = Color.Gray)
            Spacer(Modifier.height(4.dp))
            LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                items(presets) { p ->
                    FilterChip(
                        selected = presetId == p.id,
                        onClick = { onPresetPick(p) },
                        label = { Text(p.name, fontSize = 10.sp) },
                        modifier = Modifier.height(28.dp)
                    )
                }
            }
            Spacer(Modifier.height(6.dp))

            // 拟物化最有效的用法：先让文字模型把「拟物化」展开成具体的材质/光影/配色，
            // 再把这段描述连同原图标一起交给生图模型。一句话的「做成拟物化」出图很泛。
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedButton(
                    onClick = onGenerateSkeuoPrompt,
                    enabled = !skeuoLoading && deepSeekReady,
                    contentPadding = PaddingValues(horizontal = 10.dp),
                    modifier = Modifier.height(32.dp)
                ) {
                    if (skeuoLoading) {
                        CircularProgressIndicator(Modifier.size(13.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.width(6.dp))
                    }
                    Text(if (skeuoLoading) "正在写…" else "DeepSeek 写拟物化描述", fontSize = 11.sp)
                }
                Spacer(Modifier.width(8.dp))
                Text(
                    if (!deepSeekReady) "先在「设置」里填 DeepSeek Key"
                    else "把「拟物化」拆成材质/光影/配色，再交给生图模型",
                    fontSize = 9.sp, color = if (deepSeekReady) Color.Gray else Color(0xFFFF9800),
                    modifier = Modifier.weight(1f)
                )
            }
            skeuoError?.let {
                Text(it, fontSize = 10.sp, color = MaterialTheme.colorScheme.error)
            }

            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(
                    checked = useStyleRef && providerSupportsStyleRef,
                    onCheckedChange = { onUseStyleRefChange(it) },
                    enabled = providerSupportsStyleRef
                )
                Column(Modifier.weight(1f)) {
                    Text("同时把风格参考图发给模型", fontSize = 12.sp)
                    Text(
                        if (providerSupportsStyleRef) {
                            val n = styleRef?.name ?: "未选择"
                            "当前：$n（点这里更换：右侧按钮）"
                        } else {
                            "当前服务商只接受一张输入图，传不了风格参考图（Gemini / OpenAI 可以）"
                        },
                        fontSize = 10.sp,
                        color = if (providerSupportsStyleRef) Color.Gray else Color(0xFFFF9800)
                    )
                }
                if (providerSupportsStyleRef) {
                    TextButton(onClick = onOpenLibrary) { Text("选择", fontSize = 12.sp) }
                }
            }
            }
        }
    }
}

// =====================================================================
// 风格库弹窗
// =====================================================================

@Composable
private fun StyleLibraryDialog(
    styles: List<StyleRef>,
    selectedId: String?,
    styleLibrary: StyleLibrary,
    onImport: () -> Unit,
    onDelete: (StyleRef) -> Unit,
    onSelect: (StyleRef) -> Unit,
    onDismiss: () -> Unit
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("风格库", fontWeight = FontWeight.Bold) },
        text = {
            Column(Modifier.fillMaxWidth().heightIn(max = 420.dp).verticalScroll(rememberScrollState())) {
                Text(
                    "选一张图作为风格基准，之后所有图标都会按它的色彩风格迁移。" +
                        "内置的几张是程序生成的参考图，可以直接用，也可以用你自己的图片替换。",
                    fontSize = 11.sp, color = Color.Gray
                )
                Spacer(Modifier.height(10.dp))
                styles.forEach { ref ->
                    StyleRow(
                        ref = ref,
                        selected = ref.id == selectedId,
                        styleLibrary = styleLibrary,
                        onSelect = { onSelect(ref) },
                        onDelete = { onDelete(ref) }
                    )
                    Spacer(Modifier.height(6.dp))
                }
                if (styles.isEmpty()) {
                    Text("风格库是空的，先导入一张图片。", fontSize = 12.sp, color = Color.Gray)
                }
            }
        },
        confirmButton = { Button(onClick = onImport) { Text("导入图片") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("关闭") } }
    )
}

@Composable
private fun StyleRow(
    ref: StyleRef,
    selected: Boolean,
    styleLibrary: StyleLibrary,
    onSelect: () -> Unit,
    onDelete: () -> Unit
) {
    val img by produceState<ImageBitmap?>(null, ref.id) {
        value = withContext(Dispatchers.IO) {
            styleLibrary.loadBitmap(ref)?.let { bmp ->
                val small = Bitmap.createScaledBitmap(bmp, 64, 64, true)
                if (small !== bmp) bmp.recycle()
                small.asImageBitmap()
            }
        }
    }
    Row(
        modifier = Modifier.fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(if (selected) MaterialTheme.colorScheme.primaryContainer else Color.Transparent)
            .clickable { onSelect() }
            .padding(8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(
            modifier = Modifier.size(48.dp).clip(RoundedCornerShape(8.dp)).background(Color(0xFFEDEDED)),
            contentAlignment = Alignment.Center
        ) {
            val i = img
            if (i != null) Image(i, ref.name, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
        }
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(ref.name, fontSize = 13.sp, fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal)
            Text(if (ref.builtIn) "内置" else "我的图片", fontSize = 10.sp, color = Color.Gray)
        }
        if (selected) {
            Icon(Icons.Default.CheckCircle, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(4.dp))
        }
        if (!ref.builtIn) {
            IconButton(onClick = onDelete, modifier = Modifier.size(32.dp)) {
                Icon(Icons.Default.Delete, null, tint = Color.Gray, modifier = Modifier.size(18.dp))
            }
        }
    }
}

// =====================================================================
// 列表项 / 服务商配置弹窗
// =====================================================================

@Composable
private fun AppIconRow(
    entry: AppIconEntry,
    showOriginal: Boolean,
    appService: AppInfoService,
    onGenerate: () -> Unit,
    /** 紧凑模式：只留图标 + 名称 + 状态，隐藏包名与错误详情，行高约减半 */
    compact: Boolean = false
) {
    val bitmap by produceState<Bitmap?>(null, entry.packageName, entry.generatedBase64, showOriginal) {
        value = withContext(Dispatchers.IO) {
            try {
                val b64 = if (showOriginal) {
                    appService.loadAppIcon(entry.packageName, size = 64, quality = 80)
                } else {
                    entry.generatedBase64 ?: appService.loadAppIcon(entry.packageName, size = 64, quality = 80)
                }
                if (b64 == null) null else {
                    val bytes = android.util.Base64.decode(b64, android.util.Base64.DEFAULT)
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                }
            } catch (e: Exception) { null }
        }
    }
    val image: ImageBitmap? = remember(bitmap) { bitmap?.asImageBitmap() }

    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(10.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f))
    ) {
        val iconSize = if (compact) 36.dp else 46.dp
        val pad = if (compact) 6.dp else 8.dp
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = pad),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Box(
                modifier = Modifier.size(iconSize).clip(RoundedCornerShape(9.dp)).background(Color(0xFFF0F0F0)),
                contentAlignment = Alignment.Center
            ) {
                if (image != null) {
                    Image(image, entry.appName, Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
                } else {
                    Icon(AppIcons.Android, null, tint = Color.Gray, modifier = Modifier.size(if (compact) 18.dp else 24.dp))
                }
            }
            Spacer(Modifier.width(if (compact) 8.dp else 10.dp))
            Column(Modifier.weight(1f)) {
                Text(entry.appName, fontSize = if (compact) 13.sp else 14.sp,
                    fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)

                val (statusText, statusColor) = when (entry.status) {
                    AppIconEntry.STATUS_DONE -> "已生成" to Color(0xFF4CAF50)
                    AppIconEntry.STATUS_FAILED -> "失败" to Color(0xFFE53935)
                    else -> "待生成" to Color.Gray
                }
                if (compact) {
                    // 紧凑模式：名称 + 状态挤在同一行，包名与错误详情都收起来
                    Text(statusText, fontSize = 9.sp, color = statusColor, maxLines = 1)
                } else {
                    Text(entry.packageName, fontSize = 10.sp, color = Color.Gray,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(statusText, fontSize = 10.sp, color = statusColor)
                    entry.error?.let {
                        Text(it, fontSize = 9.sp, color = Color(0xFFE53935), maxLines = 2,
                            overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            IconButton(onClick = onGenerate, modifier = Modifier.size(if (compact) 30.dp else 34.dp)) {
                Icon(
                    if (entry.status == AppIconEntry.STATUS_DONE) Icons.Default.Refresh else AppIcons.AutoAwesome,
                    if (entry.status == AppIconEntry.STATUS_DONE) "重新生成" else "生成",
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(if (compact) 17.dp else 19.dp)
                )
            }
        }
    }
}

@Composable
private fun ImageApiDialog(
    prefs: PreferencesManager,
    currentEngineId: String,
    onDismiss: () -> Unit,
    onSaved: (String) -> Unit
) {
    var selected by remember { mutableStateOf(currentEngineId) }
    val provider = ImageGenProviders.byId(selected)

    var apiKey by remember(selected) { mutableStateOf(prefs.getImageApiKey(selected)) }
    var model by remember(selected) { mutableStateOf(prefs.getImageModel(selected)) }
    var baseUrl by remember(selected) { mutableStateOf(prefs.getImageBaseUrl(selected)) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("图标生成引擎", fontWeight = FontWeight.Bold) },
        text = {
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState())) {
                Text("选择引擎", fontSize = 13.sp, fontWeight = FontWeight.Medium)
                Spacer(Modifier.height(6.dp))
                ImageGenProviders.allIds.forEach { id ->
                    Row(
                        modifier = Modifier.fillMaxWidth().clickable { selected = id }.padding(vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        RadioButton(selected = selected == id, onClick = { selected = id })
                        Text(
                            ImageGenProviders.displayNameOf(id),
                            fontSize = 13.sp,
                            fontWeight = if (selected == id) FontWeight.Bold else FontWeight.Normal
                        )
                    }
                }

                if (provider == null) {
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "本地风格迁移：输入「风格参考图 + 原图标」，输出新图标。" +
                            "在区间色彩空间（lαβ）里把原图标的色彩统计替换成风格图的，结构完全保留。" +
                            "不联网、零成本、离线可用。",
                        fontSize = 11.sp, color = Color.Gray
                    )
                } else {
                    Spacer(Modifier.height(10.dp))
                    HorizontalDivider()
                    Spacer(Modifier.height(10.dp))
                    Text("API Key", fontSize = 13.sp, fontWeight = FontWeight.Medium)
                    Spacer(Modifier.height(6.dp))
                    OutlinedTextField(
                        value = apiKey, onValueChange = { apiKey = it },
                        modifier = Modifier.fillMaxWidth(),
                        placeholder = { Text(provider.keyHint, fontSize = 11.sp) },
                        singleLine = true
                    )
                    Spacer(Modifier.height(4.dp))
                    Text("申请地址：${provider.applyUrl}", fontSize = 10.sp, color = MaterialTheme.colorScheme.primary)

                    Spacer(Modifier.height(10.dp))
                    Text("模型", fontSize = 13.sp, fontWeight = FontWeight.Medium)
                    Spacer(Modifier.height(6.dp))
                    OutlinedTextField(
                        value = model, onValueChange = { model = it },
                        modifier = Modifier.fillMaxWidth(),
                        placeholder = { Text(provider.modelHint, fontSize = 11.sp) },
                        singleLine = true
                    )

                    Spacer(Modifier.height(10.dp))
                    Text("网关地址（一般不用改）", fontSize = 13.sp, fontWeight = FontWeight.Medium)
                    Spacer(Modifier.height(6.dp))
                    OutlinedTextField(
                        value = baseUrl, onValueChange = { baseUrl = it },
                        modifier = Modifier.fillMaxWidth(),
                        placeholder = { Text(provider.defaultBaseUrl, fontSize = 11.sp) },
                        singleLine = true
                    )
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "Key 只保存在本机，不会打进 APK。" +
                            (if (provider.promptLimit > 0) "该服务提示词上限约 ${provider.promptLimit} 字，超长会自动截断。" else "") +
                            (if (provider.maxReferenceImages > 1) " 支持同时传风格参考图。" else " 只接受一张输入图，不能传风格参考图。"),
                        fontSize = 10.sp, color = Color.Gray
                    )
                }
            }
        },
        confirmButton = {
            Button(onClick = {
                prefs.setImageProviderId(selected)
                if (selected != ImageGenProviders.LOCAL_ID) {
                    prefs.setImageApiKey(selected, apiKey)
                    prefs.setImageModel(selected, model)
                    prefs.setImageBaseUrl(selected, baseUrl)
                }
                onSaved(selected)
            }) { Text("保存") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } }
    )
}
