package com.appanalyzer.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * 关于页：把项目里的 README.md 原样显示出来。
 *
 * README 放在 app/src/main/assets/README.md，构建时打包进 APK。
 * 这样文档只有一份，改 README 不用同步改代码；代价是显示的是**纯文本 + 简易排版**，
 * 不是完整渲染 Markdown 表格。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AboutScreen(onBack: () -> Unit) {
    val context = LocalContext.current
    var lines by remember { mutableStateOf<List<String>?>(null) }

    LaunchedEffect(Unit) {
        lines = withContext(Dispatchers.IO) {
            try {
                context.assets.open("README.md").bufferedReader().use { it.readLines() }
            } catch (e: Exception) {
                listOf("读取 README 失败：" + e.message)
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("关于", fontSize = 16.sp) },
                navigationIcon = {
                    TextButton(onClick = onBack) { Text("返回", fontSize = 13.sp) }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.primary,
                    titleContentColor = Color.White,
                    navigationIconContentColor = Color.White
                )
            )
        }
    ) { padding ->
        val content = lines
        // ⚠️ 不能写「if (null) { ...; return@Scaffold }」——
        // 在 @Composable lambda 里提前 return 会让 Compose 的槽表失衡。
        // 项目里已经在图表页实测崩过一次（IndexOutOfBoundsException at endRoot）。
        if (content == null) {
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
        } else {
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp)
        ) {
            itemsIndexed(content) { _, line ->
                MarkdownLine(line)
            }
            item {
                Spacer(Modifier.height(24.dp))
                Text(
                    "以上内容来自项目根目录的 README.md，随 APK 一起打包。",
                    fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Spacer(Modifier.height(16.dp))
            }
        }
        }   // 关闭 else
    }
}

/**
 * 一行 Markdown 的简易渲染。
 *
 * 只处理最常见的几种：标题、代码块围栏、引用、列表项、表格行、空行。
 * 故意不追求完整 —— 表格在手机上本来就显示不下，按等宽文本原样展示反而更好读。
 */
@Composable
private fun MarkdownLine(raw: String) {
    val line = raw.trimEnd()
    val cs = MaterialTheme.colorScheme

    when {
        line.isBlank() -> Spacer(Modifier.height(6.dp))

        line.startsWith("```") -> {
            // 代码围栏本身不显示，只留一点间距
            Spacer(Modifier.height(4.dp))
        }

        line.startsWith("#### ") -> MarkdownText(line.removePrefix("#### "), 13.sp, FontWeight.Bold, cs.primary)

        line.startsWith("### ") -> MarkdownText(line.removePrefix("### "), 14.sp, FontWeight.Bold, cs.primary)

        line.startsWith("## ") -> {
            Spacer(Modifier.height(8.dp))
            MarkdownText(line.removePrefix("## "), 16.sp, FontWeight.Bold, cs.primary)
            HorizontalDivider(Modifier.padding(vertical = 4.dp))
        }

        line.startsWith("# ") -> MarkdownText(line.removePrefix("# "), 19.sp, FontWeight.Bold, cs.primary)

        line.startsWith("> ") -> {
            Row(Modifier.fillMaxWidth().padding(vertical = 1.dp)) {
                Box(
                    Modifier.width(3.dp).fillMaxHeight().clip(RoundedCornerShape(2.dp))
                        .background(cs.primary.copy(alpha = 0.5f))
                )
                Spacer(Modifier.width(8.dp))
                MarkdownText(line.removePrefix("> "), 11.sp, FontWeight.Normal, cs.onSurfaceVariant)
            }
        }

        line.startsWith("|") -> {
            // 表格：按等宽字体整行显示，分隔行（|---|）直接跳过
            if (line.replace("|", "").replace("-", "").replace(":", "").isBlank()) {
                HorizontalDivider(Modifier.padding(vertical = 2.dp))
            } else {
                Text(
                    line, fontSize = 10.sp, fontFamily = FontFamily.Monospace,
                    color = cs.onSurface, maxLines = 3,
                    modifier = Modifier.padding(vertical = 1.dp)
                )
            }
        }

        line.startsWith("- ") || line.startsWith("* ") -> {
            Row(Modifier.fillMaxWidth().padding(start = 4.dp, top = 1.dp)) {
                Text("•", fontSize = 12.sp, color = cs.primary)
                Spacer(Modifier.width(6.dp))
                MarkdownInline(line.substring(2), 12.sp)
            }
        }

        line.firstOrNull()?.isDigit() == true && line.contains(". ") -> {
            val idx = line.indexOf(". ")
            Row(Modifier.fillMaxWidth().padding(start = 4.dp, top = 1.dp)) {
                Text(line.substring(0, idx + 1), fontSize = 12.sp, color = cs.primary)
                Spacer(Modifier.width(6.dp))
                MarkdownInline(line.substring(idx + 2), 12.sp)
            }
        }

        line.startsWith("---") -> HorizontalDivider(Modifier.padding(vertical = 6.dp))

        else -> MarkdownInline(line, 12.sp)
    }
}

@Composable
private fun MarkdownText(text: String, size: androidx.compose.ui.unit.TextUnit, weight: FontWeight, color: Color) {
    Text(text, fontSize = size, fontWeight = weight, color = color, modifier = Modifier.padding(vertical = 1.dp))
}

/** 处理行内的 **粗体** 与 `代码` */
@Composable
private fun MarkdownInline(text: String, size: androidx.compose.ui.unit.TextUnit) {
    val cs = MaterialTheme.colorScheme
    val annotated = buildAnnotatedString {
        var i = 0
        while (i < text.length) {
            when {
                text.startsWith("**", i) -> {
                    val end = text.indexOf("**", i + 2)
                    if (end < 0) { append(text.substring(i)); i = text.length }
                    else {
                        withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(text.substring(i + 2, end)) }
                        i = end + 2
                    }
                }
                text[i] == '`' -> {
                    val end = text.indexOf('`', i + 1)
                    if (end < 0) { append(text.substring(i)); i = text.length }
                    else {
                        withStyle(SpanStyle(fontFamily = FontFamily.Monospace, color = cs.primary)) {
                            append(text.substring(i + 1, end))
                        }
                        i = end + 1
                    }
                }
                else -> { append(text[i]); i++ }
            }
        }
    }
    Text(annotated, fontSize = size, color = cs.onSurface, modifier = Modifier.padding(vertical = 1.dp))
}
