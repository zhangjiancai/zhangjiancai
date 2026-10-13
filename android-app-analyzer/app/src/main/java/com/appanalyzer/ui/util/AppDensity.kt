package com.appanalyzer.ui.util

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density

/**
 * 全局紧凑模式。
 *
 * ## 为什么这么实现
 *
 * 最早的「紧凑模式」只改了图标页列表行的高度 —— 用户的原话是
 * 「紧凑模式做的不全呀，全局紧凑」。一页一页去调 padding / 字号，
 * 既改不全，将来新增页面也会漏。
 *
 * 这里改用 Compose 自带的 [LocalDensity]：把 density 乘一个系数，
 * **所有 dp 和 sp 会一起等比缩小**，不需要改任何一页的代码，全局立刻生效，
 * 新页面自动跟随。
 *
 * 系数取 0.85：屏幕上能多放约 18% 的内容，同时 12sp 的正文还有 10.2sp 的等效大小，
 * 仍在可读范围内。再往上压（比如 0.75）触摸目标会小于 36dp，不好点。
 */
private const val COMPACT_DENSITY_SCALE = 0.85f

/** 当前是否处于紧凑模式 */
val LocalCompactMode = compositionLocalOf { false }

/** 紧凑模式的读写入口，供设置页/工具栏里的开关使用 */
class CompactModeController(val enabled: Boolean, val setEnabled: (Boolean) -> Unit)

val LocalCompactModeController = compositionLocalOf { CompactModeController(false) {} }

/**
 * 在子树里应用紧凑模式。
 *
 * 注意 [LocalDensity] 要在**读取基准值之后**再提供，否则会自己乘自己。
 */
@Composable
fun ProvideCompactMode(
    enabled: Boolean,
    onEnabledChange: (Boolean) -> Unit,
    content: @Composable () -> Unit
) {
    val base = LocalDensity.current
    val target = if (enabled) Density(base.density * COMPACT_DENSITY_SCALE, base.fontScale) else base

    CompositionLocalProvider(
        LocalDensity provides target,
        LocalCompactMode provides enabled,
        LocalCompactModeController provides CompactModeController(enabled, onEnabledChange),
        content = content
    )
}

/** 按紧凑与否取不同的 dp 值（给那些需要"紧凑时更极端"的地方用） */
@Composable
fun dense(normal: androidx.compose.ui.unit.Dp, compact: androidx.compose.ui.unit.Dp) =
    if (LocalCompactMode.current) compact else normal
