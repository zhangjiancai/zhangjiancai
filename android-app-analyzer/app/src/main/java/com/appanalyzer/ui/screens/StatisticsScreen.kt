package com.appanalyzer.ui.screens

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.appanalyzer.data.model.AppInfo
import com.appanalyzer.data.model.StatisticsInfo
import com.appanalyzer.service.AnalysisService
import com.appanalyzer.ui.components.CompositionBar
import com.appanalyzer.ui.components.CompositionSegment
import com.appanalyzer.ui.components.HistogramBin
import com.appanalyzer.ui.components.InfoPill
import com.appanalyzer.ui.components.LegendItem
import com.appanalyzer.ui.components.MetricTile
import com.appanalyzer.ui.components.MiniHistogram
import com.appanalyzer.ui.components.RankBadge
import com.appanalyzer.ui.components.RelativeBarRow
import com.appanalyzer.ui.components.SectionCard
import com.appanalyzer.ui.components.SegmentedToggle
import com.appanalyzer.ui.icons.AppIcons
import com.appanalyzer.ui.theme.ChartPalette
import com.appanalyzer.ui.util.formatFileSize
import com.appanalyzer.ui.util.formatFileSizeOrUnknown
import java.text.NumberFormat
import java.util.Locale

/**
 * 统计页。
 *
 * ## 这一版重做了什么
 *
 * 上一版是"七张等大的卡片垂直堆叠"：每张卡都是「小标题 + 一堆同样字号的行」，
 * 没有主次，一屏只能看两张卡，而且颜色是散的（金黄/银灰/铜色/浅灰/橙/红/绿，
 * 还有 🟢🔴⚠️ 三个 emoji）。用户的原话是"土里土气"。
 *
 * 这一版只做三件事：
 *
 * 1. **建立层级**：顶部一张 primaryContainer 的"主卡"，只放两个大数字；
 *    其余信息全部降级成 10~12sp 的小字，塞进 12dp 内边距的紧凑卡片里。
 * 2. **统一颜色**：所有颜色都从 MaterialTheme 语义色推导（见 ChartPalette），
 *    需要区分数据系列时只做"同一色相的浓度台阶"，不再引入新色相，emoji 全部换成矢量图标/色块。
 * 3. **提高密度**：卡片间距 8dp、内边距 12dp、区块标题 14sp、正文 11~12sp，
 *    长条形的排行榜和分布用"背景填充条"表达，一行一个应用。
 *
 * 功能一个没少：总览、存储构成（总/平均/缓存/数据）、极值应用、分类分布、
 * 缓存 Top5、体积分布直方图、隐藏系统应用开关，全在。
 */

private fun formatNumber(n: Int): String =
    NumberFormat.getNumberInstance(Locale.getDefault()).format(n)

/** 体积分档，与 AnalysisService.calculateSizeDistribution 的口径一致。 */
private val SIZE_BIN_LABELS = listOf("<10M", "10-50M", "50-100M", "100-500M", ">500M")
private const val ONE_MB = 1024L * 1024L

private fun sizeBinIndex(totalBytes: Long): Int = when {
    totalBytes < 10 * ONE_MB -> 0
    totalBytes < 50 * ONE_MB -> 1
    totalBytes < 100 * ONE_MB -> 2
    totalBytes < 500 * ONE_MB -> 3
    else -> 4
}

/** 分类最多列这么多行，其余合并成"其他 N 类"，避免一张卡撑出两屏。 */
private const val MAX_CATEGORY_ROWS = 8

/** 无权限时的完整说明。卡片里只放一行摘要，点一下看全文。 */
private const val PERMISSION_TIP_FULL =
    "未获取「使用情况访问」权限，缓存/数据无法读取，因此显示「—」。这里不会用估算值填充。"
private const val PERMISSION_TIP_SHORT = "未授权：缓存/数据不可读（不用估算值）"

@Composable
fun StatisticsScreen(statistics: StatisticsInfo?, apps: List<AppInfo>, isLoading: Boolean) {
    when {
        isLoading -> Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }

        statistics == null -> Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text(
                text = "暂无数据",
                fontSize = 13.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1
            )
        }

        else -> StatisticsContent(statistics = statistics, apps = apps)
    }
}

