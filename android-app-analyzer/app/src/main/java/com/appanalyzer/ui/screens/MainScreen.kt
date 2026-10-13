package com.appanalyzer.ui.screens

import android.content.Intent
import android.provider.Settings
import com.appanalyzer.service.DebugLogger
import androidx.compose.animation.*
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import com.appanalyzer.data.model.AppInfo
import com.appanalyzer.data.model.StatisticsInfo
import com.appanalyzer.service.AnalysisService
import com.appanalyzer.service.AppInfoService
import com.appanalyzer.service.PreferencesManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import com.appanalyzer.ui.icons.AppIcons
import com.appanalyzer.ui.util.AdaptiveScaffold
import androidx.compose.material.icons.filled.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainScreen() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val lifecycleOwner = LocalLifecycleOwner.current

    var selectedTab by remember { mutableStateOf(0) }
    var apps by remember { mutableStateOf<List<AppInfo>>(emptyList()) }
    var statistics by remember { mutableStateOf<StatisticsInfo?>(null) }
    var isLoading by remember { mutableStateOf(false) }
    var searchQuery by remember { mutableStateOf("") }
    var showSystemApps by remember { mutableStateOf(false) }
    // 三态：null 表示「还没检测过」。
    // 以前这里初值是 true，紧接着又被改成 false，而加载逻辑挂在这个状态上当 key，
    // 结果整个「枚举全部应用 + 调 AI」的流程会完整跑两遍（实测日志里同一毫秒出现两行）。
    var hasStoragePermission by remember { mutableStateOf<Boolean?>(null) }
    var showPermissionDialog by remember { mutableStateOf(false) }
    var showSettingsDialog by remember { mutableStateOf(false) }
    var showAbout by remember { mutableStateOf(false) }
    var permissionCardDismissed by remember { mutableStateOf(false) }
    var tabBarVisible by remember { mutableStateOf(true) }
    var aiStatus by remember { mutableStateOf("") }

    val appService = remember { AppInfoService(context) }
    val prefsManager = remember { PreferencesManager(context) }

    /**
     * 唯一的加载逻辑。
     *
     * 以前这段代码在文件里被逐行复制了三份（首次加载 / 设置保存后 / 手动刷新），
     * 改一处漏两处几乎是必然的。现在只有这一份。
     *
     * 注意：Compose 状态的赋值全部在主线程完成，IO 只负责取数据。
     */
    suspend fun loadData(forceAiRefresh: Boolean) {
        // 记一行日志，「一次启动到底加载了几次」在日志里可以直接数出来。
        // （修掉重复加载之前，这里每次启动都会出现两行。）
        DebugLogger.d("▶ 开始加载应用列表 (forceAi=$forceAiRefresh, 权限=$hasStoragePermission)")
        isLoading = true
        try {
            val loadedApps = withContext(Dispatchers.IO) { appService.getAllInstalledApps() }
            apps = loadedApps
            statistics = AnalysisService().calculateStatistics(loadedApps)

            if (!prefsManager.hasApiKey()) {
                aiStatus = ""
                return
            }
            aiStatus = "AI分类中..."
            val aiMap = withContext(Dispatchers.IO) {
                appService.enhanceWithAI(loadedApps, forceRefresh = forceAiRefresh)
            }
            if (aiMap.isEmpty()) {
                aiStatus = ""
                return
            }
            // covered 才是「有多少个应用真的拿到了分类」。
            // 以前显示的是映射条数（= 不重名的应用名个数），在 258 个应用的机器上
            // 会显示成 200，凭空少了 58 个，属于口径错误。
            val (withAi, covered) = appService.applyAiCategories(loadedApps, aiMap)
            apps = withAi
            statistics = AnalysisService().calculateStatistics(withAi)
            aiStatus = "AI: ${covered}个已分类"
        } catch (e: Exception) {
            DebugLogger.e("加载失败: ${e.message}", e)
        } finally {
            isLoading = false
        }
    }

    // 启动检测一次权限。检测完才把 hasStoragePermission 从 null 变成具体值，
    // 下面那个 LaunchedEffect 因此只会触发一次加载。
    LaunchedEffect(Unit) {
        val granted = withContext(Dispatchers.IO) { appService.hasStorageStatsPermission() }
        hasStoragePermission = granted
        if (!granted) showPermissionDialog = true
    }

    // 依赖 hasStoragePermission 而不是 Unit：
    // 用户在系统设置里授权后回到应用，这个值从 false 变 true，会自动重新加载。
    LaunchedEffect(hasStoragePermission) {
        if (hasStoragePermission == null) return@LaunchedEffect
        loadData(forceAiRefresh = false)
    }

    // 从系统设置返回时重新检测权限。
    // 以前完全没有这段：用户按引导授完权回到应用，横幅还在、数据还是旧的，
    // 必须自己发现右上角的刷新按钮。这对首次使用是致命的。
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                scope.launch {
                    val granted = withContext(Dispatchers.IO) { appService.hasStorageStatsPermission() }
                    if (granted != hasStoragePermission) {
                        DebugLogger.d("权限状态变化: $hasStoragePermission → $granted，自动重新加载")
                        permissionCardDismissed = false
                        hasStoragePermission = granted
                    }
                }
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    if (showPermissionDialog) {
        AlertDialog(
            onDismissRequest = { showPermissionDialog = false },
            title = { Text("需要权限", fontWeight = FontWeight.Bold) },
            text = {
                Column {
                    Text("需要「使用情况访问」权限才能显示缓存和数据大小。")
                    Spacer(modifier = Modifier.height(8.dp))
                    Text("设置 → 使用情况访问 → 开启 App Analyzer", fontSize = 13.sp)
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        "⚠️ 不授权也能用，但缓存/数据会显示为「—」（不会用估算值代替）",
                        fontSize = 11.sp, color = Color.Gray
                    )
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    showPermissionDialog = false
                    openUsageAccessSettings(context)
                }) { Text("去授权") }
            },
            dismissButton = {
                TextButton(onClick = { showPermissionDialog = false }) { Text("暂不") }
            }
        )
    }

    if (showAbout) {
        AboutScreen(onBack = { showAbout = false })
        return
    }

    if (showSettingsDialog) {
        SettingsDialog(
            onDismiss = { showSettingsDialog = false },
            onSaved = {
                showSettingsDialog = false
                scope.launch { loadData(forceAiRefresh = true) }
            },
            onOpenAbout = { showAbout = true }
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("App Analyzer", fontWeight = FontWeight.Bold)
                    if (aiStatus.isNotEmpty()) {
                        Spacer(Modifier.width(8.dp))
                        Surface(shape = RoundedCornerShape(8.dp), color = Color.White.copy(alpha = 0.2f)) {
                            Text(aiStatus, modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp), fontSize = 10.sp, color = Color.White)
                        }
                    }
                }},
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.primary, titleContentColor = Color.White),
                actions = {
                    IconButton(onClick = { tabBarVisible = !tabBarVisible }) {
                        Icon(if (tabBarVisible) Icons.Default.KeyboardArrowUp else Icons.Default.KeyboardArrowDown, "隐藏tab", tint = Color.White)
                    }
                    // 「关于」已按用户要求挪进设置界面里（顶栏不再放 Info 图标）
                    IconButton(onClick = { showSettingsDialog = true }) {
                        Icon(Icons.Default.Settings, "设置", tint = Color.White)
                    }
                    IconButton(onClick = {
                        scope.launch { loadData(forceAiRefresh = true) }
                    }) {
                        Icon(Icons.Default.Refresh, "刷新", tint = Color.White)
                    }
                }
            )
        }
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding)) {
            // TabRow with collapse animation
            AnimatedVisibility(visible = tabBarVisible, enter = expandVertically(), exit = shrinkVertically()) {
                // 只留文字、不放图标：带图标的 Tab 行高约 72dp，去掉后约 48dp，
                // 六个 tab 的标签都是两个字，文字本身足够区分。
                TabRow(selectedTabIndex = selectedTab, containerColor = MaterialTheme.colorScheme.surface) {
                    Tab(selectedTab == 0, { selectedTab = 0 }, text = { Text("列表", fontSize = 13.sp, maxLines = 1) })
                    Tab(selectedTab == 1, { selectedTab = 1 }, text = { Text("统计", fontSize = 13.sp, maxLines = 1) })
                    Tab(selectedTab == 2, { selectedTab = 2 }, text = { Text("存储", fontSize = 13.sp, maxLines = 1) })
                    Tab(selectedTab == 3, { selectedTab = 3 }, text = { Text("图表", fontSize = 13.sp, maxLines = 1) })
                    Tab(selectedTab == 4, { selectedTab = 4 }, text = { Text("日志", fontSize = 13.sp, maxLines = 1) })
                    Tab(selectedTab == 5, { selectedTab = 5 }, text = { Text("图标", fontSize = 13.sp, maxLines = 1) })
                }
            }

            // Permission banner (dismissable)
            AnimatedVisibility(visible = hasStoragePermission == false && !permissionCardDismissed) {
                // 压成一条：以前是「图标 + 两行文字 + 授权按钮 + 关闭按钮」的卡片，
                // 光这一条就吃掉约 70dp，相当于少看一个应用。
                Surface(color = MaterialTheme.colorScheme.errorContainer, modifier = Modifier.fillMaxWidth()) {
                    Row(
                        Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp, top = 2.dp, bottom = 2.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Icon(Icons.Default.Warning, null, tint = MaterialTheme.colorScheme.onErrorContainer, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("无存储权限，缓存/数据显示为「—」", fontSize = 11.sp, color = MaterialTheme.colorScheme.onErrorContainer, maxLines = 1, modifier = Modifier.weight(1f))
                        TextButton(
                            onClick = { openUsageAccessSettings(context) },
                            contentPadding = PaddingValues(horizontal = 10.dp, vertical = 0.dp),
                            modifier = Modifier.height(30.dp)
                        ) { Text("授权", fontSize = 12.sp) }
                        IconButton(onClick = { permissionCardDismissed = true }, modifier = Modifier.size(30.dp)) {
                            Icon(Icons.Default.Close, null, modifier = Modifier.size(14.dp))
                        }
                    }
                }
            }

            // Skeleton loading
            // 自适应：手机上 maxWidth < 720dp，等于没有影响；
            // 平板/展开的大折叠上把内容限宽居中，避免一行文字被拉满整块屏幕。
            if (isLoading && apps.isEmpty()) {
                LazyLoadingSkeleton()
            } else {
                AdaptiveScaffold {
                when (selectedTab) {
                    0 -> AppListScreen(
                        apps = apps,
                        isLoading = isLoading,
                        searchQuery = searchQuery,
                        showSystemApps = showSystemApps,
                        onSearchQueryChange = { searchQuery = it },
                        onShowSystemAppsChange = { showSystemApps = it },
                        appService = appService,
                        onRetry = { scope.launch { loadData(forceAiRefresh = false) } }
                    )
                    1 -> StatisticsScreen(statistics, apps, isLoading)
                    2 -> StorageAnalysisScreen(statistics, apps, isLoading, hasStoragePermission == true)
                    3 -> ChartScreen(apps)
                    4 -> DebugLogScreen()
                    5 -> IconReplaceScreen(apps = apps, appService = appService)
                }
                }
            }
        }
    }
}

