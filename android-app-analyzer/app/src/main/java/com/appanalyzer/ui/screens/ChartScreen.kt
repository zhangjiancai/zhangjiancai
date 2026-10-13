package com.appanalyzer.ui.screens

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.appanalyzer.data.model.AppInfo
import com.appanalyzer.ui.components.MetricTile
import com.appanalyzer.ui.components.RankBadge
import com.appanalyzer.ui.components.SegmentedToggle
import com.appanalyzer.ui.icons.AppIcons
import com.appanalyzer.ui.theme.ChartPalette
import com.appanalyzer.ui.util.SizeUnit
import com.appanalyzer.ui.util.formatFileSizeOrUnknown
import java.util.Locale
import kotlin.math.roundToInt

/**
 * 图表页。
 *
 * ## 这一版重做了什么
 *
 * 上一版的问题：控制栏默认折叠（要先展开才知道有单位可选）、柱子是纯色直角块、
 * 排名前三用金黄/银灰/铜色三个硬编码色、点击只能弹 Toast（看完就没了）、
 * 折线图的轴标签是写死的灰色、坐标轴画了两条又粗又直的深灰线。
 *
 * 这一版：
 *
 * 1. **控制栏不再折叠**：把 FilterChip（最小高度 32dp、内边距很宽）换成自绘的
 *    分段选择器（每段 5dp 纵向内边距），三行加起来约 100dp，比原来"折叠起来只剩标题"
 *    反而更省空间，而且功能一眼可见。
 * 2. **选中态**：点任意条目/曲线任意位置 → 卡片顶部固定显示这个应用的尺寸明细。
 *    原来的 Toast 只能看几秒，现在信息常驻（Toast 的内容也一并搬过来了）。
 * 3. **图形高级化**：圆角柱 + 横向渐变、背景轨道弱化、网格线降到 outline 的 20%~30%、
 *    折线用面积渐变填充 + 高亮竖线 + 环形游标。
 * 4. **颜色全部走语义色**：金/银/铜换成"第 1 名实心强调色，其余同色相弱化"，
 *    轴标签用 onSurfaceVariant，深色模式下不会出现灰字糊在暗底上。
 */

private enum class ChartKind { BAR, LINE }

private val AppInfo.totalSize: Long get() = appSize + cacheSize + dataSize

/** 轴标签：数值大就少留小数，避免"1024.0MB"这种又长又没信息量的刻度。 */
private fun formatAxisValue(value: Float, unit: SizeUnit): String = when {
    value >= 100f -> String.format(Locale.US, "%.0f%s", value, unit.label)
    value >= 10f -> String.format(Locale.US, "%.1f%s", value, unit.label)
    else -> String.format(Locale.US, "%.2f%s", value, unit.label)
}

/** 把点击/拖动的横坐标换算成最近的数据点下标。n >= 2 由调用方保证。 */
private fun nearestIndex(
    x: Float,
    widthPx: Int,
    plotLeftPx: Float,
    plotRightPx: Float,
    n: Int
): Int {
    val plotWidth = widthPx - plotLeftPx - plotRightPx
    if (plotWidth <= 1f || n < 2) return 0
    val ratio = ((x - plotLeftPx) / plotWidth).coerceIn(0f, 1f)
    return (ratio * (n - 1)).roundToInt().coerceIn(0, n - 1)
}

