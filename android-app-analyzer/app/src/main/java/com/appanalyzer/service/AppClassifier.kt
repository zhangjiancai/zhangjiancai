package com.appanalyzer.service

import android.content.pm.ApplicationInfo

/**
 * 应用分类器（加权评分制）。
 *
 * ## 为什么单独抽出来
 *
 * 原来这段逻辑是 `AppInfoService` 里的 private 方法，参数是 [PackageInfo] /
 * [ApplicationInfo]，于是：
 *
 * - **测不了**：纯 JVM 单元测试里连这两个类的构造都会抛 "not mocked"，
 *   而它偏偏又是「分类」这个核心功能里唯一有判断逻辑的地方；
 * - **复用不了**：想在别处（比如导出、批量处理）用同一套分类，只能复制一份，
 *   改一处漏一处几乎是必然的。
 *
 * 现在它只接收原始数据（包名、应用名、权限名、内置分类号、两个布尔），
 * 不碰任何 Android 对象，因此可以直接单元测试。Android 侧的取值由
 * `AppInfoService.smartClassify` 负责，那层只剩几行取值代码。
 *
 * 打分规则与权重（保持不变）：
 * 1. 包名分段匹配 **+3**（最有区分度）
 * 2. 应用名关键词匹配 **+2**（中文名更可靠）
 * 3. 权限特征 **+1**
 * 4. Android 内置分类 **+2**
 * 5. 没有启动器入口 **+4** 记到「系统组件」；系统应用 **+2** 记到「系统工具」
 *
 * 最终取最高分；**最高分不足 2 分则归入「其他」**。
 */
object AppClassifier {

    val CATEGORIES = listOf(
        "社交", "视频", "音乐", "游戏", "地图导航", "办公", "购物",
        "浏览器", "输入法", "安全工具", "拍照摄影", "新闻资讯",
        "健康运动", "教育学习", "出行交通", "金融理财", "文件管理",
        "系统工具", "系统组件"
    )

    const val UNKNOWN = "其他"

    /** 低于这个分数不认为分类有效 */
    private const val MIN_SCORE = 2

    /** 无法取得 Android 内置分类时传这个值 */
    const val NO_BUILT_IN_CATEGORY = Int.MIN_VALUE

    /**
     * @param packageName      包名（大小写不敏感）
     * @param appName          应用显示名（大小写不敏感）
     * @param permissions      申请的权限名列表
     * @param builtInCategory  ApplicationInfo.category；取不到时传 [NO_BUILT_IN_CATEGORY]
     * @param isSystemApp      是否为系统应用（FLAG_SYSTEM）
     * @param hasLauncherIntent 是否有启动器入口
     */
    fun classify(
        packageName: String,
        appName: String,
        permissions: List<String> = emptyList(),
        builtInCategory: Int = NO_BUILT_IN_CATEGORY,
        isSystemApp: Boolean = false,
        hasLauncherIntent: Boolean = true
    ): String {
        val pn = packageName.lowercase()
        val an = appName.lowercase()
        val perms = permissions.map { it.lowercase() }

        val scores = mutableMapOf<String, Int>().apply {
            CATEGORIES.forEach { put(it, 0) }
        }

        scoreByPackageSegments(pn.split("."), scores)
        scoreByAppName(an, scores)
        scoreByPermission(perms, scores)
        scoreByBuiltInCategory(builtInCategory, scores)

        if (!hasLauncherIntent) scores["系统组件"] = (scores["系统组件"] ?: 0) + 4
        if (isSystemApp) scores["系统工具"] = (scores["系统工具"] ?: 0) + 2

        val best = scores.maxByOrNull { it.value }
        return if (best != null && best.value >= MIN_SCORE) best.key else UNKNOWN
    }

