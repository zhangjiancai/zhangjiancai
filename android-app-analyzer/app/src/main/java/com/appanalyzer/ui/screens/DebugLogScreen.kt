package com.appanalyzer.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.appanalyzer.service.DebugLogger
import com.appanalyzer.ui.util.formatFileSize
import kotlinx.coroutines.delay
import com.appanalyzer.ui.icons.AppIcons
import androidx.compose.material.icons.filled.*

@Composable
fun DebugLogScreen() {
    val logEntries = remember { mutableStateListOf<DebugLogger.LogEntry>() }
    val listState = rememberLazyListState()
    val clip = LocalClipboardManager.current
    var autoScroll by remember { mutableStateOf(true) }
    var fileSize by remember { mutableStateOf(0L) }

    // 只有内容真的变了才重建列表。
    // 原来是每 2 秒无条件 clear()+addAll() 整表刷新，日志没变化也会把整个列表
    // 重新 diff 一遍，而且每一轮都会触发一次滚动动画。
    LaunchedEffect(Unit) {
        while (true) {
            val current = DebugLogger.getEntries()
            fileSize = DebugLogger.getFileSizeBytes()
            if (current != logEntries.toList()) {
                val appendedOnly = current.size >= logEntries.size &&
                    logEntries.indices.all { current[it] == logEntries[it] }
                logEntries.clear()
                logEntries.addAll(current)
                if (autoScroll && logEntries.isNotEmpty() && appendedOnly) {
                    try { listState.animateScrollToItem(logEntries.size - 1) } catch (_: Exception) {}
                }
            }
            delay(2000)
        }
    }

    Column(modifier = Modifier.fillMaxSize().background(Color(0xFF1E1E1E))) {
        Row(
            modifier = Modifier.fillMaxWidth().background(Color(0xFF2D2D2D)).padding(horizontal = 12.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Column {
                Text("Debug 日志 (文件持久化)", color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.Bold)
                // 以前这里写的是「文件无上限」——那不是在夸它，是在描述一个会吃满存储的缺陷。
                // 现在日志超过 2MB 会自动轮转，这里显示真实占用。
                Text(
                    "内存 ${logEntries.size} 行 · 文件 ${formatFileSize(fileSize)} / 上限 ${formatFileSize(DebugLogger.getMaxFileBytes())}",
                    color = Color(0xFF888888), fontSize = 10.sp
                )
            }
            Row {
                TextButton(onClick = { autoScroll = !autoScroll }) {
                    Text(if (autoScroll) "ON" else "OFF", color = if (autoScroll) Color(0xFF4CAF50) else Color(0xFF888888), fontSize = 11.sp)
                }
                IconButton(onClick = { clip.setText(AnnotatedString(DebugLogger.getFullText())) }) {
                    Icon(AppIcons.ContentCopy, "复制", tint = Color(0xFFAAAAAA))
                }
                IconButton(onClick = { DebugLogger.clear(); logEntries.clear() }) {
                    Icon(Icons.Default.Delete, "清空", tint = Color(0xFFAAAAAA))
                }
            }
        }

        LazyColumn(state = listState, modifier = Modifier.fillMaxSize(), contentPadding = PaddingValues(2.dp)) {
            if (logEntries.isEmpty()) {
                item {
                    Box(modifier = Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Text("📭 暂无日志", color = Color(0xFF666666), fontSize = 14.sp)
                            Text("打开APP后自动记录", color = Color(0xFF555555), fontSize = 11.sp)
                        }
                    }
                }
            }
            // 加 key：以前没有 key，每次刷新都会把整列重新组合一遍
            itemsIndexed(logEntries, key = { index, entry -> "$index|${entry.time}|${entry.level}" }) { _, entry ->
                val bg = when (entry.level) { "E" -> Color(0xFF4A2020); "W" -> Color(0xFF3A3020); else -> Color.Transparent }
                val tc = when (entry.level) { "E" -> Color(0xFFFF6B6B); "W" -> Color(0xFFFFC107); else -> Color(0xFFC0C0C0) }
                Text(
                    text = "[${entry.time}] [${entry.level}] ${entry.message}",
                    modifier = Modifier.fillMaxWidth().background(bg).padding(horizontal = 8.dp, vertical = 2.dp),
                    color = tc, fontSize = 10.sp, fontFamily = FontFamily.Monospace,
                    maxLines = 20, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis
                )
            }
        }
    }
}