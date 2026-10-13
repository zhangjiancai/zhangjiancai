package com.appanalyzer.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.appanalyzer.ui.theme.ChartPalette

/**
 * 统计/图表页共用的积木。
 *
 * ## 两条硬规则（写在组件里，别处就不用再记）
 *
 * 1. **文字一律不换行**：所有 Text 都是 maxLines = 1 + Ellipsis，靠 weight 分配宽度，
 *    空间不够时省略而不是折行。折行会让卡片高度参差不齐，是"土"的主要来源之一。
 * 2. **颜色一律来自 ChartPalette / MaterialTheme**：本文件里没有写死的色值，
 *    深浅色自动跟随。
 *
 * 尺寸约定：卡片内边距 12dp、卡片间距由调用方给 8dp、区块标题 14sp、正文 11~12sp。
 */

/** 卡片圆角，全站统一。 */
private val CardShape = RoundedCornerShape(14.dp)

/**
 * 区块卡片：标题行（图标 + 标题 + 右侧附加内容）+ 内容。
 *
 * 用一根发丝线描边、零阴影：比默认的 Material 阴影更"轻"，
 * 一屏里放七八张卡也不会显得笨重。
 */
@Composable
fun SectionCard(
    title: String,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    trailing: (@Composable () -> Unit)? = null,
    contentPadding: PaddingValues = PaddingValues(12.dp),
    content: @Composable ColumnScope.() -> Unit
) {
    Card(
        modifier = modifier
            .fillMaxWidth()
            .border(BorderStroke(1.dp, ChartPalette.hairline()), CardShape),
        shape = CardShape,
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 0.dp)
    ) {
        Column(modifier = Modifier.padding(contentPadding)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically
            ) {
                if (icon != null) {
                    Icon(
                        imageVector = icon,
                        contentDescription = null,
                        tint = ChartPalette.accent(),
                        modifier = Modifier.size(14.dp)
                    )
                    Spacer(Modifier.width(6.dp))
                }
                Text(
                    text = title,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f)
                )
                if (trailing != null) {
                    Spacer(Modifier.width(8.dp))
                    trailing()
                }
            }
            Spacer(Modifier.size(10.dp))
            content()
        }
    }
}

/**
 * 一个"数字 + 说明"的小格子。
 *
 * 数字比说明大 3~4sp 是实现层次感最省事的办法：
 * 一眼扫过去先看到数字，需要细节时再读说明。
 */
@Composable
fun MetricTile(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
    valueSize: TextUnit = 15.sp,
    valueColor: Color = Color.Unspecified,
    labelColor: Color = Color.Unspecified,
    horizontalAlignment: Alignment.Horizontal = Alignment.Start
) {
    val labelC = if (labelColor == Color.Unspecified) MaterialTheme.colorScheme.onSurfaceVariant else labelColor
    val valueC = if (valueColor == Color.Unspecified) MaterialTheme.colorScheme.onSurface else valueColor
    Column(modifier = modifier, horizontalAlignment = horizontalAlignment) {
        Text(
            text = value,
            fontSize = valueSize,
            fontWeight = FontWeight.SemiBold,
            color = valueC,
            maxLines = 1,
            softWrap = false,
            overflow = TextOverflow.Ellipsis
        )
        Spacer(Modifier.size(2.dp))
        Text(
            text = label,
            fontSize = 10.sp,
            color = labelC,
            maxLines = 1,
            softWrap = false,
            overflow = TextOverflow.Ellipsis
        )
    }
}

/**
 * 分段选择器。
 *
 * 换掉原来的 FilterChip：FilterChip 自带 32dp 的最小高度和较宽的内边距，
 * 四个选项一排就顶到屏幕边上了。这里的每一段只有 5dp 纵向内边距，
 * 窄屏也放得下，文字更不会折行。
 */
