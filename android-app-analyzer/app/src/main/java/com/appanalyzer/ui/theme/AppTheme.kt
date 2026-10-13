package com.appanalyzer.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/**
 * 应用配色。
 *
 * ## 设计原则
 *
 * 1. **一套色相，靠明度分层**。主色是同一个蓝（H≈215），浅色深色两套只是明度不同，
 *    不会出现「蓝色主色 + 紫色按钮 + 橙色高亮」这种各自为政的情况。
 * 2. **深色模式不用纯黑也不给纯白**。背景 #12151A 而不是 #000000（纯黑上放白字会发光刺眼），
 *    正文 #E2E5EA 而不是 #FFFFFF（降低亮度对比，长时间看不累）。
 * 3. **深色模式里的强调色要「压暗提灰」**。浅色下主色 #1B6EF3 直接搬到深色会刺眼，
 *    换成 #8FB6F0 —— 明度降到 70% 左右，饱和度也降，长看舒服。
 * 4. **分隔线用 outlineVariant**，它被刻意设计成低对比，不会出现「亮线刺眼」。
 *
 * 上一版的深色主色是 #9EC5FF（很亮的浅蓝），凡是拿 primary 当文字或图标的地方
 * 都会亮得扎眼；这一版统一压下来了。
 */
private val LightColors = lightColorScheme(
    primary = Color(0xFF1B6EF3),
    onPrimary = Color(0xFFFFFFFF),
    primaryContainer = Color(0xFFDCE7FB),
    onPrimaryContainer = Color(0xFF0B2B60),

    secondary = Color(0xFF54637A),
    onSecondary = Color(0xFFFFFFFF),
    secondaryContainer = Color(0xFFDDE3EC),
    onSecondaryContainer = Color(0xFF1B2534),

    tertiary = Color(0xFF3F6B5C),
    onTertiary = Color(0xFFFFFFFF),
    tertiaryContainer = Color(0xFFD6E7DF),
    onTertiaryContainer = Color(0xFF11291F),

    background = Color(0xFFF6F8FB),
    onBackground = Color(0xFF11151C),
    surface = Color(0xFFFFFFFF),
    onSurface = Color(0xFF11151C),
    surfaceVariant = Color(0xFFE9EDF3),
    onSurfaceVariant = Color(0xFF454B55),
    surfaceContainerHighest = Color(0xFFEDF0F5),

    outline = Color(0xFF9BA3AE),
    outlineVariant = Color(0xFFDCE1E8),

    error = Color(0xFFB3261E),
    onError = Color(0xFFFFFFFF),
    errorContainer = Color(0xFFF9DEDC),
    onErrorContainer = Color(0xFF410E0B),
)

private val DarkColors = darkColorScheme(
    // 深色主色：同一色相，明度 ~72%，饱和度压到一半
    primary = Color(0xFF8FB6F0),
    onPrimary = Color(0xFF07254F),
    primaryContainer = Color(0xFF23405F),
    onPrimaryContainer = Color(0xFFD6E3FA),

    secondary = Color(0xFFAEBBCE),
    onSecondary = Color(0xFF1B2534),
    secondaryContainer = Color(0xFF303B4B),
    onSecondaryContainer = Color(0xFFDDE3EC),

    tertiary = Color(0xFF9CC7B6),
    onTertiary = Color(0xFF11291F),
    tertiaryContainer = Color(0xFF2A4438),
    onTertiaryContainer = Color(0xFFD6E7DF),

    // 不用纯黑：纯黑背景下任何浅色文字都会"发光"
    background = Color(0xFF12151A),
    onBackground = Color(0xFFE2E5EA),
    surface = Color(0xFF181C22),
    onSurface = Color(0xFFE2E5EA),
    surfaceVariant = Color(0xFF262C34),
    onSurfaceVariant = Color(0xFFBFC6D0),
    surfaceContainerHighest = Color(0xFF2E353E),

    outline = Color(0xFF7C848F),
    // 低对比分隔线，避免"亮线刺眼"
    outlineVariant = Color(0xFF333A44),

    error = Color(0xFFE8A9A3),
    onError = Color(0xFF4A100C),
    errorContainer = Color(0xFF5C211C),
    onErrorContainer = Color(0xFFF9DEDC),
)

@Composable
fun AppTheme(
    /** 默认跟随系统深浅色 */
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        content = content
    )
}