@Composable
fun ChartScreen(apps: List<AppInfo>) {
    // 按总大小降序。过滤掉 totalSize <= 0 的：它们在柱状图里没有长度，
    // 画出来只是一条看不见的缝，却会占掉一个排名。
    val sortedApps = remember(apps) {
        apps.filter { it.totalSize > 0 }.sortedByDescending { it.totalSize }
    }

    if (sortedApps.isEmpty()) {
        ChartEmptyState()
        return
    }

    var kind by remember { mutableStateOf(ChartKind.BAR) }
    var selectedUnit by remember { mutableStateOf(SizeUnit.MB) }
    var showCount by remember { mutableStateOf<Int?>(50) }
    var selectedIndex by remember { mutableStateOf<Int?>(null) }

    val displayApps = remember(sortedApps, showCount) {
        val count = showCount
        if (count == null) sortedApps else sortedApps.take(count)
    }

    // 切换单位/数量后原来的选中下标可能越界，这里统一收敛掉
    val selected = selectedIndex?.takeIf { it in displayApps.indices }
    val maxValue = (displayApps.maxOfOrNull { it.totalSize } ?: 1L).coerceAtLeast(1L).toFloat()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 10.dp, vertical = 8.dp)
    ) {
        ChartControlCard(
            kind = kind,
            onKindChange = { kind = it },
            unit = selectedUnit,
            onUnitChange = { selectedUnit = it },
            showCount = showCount,
            onShowCountChange = { showCount = it },
            chartedCount = sortedApps.size
        )
        Spacer(Modifier.height(8.dp))
        Card(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .border(
                    width = 1.dp,
                    color = ChartPalette.hairline(),
                    shape = RoundedCornerShape(14.dp)
                ),
            shape = RoundedCornerShape(14.dp),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
            elevation = CardDefaults.cardElevation(defaultElevation = 0.dp)
        ) {
            Column(modifier = Modifier.fillMaxSize()) {
                if (kind == ChartKind.BAR) {
                    BarDetailStrip(app = selected?.let { displayApps[it] }, unit = selectedUnit)
                } else {
                    LineDetailStrip(apps = displayApps, unit = selectedUnit, selectedIndex = selected)
                }
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(1.dp)
                        .background(ChartPalette.hairline())
                )
                if (kind == ChartKind.BAR) {
                    BarRankList(
                        apps = displayApps,
                        maxValue = maxValue,
                        unit = selectedUnit,
                        selectedIndex = selected,
                        onSelect = { selectedIndex = it }
                    )
                } else {
                    LineCurveChart(
                        apps = displayApps,
                        unit = selectedUnit,
                        selectedIndex = selected,
                        onSelectIndex = { selectedIndex = it }
                    )
                }
            }
        }
    }
}

@Composable
private fun ChartEmptyState() {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(
                imageVector = AppIcons.BarChart,
                contentDescription = null,
                tint = ChartPalette.accent().copy(alpha = 0.55f),
                modifier = Modifier.size(44.dp)
            )
            Spacer(Modifier.height(10.dp))
            Text(
                text = "暂无数据",
                fontSize = 14.sp,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                softWrap = false
            )
            Spacer(Modifier.height(4.dp))
            Text(
                text = "请先在「列表」页加载应用，或点击右上角刷新",
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                softWrap = false,
                overflow = TextOverflow.Ellipsis
            )
        }
    }
}

/**
 * 控制栏。
 *
 * 三行、每行一个主题：图形类型 / 单位 / 显示数量。
 * 每行的高度由 11sp 文字 + 5dp 纵向内边距决定，约 30dp，
 * 全部展开也只占约 110dp —— 比"折叠起来省下的空间"划算得多。
 */
@Composable
private fun ChartControlCard(
    kind: ChartKind,
    onKindChange: (ChartKind) -> Unit,
    unit: SizeUnit,
    onUnitChange: (SizeUnit) -> Unit,
    showCount: Int?,
    onShowCountChange: (Int?) -> Unit,
    chartedCount: Int
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .border(1.dp, ChartPalette.hairline(), RoundedCornerShape(14.dp)),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 0.dp)
    ) {
        Column(modifier = Modifier.padding(10.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically
            ) {
                SegmentedToggle(
                    options = listOf(ChartKind.BAR, ChartKind.LINE),
                    selected = kind,
                    onSelect = onKindChange,
                    label = { if (it == ChartKind.BAR) "柱状" else "折线" }
                )
                Spacer(Modifier.weight(1f))
                Text(
                    text = "共 " + chartedCount + " 个",
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    softWrap = false
                )
            }
            Spacer(Modifier.height(8.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically
            ) {
                ControlLabel("单位")
                SegmentedToggle(
                    options = SizeUnit.values().toList(),
                    selected = unit,
                    onSelect = onUnitChange,
                    label = { it.label }
                )
            }
            if (kind == ChartKind.BAR) {
                Spacer(Modifier.height(8.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    ControlLabel("显示前")
                    SegmentedToggle(
                        options = listOf<Int?>(10, 20, 50, null),
                        selected = showCount,
                        onSelect = onShowCountChange,
                        label = { if (it == null) "全部" else it.toString() }
                    )
                }
            }
        }
    }
}

@Composable
private fun ControlLabel(text: String) {
    Text(
        text = text,
        fontSize = 10.sp,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        maxLines = 1,
        softWrap = false,
        modifier = Modifier.width(34.dp)
    )
}

/**
 * 明细条（柱状图模式）。
 *
 * 未选中时只占一行（一行提示），选中后展开成两行 —— 用 animateContentSize
 * 让高度变化不突兀。这里就是原来那个 Toast 的内容，只是变成了常驻。
 */
@Composable
private fun BarDetailStrip(app: AppInfo?, unit: SizeUnit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .animateContentSize()
            .padding(horizontal = 12.dp, vertical = 9.dp)
    ) {
        if (app == null) {
            Text(
                text = "点击任意条目查看尺寸明细",
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                softWrap = false,
                overflow = TextOverflow.Ellipsis
            )
            return@Column
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = app.appName,
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                softWrap = false,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f)
            )
            Spacer(Modifier.width(8.dp))
            Text(
                text = "总 " + unit.format(app.totalSize),
                fontSize = 11.sp,
                fontWeight = FontWeight.SemiBold,
                color = ChartPalette.accent(),
                maxLines = 1,
                softWrap = false
            )
        }
        Spacer(Modifier.height(8.dp))
        Row(modifier = Modifier.fillMaxWidth()) {
            MetricTile(
                label = "应用",
                value = unit.format(app.appSize),
                valueSize = 12.sp,
                horizontalAlignment = Alignment.Start,
                modifier = Modifier.weight(1f)
            )
            MetricTile(
                label = "缓存",
                value = formatFileSizeOrUnknown(app.cacheSize, app.hasSizeDetail),
                valueSize = 12.sp,
                horizontalAlignment = Alignment.CenterHorizontally,
                modifier = Modifier.weight(1f)
            )
            MetricTile(
                label = "数据",
                value = formatFileSizeOrUnknown(app.dataSize, app.hasSizeDetail),
                valueSize = 12.sp,
                horizontalAlignment = Alignment.End,
                modifier = Modifier.weight(1f)
            )
        }
    }
}

