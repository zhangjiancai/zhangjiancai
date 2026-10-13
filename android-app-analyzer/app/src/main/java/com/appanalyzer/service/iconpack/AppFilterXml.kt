package com.appanalyzer.service.iconpack

/** 一条「启动器组件 → 图标资源名」映射。 */
class IconMapping(
    /** 形如 com.tencent.mm/com.tencent.mm.ui.LauncherUI */
    val component: String,
    val packageName: String,
    val drawableName: String,
)

/**
 * appfilter.xml / drawable.xml 的生成逻辑 —— 纯字符串处理，可脱离 Android 测试。
 *
 * 两个文件的格式与电脑端 :iconpack 模块、以及主流图标包的约定完全一致：
 *
 *   appfilter.xml
 *     <resources>
 *         <item component="ComponentInfo{com.tencent.mm/com.tencent.mm.ui.LauncherUI}" drawable="ic_com_tencent_mm"/>
 *         <item component="ComponentInfo{com.tencent.mm/.ui.LauncherUI}" drawable="ic_com_tencent_mm"/>
 *     </resources>
 *
 *   drawable.xml
 *     <resources>
 *         <item drawable="ic_com_tencent_mm"/>
 *     </resources>
 *
 * 同一个图标写两条映射（完整组件名 + 包名/.Activity 缩写）：不同启动器对
 * ComponentInfo 的匹配方式不完全一致，两条都写能显著提高命中率，主流图标包都这么做。
 */
object AppFilterXml {

    /** 包名 → 合法的 Android 资源名（只能小写字母/数字/下划线，且不能以数字开头）。 */
    fun drawableNameOf(packageName: String): String {
        val sanitized = packageName.lowercase().map { c ->
            if (c.isLetterOrDigit() && c.code < 128) c else '_'
        }.joinToString("")
        return "ic_" + sanitized.trim('_')
    }

    fun xmlEscape(value: String): String = value
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\"", "&quot;")

    fun buildAppFilter(mappings: List<IconMapping>): String {
        val sb = StringBuilder()
        sb.append("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n")
        sb.append("<resources>\n")
        for (m in mappings.sortedBy { it.packageName }) {
            sb.append("    <item component=\"")
                .append(xmlEscape("ComponentInfo{${m.component}}"))
                .append("\" drawable=\"")
                .append(m.drawableName)
                .append("\"/>\n")
            val activity = m.component.substringAfter('/', "")
            if (activity.startsWith("${m.packageName}.")) {
                val short = "ComponentInfo{${m.packageName}/.${activity.removePrefix("${m.packageName}.")}}"
                sb.append("    <item component=\"")
                    .append(xmlEscape(short))
                    .append("\" drawable=\"")
                    .append(m.drawableName)
                    .append("\"/>\n")
            }
        }
        sb.append("</resources>\n")
        return sb.toString()
    }

    fun buildDrawableList(names: List<String>): String {
        val sb = StringBuilder()
        sb.append("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n")
        sb.append("<resources>\n")
        for (name in names.sorted()) {
            sb.append("    <item drawable=\"").append(name).append("\"/>\n")
        }
        sb.append("</resources>\n")
        return sb.toString()
    }
}
