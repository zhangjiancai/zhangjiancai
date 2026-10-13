package com.appanalyzer.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance

/**
 * 统计页 / 图表页的**唯一取色口**。
 *
 * ## 为什么要有这个文件
 *
 * 以前这两个页面里散着二十多个硬编码色值（Color(0xFF4CAF50)、Color(0xFFFFD700)、
 * Color.Gray、Color.LightGray、Color(0xFFFF9800)……）。它们有两个毛病：
 *
 * 1. 彼此色相毫无关系，整页像打翻的调色盘，也就是"土"；
 * 2. 写死的浅色值在深色模式下要么变成"暗底上的暗字"（Color.Gray、Color.LightGray），
 *    要么是刺眼的纯白亮线。
 *
 * 所以这里把颜色收敛成一个口子，而且**全部从 MaterialTheme 的语义色推导**：
 * 主题换成什么色系整页跟着换，深浅色由主题负责，本文件里没有任何一个写死的色值。
 *
 * ## 怎么表达"多组数据"
 *
 * 只在**同一个色相**上做浓度台阶（[rampAlpha] / [ramp]）：既能区分系列，
 * 又不会引入互不相干的新颜色。浓度是用 alpha 表达的，alpha 是"叠在当前背景上"的，
 * 因此浅色下变淡、深色下变暗，两种模式都成立 —— 不需要写两套色值。
 *
 * 需要更强的区分度时（例如堆叠条的几段），配合形状与间距一起用，而不是再加新色相。
 */
object ChartPalette {

    /**
     * 当前是不是深色主题。
     *
     * 用**背景亮度**判断而不是 isSystemInDarkTheme()：AppTheme 将来如果支持
     * 手动切换深浅色，这里也能跟着走，不会和实际渲染出来的配色脱节。
     */
    @Composable
    @ReadOnlyComposable
    fun isDark(): Boolean = MaterialTheme.colorScheme.surface.luminance() < 0.5f

    /** 全页唯一的强调色。需要"跳出来"的元素（主数字、选中项、图形主体）都用它。 */
    @Composable
    @ReadOnlyComposable
    fun accent(): Color = MaterialTheme.colorScheme.primary

    /** 与强调色同族的次要色，用于和强调色并列但不抢戏的图形。 */
    @Composable
    @ReadOnlyComposable
    fun accentSoft(): Color = MaterialTheme.colorScheme.secondary

    /** 网格线：必须弱化，不能比数据本身还显眼。 */
    @Composable
    @ReadOnlyComposable
    fun grid(): Color = MaterialTheme.colorScheme.outline.copy(alpha = if (isDark()) 0.30f else 0.20f)

    /** 条形/堆叠条的轨道底色（未填充部分）。 */
    @Composable
    @ReadOnlyComposable
    fun track(): Color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = if (isDark()) 0.50f else 0.65f)

    /** 卡片描边。用一根发丝线代替阴影，两种模式下都干净。 */
    @Composable
    @ReadOnlyComposable
    fun hairline(): Color = MaterialTheme.colorScheme.outline.copy(alpha = if (isDark()) 0.26f else 0.18f)

    /**
     * 同色相台阶的浓度（alpha）。
     *
     * @param index 第几阶（0 最浓）
     * @param steps 共几阶
     * @return 1.0 ~ 0.38 之间的 alpha
     */
    fun rampAlpha(index: Int, steps: Int): Float {
        if (steps <= 1) return 1f
        val t = index.coerceIn(0, steps - 1).toFloat() / (steps - 1).toFloat()
        return 1f - t * 0.62f
    }

    /** 同色相台阶的颜色。 */
    @Composable
    @ReadOnlyComposable
    fun ramp(index: Int, steps: Int): Color = accent().copy(alpha = rampAlpha(index, steps))

    /**
     * 横向条形填充：从左到右轻微衰减。
     *
     * @param strength 整体浓度（0~1）。列表里的背景填充条传 0.2 左右即可。
     */
    @Composable
    @ReadOnlyComposable
    fun barBrush(strength: Float = 1f): Brush {
        val c = accent()
        return Brush.horizontalGradient(
            listOf(c.copy(alpha = 0.95f * strength), c.copy(alpha = 0.52f * strength))
        )
    }

    /** 纵向柱形填充：底部实、顶部亮，柱体有体积感。 */
    @Composable
    @ReadOnlyComposable
    fun columnBrush(strength: Float = 1f): Brush {
        val c = accent()
        return Brush.verticalGradient(
            listOf(c.copy(alpha = 0.95f * strength), c.copy(alpha = 0.40f * strength))
        )
    }

    /** 折线下方的面积填充：从强调色渐隐到透明，不会在深色底上糊成一块。 */
    @Composable
    @ReadOnlyComposable
    fun areaBrush(): Brush {
        val c = accent()
        return Brush.verticalGradient(listOf(c.copy(alpha = 0.34f), c.copy(alpha = 0.02f)))
    }
}