/**
 * 明细条（折线图模式）。
 *
 * 常驻显示"总占用 / 最大 / 最小"（这是原来点击后 Toast 里的汇总），
 * 选中某一点时下面那行变成该点的信息。
 */
@Composable
private fun LineDetailStrip(apps: List<AppInfo>, unit: SizeUnit, selectedIndex: Int?) {
    val total = remember(apps) { apps.sumOf { it.totalSize } }
    val maxApp = apps.first()
    val minApp = apps.last()
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .animateContentSize()
            .padding(horizontal = 12.dp, vertical = 9.dp)
    ) {
        Row(modifier = Modifier.fillMaxWidth()) {
            MetricTile(
                label = "总占用",
                value = unit.format(total),
                valueSize = 12.sp,
                horizontalAlignment = Alignment.Start,
                modifier = Modifier.weight(1f)
            )
            MetricTile(
                label = "最大 · " + maxApp.appName,
                value = unit.format(maxApp.totalSize),
                valueSize = 12.sp,
                horizontalAlignment = Alignment.CenterHorizontally,
                modifier = Modifier.weight(1f)
            )
            MetricTile(
                label = "最小 · " + minApp.appName,
                value = unit.format(minApp.totalSize),
                valueSize = 12.sp,
                horizontalAlignment = Alignment.End,
                modifier = Modifier.weight(1f)
            )
        }
        Spacer(Modifier.height(6.dp))
        val pointInfo = if (selectedIndex != null && selectedIndex in apps.indices) {
            "第 " + (selectedIndex + 1) + " 位 · " + apps[selectedIndex].appName +
                " · " + unit.format(apps[selectedIndex].totalSize)
        } else {
            "点按或拖动曲线，查看某一位对应的应用"
        }
        Text(
            text = pointInfo,
            fontSize = 10.sp,
            color = if (selectedIndex != null) ChartPalette.accent() else MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            softWrap = false,
            overflow = TextOverflow.Ellipsis
        )
    }
}

/**
 * 横向排行榜。
 *
 * 用 LazyColumn 而不是 Column + forEach：应用可能有几百个，
 * 一次性组合出来内存扛不住（这是项目里踩过的坑）。
 */
@Composable
private fun BarRankList(
    apps: List<AppInfo>,
    maxValue: Float,
    unit: SizeUnit,
    selectedIndex: Int?,
    onSelect: (Int) -> Unit
) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = 8.dp, vertical = 6.dp)
    ) {
        itemsIndexed(apps) { index, app ->
            BarRankRow(
                index = index,
                app = app,
                maxValue = maxValue,
                unit = unit,
                selected = index == selectedIndex,
                onClick = { onSelect(index) }
            )
        }
    }
}

