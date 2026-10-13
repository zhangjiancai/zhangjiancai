package com.appanalyzer.service.iconpack

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.appanalyzer.service.IconPackExporter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 可展开的「图标包说明」区块 —— 直接塞进图标页即可。
 *
 * 内容见 [IconPackTutorial]：图标包是什么、为什么必须做成 APK、装完怎么启用、
 * 哪些启动器支持 / 不支持、签名与更新的注意事项。
 */
@Composable
fun IconPackTutorialCard(
    modifier: Modifier = Modifier,
    initiallyExpanded: Boolean = false,
) {
    var expanded by remember { mutableStateOf(initiallyExpanded) }
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(10.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.35f),
    ) {
        Column(modifier = Modifier.fillMaxWidth().padding(12.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth().clickable { expanded = !expanded },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = IconPackTutorial.SUMMARY,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Medium,
                    modifier = Modifier.weight(1f),
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    text = if (expanded) "收起 ▲" else "展开 ▼",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.primary,
                )
            }
            if (expanded) {
                Spacer(Modifier.height(8.dp))
                for (section in IconPackTutorial.SECTIONS) {
                    Text(
                        text = section.title,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.padding(top = 8.dp, bottom = 2.dp),
                    )
                    Text(
                        text = section.body,
                        fontSize = 12.sp,
                        lineHeight = 18.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

/**
 * 「在手机里打包图标包 APK」对话框：上面是说明，下面是打包按钮与进度。
 *
 * 调用方（图标页）只需要：
 *   var show by remember { mutableStateOf(false) }
 *   if (show) IconPackBuilderDialog(entries = payload, onDismiss = { show = false })
 * 其中 payload 就是「导出图标包 zip」时用的那份 List<IconPackExporter.Entry>。
 */
@Composable
fun IconPackBuilderDialog(
    entries: List<IconPackExporter.Entry>,
    packName: String = IconPackApkBuilder.DEFAULT_LABEL,
    onDismiss: () -> Unit,
    onFinished: (String) -> Unit = {},
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val service = remember { IconPackApkService(context) }
    var running by remember { mutableStateOf(false) }
    var progress by remember { mutableStateOf("") }
    var resultText by remember { mutableStateOf<String?>(null) }
    var errorText by remember { mutableStateOf<String?>(null) }

    AlertDialog(
        onDismissRequest = { if (!running) onDismiss() },
        title = { Text("在手机里打包图标包 APK", fontSize = 16.sp) },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 420.dp)
                    .verticalScroll(rememberScrollState()),
            ) {
                IconPackTutorialCard()
                Spacer(Modifier.height(10.dp))
                Text(
                    text = "本次将打包 ${entries.size} 个图标，图标包名字：$packName",
                    fontSize = 12.sp,
                )
                if (running) {
                    Spacer(Modifier.height(10.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(modifier = Modifier.width(16.dp).height(16.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.width(8.dp))
                        Text(progress.ifBlank { "打包中…" }, fontSize = 12.sp)
                    }
                }
                resultText?.let {
                    Spacer(Modifier.height(10.dp))
                    Text(it, fontSize = 12.sp, color = MaterialTheme.colorScheme.primary)
                }
                errorText?.let {
                    Spacer(Modifier.height(10.dp))
                    Text("打包失败：$it", fontSize = 12.sp, color = MaterialTheme.colorScheme.error)
                }
            }
        },
        confirmButton = {
            Button(
                enabled = !running && entries.isNotEmpty(),
                onClick = {
                    running = true
                    errorText = null
                    resultText = null
                    progress = ""
                    scope.launch {
                        try {
                            val res = withContext(Dispatchers.IO) {
                                service.buildAndExport(entries, packName) { message -> progress = message }
                            }
                            val skippedNote = if (res.skippedPackages.isEmpty()) {
                                ""
                            } else {
                                "\n有 ${res.skippedPackages.size} 个图标数据无效被跳过。"
                            }
                            resultText = "已生成 ${res.iconCount} 个图标的图标包（${res.bytes / 1024} KB）" +
                                "\n存放位置：${res.location}" +
                                "\n\n下一步：在文件管理器/下载里点它安装，然后到启动器设置 → 图标包 里选择「$packName」。" +
                                skippedNote
                            onFinished(res.location)
                        } catch (e: Exception) {
                            errorText = e.message ?: e.javaClass.simpleName
                        } finally {
                            running = false
                            progress = ""
                        }
                    }
                },
            ) {
                Text(if (resultText == null) "开始打包" else "再打一次", fontSize = 13.sp)
            }
        },
        dismissButton = {
            TextButton(onClick = { if (!running) onDismiss() }) {
                Text("关闭")
            }
        },
    )
}