/**
 * 跳转到「使用情况访问」设置页。
 * 以前横幅上那个按钮的 catch 体是空的，失败时什么都不会发生，用户只会以为按钮坏了。
 */
private fun openUsageAccessSettings(context: android.content.Context) {
    try {
        context.startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS))
    } catch (e: Exception) {
        DebugLogger.w("打开使用情况访问设置失败，回退到设置首页: ${e.message}")
        try {
            context.startActivity(Intent(Settings.ACTION_SETTINGS))
        } catch (e2: Exception) {
            DebugLogger.e("连设置首页都打不开", e2)
        }
    }
}

@Composable
private fun LazyLoadingSkeleton() {
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        repeat(6) {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp)) {
                    Box(Modifier.fillMaxWidth(0.6f).height(16.dp).clip(RoundedCornerShape(4.dp))
                        .background(Brush.horizontalGradient(listOf(Color(0xFFE0E0E0), Color(0xFFF5F5F5)))))
                    Spacer(Modifier.height(8.dp))
                    Box(Modifier.fillMaxWidth(0.3f).height(12.dp).clip(RoundedCornerShape(4.dp))
                        .background(Brush.horizontalGradient(listOf(Color(0xFFE0E0E0), Color(0xFFF5F5F5)))))
                }
            }
        }
    }
}