@Composable
private fun BarRankRow(
    index: Int,
    app: AppInfo,
    maxValue: Float,
    unit: SizeUnit,
    selected: Boolean,
    onClick: () -> Unit
) {
    val fraction = (app.totalSize.toFloat() / maxValue).coerceIn(0.02f, 1f)
    val shape = RoundedCornerShape(10.dp)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(if (selected) ChartPalette.accent().copy(alpha = 0.10f) else Color.Transparent)
            .clickable(onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 6.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            RankBadge(rank = index + 1, size = 18.dp)
            Spacer(Modifier.width(7.dp))
            Text(
                text = app.appName,
                fontSize = 12.sp,
                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                softWrap = false,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f)
            )
            Spacer(Modifier.width(8.dp))
            Text(
                text = unit.format(app.totalSize),
                fontSize = 11.sp,
                fontWeight = FontWeight.SemiBold,
                color = ChartPalette.accent(),
                maxLines = 1,
                softWrap = false
            )
        }
        Spacer(Modifier.height(4.dp))
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(6.dp)
                .clip(RoundedCornerShape(3.dp))
                .background(ChartPalette.track())
        ) {
            Box(
                modifier = Modifier
                    .fillMaxHeight()
                    .fillMaxWidth(fraction)
                    .clip(RoundedCornerShape(3.dp))
                    .background(ChartPalette.barBrush(if (selected) 1f else 0.7f))
            )
        }
    }
}

/**
 * 折线图（应用体积分布曲线）。
 *
 * 几何量（左边距）在组合期就算好成 px：Canvas 画网格和手势命中判定用的是同一组数字，
 * 否则点击位置和视觉位置会对不上。轴标签走 nativeCanvas（它天生不换行），
 * 但字号用 sp 换算、颜色取 onSurfaceVariant —— 上一版是写死的 22f 像素 + Color.GRAY，
 * 在高密度屏上字小得看不清，深色模式下还是一片灰。
 */
