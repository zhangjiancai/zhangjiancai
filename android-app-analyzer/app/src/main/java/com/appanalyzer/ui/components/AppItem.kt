package com.appanalyzer.ui.components

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.Settings
import android.util.Base64
import android.widget.Toast
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.appanalyzer.data.model.AppInfo
import com.appanalyzer.service.AppInfoService
import com.appanalyzer.ui.util.formatFileSize
import com.appanalyzer.ui.util.formatFileSizeOrUnknown
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import com.appanalyzer.ui.icons.AppIcons
import androidx.compose.material.icons.filled.*

@Composable
fun AppItem(app: AppInfo, appService: AppInfoService) {
    val context = LocalContext.current
    var expanded by remember { mutableStateOf(false) }
    var iconBase64 by remember { mutableStateOf<String?>(null) }

    // appService 由调用方传入。
    // 以前这里写的是 remember { AppInfoService(context) }，而 AppItem 是 LazyColumn 的
    // 列表项 —— 258 个应用就会 new 出 258 个 AppInfoService，每个内部还各带一个
    // OkHttpClient（含线程池和连接池）。纯属浪费。
    LaunchedEffect(app.packageName) {
        // 必须在 IO 线程做：loadAppIcon 要跑 PackageManager 取图标、
        // 缩放到 64x64、PNG 压缩、再 Base64 编码，全程是实打实的 CPU 活。
        // LaunchedEffect 的协程体默认跑在主线程，以前每滚一行都在主线程干这些。
        iconBase64 = withContext(Dispatchers.IO) { appService.loadAppIcon(app.packageName) }
    }

    // 展开时才需要图标位图。解码放到 Default 线程，
    // 以前是 remember(iconBase64) { Base64.decode(...) } —— 在组合阶段同步解码，
    // 也就是主线程上逐行做 Base64 解码 + BitmapFactory。
    val iconBitmap by produceState<Bitmap?>(initialValue = null, iconBase64) {
        val raw = iconBase64
        value = if (raw == null) null else withContext(Dispatchers.Default) {
            try {
                val bytes = Base64.decode(raw, Base64.DEFAULT)
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            } catch (e: Exception) { null }
        }
    }

    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { expanded = !expanded },
        elevation = CardDefaults.cardElevation(defaultElevation = 0.dp)
    ) {
        // 行高是被这里撑起来的：以前三个操作按钮**竖着**排在一个 Column 里，
        // 每个 32dp，于是每一行至少 96dp；再加上单独占一行的折叠箭头，
        // 单行接近 110dp —— 258 个应用就是 2.8 万 dp 的滚动距离。
        // 现在按钮横排、箭头并进主行，一行压到 50dp 上下。
        Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 6.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(app.appName, fontSize = 14.sp, fontWeight = FontWeight.Bold, maxLines = 1)
                        if (app.isSystemApp) {
                            Spacer(modifier = Modifier.width(5.dp))
                            Surface(shape = RoundedCornerShape(3.dp), color = Color.Gray.copy(alpha = 0.15f)) {
                                Text("系统", fontSize = 9.sp, color = Color.Gray,
                                    modifier = Modifier.padding(horizontal = 4.dp, vertical = 1.dp))
                            }
                        }
                    }
                    Text(app.packageName, fontSize = 10.sp, color = Color.Gray, maxLines = 1)
                }

                Column(horizontalAlignment = Alignment.End) {
                    Text(formatFileSize(app.appSize), fontSize = 14.sp, fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.primary)
                    Text(if (app.hasSizeDetail) "应用大小" else "仅APK", fontSize = 9.sp, color = Color.Gray)
                }

                Spacer(modifier = Modifier.width(4.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconButton(
                        onClick = {
                            try {
                                context.packageManager.getLaunchIntentForPackage(app.packageName)?.let {
                                    context.startActivity(it)
                                }
                            } catch (e: Exception) {
                                Toast.makeText(context, "无法启动: ${e.message}", Toast.LENGTH_SHORT).show()
                            }
                        },
                        enabled = app.packageName != context.packageName,
                        modifier = Modifier.size(28.dp)
                    ) {
                        @Suppress("DEPRECATION")
                        Icon(AppIcons.OpenInNew, contentDescription = "启动", modifier = Modifier.size(16.dp))
                    }
                    IconButton(
                        onClick = {
                            Toast.makeText(context, "请手动在系统设置中清除缓存", Toast.LENGTH_SHORT).show()
                            val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                                data = Uri.fromParts("package", app.packageName, null)
                            }
                            context.startActivity(intent)
                        },
                        modifier = Modifier.size(28.dp)
                    ) {
                        Icon(AppIcons.Cached, contentDescription = "清缓存", modifier = Modifier.size(16.dp))
                    }
                    if (!app.isSystemApp) {
                        IconButton(
                            onClick = {
                                try {
                                    val intent = Intent(Intent.ACTION_DELETE, Uri.fromParts("package", app.packageName, null))
                                    context.startActivity(intent)
                                } catch (e: Exception) {
                                    Toast.makeText(context, "卸载失败: ${e.message}", Toast.LENGTH_SHORT).show()
                                }
                            },
                            modifier = Modifier.size(28.dp)
                        ) {
                            Icon(Icons.Default.Delete, contentDescription = "卸载", modifier = Modifier.size(16.dp))
                        }
                    }
                    Icon(
                        if (expanded) AppIcons.ExpandLess else AppIcons.ExpandMore,
                        contentDescription = if (expanded) "收起" else "展开",
                        modifier = Modifier.size(18.dp),
                        tint = Color.Gray
                    )
                }
            }

            // 可折叠详情区域
            AnimatedVisibility(
                visible = expanded,
                enter = expandVertically(),
                exit = shrinkVertically()
            ) {
                Column {
                    Spacer(modifier = Modifier.height(6.dp))
                    HorizontalDivider()
                    Spacer(modifier = Modifier.height(8.dp))

                    // 这里以前又重复了一遍「图标 + 应用名 + 包名」，
                    // 而折叠状态下这三样都已经显示过了，纯属浪费半屏高度。
                    // 现在只在展开时补上折叠态没有的东西。
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceEvenly
                    ) {
                        // known 为 false 时显示「—」。以前这里会显示一个凭空算出来的数字，
                        // 用户根本没有办法分辨哪个是真测量、哪个是编的。
                        StorageItem(AppIcons.Cached, "缓存",
                            formatFileSizeOrUnknown(app.cacheSize, app.hasSizeDetail))
                        StorageItem(AppIcons.DataUsage, "数据",
                            formatFileSizeOrUnknown(app.dataSize, app.hasSizeDetail))
                        StorageItem(AppIcons.Storage, "总计",
                            formatFileSize(app.appSize + app.cacheSize + app.dataSize))
                    }

                    if (!app.hasSizeDetail) {
                        Spacer(modifier = Modifier.height(8.dp))
                        Text(
                            "未获取「使用情况访问」权限，缓存/数据读不到（这里不显示估算值）",
                            fontSize = 10.sp, color = Color(0xFFFF9800)
                        )
                    }

                    Spacer(modifier = Modifier.height(8.dp))
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Text("版本 ${app.versionName}", fontSize = 11.sp, color = Color.Gray)
                        Text("分类: ${app.category}", fontSize = 11.sp, color = Color.Gray)
                    }
                }
            }
        }
    }
}