@Composable
private fun StatisticsContent(statistics: StatisticsInfo, apps: List<AppInfo>) {
    // 「隐藏系统应用」以前只影响下面的分布/榜单，上面的总览仍然是全量，
    // 两个数字对不上。现在筛选作用于整页：总览也按同一份数据重算。
    var onlyUser by remember { mutableStateOf(false) }

    val filteredApps = remember(apps, onlyUser) {
        if (onlyUser) apps.filter { !it.isSystemApp } else apps
    }
    val stats = remember(statistics, apps, onlyUser) {
        if (!onlyUser) statistics else AnalysisService().calculateStatistics(apps.filter { !it.isSystemApp })
    }

    val categories = remember(filteredApps) {
        filteredApps
            .groupBy { it.category.ifBlank { "未分类" } }
            .map { entry -> entry.key to entry.value.size }
            .sortedByDescending { it.second }
    }

    val sizeBins = remember(filteredApps) {
        val counts = IntArray(SIZE_BIN_LABELS.size)
        filteredApps.forEach { counts[sizeBinIndex(it.appSize + it.cacheSize + it.dataSize)]++ }
        SIZE_BIN_LABELS.mapIndexed { index, label -> HistogramBin(label, counts[index]) }
    }

    val cacheTop = remember(filteredApps) {
        filteredApps.sortedByDescending { it.cacheSize }.take(5)
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 10.dp, end = 10.dp, top = 8.dp, bottom = 16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        item {
            FilterBar(onlyUser = onlyUser, onOnlyUserChange = { onlyUser = it })
        }
        item {
            OverviewCard(stats = stats, onlyUser = onlyUser)
        }
        item {
            StorageCard(stats = stats)
        }
        item {
            ExtremesCard(stats = stats)
        }
        item {
            SizeDistributionCard(bins = sizeBins, appCount = filteredApps.size)
        }
        item {
            CategoryCard(categories = categories, appCount = filteredApps.size)
        }
        item {
            CacheTopCard(apps = cacheTop, hasSizeDetail = stats.hasSizeDetail, onlyUser = onlyUser)
        }
    }
}

/** 顶部筛选条。一行装下：分段开关 + 作用范围说明。 */
@Composable
private fun FilterBar(onlyUser: Boolean, onOnlyUserChange: (Boolean) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically
    ) {
        SegmentedToggle(
            options = listOf(false, true),
            selected = onlyUser,
            onSelect = onOnlyUserChange,
            label = { if (it) "仅用户" else "全部" }
        )
        Spacer(Modifier.width(8.dp))
        Text(
            text = "筛选影响：总览 · 分类 · 分布 · 缓存榜",
            fontSize = 10.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            softWrap = false,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f)
        )
    }
}

/**
 * 主卡：只放两个大数字。
 *
 * 全页唯一使用 primaryContainer 的地方 —— 一整页里只有这一个"重色块"，
 * 眼睛第一眼就落在这里，层级自然就出来了。
 */
@Composable
private fun OverviewCard(stats: StatisticsInfo, onlyUser: Boolean) {
    val scheme = MaterialTheme.colorScheme
    val dim = scheme.onPrimaryContainer.copy(alpha = 0.72f)
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = scheme.primaryContainer),
        elevation = CardDefaults.cardElevation(defaultElevation = 0.dp)
    ) {
        Column(modifier = Modifier.padding(12.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.Bottom
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = if (onlyUser) "用户应用" else "已安装应用",
                        fontSize = 10.sp,
                        color = dim,
                        maxLines = 1,
                        softWrap = false,
                        overflow = TextOverflow.Ellipsis
                    )
                    Spacer(Modifier.height(2.dp))
                    Row(verticalAlignment = Alignment.Bottom) {
                        Text(
                            text = formatNumber(stats.totalApps),
                            fontSize = 32.sp,
                            fontWeight = FontWeight.Bold,
                            color = scheme.onPrimaryContainer,
                            maxLines = 1,
                            softWrap = false
                        )
                        Spacer(Modifier.width(4.dp))
                        Text(
                            text = "个",
                            fontSize = 11.sp,
                            color = dim,
                            maxLines = 1,
                            softWrap = false,
                            modifier = Modifier.padding(bottom = 5.dp)
                        )
                    }
                }
                Column(horizontalAlignment = Alignment.End) {
                    Text(
                        text = "总占用",
                        fontSize = 10.sp,
                        color = dim,
                        maxLines = 1,
                        softWrap = false
                    )
                    Spacer(Modifier.height(2.dp))
                    Text(
                        text = formatFileSize(stats.totalSize),
                        fontSize = 18.sp,
                        fontWeight = FontWeight.Bold,
                        color = scheme.onPrimaryContainer,
                        maxLines = 1,
                        softWrap = false
                    )
                }
            }
            Spacer(Modifier.height(10.dp))
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(1.dp)
                    .background(scheme.onPrimaryContainer.copy(alpha = 0.16f))
            )
            Spacer(Modifier.height(10.dp))
            Row(modifier = Modifier.fillMaxWidth()) {
                MetricTile(
                    label = "用户应用",
                    value = formatNumber(stats.userApps),
                    valueColor = scheme.onPrimaryContainer,
                    labelColor = dim,
                    horizontalAlignment = Alignment.Start,
                    modifier = Modifier.weight(1f)
                )
                MetricTile(
                    label = "系统应用",
                    value = formatNumber(stats.systemApps),
                    valueColor = scheme.onPrimaryContainer,
                    labelColor = dim,
                    horizontalAlignment = Alignment.CenterHorizontally,
                    modifier = Modifier.weight(1f)
                )
                MetricTile(
                    label = "平均体积",
                    value = formatFileSize(stats.averageSize),
                    valueColor = scheme.onPrimaryContainer,
                    labelColor = dim,
                    horizontalAlignment = Alignment.End,
                    modifier = Modifier.weight(1f)
                )
            }
        }
    }
}

