# App Analyzer 混淆规则
#
# 注意：之前在 build.gradle 的 release 配置里引用了本文件，但文件并不存在。
# 目前 release 的 minifyEnabled = false，所以没暴露出问题；一旦打开混淆就会直接构建失败。
# 这里先补上基础规则，保持默认行为不变。

# 保留行号信息，方便线上崩溃还原堆栈
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# Gson 通过反射读写这些数据类，字段名不能混淆
-keep class com.appanalyzer.data.model.** { *; }
-keep class com.appanalyzer.service.imagegen.ImageGenOutcome$* { *; }
-keep class com.appanalyzer.service.IconReplaceService$IconStyle { *; }

# Gson 泛型 TypeToken 相关
-keepattributes Signature
-keepattributes *Annotation*
-dontwarn sun.misc.**
-keep class com.google.gson.reflect.TypeToken { *; }
-keep class * extends com.google.gson.reflect.TypeToken

# OkHttp
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