@Composable
private fun LineCurveChart(
    apps: List<AppInfo>,
    unit: SizeUnit,
    selectedIndex: Int?,
    onSelectIndex: (Int?) -> Unit
) {
    if (apps.size < 2) {
        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text(
                text = "数据不足",
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                softWrap = false
            )
        }
        return
    }

    val n = apps.size
    val values = remember(apps, unit) {
        FloatArray(n) { index ->
            val bytes = apps[index].totalSize
            when (unit) {
                SizeUnit.B -> bytes.toFloat()
                SizeUnit.KB -> bytes / 1024f
                SizeUnit.MB -> bytes / (1024f * 1024f)
                SizeUnit.GB -> bytes / (1024f * 1024f * 1024f)
            }
        }
    }
    val maxValue = values.maxOrNull()?.takeIf { it > 0f } ?: 1f
    val yLabels = remember(maxValue, unit) {
        List(6) { index -> formatAxisValue(maxValue * index / 5f, unit) }
    }
    val xTicks = remember(n) {
        listOf(0, n / 4, n / 2, n * 3 / 4, n - 1).distinct().filter { it in 0 until n }
    }

    val density = LocalDensity.current
    val labelPx = with(density) { 9.sp.toPx() }
    val paint = remember { android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG) }
    // Y 轴标签要占多宽，实测决定 —— 固定 68px 在"1024.0MB"这种刻度下会压到图里
    val labelWidthPx = remember(yLabels, labelPx) {
        paint.textSize = labelPx
        yLabels.maxOf { paint.measureText(it) }
    }
    val plotLeftPx = labelWidthPx + with(density) { 12.dp.toPx() }
    val plotRightPx = with(density) { 10.dp.toPx() }
    val topPadPx = with(density) { 6.dp.toPx() }
    val bottomPadPx = with(density) { 30.dp.toPx() }

    val gridColor = ChartPalette.grid()
    val lineColor = ChartPalette.accent()
    val areaBrush = ChartPalette.areaBrush()
    val axisTextArgb = MaterialTheme.colorScheme.onSurfaceVariant.toArgb()
    val surfaceColor = MaterialTheme.colorScheme.surface

    Canvas(
        modifier = Modifier
            .fillMaxSize()
            .padding(start = 4.dp, end = 4.dp, top = 6.dp, bottom = 2.dp)
            .pointerInput(n, plotLeftPx, plotRightPx) {
                // 点按与拖动共用一个手势循环：detectTapGestures 会先消费 down，
                // 和 detectDragGestures 放两个 pointerInput 里会互相打架。
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    onSelectIndex(
                        nearestIndex(down.position.x, size.width, plotLeftPx, plotRightPx, n)
                    )
                    down.consume()
                    while (true) {
                        val event = awaitPointerEvent()
                        val change = event.changes.firstOrNull { it.id == down.id } ?: break
                        if (!change.pressed) break
                        onSelectIndex(
                            nearestIndex(change.position.x, size.width, plotLeftPx, plotRightPx, n)
                        )
                        change.consume()
                    }
                }
            }
    ) {
        val width = size.width
        val height = size.height
        val plotWidth = width - plotLeftPx - plotRightPx
        val plotHeight = height - topPadPx - bottomPadPx
        if (plotWidth <= 1f || plotHeight <= 1f) return@Canvas
        val stepX = plotWidth / (n - 1)

        // 网格：只画横线，浓度压到 outline 的 20%~30%，绝不抢数据
        for (i in 0..5) {
            val y = topPadPx + plotHeight * (1f - i / 5f)
            drawLine(
                color = gridColor,
                start = Offset(plotLeftPx, y),
                end = Offset(plotLeftPx + plotWidth, y),
                strokeWidth = 1f
            )
        }

        // Y 轴刻度
        paint.textAlign = android.graphics.Paint.Align.RIGHT
        paint.textSize = labelPx
        paint.color = axisTextArgb
        yLabels.forEachIndexed { index, label ->
            val y = topPadPx + plotHeight * (1f - index / 5f)
            drawContext.canvas.nativeCanvas.drawText(
                label,
                plotLeftPx - 6.dp.toPx(),
                y + labelPx * 0.36f,
                paint
            )
        }

        // X 轴刻度
        paint.textAlign = android.graphics.Paint.Align.CENTER
        xTicks.forEach { index ->
            drawContext.canvas.nativeCanvas.drawText(
                (index + 1).toString(),
                plotLeftPx + index * stepX,
                height - bottomPadPx + labelPx + 6.dp.toPx(),
                paint
            )
        }
        drawContext.canvas.nativeCanvas.drawText(
            "应用序号（体积从大到小）",
            plotLeftPx + plotWidth / 2f,
            height - 3.dp.toPx(),
            paint
        )

        // 面积 + 折线
        val linePath = Path()
        val areaPath = Path()
        for (i in 0 until n) {
            val x = plotLeftPx + i * stepX
            val y = topPadPx + plotHeight * (1f - values[i] / maxValue)
            if (i == 0) {
                linePath.moveTo(x, y)
                areaPath.moveTo(x, topPadPx + plotHeight)
                areaPath.lineTo(x, y)
            } else {
                linePath.lineTo(x, y)
                areaPath.lineTo(x, y)
            }
        }
        areaPath.lineTo(plotLeftPx + plotWidth, topPadPx + plotHeight)
        areaPath.close()

        drawPath(path = areaPath, brush = areaBrush)
        drawPath(
            path = linePath,
            color = lineColor,
            style = Stroke(
                width = 2.dp.toPx(),
                cap = StrokeCap.Round,
                join = StrokeJoin.Round
            )
        )

        // 首尾端点（首点就是最大的那个应用）
        drawCircle(
            color = lineColor,
            radius = 3.dp.toPx(),
            center = Offset(plotLeftPx, topPadPx + plotHeight * (1f - values[0] / maxValue))
        )
        drawCircle(
            color = lineColor,
            radius = 3.dp.toPx(),
            center = Offset(
                plotLeftPx + plotWidth,
                topPadPx + plotHeight * (1f - values[n - 1] / maxValue)
            )
        )

        // 选中：竖线 + 环形游标（外圈用卡片底色，深浅色下都有"挖空"的层次）
        val selected = selectedIndex
        if (selected != null && selected in 0 until n) {
            val x = plotLeftPx + selected * stepX
            val y = topPadPx + plotHeight * (1f - values[selected] / maxValue)
            drawLine(
                color = lineColor.copy(alpha = 0.45f),
                start = Offset(x, topPadPx),
                end = Offset(x, topPadPx + plotHeight),
                strokeWidth = 1.5.dp.toPx()
            )
            drawCircle(color = surfaceColor, radius = 5.5.dp.toPx(), center = Offset(x, y))
            drawCircle(color = lineColor, radius = 3.5.dp.toPx(), center = Offset(x, y))
        }
    }
}
