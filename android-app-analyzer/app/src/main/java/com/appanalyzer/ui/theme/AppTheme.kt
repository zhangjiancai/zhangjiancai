package com.appanalyzer.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/**
 * 应用主题。
 *
 * 以前 MainActivity 里直接写的是裸的 `MaterialTheme { }` —— 没传 colorScheme，
 * 于是永远用 Material3 的默认浅色方案，**系统切到深色模式也不会变**。
 * 这里补上浅色/深色两套，默认跟随系统。
 *
 * 配色没有用 Material3 默认的紫色，改成一套偏蓝的主色：
 * 深色下对比度更舒服，也和图标页里那些深色背景预设更协调。
 */
private val LightColors = lightColorScheme(
    primary = Color(0xFF1B6EF3),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFD8E6FF),
    onPrimaryContainer = Color(0xFF00174A),
    secondary = Color(0xFF4A6088),
    secondaryContainer = Color(0xFFDCE4F5),
    background = Color(0xFFF7F9FC),
    onBackground = Color(0xFF11151C),
    surface = Color(0xFFFFFFFF),
    onSurface = Color(0xFF11151C),
    surfaceVariant = Color(0xFFE6EBF2),
    onSurfaceVariant = Color(0xFF43474E),
    outline = Color(0xFF9AA2AD),
    error = Color(0xFFBA1A1A),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFF9EC5FF),
    onPrimary = Color(0xFF00306B),
    primaryContainer = Color(0xFF00458F),
    onPrimaryContainer = Color(0xFFD8E6FF),
    secondary = Color(0xFFB6C6E3),
    secondaryContainer = Color(0xFF33445E),
    background = Color(0xFF0F1216),
    onBackground = Color(0xFFE3E6EA),
    surface = Color(0xFF171B21),
    onSurface = Color(0xFFE3E6EA),
    surfaceVariant = Color(0xFF2A2F37),
    onSurfaceVariant = Color(0xFFC2C7CF),
    outline = Color(0xFF8C929B),
    error = Color(0xFFFFB4AB),
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
