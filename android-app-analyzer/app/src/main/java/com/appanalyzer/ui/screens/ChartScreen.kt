package com.appanalyzer.ui.screens

import android.widget.Toast
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.appanalyzer.data.model.AppInfo
import com.appanalyzer.ui.util.SizeUnit
import com.appanalyzer.ui.util.formatFileSizeOrUnknown
import java.util.Locale
import com.appanalyzer.ui.icons.AppIcons
import androidx.compose.material.icons.filled.*

@Composable
fun ChartScreen(apps: List<AppInfo>) {
    if (apps.isEmpty()) {
        // 以前这里显示的是一个永不停止的 CircularProgressIndicator：
        // 「没有数据」被伪装成「正在加载」，用户会一直等下去。
        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Icon(AppIcons.BarChart, null, modifier = Modifier.size(48.dp), tint = Color.Gray)
                Spacer(modifier = Modifier.height(12.dp))
                Text("暂无数据", fontSize = 16.sp, color = Color.Gray)
                Spacer(modifier = Modifier.height(4.dp))
                Text("请先在「列表」页加载应用，或点击右上角刷新", fontSize = 12.sp, color = Color.Gray)
            }
        }
        return
    }

    // 按总大小降序排列
    val sortedApps = remember(apps) {
        apps.filter { it.totalSize > 0 }
            .sortedByDescending { it.totalSize }
    }

    // 图表类型：柱状图 vs L型折线图
    var chartType by remember { mutableStateOf(false) }

    // 单位选择（两种图表通用）
    var selectedUnit by remember { mutableStateOf(SizeUnit.MB) }

    // 显示的条目数（null表示全部）
    var showCount by remember { mutableStateOf<Int?>(50) }

    // 控制栏折叠状态
    var controlsExpanded by remember { mutableStateOf(false) }

    val displayApps = remember(sortedApps, showCount) {
        val count = showCount
        if (count == null) sortedApps else sortedApps.take(count)
    }

    Column(modifier = Modifier.fillMaxSize()) {
        // 控制栏头部（可点击折叠）
        Card(
            modifier = Modifier.fillMaxWidth().padding(12.dp)
        ) {
            Column(modifier = Modifier.padding(12.dp)) {
                // 标题行 + 折叠按钮
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.clickable { controlsExpanded = !controlsExpanded }
                ) {
                    @Suppress("DEPRECATION")
                    Icon(
                        if (chartType) AppIcons.ShowChart else AppIcons.BarChart,
                        contentDescription = null, tint = MaterialTheme.colorScheme.primary
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(
                        if (chartType) "L型曲线（应用大小分布）" else "应用大小排行榜",
                        fontSize = 16.sp, fontWeight = FontWeight.Bold,
                        modifier = Modifier.weight(1f)
                    )
                    // 以前用的是未经过滤的 apps.size，而图上画的只有 totalSize>0 的部分，
                    // 于是标题上的数字和实际柱子数量对不上。
                    Text("共${sortedApps.size}个", fontSize = 12.sp, color = Color.Gray)
                    Spacer(modifier = Modifier.width(4.dp))
                    Icon(
                        if (controlsExpanded) AppIcons.ExpandLess else AppIcons.ExpandMore,
                        contentDescription = if (controlsExpanded) "收起" else "展开",
                        tint = Color.Gray
                    )
                }

                // 可折叠控制栏
                AnimatedVisibility(
                    visible = controlsExpanded,
                    enter = expandVertically(),
                    exit = shrinkVertically()
                ) {
                    Column {
                        Spacer(modifier = Modifier.height(10.dp))

                        // 图表类型切换 + 单位选择（同一行）
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            // 柱状 / 折线 切换
                            Surface(
                                shape = RoundedCornerShape(8.dp),
                                color = MaterialTheme.colorScheme.surfaceVariant
                            ) {
                                Row(modifier = Modifier.padding(horizontal = 4.dp, vertical = 2.dp)) {
                                    FilterChip(
                                        selected = !chartType,
                                        onClick = { chartType = false },
                                        label = { Text("柱状", fontSize = 12.sp) },
                                        modifier = Modifier.height(30.dp)
                                    )
                                    Spacer(modifier = Modifier.width(2.dp))
                                    FilterChip(
                                        selected = chartType,
                                        onClick = { chartType = true },
                                        label = { Text("折线", fontSize = 12.sp) },
                                        modifier = Modifier.height(30.dp)
                                    )
                                }
                            }

                            Spacer(modifier = Modifier.weight(1f))

                            // 单位选择（两种模式都显示）
                            Text("单位:", fontSize = 13.sp)
                            Spacer(modifier = Modifier.width(4.dp))
                            SizeUnit.values().forEach { unit ->
                                FilterChip(
                                    selected = selectedUnit == unit,
                                    onClick = { selectedUnit = unit },
                                    label = { Text(unit.label, fontSize = 11.sp) },
                                    modifier = Modifier.height(28.dp)
                                )
                            }
                        }

                        // 柱状图模式下才显示数量控制
                        if (!chartType) {
                            Spacer(modifier = Modifier.height(8.dp))
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(6.dp)
                            ) {
                                Text("显示:", fontSize = 13.sp)
                                listOf(10, 20, 50, null).forEach { count ->
                                    FilterChip(
                                        selected = showCount == count,
                                        onClick = { showCount = count },
                                        label = { Text(if (count == null) "全部" else "Top${count}", fontSize = 12.sp) },
                                        modifier = Modifier.height(28.dp)
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }

        // 图表区域
        Card(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .padding(horizontal = 12.dp, vertical = 4.dp)
        ) {
            if (chartType) {
                // L型折线图（应用大小分布曲线）
                Box(modifier = Modifier.fillMaxSize().padding(4.dp)) {
                    LCurveChart(apps = displayApps, unit = selectedUnit)
                }
            } else {
                // 水平柱状图 - 使用 LazyColumn 避免 OOM
                BarChartView(
                    apps = displayApps,
                    selectedUnit = selectedUnit
                )
            }
        }
    }
}

private val AppInfo.totalSize: Long get() = appSize + cacheSize + dataSize

@Composable
fun BarChartView(
    apps: List<AppInfo>,
    selectedUnit: SizeUnit
) {
    val context = LocalContext.current
    val primaryColor = MaterialTheme.colorScheme.primary
    val surfaceVariant = MaterialTheme.colorScheme.surfaceVariant
    // 取真实最大值。以前写的是 apps.firstOrNull()?.totalSize —— 隐含「调用方一定
    // 按大小降序排好」这个前提，一旦顺序变了 ratio 就 >1，再被 coerceIn 悄悄夹住，
    // 图形看着挺正常，数据其实是错的。
    val maxValue = (apps.maxOfOrNull { it.totalSize } ?: 1L).coerceAtLeast(1L).toFloat()

    // 使用 LazyColumn + itemsIndexed 代替 verticalScroll + forEach，避免大量 app 时的 OOM
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 4.dp, end = 4.dp, top = 8.dp, bottom = 8.dp)
    ) {
        itemsIndexed(apps) { index, app ->
            val ratio = app.totalSize.toFloat() / maxValue

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(40.dp)
                    .clickable {
                        // 没有权限时缓存/数据显示「—」，不显示 0 —— 0 会被读成
                        // 「这个应用没有缓存」，而事实是「读不到」。
                        val cacheText = formatFileSizeOrUnknown(app.cacheSize, app.hasSizeDetail)
                        val dataText = formatFileSizeOrUnknown(app.dataSize, app.hasSizeDetail)
                        Toast.makeText(
                            context,
                            "${app.appName}\n总大小: ${selectedUnit.format(app.totalSize)}\n" +
                                "应用: ${selectedUnit.format(app.appSize)} | 缓存: $cacheText | 数据: $dataText",
                            Toast.LENGTH_SHORT
                        ).show()
                    },
                verticalAlignment = Alignment.CenterVertically
            ) {
                // 排名
                Text(
                    text = "${index + 1}",
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Bold,
                    color = when (index) {
                        0 -> Color(0xFFFFD700)
                        1 -> Color(0xFFC0C0C0)
                        2 -> Color(0xFFCD7F32)
                        else -> Color.Gray
                    },
                    modifier = Modifier.width(24.dp)
                )

                // 柱状条
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .height(32.dp)
                        .padding(end = 4.dp)
                ) {
                    Box(
                        modifier = Modifier
                            .fillMaxHeight()
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(4.dp))
                            .background(surfaceVariant)
                    )
                    val barColor = when {
                        app.totalSize > 1024L * 1024 * 1024 -> Color(0xFFE53935)
                        app.totalSize > 500 * 1024 * 1024 -> Color(0xFFFB8C00)
                        app.totalSize > 100 * 1024 * 1024 -> Color(0xFFFFC107)
                        else -> primaryColor
                    }
                    Box(
                        modifier = Modifier
                            .fillMaxHeight()
                            .fillMaxWidth(ratio.coerceIn(0.01f, 1f))
                            .clip(RoundedCornerShape(4.dp))
                            .background(barColor)
                    )
                }

                Text(
                    text = app.appName,
                    fontSize = 11.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.width(80.dp)
                )

                Text(
                    text = selectedUnit.format(app.totalSize),
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.width(60.dp),
                    textAlign = TextAlign.End
                )
            }
        }
    }
}

