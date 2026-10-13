package com.appanalyzer.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.appanalyzer.ui.theme.ChartPalette

/** 堆叠条的一段。 */
data class CompositionSegment(val color: Color, val fraction: Float)

/**
 * 堆叠占比条。
 *
 * 几段颜色用的是**同一个色相的浓度台阶**（由调用方从 ChartPalette 里取），
 * 段与段之间留 2dp 缝：即使两段浓度接近，靠形状也能分清，
 * 不需要再引入新的色相。
 */
@Composable
fun CompositionBar(
    segments: List<CompositionSegment>,
    modifier: Modifier = Modifier,
    height: Dp = 9.dp
) {
    val visible = segments.filter { it.fraction > 0.0005f }
    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(height)
            .clip(RoundedCornerShape(height / 2))
            .background(ChartPalette.track()),
        horizontalArrangement = Arrangement.spacedBy(2.dp)
    ) {
        if (visible.isEmpty()) {
            Spacer(Modifier.weight(1f).fillMaxHeight())
        } else {
            visible.forEach { segment ->
                Box(
                    modifier = Modifier
                        .weight(segment.fraction.coerceAtLeast(0.0005f))
                        .fillMaxHeight()
                        .background(segment.color)
                )
            }
        }
    }
}

/**
 * 列表里的一行"带背景填充的条形"。
 *
 * 把条形**当成行的背景**而不是另起一行画，一行就能同时表达
 * 名称、数值和相对大小 —— 这是这个页面信息密度最高的一个组件。
 *
 * 填充浓度刻意压得很低（0.2 左右）：文字压在填充上，浓度一高就变成
 * "浅底白字"这种看不清的组合。
 */
@Composable
fun RelativeBarRow(
    label: String,
    value: String,
    fraction: Float,
    modifier: Modifier = Modifier,
    leading: (@Composable () -> Unit)? = null,
    selected: Boolean = false,
    onClick: (() -> Unit)? = null
) {
    val shape = RoundedCornerShape(9.dp)
    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(30.dp)
            .clip(shape)
            .background(ChartPalette.track().copy(alpha = 0.30f))
            .then(if (selected) Modifier.background(ChartPalette.accent().copy(alpha = 0.10f)) else Modifier)
            .then(if (onClick != null) Modifier.clickable { onClick() } else Modifier)
    ) {
        Box(
            modifier = Modifier
                .fillMaxHeight()
                .fillMaxWidth(fraction.coerceIn(0.02f, 1f))
                .clip(shape)
                // 浓度压得较低：这一条上面还要压文字，浓度一高就变成"浅底蓝字"看不清
                .background(ChartPalette.barBrush(if (selected) 0.40f else 0.26f))
        )
        Row(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            if (leading != null) {
                leading()
                Spacer(Modifier.width(6.dp))
            }
            Text(
                text = label,
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                softWrap = false,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f)
            )
            Spacer(Modifier.width(8.dp))
            Text(
                text = value,
                fontSize = 11.sp,
                fontWeight = FontWeight.SemiBold,
                color = ChartPalette.accent(),
                maxLines = 1,
                softWrap = false,
                overflow = TextOverflow.Ellipsis
            )
        }
    }
}

/** 直方图的一格。 */
data class HistogramBin(val label: String, val count: Int)

/**
 * 迷你直方图。
 *
 * 用 Compose 的布局而不是 Canvas 画：柱子高度是"按比例算出来的 dp"，
 * 轴标签是同一行里等宽权重的 Text ——
 * 这样标签天然对齐柱子中心，而且**永远不可能折行**（宽度不够时省略），
 * 文字也不需要再用 nativeCanvas 去画。
 */
@Composable
fun MiniHistogram(
    bins: List<HistogramBin>,
    modifier: Modifier = Modifier,
    areaHeight: Dp = 76.dp,
    maxBarHeight: Dp = 54.dp
) {
    if (bins.isEmpty()) return
    val maxCount = bins.maxOf { it.count }.coerceAtLeast(1)
    val steps = bins.size
    Column(modifier = modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(areaHeight),
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            bins.forEachIndexed { index, bin ->
                val fraction = bin.count.toFloat() / maxCount
                // 浓度随体积档位递增：小应用淡、大应用浓，本身就是一层语义
                val strength = 0.45f + 0.55f * (if (steps <= 1) 1f else index.toFloat() / (steps - 1))
                Column(
                    modifier = Modifier.weight(1f),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Text(
                        text = "${bin.count}",
                        fontSize = 10.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = if (bin.count > 0) ChartPalette.accent() else MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        softWrap = false,
                        overflow = TextOverflow.Ellipsis
                    )
                    Spacer(Modifier.size(3.dp))
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .height((maxBarHeight * fraction).coerceAtLeast(2.dp))
                            .clip(RoundedCornerShape(topStart = 6.dp, topEnd = 6.dp, bottomStart = 2.dp, bottomEnd = 2.dp))
                            .then(
                                if (bin.count > 0) {
                                    Modifier.background(ChartPalette.columnBrush(strength))
                                } else {
                                    Modifier.background(ChartPalette.track())
                                }
                            )
                    )
                }
            }
        }
        Spacer(Modifier.size(4.dp))
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(1.dp)
                .background(ChartPalette.grid())
        )
        Spacer(Modifier.size(5.dp))
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            bins.forEach { bin ->
                Text(
                    text = bin.label,
                    fontSize = 9.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                    maxLines = 1,
                    softWrap = false,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f)
                )
            }
        }
    }
}
