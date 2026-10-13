package com.appanalyzer.service

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 应用分类器的单元测试。
 *
 * 这块逻辑原本是 AppInfoService 里的 private 方法、参数是 PackageInfo/ApplicationInfo，
 * 纯 JVM 下连构造都抛 not mocked，所以一直测不到。抽成 AppClassifier 之后就可以直接测了。
 */
class AppClassifierTest {

    @Test
    fun `知名包名应当被认出`() {
        assertEquals("微信", "社交", AppClassifier.classify("com.tencent.mm", "微信"))
        assertEquals("WhatsApp", "社交", AppClassifier.classify("com.whatsapp", "WhatsApp"))
        assertEquals("YouTube", "视频", AppClassifier.classify("com.google.android.youtube", "YouTube"))
        assertEquals("Spotify", "音乐", AppClassifier.classify("com.spotify.music", "Spotify"))
        assertEquals("Chrome", "浏览器", AppClassifier.classify("com.android.chrome", "Chrome"))
    }

    @Test
    fun `包名分段按包含模式匹配`() {
        assertEquals("含 game 应当是游戏", "游戏", AppClassifier.classify("com.foo.mygame.hd", "随便一个名字"))
        assertEquals("含 navi 应当是地图导航", "地图导航", AppClassifier.classify("com.x.navi", "某个应用"))
        // manager 与 download 的组合有特判：含 download 的不算文件管理。
        // 注意应用名必须用中性的：用「下载管理器」会命中应用名规则里的
        // 「下载」「管理」两个关键词（各 +2），那是另一条规则，会盖住这里要测的东西。
        assertEquals("downloadmanager 不应被包名规则判成文件管理", "其他",
            AppClassifier.classify("com.x.downloadmanager", "xyzzy"))
        // 对照组：不含 download 的 manager 应当判成文件管理
        assertEquals("filemanager 应当判成文件管理", "文件管理",
            AppClassifier.classify("com.x.filemanager", "xyzzy"))
    }

    @Test
    fun `中文应用名应当被认出`() {
        // 包名毫无特征，只能靠应用名
        assertEquals("淘宝", "购物", AppClassifier.classify("com.taobao.taobao", "淘宝"))
        assertEquals("高德地图", "地图导航", AppClassifier.classify("com.autonavi.minimap", "高德地图"))
        assertEquals("王者荣耀", "游戏", AppClassifier.classify("com.tencent.tmgp.sgame", "王者荣耀"))
    }

    @Test
    fun `权限特征加一分`() {
        // 相机权限单独只有 1 分，达不到 2 分门槛 -> 其他
        assertEquals("只有相机权限时分数不够", AppClassifier.UNKNOWN,
            AppClassifier.classify("com.x.y", "无关名字", listOf("android.permission.CAMERA")))
        // 相机权限 + 名字里的「相机」关键词（+2）= 3 分
        assertEquals("相机权限 + 关键词应当成立", "拍照摄影",
            AppClassifier.classify("com.x.y", "相机", listOf("android.permission.CAMERA")))
        // 定位权限 + 名字里的「地图」
        assertEquals("定位权限 + 地图关键词", "地图导航",
            AppClassifier.classify("com.x.y", "地图", listOf("android.permission.ACCESS_FINE_LOCATION")))
    }

    @Test
    fun `Android 内置分类加两分`() {
        // 内置分类 4 = CATEGORY_SOCIAL
        assertEquals("内置社交分类", "社交",
            AppClassifier.classify("com.x.y", "无名", builtInCategory = android.content.pm.ApplicationInfo.CATEGORY_SOCIAL))
        // 内置分类 2 = CATEGORY_GAME
        assertEquals("内置游戏分类", "游戏",
            AppClassifier.classify("com.x.y", "无名", builtInCategory = android.content.pm.ApplicationInfo.CATEGORY_GAME))
    }

    @Test
    fun `没有启动器入口的算系统组件`() {
        assertEquals("无启动器入口", "系统组件",
            AppClassifier.classify("com.android.providers.media", "媒体存储", hasLauncherIntent = false))
    }

    @Test
    fun `系统应用加两分到系统工具`() {
        assertEquals("系统应用", "系统工具",
            AppClassifier.classify("com.vendor.service", "厂商服务", isSystemApp = true))
    }

    @Test
    fun `毫无特征的包名应当落到其他`() {
        assertEquals("无法分类", AppClassifier.UNKNOWN,
            AppClassifier.classify("com.zzz.qqq", "xyzzy"))
        assertEquals("空包名空名字", AppClassifier.UNKNOWN, AppClassifier.classify("", ""))
    }

    @Test
    fun `大小写不敏感`() {
        val lower = AppClassifier.classify("com.whatsapp", "whatsapp")
        val upper = AppClassifier.classify("COM.WHATSAPP", "WHATSAPP")
        val mixed = AppClassifier.classify("Com.WhatsApp", "WhatsApp")
        assertEquals("三种写法应当得到同一结果", lower, upper)
        assertEquals("三种写法应当得到同一结果", lower, mixed)
    }

    @Test
    fun `返回的分类必须来自预定义列表`() {
        val samples = listOf(
            Triple("com.tencent.mm", "微信", emptyList<String>()),
            Triple("com.zzz", "zzz", emptyList()),
            Triple("com.android.systemui", "系统界面", emptyList()),
            Triple("com.x.game", "游戏", listOf("android.permission.CAMERA")),
        )
        for ((pkg, name, perms) in samples) {
            val c = AppClassifier.classify(pkg, name, perms)
            assertTrue("返回了未定义的分类「$c」（来自 $pkg）",
                c == AppClassifier.UNKNOWN || c in AppClassifier.CATEGORIES)
        }
    }

    @Test
    fun `分类列表本身没有重复项`() {
        assertEquals("CATEGORIES 里出现了重复分类", AppClassifier.CATEGORIES.size,
            AppClassifier.CATEGORIES.toSet().size)
    }

    @Test
    fun `多路证据应当指向同一分类时分数累加`() {
        // 包名 youku(+3) + 应用名「优酷」(+2) + 内置视频分类(+2) => 视频 7 分
        // 这里只验证结果是「视频」而不是别的分类被别的证据抢走
        assertEquals("多路证据应当都指向视频", "视频",
            AppClassifier.classify(
                "com.youku.phone", "优酷视频",
                builtInCategory = android.content.pm.ApplicationInfo.CATEGORY_VIDEO
            ))
    }
}
