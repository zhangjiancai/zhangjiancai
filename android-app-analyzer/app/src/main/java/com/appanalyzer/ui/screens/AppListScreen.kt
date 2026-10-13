package com.appanalyzer.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.appanalyzer.data.model.AppInfo
import com.appanalyzer.service.AppInfoService
import com.appanalyzer.ui.components.AppItem
import kotlinx.coroutines.delay
import com.appanalyzer.ui.icons.AppIcons
import androidx.compose.material.icons.filled.*

private enum class SortOption(val label: String) {
    SIZE_DESC("大小↓"), SIZE_ASC("大小↑"), NAME_ASC("名称↑"), NAME_DESC("名称↓"), CATEGORY("分类")
}

@Composable
fun AppListScreen(
    apps: List<AppInfo>,
    isLoading: Boolean,
    searchQuery: String,
    showSystemApps: Boolean,
    onSearchQueryChange: (String) -> Unit,
    onShowSystemAppsChange: (Boolean) -> Unit,
    /** 由 MainScreen 传入的唯一实例，避免每个列表项各建一个（原来 258 项就是 258 个） */
    appService: AppInfoService,
    /** 「重试」必须真的重新加载数据；以前它只是清搜索词 + 反转系统应用开关，什么也没刷新 */
    onRetry: () -> Unit
) {
    var selectedCategory by remember { mutableStateOf("全部") }
    var sortOption by remember { mutableStateOf(SortOption.SIZE_DESC) }
    var showSortMenu by remember { mutableStateOf(false) }
    var debouncedQuery by remember { mutableStateOf(searchQuery) }

    // 自动隐藏状态
    var searchExpanded by remember { mutableStateOf(false) }
    var filterExpanded by remember { mutableStateOf(false) }
    var categoryExpanded by remember { mutableStateOf(false) }

    LaunchedEffect(searchQuery) {
        delay(300L)
        debouncedQuery = searchQuery
    }

    Column(modifier = Modifier.fillMaxSize()) {
        // ═══ 工具栏（紧凑一行） ═══
        Surface(
            modifier = Modifier.fillMaxWidth(),
            shadowElevation = 1.dp,
            color = MaterialTheme.colorScheme.surface
        ) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                // 搜索按钮（默认收起，点开变输入框）
                if (!searchExpanded) {
                    IconButton(onClick = { searchExpanded = true }, modifier = Modifier.size(36.dp)) {
                        Icon(Icons.Default.Search, "搜索", tint = Color.Gray, modifier = Modifier.size(20.dp))
                    }
                }

                Spacer(modifier = Modifier.weight(1f))

                // 筛选按钮（以前这里三元表达式的两个分支写的是同一个图标，展开与否图标都不变）
                IconButton(onClick = { filterExpanded = !filterExpanded }, modifier = Modifier.size(36.dp)) {
                    Icon(
                        if (filterExpanded) AppIcons.FilterAlt else AppIcons.FilterAltOff,
                        "筛选",
                        modifier = Modifier.size(20.dp),
                        tint = if (filterExpanded) MaterialTheme.colorScheme.primary else Color.Gray
                    )
                }

                // 分类按钮（始终显示）
                Surface(
                        shape = RoundedCornerShape(16.dp),
                        color = if (categoryExpanded) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant,
                        onClick = { categoryExpanded = !categoryExpanded }
                    ) {
                        Row(
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Icon(
                                AppIcons.Category,
                                contentDescription = null,
                                modifier = Modifier.size(14.dp),
                                tint = MaterialTheme.colorScheme.primary
                            )
                            Spacer(modifier = Modifier.width(4.dp))
                            Text(
                                selectedCategory.take(4),
                                fontSize = 12.sp,
                                color = MaterialTheme.colorScheme.primary
                            )
                            Icon(
                                if (categoryExpanded) AppIcons.ExpandLess else AppIcons.ExpandMore,
                                contentDescription = null,
                                modifier = Modifier.size(16.dp),
                                tint = MaterialTheme.colorScheme.primary
                            )
                        }
                    }
                    Spacer(modifier = Modifier.width(4.dp))

                // 排序
                Box {
                    IconButton(onClick = { showSortMenu = true }, modifier = Modifier.size(36.dp)) {
                        Icon(AppIcons.Sort, "排序", tint = Color.Gray, modifier = Modifier.size(20.dp))
                    }
                    DropdownMenu(expanded = showSortMenu, onDismissRequest = { showSortMenu = false }) {
                        SortOption.values().forEach { opt ->
                            DropdownMenuItem(
                                text = {
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        if (sortOption == opt) {
                                            Icon(Icons.Default.Check, null, modifier = Modifier.size(16.dp),
                                                tint = MaterialTheme.colorScheme.primary)
                                            Spacer(modifier = Modifier.width(4.dp))
                                        }
                                        Text(opt.label, fontWeight = if (sortOption == opt) FontWeight.Bold else FontWeight.Normal, fontSize = 14.sp)
                                    }
                                },
                                onClick = { sortOption = opt; showSortMenu = false }
                            )
                        }
                    }
                }

                // 应用计数 Badge
                Surface(
                    shape = RoundedCornerShape(10.dp),
                    color = MaterialTheme.colorScheme.primaryContainer
                ) {
                    Text(
                        "${apps.size}",
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.primary,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp)
                    )
                }
            }
        }

        // ═══ 搜索栏（展开时显示） ═══
        AnimatedVisibility(visible = searchExpanded, enter = expandVertically(), exit = shrinkVertically()) {
            OutlinedTextField(
                value = searchQuery,
                onValueChange = onSearchQueryChange,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 2.dp),
                placeholder = { Text("搜索应用名或包名...", fontSize = 13.sp) },
                singleLine = true,
                leadingIcon = { Icon(Icons.Default.Search, null, modifier = Modifier.size(18.dp)) },
                trailingIcon = {
                    Row {
                        if (searchQuery.isNotEmpty()) {
                            IconButton(onClick = { onSearchQueryChange("") }) {
                                Icon(Icons.Default.Clear, "清除")
                            }
                        }
                        IconButton(onClick = {
                            if (searchQuery.isEmpty()) searchExpanded = false
                            else onSearchQueryChange("")
                        }) {
                            Icon(Icons.Default.Close, "收起")
                        }
                    }
                }
            )
        }

        // ═══ 筛选面板（展开时显示） ═══
        AnimatedVisibility(visible = filterExpanded, enter = expandVertically(), exit = shrinkVertically()) {
            Card(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text("系统应用", fontSize = 13.sp)
                    Spacer(modifier = Modifier.width(8.dp))
                    Switch(
                        checked = showSystemApps,
                        onCheckedChange = onShowSystemAppsChange,
                        modifier = Modifier.height(24.dp)
                    )
                    Spacer(modifier = Modifier.weight(1f))
                    Text(
                        if (showSystemApps) "已显示系统应用" else "已隐藏系统应用",
                        fontSize = 11.sp, color = Color.Gray
                    )
                }
            }
        }

        // ═══ 分类筛选（展开时显示） ═══
        AnimatedVisibility(visible = categoryExpanded, enter = expandVertically(), exit = shrinkVertically()) {
            val categories = remember(apps) { apps.map { it.category }.distinct().sorted() }
            LazyRow(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                item {
                    FilterChip(
                        selected = selectedCategory == "全部",
                        onClick = { selectedCategory = "全部" },
                        label = { Text("全部", fontSize = 11.sp) },
                        modifier = Modifier.height(28.dp)
                    )
                }
                items(categories) { category ->
                    FilterChip(
                        selected = selectedCategory == category,
                        onClick = { selectedCategory = category },
                        label = { Text(category, fontSize = 11.sp) },
                        modifier = Modifier.height(28.dp)
                    )
                }
            }
        }

        // ═══ 内容区 ═══
        if (isLoading) {
            Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    CircularProgressIndicator()
                    Spacer(modifier = Modifier.height(16.dp))
                    Text("正在加载...", color = Color.Gray)
                }
            }
        } else if (apps.isEmpty()) {
            Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Default.Info, null, modifier = Modifier.size(48.dp), tint = Color.Gray)
                    Spacer(modifier = Modifier.height(12.dp))
                    Text("暂无应用数据", fontSize = 16.sp, color = Color.Gray)
                    Spacer(modifier = Modifier.height(8.dp))
                    OutlinedButton(onClick = onRetry) {
                        Icon(Icons.Default.Refresh, null, modifier = Modifier.size(16.dp))
                        Spacer(modifier = Modifier.width(4.dp))
                        Text("重新加载")
                    }
                }
            }
        } else {
            val filteredApps = remember(apps, debouncedQuery, showSystemApps) {
                apps.filter { app ->
                    (app.appName.contains(debouncedQuery, true) || app.packageName.contains(debouncedQuery, true))
                        && (showSystemApps || !app.isSystemApp)
                }
            }
            val sortedApps = remember(filteredApps, sortOption) {
                when (sortOption) {
                    SortOption.SIZE_DESC -> filteredApps.sortedByDescending { it.totalSize }
                    SortOption.SIZE_ASC -> filteredApps.sortedBy { it.totalSize }
                    SortOption.NAME_ASC -> filteredApps.sortedBy { it.appName.lowercase() }
                    SortOption.NAME_DESC -> filteredApps.sortedByDescending { it.appName.lowercase() }
                    SortOption.CATEGORY -> filteredApps.sortedBy { it.category }
                }
            }
            val displayApps = if (selectedCategory == "全部") sortedApps
                else sortedApps.filter { it.category == selectedCategory }

            if (displayApps.isEmpty()) {
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Icon(AppIcons.SearchOff, null, modifier = Modifier.size(48.dp), tint = Color.Gray)
                        Spacer(modifier = Modifier.height(12.dp))
                        Text(if (debouncedQuery.isNotEmpty()) "无匹配「$debouncedQuery」" else "无应用", fontSize = 14.sp, color = Color.Gray)
                    }
                }
            } else {
                // 显示计数（选中分类时）
                if (selectedCategory != "全部") {
                    Surface(
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                        color = MaterialTheme.colorScheme.primaryContainer,
                        shape = RoundedCornerShape(8.dp)
                    ) {
                        Text(
                            "$selectedCategory: ${displayApps.size} 个",
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 3.dp),
                            fontSize = 12.sp, color = MaterialTheme.colorScheme.primary
                        )
                    }
                }
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    // 每个条目本身就是一张卡片，条目之间再留 8dp 会让 258 个应用
                    // 白白多出 2000dp 的空白。压到 3dp 只作为卡片分隔。
                    contentPadding = PaddingValues(horizontal = 6.dp, vertical = 2.dp),
                    verticalArrangement = Arrangement.spacedBy(3.dp)
                ) {
                    items(displayApps, key = { it.packageName }) { app ->
                        AppItem(app = app, appService = appService)
                    }
                }
            }
        }
    }
}

private val AppInfo.totalSize: Long get() = appSize + cacheSize + dataSize