    private fun scoreByPackageSegments(segments: List<String>, scores: MutableMap<String, Int>) {
        for (seg in segments) {
            val match = when {
                // 精确匹配 —— 知名应用
                seg in SOCIAL_APPS -> "社交"
                seg == "youtube" -> "视频"
                seg == "bilibili" || (seg == "tv" && seg == "danmaku") -> "视频"
                seg in VIDEO_APPS -> "视频"
                seg in MUSIC_APPS -> "音乐"

                // 包含模式 —— 复合词匹配
                seg.contains("music") || seg.contains("player") || seg.contains("radio") || seg.contains("podcast") -> "音乐"
                seg.contains("game") || seg.contains("gaming") || seg.contains("unity") || seg.contains("cocos") -> "游戏"
                seg.contains("map") || seg.contains("navi") || seg.contains("gps") || seg.contains("gaode") || seg.contains("amap") -> "地图导航"
                seg.contains("browser") || seg.contains("chrome") || seg.contains("firefox") || seg.contains("edge") || seg.contains("ucweb") -> "浏览器"
                seg.contains("office") || seg.contains("doc") || seg.contains("pdf") || seg.contains("wps") || seg.contains("evernote") || seg.contains("notion") -> "办公"
                seg.contains("shop") || seg.contains("mall") || seg.contains("taobao") || seg.contains("pinduoduo") || seg.contains("alipay") -> "购物"
                seg.contains("camera") || seg.contains("photo") || seg.contains("gallery") || seg.contains("beauty") -> "拍照摄影"
                seg.contains("inputmethod") || seg.contains("keyboard") || seg.contains("ime") || seg.contains("sogou") || seg.contains("gboard") -> "输入法"
                seg.contains("security") || seg.contains("vpn") || seg.contains("clean") || seg.contains("antivirus") || seg.contains("firewall") -> "安全工具"
                seg.contains("news") || seg.contains("reader") || seg.contains("feed") || seg.contains("toutiao") -> "新闻资讯"
                seg.contains("health") || seg.contains("fitness") || seg.contains("sport") || seg.contains("keep") -> "健康运动"
                seg.contains("edu") || seg.contains("learn") || seg.contains("course") || seg.contains("school") || seg.contains("dictionary") -> "教育学习"
                seg.contains("travel") || seg.contains("flight") || seg.contains("hotel") || seg.contains("train") || seg.contains("ctrip") -> "出行交通"
                seg.contains("bank") || seg.contains("finance") || seg.contains("pay") || seg.contains("wallet") || seg.contains("stock") -> "金融理财"
                seg.contains("file") || seg.contains("explorer") || (seg.contains("manager") && !seg.contains("download")) -> "文件管理"

                else -> null
            }
            match?.let { scores[it] = (scores[it] ?: 0) + 3 }
        }
    }

    private fun scoreByAppName(appName: String, scores: MutableMap<String, Int>) {
        for ((keywords, category) in NAME_RULES) {
            for (keyword in keywords) {
                if (appName.contains(keyword, ignoreCase = true)) {
                    scores[category] = (scores[category] ?: 0) + 2
                }
            }
        }
    }

    private fun scoreByPermission(perms: List<String>, scores: MutableMap<String, Int>) {
        if (perms.any { it.endsWith(".camera") }) bump(scores, "拍照摄影")
        if (perms.any { it.contains("record_audio") || it.contains("capture_audio") }) bump(scores, "音乐")
        if (perms.any { it.contains("access_fine_location") || it.contains("access_coarse_location") }) bump(scores, "地图导航")
        if (perms.any { it.contains("body_sensors") || it.contains("activity_recognition") }) bump(scores, "健康运动")
        if (perms.any { it.contains("send_sms") || it.contains("receive_sms") }) bump(scores, "社交")
        if (perms.any { it.contains("read_contacts") || it.contains("write_contacts") }) bump(scores, "社交")
    }

    private fun bump(scores: MutableMap<String, Int>, category: String) {
        scores[category] = (scores[category] ?: 0) + 1
    }

