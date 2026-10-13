package com.appanalyzer.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.appanalyzer.data.model.AppInfo
import com.appanalyzer.data.model.StatisticsInfo
import com.appanalyzer.ui.components.StorageBar
import com.appanalyzer.ui.util.formatFileSize
import java.util.Locale
import com.appanalyzer.ui.icons.AppIcons
import androidx.compose.material.icons.filled.*

@Composable
fun StorageAnalysisScreen(
    statistics: StatisticsInfo?,
    apps: List<AppInfo>,
    isLoading: Boolean,
    hasStoragePermission: Boolean
) {
    if (isLoading) {
        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        return
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = 10.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(AppIcons.Storage, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(28.dp))
                Spacer(modifier = Modifier.width(8.dp))
                Text("存储分析", fontSize = 24.sp, fontWeight = FontWeight.Bold)
            }
        }

        item {
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(containerColor = if (hasStoragePermission) Color(0xFFE8F5E9) else Color(0xFFFFF3E0))
            ) {
                Row(modifier = Modifier.padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(
                        if (hasStoragePermission) Icons.Default.CheckCircle else Icons.Default.Info,
                        contentDescription = null,
                        tint = if (hasStoragePermission) Color(0xFF4CAF50) else Color(0xFFFF9800)
                    )
                    Spacer(modifier = Modifier.width(12.dp))
                    Column {
                        Text(if (hasStoragePermission) "已获取完整权限" else "未获取完整权限", fontWeight = FontWeight.Bold)
                        Text(
                            // 以前这里写的是「缓存和数据大小为估算值，可能存在误差」——
                            // 但那些"估算值"是 apkSize*0.2 之类拍出来的公式，且被当成测量值
                            // 展示在统计页里。现在读不到就是读不到。
                            if (hasStoragePermission) "缓存和数据大小为系统返回的真实测量值"
                            else "缓存/数据无法读取，相关项显示「—」（不使用估算值）",
                            fontSize = 12.sp, color = Color.Gray
                        )
                    }
                }
            }
        }

        item {
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)
            ) {
                Column(modifier = Modifier.padding(10.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(AppIcons.Lightbulb, contentDescription = null, tint = Color(0xFFFFC107))
                        Spacer(modifier = Modifier.width(8.dp))
                        Text("存储优化建议", fontSize = 14.sp, fontWeight = FontWeight.Bold)
                    }
                    Spacer(modifier = Modifier.height(12.dp))
                    val suggestions = remember(apps, statistics) { mutableListOf<String>().apply {
                        if (statistics != null) {
                            if (!statistics.hasSizeDetail) {
                                // 没有权限就不要给任何关于缓存/数据的建议——
                                // 以前这些分支会因为 totalCache=0 而静默跳过，用户看到的是
                                // 一句"存储状态良好"，而他其实什么都没被测量。
                                add("🔑 未获取「使用情况访问」权限，暂时无法给出缓存清理建议")
                                add("   设置 → 使用情况访问 → 开启 App Analyzer")
                            } else {
                                val totalCacheGB = statistics.totalCache / (1024.0 * 1024 * 1024)
                                if (totalCacheGB > 0.5) {
                                    add("💾 缓存共 ${String.format(Locale.US, "%.1f", totalCacheGB)} GB，可在各应用的系统设置页清理")
                                }
                            }
                            // 去掉了一条「系统应用较多(N个)，可考虑禁用不常用的系统应用」的建议。
                            // 系统应用多寡是机型决定的，禁用系统应用会导致系统异常甚至无法开机，
                            // 这种一句话指导既无操作性又有风险。
                            val largeApps = apps.filter { it.appSize > 500 * 1024 * 1024 }
                            if (largeApps.isNotEmpty()) {
                                add("📦 发现${largeApps.size}个体积超过 500MB 的应用：")
                                largeApps.take(3).forEach { add("   • ${it.appName} — ${formatFileSize(it.appSize)}") }
                            }
                        }
                        if (isEmpty()) add("✨ 暂无可优化项")
                    }}
                    suggestions.forEach { Text(it, fontSize = 14.sp, modifier = Modifier.padding(vertical = 4.dp)) }
                }
            }
        }

        item {
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(10.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(AppIcons.PieChart, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                        Spacer(modifier = Modifier.width(8.dp))
                        Text("应用类型占比", fontSize = 14.sp, fontWeight = FontWeight.Bold)
                    }
                    Spacer(modifier = Modifier.height(16.dp))
                    statistics?.let { stats ->

                        // totalApps==0 时以前会算出 userPercentage=0，然后右边显示 100-0=100%，
                        // 也就是「0 个应用里系统应用占 100%」这种自相矛盾的展示。
                        val userPercentage = if (stats.totalApps > 0) (stats.userApps.toFloat() / stats.totalApps * 100).toInt() else 0
                        val systemPercentage = if (stats.totalApps > 0) 100 - userPercentage else 0
                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
                            Column(horizontalAlignment = Alignment.CenterHorizontally,
                                modifier = Modifier.weight(1f).clip(RoundedCornerShape(8.dp))
                                    .background(Color(0xFF2196F3).copy(alpha = 0.1f)).padding(12.dp)) {
                                Icon(Icons.Default.Person, contentDescription = null, tint = Color(0xFF2196F3), modifier = Modifier.size(32.dp))
                                Text("${stats.userApps}个", fontSize = 14.sp, fontWeight = FontWeight.Bold, color = Color(0xFF2196F3))
                                Text("用户应用", fontSize = 12.sp, color = Color.Gray)
                                Text("$userPercentage%", fontSize = 14.sp, fontWeight = FontWeight.Bold)
                            }
                            Spacer(modifier = Modifier.width(12.dp))
                            Column(horizontalAlignment = Alignment.CenterHorizontally,
                                modifier = Modifier.weight(1f).clip(RoundedCornerShape(8.dp))
                                    .background(Color(0xFFF44336).copy(alpha = 0.1f)).padding(12.dp)) {
                                Icon(AppIcons.Android, contentDescription = null, tint = Color(0xFFF44336), modifier = Modifier.size(32.dp))
                                Text("${stats.systemApps}个", fontSize = 14.sp, fontWeight = FontWeight.Bold, color = Color(0xFFF44336))
                                Text("系统应用", fontSize = 12.sp, color = Color.Gray)
                                Text("$systemPercentage%", fontSize = 14.sp, fontWeight = FontWeight.Bold)
                            }
                        }
                        Spacer(modifier = Modifier.height(12.dp))
                        if (stats.totalApps > 0) {
                            Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                                Box(modifier = Modifier.weight(userPercentage.toFloat().coerceAtLeast(1f)).height(12.dp)
                                    .clip(RoundedCornerShape(6.dp)).background(Color(0xFF2196F3)))
                                Box(modifier = Modifier.weight(systemPercentage.toFloat().coerceAtLeast(1f)).height(12.dp)
                                    .clip(RoundedCornerShape(6.dp)).background(Color(0xFFF44336)))
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
                        Icon(AppIcons.SdStorage, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                        Spacer(modifier = Modifier.width(8.dp))
                        Text("存储组成（按应用汇总）", fontSize = 14.sp, fontWeight = FontWeight.Bold)
                    }
                    Spacer(modifier = Modifier.height(16.dp))
                    statistics?.let { stats ->
                        val total = stats.totalSize
                        // 这里以前第一行是 StorageBar("📱 总占用", stats.totalSize, total, ...)，
                        // 而分母 total 就等于 stats.totalSize —— 进度条恒为 100%，毫无信息量。
                        // 现在拆成三个互补的部分：应用本体 / 缓存 / 数据，都占同一个分母。
                        val appBodyBytes = (total - stats.totalCache - stats.totalData).coerceAtLeast(0L)
                        if (total <= 0L) {
                            Text("暂无可统计的数据", color = Color.Gray, fontSize = 14.sp)
                        } else {
                            StorageBar("📦 应用本体", appBodyBytes, total, Color(0xFF2196F3))
                            Spacer(modifier = Modifier.height(8.dp))
                            // 无权限时缓存/数据读不到，画出来会是两条 0% 的空条，
                            // 与其让人误以为「缓存为 0」，不如明确说明。
                            if (stats.hasSizeDetail) {
                                StorageBar("💾 缓存", stats.totalCache, total, Color(0xFFFF9800))
                                Spacer(modifier = Modifier.height(8.dp))
                                StorageBar("📁 数据（不含缓存）", stats.totalData, total, Color(0xFF4CAF50))
                            } else {
                                Text(
                                    "💾 缓存 / 📁 数据：未授权，无法读取（不计入上方比例）",
                                    fontSize = 12.sp, color = Color(0xFFFF9800)
                                )
                            }
                            Spacer(modifier = Modifier.height(12.dp))
                            HorizontalDivider()
                            Spacer(modifier = Modifier.height(12.dp))
                            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text("合计", fontWeight = FontWeight.Bold)
                                Text(formatFileSize(total), fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
                            }
                        }
                    }
                }
            }
        }
    }
}