/** 存储构成：一根堆叠条 + 三项图例。 */
@Composable
private fun StorageCard(stats: StatisticsInfo) {
    val known = stats.hasSizeDetail
    val appBytes = (stats.totalSize - stats.totalCache - stats.totalData).coerceAtLeast(0L)
    val total = stats.totalSize.coerceAtLeast(1L)
    val context = LocalContext.current

    SectionCard(
        title = "存储构成",
        icon = AppIcons.Storage,
        trailing = {
            Text(
                text = "平均 " + formatFileSize(stats.averageSize),
                fontSize = 10.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                softWrap = false
            )
        }
    ) {
        CompositionBar(
            segments = listOf(
                CompositionSegment(ChartPalette.accent(), appBytes.toFloat() / total),
                CompositionSegment(ChartPalette.ramp(1, 3), stats.totalCache.toFloat() / total),
                CompositionSegment(ChartPalette.ramp(2, 3), stats.totalData.toFloat() / total)
            )
        )
        Spacer(Modifier.height(10.dp))
        Row(modifier = Modifier.fillMaxWidth()) {
            LegendItem(
                color = ChartPalette.accent(),
                label = "应用本体",
                value = formatFileSize(appBytes),
                modifier = Modifier.weight(1f)
            )
            LegendItem(
                color = ChartPalette.ramp(1, 3),
                label = "缓存",
                value = formatFileSizeOrUnknown(stats.totalCache, known),
                modifier = Modifier.weight(1f)
            )
            LegendItem(
                color = ChartPalette.ramp(2, 3),
                label = "数据",
                value = formatFileSizeOrUnknown(stats.totalData, known),
                modifier = Modifier.weight(1f)
            )
        }
        if (!known) {
            Spacer(Modifier.height(10.dp))
            InfoPill(
                text = PERMISSION_TIP_SHORT,
                icon = Icons.Default.Warning,
                onClick = {
                    Toast.makeText(context, PERMISSION_TIP_FULL, Toast.LENGTH_LONG).show()
                }
            )
        }
    }
}

/** 体积极值：两块并列的小方块，颜色深浅区分主次，不再用 🟢🔴。 */
@Composable
private fun ExtremesCard(stats: StatisticsInfo) {
    SectionCard(title = "体积极值", icon = Icons.Default.Star) {
        if (stats.maxSize <= 0L) {
            EmptyHint()
        } else {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                ExtremeTile(
                    tag = "最大",
                    name = stats.maxAppName,
                    size = stats.maxSize,
                    highlight = true,
                    modifier = Modifier.weight(1f)
                )
                ExtremeTile(
                    tag = "最小",
                    name = stats.minAppName,
                    size = stats.minSize,
                    highlight = false,
                    modifier = Modifier.weight(1f)
                )
            }
        }
    }
}

