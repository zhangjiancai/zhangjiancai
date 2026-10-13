package com.appanalyzer.service.iconpack

/**
 * 应用内教程的文案 —— 纯数据，方便测试与复用（UI 见 IconPackUi.kt 的 IconPackTutorialCard）。
 *
 * 这些内容不是可有可无的装饰：绝大多数用户从没接触过「图标包」这个概念，
 * 不知道它为什么必须做成 APK、装完为什么还要去启动器里选一次、以及自己手机上的桌面
 * 到底支不支持。不把这些讲清楚，功能就是「点了没反应」。
 */
object IconPackTutorial {

    class Section(val title: String, val body: String)

    const val SUMMARY: String = "图标包是什么？为什么装完还要去启动器里选一次？点开看说明"

    /** 支持第三方图标包的启动器（按常见程度排序）。 */
    val SUPPORTED_LAUNCHERS: List<String> = listOf(
        "Nova Launcher",
        "Smart Launcher",
        "Lawnchair",
        "ADW Launcher 2",
        "Apex Launcher",
        "GO Launcher",
        "Action Launcher",
        "Niagara Launcher",
        "Microsoft Launcher",
        "Total Launcher",
        "Kvaesitso",
        "Hyperion",
    )

    /** 基本不支持第三方图标包的桌面（只认自家主题商店）。 */
    val UNSUPPORTED_LAUNCHERS: List<String> = listOf(
        "Pixel 原生启动器（Pixel Launcher）",
        "三星 One UI 桌面",
        "小米 / 红米 系统桌面",
        "OPPO / vivo / realme 自带桌面",
        "华为 EMUI 桌面",
    )

    val SECTIONS: List<Section> = listOf(
        Section(
            "1. 图标包是什么",
            "图标包（Icon Pack）是一个「只有图片、没有代码」的 APK：里面装着每个应用对应的新图标，" +
                "外加一张对照表（appfilter.xml）记录「哪个应用的哪个界面用哪张图」。" +
                "支持图标包的第三方启动器会读这张表，把桌面和抽屉里的图标替换成你这套。" +
                "\n\n本应用生成的就是这种 APK，所以它装上去之后自己不会出现图标、也不会启动，" +
                "它只是一个「给启动器看的素材包」。",
        ),
        Section(
            "2. 为什么必须做成 APK",
            "启动器是「跨应用」取图的：它通过 Android 的资源系统，按资源名去图标包里取图片。" +
                "资源名要能被系统解析，APK 里就必须有资源表（resources.arsc）和 res/ 目录，" +
                "而且 APK 必须经过签名才能安装 —— 这几样都得在打包时自己生成，手机上就完成了，" +
                "所以不再需要电脑。" +
                "\n\n普通应用没有权限直接改别的应用的图标，所以「一键替换系统图标」是不存在的，" +
                "只能做成图标包交给启动器使用。",
        ),
        Section(
            "3. 怎么用（三步）",
            "① 在图标页批量生成图标；" +
                "\n② 点「打包图标包 APK」，装好后在通知栏/下载目录里找到它并安装；" +
                "\n③ 打开启动器设置 → 图标包 → 选中本次生成的名字（默认「App Analyzer Icons」）。" +
                "\n\n常见启动器的入口：" +
                "\n· Nova：设置 → 外观 → 图标样式 → 图标包" +
                "\n· Smart Launcher：设置 → 全局外观 → 图标包" +
                "\n· Lawnchair：桌面设置 → 通用 → 图标包" +
                "\n· ADW / Apex / GO / Action：设置 → 外观或主题 → 图标包" +
                "\n\n注意：安装图标包 APK 之后**不会自动生效**，必须去启动器里手动选一次。",
        ),
        Section(
            "4. 哪些启动器支持",
            "支持：${SUPPORTED_LAUNCHERS.joinToString("、")}。" +
                "\n\n不支持：${UNSUPPORTED_LAUNCHERS.joinToString("、")} —— " +
                "这些系统桌面基本只认自家主题商店，装上图标包也没有入口可以选。" +
                "\n\n实在想用，可以装上面任意一个第三方启动器，再把图标包选上。" +
                "（各启动器版本更新可能变化，以官方说明为准。）",
        ),
        Section(
            "5. 签名与更新（重要）",
            "图标包 APK 用本机生成的一把密钥签名，密钥保存在本应用的私有目录里：" +
                "\n· 只要不卸载本应用，以后重新打包的图标包可以直接覆盖安装（版本号会自动 +1）；" +
                "\n· 一旦卸载本应用，密钥会随之删除，之后打包出来的图标包签名不同，" +
                "装的时候会提示「应用未安装」——此时需要先卸载手机上旧的图标包再装新的。",
        ),
        Section(
            "6. 体积与耗时",
            "每个图标是一张 192×192 左右的 PNG，100 个图标大约 2~5 MB。" +
                "\n打包全程在手机上完成：首次会生成一把 2048 位 RSA 密钥（约 1~2 秒），" +
                "之后的打包通常在几秒内结束。",
        ),
    )
}
