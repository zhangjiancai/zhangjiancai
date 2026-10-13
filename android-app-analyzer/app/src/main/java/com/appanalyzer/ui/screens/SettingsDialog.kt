package com.appanalyzer.ui.screens

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.appanalyzer.service.PreferencesManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import com.appanalyzer.ui.icons.AppIcons
import com.appanalyzer.ui.util.LocalCompactModeController
import androidx.compose.material.icons.filled.*

/**
 * 设置弹窗：显示偏好 + DeepSeek API Key + 关于入口。
 *
 * 这次重做了三处：
 * 1. **配色改用主题语义色**。原来网络状态卡写死 Color(0xFFE8F5E9) 这种淡绿/淡红，
 *    深色模式下就是两块刺眼的亮斑，而且和整体色系完全不搭。
 * 2. **加了「关于」入口**。用户要求把它从顶栏挪进设置里。
 * 3. **可滚动**。小屏幕上内容会超出对话框高度。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsDialog(
    onDismiss: () -> Unit,
    onSaved: () -> Unit,
    onOpenAbout: () -> Unit = {}
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val prefsManager = remember { PreferencesManager(context) }
    val compact = LocalCompactModeController.current

    var apiKey by remember { mutableStateOf(prefsManager.getApiKey()) }
    var testing by remember { mutableStateOf(false) }
    var testResult by remember { mutableStateOf<String?>(null) }
    var showKey by remember { mutableStateOf(false) }
    var isNetworkAvailable by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        while (true) {
            isNetworkAvailable = checkNetwork(context)
            delay(10_000L)
        }
    }

    val keyFormatWarning = remember(apiKey) {
        val trimmed = apiKey.trim()
        when {
            trimmed.isEmpty() -> null
            !trimmed.startsWith("sk-") -> "Key 通常以 sk- 开头，请确认格式"
            trimmed.length < 20 -> "Key 似乎太短，请检查是否完整"
            else -> null
        }
    }

    val cs = MaterialTheme.colorScheme

    AlertDialog(
        onDismissRequest = { if (!testing) onDismiss() },
        title = { Text("设置", fontWeight = FontWeight.Bold, fontSize = 17.sp, maxLines = 1) },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 460.dp)
                    .verticalScroll(rememberScrollState())
            ) {
                // ===== 显示 =====
                SectionLabel("显示")
                Row(
                    modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column(Modifier.weight(1f)) {
                        Text("全局紧凑", fontSize = 13.sp, maxLines = 1)
                        Text(
                            "所有页面整体缩小，一屏能多看约 18% 内容",
                            fontSize = 10.sp, color = cs.onSurfaceVariant, maxLines = 2
                        )
                    }
                    Switch(
                        checked = compact.enabled,
                        onCheckedChange = { compact.setEnabled(it) }
                    )
                }

                HorizontalDivider(Modifier.padding(vertical = 10.dp))

                // ===== DeepSeek =====
                SectionLabel("DeepSeek API")

                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(
                        if (isNetworkAvailable) AppIcons.Wifi else AppIcons.WifiOff,
                        contentDescription = null,
                        tint = if (isNetworkAvailable) cs.primary else cs.error,
                        modifier = Modifier.size(16.dp)
                    )
                    Spacer(Modifier.width(6.dp))
                    Text(
                        if (isNetworkAvailable) "网络已连接" else "无网络连接",
                        fontSize = 12.sp,
                        color = if (isNetworkAvailable) cs.onSurfaceVariant else cs.error,
                        maxLines = 1
                    )
                }

                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = apiKey,
                    onValueChange = { apiKey = it; testResult = null },
                    modifier = Modifier.fillMaxWidth(),
                    placeholder = { Text("sk-...", fontSize = 13.sp) },
                    visualTransformation = if (showKey)
                        androidx.compose.ui.text.input.VisualTransformation.None
                    else PasswordVisualTransformation(),
                    trailingIcon = {
                        IconButton(onClick = { showKey = !showKey }) {
                            Icon(
                                if (showKey) AppIcons.VisibilityOff else AppIcons.Visibility,
                                contentDescription = if (showKey) "隐藏" else "显示",
                                modifier = Modifier.size(18.dp)
                            )
                        }
                    },
                    singleLine = true,
                    textStyle = LocalTextStyle.current.copy(fontSize = 13.sp)
                )

                if (keyFormatWarning != null) {
                    Spacer(Modifier.height(4.dp))
                    Text(keyFormatWarning, fontSize = 10.sp, color = cs.error, maxLines = 1)
                }

                Spacer(Modifier.height(4.dp))
                Text(
                    "在 platform.deepseek.com 获取。只存在本机，不会编译进 APK。",
                    fontSize = 10.sp, color = cs.onSurfaceVariant
                )

                if (testing) {
                    Spacer(Modifier.height(10.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(modifier = Modifier.size(14.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.width(8.dp))
                        Text("正在测试连接…", fontSize = 12.sp, maxLines = 1)
                    }
                } else testResult?.let { result ->
                    Spacer(Modifier.height(10.dp))
                    val ok = result.startsWith("✅")
                    Surface(
                        shape = RoundedCornerShape(8.dp),
                        color = if (ok) cs.primaryContainer else cs.errorContainer,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text(
                            result,
                            modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
                            fontSize = 11.sp,
                            color = if (ok) cs.onPrimaryContainer else cs.onErrorContainer
                        )
                    }
                }

                HorizontalDivider(Modifier.padding(vertical = 10.dp))

                // ===== 其他 =====
                SectionLabel("其他")
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(8.dp))
                        .clickable { onDismiss(); onOpenAbout() }
                        .padding(vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Icon(Icons.Default.Info, null, tint = cs.primary, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Column(Modifier.weight(1f)) {
                        Text("关于", fontSize = 13.sp, maxLines = 1)
                        Text(
                            "版本、功能说明与已知限制（README 全文）",
                            fontSize = 10.sp, color = cs.onSurfaceVariant, maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                    }
                    Icon(Icons.Default.KeyboardArrowRight, null, tint = cs.onSurfaceVariant,
                        modifier = Modifier.size(18.dp))
                }
            }
        },
        confirmButton = {
            Row {
                TextButton(
                    onClick = {
                        scope.launch {
                            testing = true
                            testResult = null
                            val keyToTest = apiKey.trim()
                            // 用 keyOverride 测试，不偷偷落盘
                            val outcome = withContext(Dispatchers.IO) {
                                com.appanalyzer.service.DeepSeekService(prefsManager, keyToTest)
                                    .testConnection()
                                    .fold(
                                        onSuccess = { "✅ 连接成功: $it" },
                                        onFailure = { "❌ 失败: ${it.message}" }
                                    )
                            }
                            testResult = outcome
                            testing = false
                        }
                    },
                    enabled = apiKey.isNotBlank() && !testing
                ) { Text("测试连接", fontSize = 13.sp, maxLines = 1) }

                Button(
                    onClick = {
                        prefsManager.setApiKey(apiKey)
                        onSaved()
                    },
                    enabled = !testing
                ) { Text("保存", fontSize = 13.sp, maxLines = 1) }
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("取消", fontSize = 13.sp, maxLines = 1) }
        }
    )
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text,
        fontSize = 11.sp,
        fontWeight = FontWeight.SemiBold,
        color = MaterialTheme.colorScheme.primary,
        maxLines = 1,
        modifier = Modifier.padding(bottom = 4.dp)
    )
}

/**
 * 检查网络连接状态
 */
private fun checkNetwork(context: Context): Boolean {
    return try {
        // as? 而不是 as：类型不符时抛 ClassCastException 会被下面的 catch 吞掉并返回
        // 「无网络」，用户看到的是一句错误的提示而不是真正的失败原因。
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return false
        val network = cm.activeNetwork
        val caps = cm.getNetworkCapabilities(network)
        caps != null && (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                || caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)
                || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))
    } catch (e: Exception) {
        false
    }
}
