package com.appanalyzer.ui.screens

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.appanalyzer.service.PreferencesManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import com.appanalyzer.ui.icons.AppIcons
import androidx.compose.material.icons.filled.*

/**
 * API Key 设置弹窗 + 联网检测
 */
@Composable
fun SettingsDialog(
    onDismiss: () -> Unit,
    onSaved: () -> Unit
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val prefsManager = remember { PreferencesManager(context) }

    var apiKey by remember { mutableStateOf(prefsManager.getApiKey()) }
    var testing by remember { mutableStateOf(false) }
    var testResult by remember { mutableStateOf<String?>(null) }
    var showKey by remember { mutableStateOf(false) }

    // 联网状态。原来有两个 LaunchedEffect(Unit)：一个循环轮询、一个做初始检测，
    // 于是首帧会并发检测两次，逻辑重复。
    var isNetworkAvailable by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        while (true) {
            isNetworkAvailable = checkNetwork(context)
            delay(10_000L)
        }
    }

    // API Key 格式校验提示
    val keyFormatWarning = remember(apiKey) {
        val trimmed = apiKey.trim()
        when {
            trimmed.isEmpty() -> null
            !trimmed.startsWith("sk-") -> "⚠️ API Key 通常以 sk- 开头，请确认格式正确"
            trimmed.length < 20 -> "⚠️ API Key 似乎太短，请检查是否完整"
            else -> null
        }
    }

    AlertDialog(
        onDismissRequest = { if (!testing) onDismiss() },
        title = { Text("DeepSeek API 设置", fontWeight = FontWeight.Bold) },
        text = {
            Column(modifier = Modifier.fillMaxWidth()) {
                // 联网状态
                Card(
                    colors = CardDefaults.cardColors(
                        containerColor = if (isNetworkAvailable) Color(0xFFE8F5E9) else Color(0xFFFFEBEE)
                    ),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Row(
                        modifier = Modifier.padding(12.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Icon(
                            if (isNetworkAvailable) AppIcons.Wifi else AppIcons.WifiOff,
                            contentDescription = null,
                            tint = if (isNetworkAvailable) Color(0xFF4CAF50) else Color(0xFFF44336)
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            if (isNetworkAvailable) "网络已连接" else "⚠️ 无网络连接",
                            fontSize = 13.sp
                        )
                    }
                }

                Spacer(modifier = Modifier.height(16.dp))

                Text("API Key", fontWeight = FontWeight.Medium, fontSize = 14.sp)
                Spacer(modifier = Modifier.height(8.dp))
                OutlinedTextField(
                    value = apiKey,
                    onValueChange = { apiKey = it; testResult = null },
                    modifier = Modifier.fillMaxWidth(),
                    placeholder = { Text("sk-...") },
                    visualTransformation = if (showKey)
                        androidx.compose.ui.text.input.VisualTransformation.None
                    else PasswordVisualTransformation(),
                    trailingIcon = {
                        IconButton(onClick = { showKey = !showKey }) {
                            Icon(
                                if (showKey) AppIcons.VisibilityOff else AppIcons.Visibility,
                                contentDescription = null
                            )
                        }
                    },
                    singleLine = true
                )

                Spacer(modifier = Modifier.height(4.dp))

                // API Key 格式警告
                if (keyFormatWarning != null) {
                    Text(
                        keyFormatWarning,
                        fontSize = 11.sp,
                        color = Color(0xFFE65100)
                    )
                }

                Text(
                    "从 DeepSeek 控制台获取: platform.deepseek.com",
                    fontSize = 11.sp, color = Color.Gray
                )

                val result = testResult
                if (result != null) {
                    Spacer(modifier = Modifier.height(12.dp))
                    val isSuccess = result.startsWith("✅")
                    Card(
                        colors = CardDefaults.cardColors(
                            containerColor = if (isSuccess) Color(0xFFE8F5E9) else Color(0xFFFFEBEE)
                        )
                    ) {
                        Text(
                            // 用局部变量代替 testResult!!：那个 !! 在提示消失的瞬间会崩
                            result,
                            modifier = Modifier.padding(12.dp),
                            fontSize = 13.sp,
                            color = if (isSuccess) Color(0xFF2E7D32) else Color(0xFFC62828)
                        )
                    }
                } else if (testing) {
                    Spacer(modifier = Modifier.height(12.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                        Spacer(modifier = Modifier.width(8.dp))
                        Text("正在测试连接...", fontSize = 13.sp)
                    }
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
                            // 用 keyOverride 测试，不再偷偷把密钥写进本地存储。
                            // 之前那句 PreferencesManager(context).apply { setApiKey(apiKey) }
                            // 意味着「测试连接」是个会落盘的副作用：点完再点取消，密钥已经存进去了。
                            val outcome = withContext(Dispatchers.IO) {
                                com.appanalyzer.service.DeepSeekService(prefsManager, keyToTest)
                                    .testConnection()
                                    .fold(
                                        onSuccess = { "✅ 连接成功: $it" },
                                        onFailure = { "❌ 失败: ${it.message}" }
                                    )
                            }
                            // 在主线程写 Compose 状态
                            testResult = outcome
                            testing = false
                        }
                    },
                    enabled = apiKey.isNotBlank() && !testing
                ) {
                    Text("测试连接")
                }
                Button(
                    onClick = {
                        prefsManager.setApiKey(apiKey)
                        onSaved()
                    },
                    enabled = !testing
                ) {
                    Text("保存")
                }
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("取消") }
        }
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