// ==================== L型折线图（应用大小分布，非累计） ====================
@Composable
fun LCurveChart(apps: List<AppInfo>, unit: SizeUnit) {
    val context = LocalContext.current

    if (apps.size < 2) {
        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("数据不足", color = Color.Gray)
        }
        return
    }

    // ---- 预计算：全部移到 Canvas 外部 ----
    val n = apps.size
    // 预计算缩放后的Y值（FloatArray，避免Canvas内重复计算）
    val scaledValues = remember(apps, unit) {
        FloatArray(n) { idx ->
            val bytes = apps[idx].totalSize
            when (unit) {
                SizeUnit.B   -> bytes.toFloat()
                SizeUnit.KB  -> bytes / 1024f
                SizeUnit.MB  -> bytes / (1024f * 1024f)
                SizeUnit.GB  -> bytes / (1024f * 1024f * 1024f)
            }
        }
    }
    // 以前是 scaledValues[0].coerceAtLeast(1f)：既假设首元素最大，又强行把轴的
    // 上界抬到 1 —— 选「GB」做单位时应用大小都在 1 以下，整条曲线会被压到轴底。
    // 现在取真实最大值，并且只用一个极小值兜底防止除零。
    val maxScaled = scaledValues.maxOrNull()?.takeIf { it > 0f } ?: 1f

    // Y轴刻度标签（预计算字符串）。显式 Locale.US，避免德语等环境输出 "1,5GB"。
    val yLabelStrings = remember(maxScaled, unit) {
        List(6) { i ->
            val value = maxScaled * i / 5f
            String.format(Locale.US, "%.1f%s", value, unit.label)
        }
    }

    // X轴刻度索引
    val xTicks = remember(n) {
        listOf(0, n / 4, n / 2, n * 3 / 4, (n - 1).coerceAtLeast(0))
    }

    // 点击弹窗内容（只计算一次）
    val toastInfo = remember(apps, unit) {
        val total = apps.sumOf { it.totalSize }
        "📈 L型曲线\n" +
        "总应用: ${apps.size}个\n" +
        "总占用: ${unit.format(total)}\n" +
        "最大: ${apps.first().appName} (${unit.format(apps.first().totalSize)})\n" +
        "最小: ${apps.last().appName} (${unit.format(apps.last().totalSize)})"
    }

    val primaryColor = MaterialTheme.colorScheme.primary
    val gridColor = Color.LightGray.copy(alpha = 0.35f)
    val axisColor = Color.Gray
    val fillColor = primaryColor.copy(alpha = 0.12f)
    val lineColor = primaryColor
    // 在 Canvas 外部预创建 Paint（避免 Canvas lambda 内调用 remember）
    val yPaint = remember { android.graphics.Paint().apply { isAntiAlias = true } }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .clickable {
                Toast.makeText(context, toastInfo, Toast.LENGTH_LONG).show()
            }
    ) {
        Canvas(modifier = Modifier.fillMaxSize().padding(horizontal = 8.dp, vertical = 4.dp)) {
            val w = size.width
            val h = size.height
            val padL = 68f
            val padR = 16f
            val padT = 16f
            val padB = 40f
            val cw = w - padL - padR
            val ch = h - padT - padB
            if (n < 2 || cw <= 0 || ch <= 0) return@Canvas

            val stepX = cw / (n - 1).toFloat().coerceAtLeast(1f)

            // ---- 背景网格 ----
            for (i in 0..5) {
                val y = padT + ch * (1f - i / 5f)
                drawLine(gridColor, Offset(padL, y), Offset(padL + cw, y), strokeWidth = 0.5f)
            }

            // ---- Y轴标签 ----
            yPaint.textAlign = android.graphics.Paint.Align.RIGHT
            yPaint.textSize = 22f
            yPaint.color = android.graphics.Color.GRAY
            yLabelStrings.forEachIndexed { i, label ->
                val y = padT + ch * (1f - i / 5f)
                drawContext.canvas.nativeCanvas.drawText(label, padL - 6f, y + 7f, yPaint)
            }

            // ---- X轴标签 ----
            yPaint.textAlign = android.graphics.Paint.Align.CENTER
            yPaint.textSize = 20f
            xTicks.forEach { idx ->
                if (idx in 0 until n) {
                    val x = padL + idx * stepX
                    drawContext.canvas.nativeCanvas.drawText("${idx + 1}", x, h - padB + 28f, yPaint)
                }
            }

            // ---- 坐标轴 ----
            drawLine(axisColor, Offset(padL, padT), Offset(padL, padT + ch), strokeWidth = 1.5f)
            drawLine(axisColor, Offset(padL, padT + ch), Offset(padL + cw, padT + ch), strokeWidth = 1.5f)

            // ---- X轴说明文字 ----
            yPaint.textAlign = android.graphics.Paint.Align.CENTER
            yPaint.textSize = 18f
            drawContext.canvas.nativeCanvas.drawText(
                "应用序号（按大小从大到小 →）",
                padL + cw / 2f,
                h - 2f,
                yPaint
            )

            // ---- 折线 + 面积填充 ----
            val ptsX = FloatArray(n) { idx -> padL + idx * stepX }
            val ptsY = FloatArray(n) { idx -> padT + ch * (1f - scaledValues[idx] / maxScaled) }

            // 面积填充路径
            val fillPath = Path()
            fillPath.moveTo(ptsX[0], padT + ch)
            fillPath.lineTo(ptsX[0], ptsY[0])
            for (i in 1 until n) fillPath.lineTo(ptsX[i], ptsY[i])
            fillPath.lineTo(ptsX[n - 1], padT + ch)
            fillPath.close()
            drawPath(fillPath, fillColor)

            // 折线
            val linePath = Path()
            linePath.moveTo(ptsX[0], ptsY[0])
            for (i in 1 until n) linePath.lineTo(ptsX[i], ptsY[i])
            drawPath(linePath, lineColor, style = Stroke(width = 2.5f))

            // 起点/终点圆点
            drawCircle(lineColor, 4.5f, Offset(ptsX[0], ptsY[0]))
            drawCircle(lineColor, 4.5f, Offset(ptsX[n - 1], ptsY[n - 1]))
        }
    }
}