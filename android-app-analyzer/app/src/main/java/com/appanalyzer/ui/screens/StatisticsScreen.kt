package com.appanalyzer.ui.screens

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.appanalyzer.data.model.AppInfo
import com.appanalyzer.data.model.StatisticsInfo
import com.appanalyzer.ui.components.StatItem
import com.appanalyzer.ui.components.StatRow
import com.appanalyzer.ui.util.formatFileSize
import com.appanalyzer.ui.util.formatFileSizeOrUnknown
import java.text.NumberFormat
import java.util.Locale
import com.appanalyzer.ui.icons.AppIcons
import androidx.compose.material.icons.filled.*

/**
 * 数字格式化：超过1000时加千位分隔符
 */
private fun formatNumber(n: Int): String {
    return NumberFormat.getNumberInstance(Locale.getDefault()).format(n)
}

@Composable
fun StatisticsScreen(statistics: StatisticsInfo?, apps: List<AppInfo>, isLoading: Boolean) {
    if (isLoading) {
        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
    } else if (statistics == null) {
        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text("暂无数据") }
    } else {
        // 隐藏系统应用开关
        var hideSystemApps by remember { mutableStateOf(false) }

        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(horizontal = 10.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            // 顶部筛选
            item {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    FilterChip(
                        selected = hideSystemApps,
                        onClick = { hideSystemApps = !hideSystemApps },
                        label = { Text("隐藏系统应用", fontSize = 13.sp) },
                        leadingIcon = if (hideSystemApps) {
                            { Icon(Icons.Default.Check, contentDescription = null, modifier = Modifier.size(16.dp)) }
                        } else null
                    )
                }
            }

            item {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)
                ) {
                    Column(modifier = Modifier.padding(12.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(AppIcons.Apps, contentDescription = null, modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(8.dp))
                            Text("应用总览", fontSize = 15.sp, fontWeight = FontWeight.Bold)
                        }
                        Spacer(modifier = Modifier.height(8.dp))
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceEvenly
                        ) {
                            @Suppress("DEPRECATION")
                            StatItem("总应用", formatNumber(statistics.totalApps), AppIcons.ListAlt)
                            StatItem("用户应用", formatNumber(statistics.userApps), Icons.Default.Person)
                            StatItem("系统应用", formatNumber(statistics.systemApps), AppIcons.Android)
                        }
                    }
                }
            }

            item {
                Card(modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.padding(10.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(AppIcons.Storage, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(8.dp))
                            Text("存储统计", fontSize = 14.sp, fontWeight = FontWeight.Bold)
                        }
                        Spacer(modifier = Modifier.height(8.dp))
                        StatRow("总安装大小", formatFileSize(statistics.totalSize), AppIcons.InstallDesktop)
                        @Suppress("DEPRECATION")
                        StatRow("平均大小", formatFileSize(statistics.averageSize), AppIcons.TrendingFlat)
                        // known=false 时显示「—」。以前无权限时会显示一个由 apkSize*0.2 之类
                        // 公式算出来的数字，用户完全无从分辨真假。
                        StatRow("缓存总大小",
                            formatFileSizeOrUnknown(statistics.totalCache, statistics.hasSizeDetail),
                            AppIcons.Cached)
                        StatRow("数据总大小",
                            formatFileSizeOrUnknown(statistics.totalData, statistics.hasSizeDetail),
                            AppIcons.DataUsage)
                        if (!statistics.hasSizeDetail) {
                            Spacer(modifier = Modifier.height(8.dp))
                            Text(
                                "⚠️ 未获取「使用情况访问」权限，缓存/数据无法读取，因此显示「—」。" +
                                    "这里不会用估算值填充。",
                                fontSize = 11.sp, color = Color(0xFFFF9800)
                            )
                        }
                    }
                }
            }

            item {
                Card(modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.padding(10.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Default.Star, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(8.dp))
                            Text("极值应用", fontSize = 14.sp, fontWeight = FontWeight.Bold)
                        }
                        Spacer(modifier = Modifier.height(16.dp))
                        if (statistics.maxSize == 0L) {
                            Text("暂无数据", color = Color.Gray, fontSize = 14.sp)
                        } else {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween
                            ) {
                                Column(modifier = Modifier.weight(1f)) {
                                    Text("🟢 最大应用", fontSize = 14.sp, fontWeight = FontWeight.Medium)
                                    Text(statistics.maxAppName, fontSize = 12.sp, color = Color.Gray, maxLines = 1)
                                    Text(formatFileSize(statistics.maxSize), fontSize = 16.sp,
                                        fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
                                }
                                Column(modifier = Modifier.weight(1f), horizontalAlignment = Alignment.End) {
                                    Text("🔴 最小应用", fontSize = 14.sp, fontWeight = FontWeight.Medium)
                                    Text(statistics.minAppName, fontSize = 12.sp, color = Color.Gray, maxLines = 1)
                                    Text(formatFileSize(statistics.minSize), fontSize = 16.sp,
                                        fontWeight = FontWeight.Bold, color = Color.Gray)
                                }
                            }
                        }
                    }
                }
            }

            // 分类分布统计
            item {
                Card(modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.padding(10.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(AppIcons.Category, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(8.dp))
                            Text("分类分布统计", fontSize = 18.sp, fontWeight = FontWeight.Bold)
                        }
                        Spacer(modifier = Modifier.height(12.dp))
                        val categoryDistribution = remember(apps) {
                            apps.groupBy { it.category }
                                .mapValues { it.value.size }
                                .toList()
                                .sortedByDescending { it.second }
                        }
                        if (categoryDistribution.isEmpty()) {
                            Text("暂无数据", color = Color.Gray, fontSize = 14.sp)
                        } else {
                            categoryDistribution.forEach { (category, count) ->
                                Row(
                                    modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Text(category, fontSize = 14.sp, modifier = Modifier.weight(1f))
                                    Text(
                                        "${formatNumber(count)} 个",
                                        fontSize = 14.sp,
                                        fontWeight = FontWeight.Bold,
                                        color = MaterialTheme.colorScheme.primary
                                    )
                                }
                            }
                        }
                    }
                }
            }

            // 缓存最多的应用 (可选隐藏系统)
            item {
                val displayApps = remember(apps, hideSystemApps) {
                    val filtered = if (hideSystemApps) apps.filter { !it.isSystemApp } else apps
                    filtered.sortedByDescending { it.cacheSize }.take(5)
                }
                Card(modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.padding(10.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(AppIcons.Cached, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(8.dp))
                            Text(
                                "缓存最多的应用 Top 5${if (hideSystemApps) "（用户应用）" else ""}",
                                fontSize = 18.sp, fontWeight = FontWeight.Bold
                            )
                        }
                        Spacer(modifier = Modifier.height(12.dp))
                        if (!statistics.hasSizeDetail) {
                            // 没有权限时每个应用的缓存都是 0，直接排名会得到一份毫无意义、
                            // 却看起来很权威的榜单。宁可不显示。
                            Text(
                                "未获取「使用情况访问」权限，无法统计各应用的缓存占用",
                                color = Color(0xFFFF9800), fontSize = 12.sp
                            )
                        } else if (displayApps.isEmpty()) {
                            Text("暂无数据", color = Color.Gray, fontSize = 14.sp)
                        } else {
                            displayApps.forEachIndexed { index, app ->
                                Row(
                                    modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Box(
                                            modifier = Modifier
                                                .size(28.dp)
                                                .clip(CircleShape)
                                                .background(
                                                    when (index) {
                                                        0 -> Color(0xFFFFD700)
                                                        1 -> Color(0xFFC0C0C0)
                                                        2 -> Color(0xFFCD7F32)
                                                        else -> Color.LightGray
                                                    }
                                                ),
                                            contentAlignment = Alignment.Center
                                        ) {
                                            Text("${index + 1}", fontSize = 12.sp, fontWeight = FontWeight.Bold)
                                        }
                                        Spacer(modifier = Modifier.width(8.dp))
                                        Text(app.appName, fontSize = 14.sp, modifier = Modifier.weight(1f), maxLines = 1)
                                    }
                                    Text(formatFileSize(app.cacheSize), fontSize = 14.sp,
                                        fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
                                }
                            }
                        }
                    }
                }
            }

            item {
                Card(modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.padding(10.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(AppIcons.PieChart, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(8.dp))
                            Text("应用大小分布", fontSize = 18.sp, fontWeight = FontWeight.Bold)
                        }
                        Spacer(modifier = Modifier.height(12.dp))
                        val distributionMap = remember(apps, hideSystemApps) {
                            val filtered = if (hideSystemApps) apps.filter { !it.isSystemApp } else apps
                            val map = mutableMapOf<String, Int>()
                            filtered.forEach { app ->
                                val total = app.appSize + app.cacheSize + app.dataSize
                                val sizeCategory = when {
                                    total < 10 * 1024 * 1024 -> "< 10MB"
                                    total < 50 * 1024 * 1024 -> "10-50MB"
                                    total < 100 * 1024 * 1024 -> "50-100MB"
                                    total < 500 * 1024 * 1024 -> "100-500MB"
                                    else -> "> 500MB"
                                }
                                map[sizeCategory] = (map[sizeCategory] ?: 0) + 1
                            }
                            map
                        }
                        val barColors = listOf(
                            Color(0xFF4CAF50), Color(0xFFFFEB3B), Color(0xFFFF9800),
                            Color(0xFFFF5722), Color(0xFFF44336)
                        )
                        val categoryOrder = listOf("< 10MB", "10-50MB", "50-100MB", "100-500MB", "> 500MB")
                        val displayAppCount = if (hideSystemApps) apps.count { !it.isSystemApp } else apps.size
                        Canvas(modifier = Modifier.fillMaxWidth().height(24.dp)) {
                            val w = size.width
                            val h = size.height
                            var offsetX = 0f
                            categoryOrder.forEachIndexed { index, category ->
                                val count = distributionMap[category] ?: 0
                                if (count > 0 && displayAppCount > 0) {
                                    val width = (count.toFloat() / displayAppCount) * w
                                    drawRect(
                                        color = barColors[index],
                                        topLeft = Offset(offsetX, 0f),
                                        size = androidx.compose.ui.geometry.Size(width, h)
                                    )
                                    offsetX += width
                                }
                            }
                        }
                        Spacer(modifier = Modifier.height(8.dp))
                        categoryOrder.forEachIndexed { index, category ->
                            val count = distributionMap[category] ?: 0
                            val pct = if (displayAppCount > 0) (count.toFloat() / displayAppCount * 100).toInt() else 0
                            Row(
                                modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Box(
                                    modifier = Modifier
                                        .size(12.dp)
                                        .clip(RoundedCornerShape(2.dp))
                                        .background(barColors[index])
                                )
                                Spacer(modifier = Modifier.width(8.dp))
                                Text(category, fontSize = 12.sp, modifier = Modifier.weight(1f))
                                Text("${formatNumber(count)} 个 ($pct%)", fontSize = 12.sp, fontWeight = FontWeight.Bold)
                            }
                        }
                    }
                }
            }
        }
    }
}