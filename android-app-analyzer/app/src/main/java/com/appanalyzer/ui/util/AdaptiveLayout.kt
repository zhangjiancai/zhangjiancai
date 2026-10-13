package com.appanalyzer.ui.util

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * 屏幕尺寸档位。
 *
 * 分档标准参考 Material 3 的 window size class：
 *  - [COMPACT]  手机竖屏（< 600dp）
 *  - [MEDIUM]   手机横屏 / 小折叠展开（600 ~ 839dp）
 *  - [EXPANDED] 平板、大折叠展开（>= 840dp）
 */
enum class ScreenSize { COMPACT, MEDIUM, EXPANDED }

/**
 * 当前屏幕尺寸档位。
 *
 * 用 CompositionLocal 而不是各处自己读 LocalConfiguration，好处是：
 * 1. 只在 AdaptiveScaffold 里算一次，不用每个页面都算；
 * 2. 预览/测试里可以直接 provide 一个值，不用造 Configuration。
 *
 * 取的是 **screenWidthDp 而不是 widthDp**：widthDp 在多窗口/分屏下会变小，
 * 而我们要判断的是"这台设备有多大"，用屏幕宽度更稳。
 */
val LocalScreenSize = compositionLocalOf { ScreenSize.COMPACT }

/** 当前是否宽屏（平板/展开的大折叠） */
val LocalIsWideScreen: Boolean
    @Composable get() = LocalScreenSize.current != ScreenSize.COMPACT

/**
 * 自适应容器。
 *
 * ## 解决什么问题
 *
 * 同一套布局在不同屏幕上会遇到两种相反的毛病：
 *
 * - **窄屏（手机）**：内容挤，一屏放不下几行，于是需要紧凑模式、可滚动；
 * - **宽屏（平板/折叠展开）**：如果不处理，内容会被横向拉满一整块 1280dp 宽的区域，
 *   一行文字长到没法读，卡片之间巨大的空白也很浪费。
 *
 * 这里做的是最常见也最稳的一种处理：**超过 [maxContentWidth] 就把内容限宽居中**，
 * 两侧留白。手机上 maxWidth 一般小于 600dp，等于完全没有影响；
 * 平板上则把内容收在一个舒适的阅读宽度里。
 *
 * 顺带把屏幕档位通过 [LocalScreenSize] 提供给子树，需要更激进的多列布局时
 * 可以在页面内读它。
 *
 * @param maxContentWidth 内容最大宽度。默认 720dp，适合以列表/表单为主的界面。
 * @param horizontalPadding 两侧最小留白（窄屏时用得上）
 */
@Composable
fun AdaptiveScaffold(
    maxContentWidth: Dp = 720.dp,
    horizontalPadding: Dp = 0.dp,
    content: @Composable () -> Unit
) {
    BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
        val screenWidth = maxWidth
        val size = remember(screenWidth) {
            when {
                screenWidth < 600.dp -> ScreenSize.COMPACT
                screenWidth < 840.dp -> ScreenSize.MEDIUM
                else -> ScreenSize.EXPANDED
            }
        }
        CompositionLocalProvider(LocalScreenSize provides size) {
            Box(
                modifier = Modifier.fillMaxSize().padding(horizontal = horizontalPadding),
                contentAlignment = Alignment.TopCenter
            ) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .then(if (screenWidth > maxContentWidth) Modifier.widthIn(max = maxContentWidth) else Modifier)
                ) {
                    content()
                }
            }
        }
    }
}

/**
 * 按屏幕档位取值。
 *
 * 用法：val pad = adaptive(compact = 8.dp, medium = 12.dp, expanded = 16.dp)
 * 不传的档位会回退到更小的那一档，省得每次都写全三个。
 */
@Composable
fun <T> adaptive(compact: T, medium: T = compact, expanded: T = medium): T =
    when (LocalScreenSize.current) {
        ScreenSize.COMPACT -> compact
        ScreenSize.MEDIUM -> medium
        ScreenSize.EXPANDED -> expanded
    }