    private fun scoreByBuiltInCategory(category: Int, scores: MutableMap<String, Int>) {
        val mapped = when (category) {
            ApplicationInfo.CATEGORY_SOCIAL -> "社交"
            ApplicationInfo.CATEGORY_NEWS -> "新闻资讯"
            ApplicationInfo.CATEGORY_PRODUCTIVITY -> "办公"
            ApplicationInfo.CATEGORY_GAME -> "游戏"
            ApplicationInfo.CATEGORY_AUDIO -> "音乐"
            ApplicationInfo.CATEGORY_VIDEO -> "视频"
            ApplicationInfo.CATEGORY_IMAGE -> "拍照摄影"
            ApplicationInfo.CATEGORY_MAPS -> "地图导航"
            else -> null
        }
        mapped?.let { scores[it] = (scores[it] ?: 0) + 2 }
    }

    // ---- 规则表 ----

    private val SOCIAL_APPS = setOf(
        "wechat", "weixin", "whatsapp", "telegram", "kakaotalk", "messenger", "skype",
        "weibo", "twitter", "facebook", "instagram", "snapchat", "linkedin",
        "qq", "mobileqq", "discord", "line", "douyin", "tiktok"
    )
    private val VIDEO_APPS = setOf(
        "iqiyi", "youku", "netflix", "disney", "twitch", "vimeo"
    )
    private val MUSIC_APPS = setOf(
        "spotify", "kugou", "kuwo", "qqmusic", "cloudmusic"
    )

    private val NAME_RULES: List<Pair<List<String>, String>> = listOf(
        listOf("微信", "QQ", "What", "WhatsApp", "Telegram", "Line", "微博", "Twitter", "Instagram", "Facebook", "抖音", "TikTok", "快手", "小红书", "知乎", "豆瓣", "贴吧") to "社交",
        listOf("视频", "影视", "播放", "B站", "哔哩", "腾讯视频", "爱奇艺", "优酷", "Netflix", "抖音", "快手", "Youtube", "Twitch") to "视频",
        listOf("音乐", "酷狗", "酷我", "网易云", "QQ音乐", "Spotify", "唱吧", "全民K歌") to "音乐",
        listOf("游戏", "王者荣耀", "和平精英", "原神", "崩坏", "阴阳师", "LOL", "英雄联盟", "炉石") to "游戏",
        listOf("地图", "导航", "高德", "百度地图", "腾讯地图", "Google Map") to "地图导航",
        listOf("办公", "文档", "笔记", "日历", "邮箱", "邮件", "会议", "WPS", "Office", "钉钉", "飞书", "企业微信", "Notion", "Evernote", "Zoom") to "办公",
        listOf("购物", "淘宝", "京东", "拼多多", "唯品会", "闲鱼", "苏宁", "美团", "饿了么") to "购物",
        listOf("浏览器", "Chrome", "Safari", "Edge", "Firefox", "UC", "百度") to "浏览器",
        listOf("输入法", "键盘", "搜狗", "百度输入", "讯飞") to "输入法",
        listOf("安全", "杀毒", "清理", "管家", "卫士", "360", "VPN") to "安全工具",
        listOf("相机", "拍照", "美颜", "修图", "相册", "剪辑", "剪映") to "拍照摄影",
        listOf("新闻", "资讯", "头条", "网易新闻", "腾讯新闻", "新浪新闻") to "新闻资讯",
        listOf("健康", "运动", "健身", "跑步", "Keep", "步数") to "健康运动",
        listOf("学习", "教育", "课程", "英语", "词典", "翻译", "背单词", "考研") to "教育学习",
        listOf("出行", "旅行", "机票", "火车票", "酒店", "携程", "去哪儿", "滴滴", "打车", "公交") to "出行交通",
        listOf("银行", "金融", "理财", "股票", "基金", "支付宝", "微信支付", "云闪付") to "金融理财",
        listOf("文件", "管理", "下载") to "文件管理",
    )
}
