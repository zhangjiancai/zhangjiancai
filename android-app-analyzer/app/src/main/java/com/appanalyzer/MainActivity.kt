package com.appanalyzer

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import com.appanalyzer.service.DebugLogger
import com.appanalyzer.service.PreferencesManager
import com.appanalyzer.ui.screens.MainScreen
import com.appanalyzer.ui.theme.AppTheme
import com.appanalyzer.ui.util.ProvideCompactMode

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        DebugLogger.init(this)
        setContent {
            // AppTheme 默认跟随系统深浅色；以前这里是裸 MaterialTheme {}，
            // 没传 colorScheme，所以系统切深色也不会变。
            AppTheme {
                val prefs = remember { PreferencesManager(this) }
                // 全局紧凑模式在这里统一提供：通过缩放 LocalDensity，
                // 所有 dp/sp 一起缩小，不需要逐页改 padding，新增页面自动跟随。
                var compact by remember { mutableStateOf(prefs.getCompactMode()) }
                ProvideCompactMode(enabled = compact, onEnabledChange = {
                    compact = it
                    prefs.setCompactMode(it)
                }) {
                    Surface(
                        modifier = Modifier.fillMaxSize(),
                        color = MaterialTheme.colorScheme.background
                    ) {
                        MainScreen()
                    }
                }
            }
        }
    }
}