@Composable
private fun ExtremeTile(
    tag: String,
    name: String,
    size: Long,
    highlight: Boolean,
    modifier: Modifier = Modifier
) {
    val scheme = MaterialTheme.colorScheme
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(10.dp))
            .background(
                if (highlight) ChartPalette.accent().copy(alpha = 0.10f)
                else scheme.surfaceVariant.copy(alpha = 0.45f)
            )
            .padding(horizontal = 10.dp, vertical = 8.dp)
    ) {
        Text(
            text = tag,
            fontSize = 10.sp,
            color = scheme.onSurfaceVariant,
            maxLines = 1,
            softWrap = false
        )
        Spacer(Modifier.height(3.dp))
        Text(
            text = name.ifBlank { "—" },
            fontSize = 11.sp,
            fontWeight = FontWeight.Medium,
            color = scheme.onSurface,
            maxLines = 1,
            softWrap = false,
            overflow = TextOverflow.Ellipsis
        )
        Spacer(Modifier.height(2.dp))
        Text(
            text = formatFileSize(size),
            fontSize = 15.sp,
            fontWeight = FontWeight.Bold,
            color = if (highlight) ChartPalette.accent() else scheme.onSurfaceVariant,
            maxLines = 1,
            softWrap = false
        )
    }
}

/** 体积分布直方图。 */
@Composable
private fun SizeDistributionCard(bins: List<HistogramBin>, appCount: Int) {
    SectionCard(
        title = "体积分布",
        icon = AppIcons.PieChart,
        trailing = {
            Text(
                text = appCount.toString() + " 个应用",
                fontSize = 10.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                softWrap = false
            )
        }
    ) {
        if (appCount == 0) {
            EmptyHint()
        } else {
            MiniHistogram(bins = bins)
        }
    }
}

/** 分类分布。背景填充条 + 排名顺序，一眼能看出"哪一类最多"。 */
@Composable
private fun CategoryCard(categories: List<Pair<String, Int>>, appCount: Int) {
    SectionCard(
        title = "分类分布",
        icon = AppIcons.Category,
        trailing = {
            Text(
                text = categories.size.toString() + " 类",
                fontSize = 10.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                softWrap = false
            )
        }
    ) {
        if (categories.isEmpty() || appCount == 0) {
            EmptyHint()
            return@SectionCard
        }
        val shown = categories.take(MAX_CATEGORY_ROWS)
        val rest = categories.drop(MAX_CATEGORY_ROWS)
        val maxCount = shown.firstOrNull()?.second?.coerceAtLeast(1) ?: 1
        Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
            shown.forEach { entry ->
                val percent = entry.second * 100 / appCount
                RelativeBarRow(
                    label = entry.first,
                    value = entry.second.toString() + " · " + percent + "%",
                    fraction = entry.second.toFloat() / maxCount
                )
            }
            if (rest.isNotEmpty()) {
                val restCount = rest.sumOf { it.second }
                val percent = restCount * 100 / appCount
                RelativeBarRow(
                    label = "其他 " + rest.size + " 类",
                    value = restCount.toString() + " · " + percent + "%",
                    fraction = restCount.toFloat() / maxCount
                )
            }
        }
    }
}

/** 缓存最多的应用 Top 5。 */
@Composable
private fun CacheTopCard(apps: List<AppInfo>, hasSizeDetail: Boolean, onlyUser: Boolean) {
    SectionCard(
        title = if (onlyUser) "缓存最多 Top 5 · 用户应用" else "缓存最多 Top 5",
        icon = AppIcons.Cached
    ) {
        val context = LocalContext.current
        when {
            !hasSizeDetail -> {
                // 没有权限时每个应用的缓存都是 0，直接排名会得到一份毫无意义、
                // 却看起来很权威的榜单。宁可不显示。
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        text = "未授权，无法统计各应用缓存占用",
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        softWrap = false,
                        overflow = TextOverflow.Ellipsis
                    )
                    InfoPill(
                        text = PERMISSION_TIP_SHORT,
                        icon = Icons.Default.Warning,
                        onClick = {
                            Toast.makeText(context, PERMISSION_TIP_FULL, Toast.LENGTH_LONG).show()
                        }
                    )
                }
            }

            apps.isEmpty() -> EmptyHint()

            else -> {
                val maxCache = apps.first().cacheSize.coerceAtLeast(1L)
                Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
                    apps.forEachIndexed { index, app ->
                        RelativeBarRow(
                            label = app.appName,
                            value = formatFileSize(app.cacheSize),
                            fraction = app.cacheSize.toFloat() / maxCache,
                            leading = { RankBadge(rank = index + 1) }
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun EmptyHint(text: String = "暂无数据") {
    Text(
        text = text,
        fontSize = 11.sp,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        maxLines = 1,
        softWrap = false
    )
}