@Composable
fun <T> SegmentedToggle(
    options: List<T>,
    selected: T,
    onSelect: (T) -> Unit,
    modifier: Modifier = Modifier,
    label: (T) -> String
) {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(9.dp),
        color = ChartPalette.track()
    ) {
        Row(
            modifier = Modifier.padding(2.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            options.forEach { option ->
                val isSelected = option == selected
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(7.dp))
                        .background(if (isSelected) ChartPalette.accent() else Color.Transparent)
                        .clickable { onSelect(option) }
                        .padding(horizontal = 10.dp, vertical = 5.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = label(option),
                        fontSize = 11.sp,
                        fontWeight = if (isSelected) FontWeight.SemiBold else FontWeight.Normal,
                        color = if (isSelected) {
                            MaterialTheme.colorScheme.onPrimary
                        } else {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        },
                        maxLines = 1,
                        softWrap = false,
                        overflow = TextOverflow.Ellipsis
                    )
                }
            }
        }
    }
}

/** 名次徽标。第 1 名用实心强调色，其余退到"底色 + 强调色文字"。 */
@Composable
fun RankBadge(rank: Int, modifier: Modifier = Modifier, size: Dp = 20.dp) {
    val top = rank == 1
    Box(
        modifier = modifier
            .size(size)
            .clip(RoundedCornerShape(6.dp))
            .background(if (top) ChartPalette.accent() else ChartPalette.track()),
        contentAlignment = Alignment.Center
    ) {
        Text(
            text = "$rank",
            fontSize = 10.sp,
            fontWeight = FontWeight.Bold,
            color = if (top) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            softWrap = false
        )
    }
}

/**
 * 提示药丸。
 *
 * 以前"没有使用情况访问权限"是用 ⚠️ emoji + 橙色硬编码文字表达的。
 * emoji 在不同厂商 ROM 上长相差别很大，橙色在深色底上也很刺眼，
 * 所以换成 errorContainer 这组语义色 + 矢量图标。
 *
 * 文字只有一行，超长省略 —— 完整解释放在 [onClick] 里（点一下弹 Toast）。
 */
@Composable
fun InfoPill(
    text: String,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    onClick: (() -> Unit)? = null
) {
    val shape = RoundedCornerShape(8.dp)
    Surface(
        modifier = modifier.then(
            if (onClick != null) Modifier.clip(shape).clickable { onClick() } else Modifier
        ),
        shape = shape,
        color = MaterialTheme.colorScheme.errorContainer
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            if (icon != null) {
                Icon(
                    imageVector = icon,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onErrorContainer,
                    modifier = Modifier.size(12.dp)
                )
                Spacer(Modifier.width(5.dp))
            }
            Text(
                text = text,
                fontSize = 10.sp,
                color = MaterialTheme.colorScheme.onErrorContainer,
                maxLines = 1,
                softWrap = false,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false)
            )
        }
    }
}

/** 图例上那个小圆点。用圆形而不是 emoji，深浅色下都干净。 */
@Composable
fun LegendDot(color: Color, modifier: Modifier = Modifier) {
    Box(modifier = modifier.size(7.dp).clip(CircleShape).background(color))
}

/** 图例的一项：圆点 + 名称（一行）+ 数值（一行）。 */
@Composable
fun LegendItem(
    color: Color,
    label: String,
    value: String,
    modifier: Modifier = Modifier,
    valueColor: Color = Color.Unspecified
) {
    Column(modifier = modifier, verticalArrangement = Arrangement.Center) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            LegendDot(color)
            Spacer(Modifier.width(5.dp))
            Text(
                text = label,
                fontSize = 10.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                softWrap = false,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false)
            )
        }
        Spacer(Modifier.size(2.dp))
        Text(
            text = value,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            color = if (valueColor == Color.Unspecified) MaterialTheme.colorScheme.onSurface else valueColor,
            maxLines = 1,
            softWrap = false,
            overflow = TextOverflow.Ellipsis
        )
    }
}
