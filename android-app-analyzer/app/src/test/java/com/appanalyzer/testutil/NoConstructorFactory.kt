package com.appanalyzer.testutil

import android.content.SharedPreferences
import com.appanalyzer.service.PreferencesManager
import java.lang.reflect.InvocationHandler
import java.lang.reflect.Method
import java.lang.reflect.Proxy

/**
 * 纯 JVM 测试用的工厂：绕过「构造函数必须要 Context」这道墙。
 *
 * 背景：AppInfoService / ImageGenService / PreferencesManager 的构造函数都要求
 * android.content.Context，而单元测试用的 android.jar 是桩实现，一调用就抛
 * "not mocked"，所以 new 不出来。但它们被测试的公开方法本身并不碰 Context，
 * 只读几个字段 —— 于是这里用 Unsafe.allocateInstance 跳过构造函数拿到实例，
 * 再把必要的字段（比如 prefs）反射注进去。
 *
 * 这是测试侧的权宜之计，**不要**为了让测试好写去改 app/src/main 下的源码。
 * 如果哪天这些类的构造函数不再需要 Context，请把这里的用法换成直接 new。
 */
object NoConstructorFactory {

    private val unsafeInstance: Any? = try {
        val cls = Class.forName("sun.misc.Unsafe")
        val field = cls.getDeclaredField("theUnsafe")
        field.isAccessible = true
        field.get(null)
    } catch (t: Throwable) {
        null
    }

    private val allocateInstanceMethod: Method? = try {
        unsafeInstance?.javaClass?.getMethod("allocateInstance", Class::class.java)
    } catch (t: Throwable) {
        null
    }

    /** 不走构造函数创建实例（所有字段都是默认值 null / 0，val 的初始化代码不会执行）。 */
    fun <T : Any> allocate(cls: Class<T>): T {
        val unsafe = unsafeInstance
        val method = allocateInstanceMethod
        if (unsafe != null && method != null) {
            try {
                @Suppress("UNCHECKED_CAST")
                return method.invoke(unsafe, cls) as T
            } catch (t: Throwable) {
                throw AssertionError("sun.misc.Unsafe.allocateInstance(" + cls.name + ") 调用失败：" + (t.cause ?: t), t)
            }
        }
        // 退路：JDK 内部的「序列化构造器」，同样不执行类自己的构造函数
        try {
            val rfClass = Class.forName("sun.reflect.ReflectionFactory")
            val factory = rfClass.getMethod("getReflectionFactory").invoke(null)
            val factoryMethod = rfClass.getMethod(
                "newConstructorForSerialization",
                Class::class.java,
                java.lang.reflect.Constructor::class.java
            )
            val ctor = factoryMethod.invoke(factory, cls, Any::class.java.getDeclaredConstructor())
                as java.lang.reflect.Constructor<*>
            ctor.isAccessible = true
            @Suppress("UNCHECKED_CAST")
            return ctor.newInstance() as T
        } catch (t: Throwable) {
            throw AssertionError("当前 JVM 既不能用 Unsafe 也不能用 ReflectionFactory 创建 " + cls.name + " 的实例", t)
        }
    }

    /** 反射写入字段（Kotlin 的 private val 在 JVM 上是 final 实例字段，setAccessible 后可写）。 */
    fun setField(target: Any, fieldName: String, value: Any?) {
        var cls: Class<*>? = target.javaClass
        while (cls != null) {
            val field = try {
                cls.getDeclaredField(fieldName)
            } catch (e: NoSuchFieldException) {
                null
            }
            if (field != null) {
                try {
                    field.isAccessible = true
                    field.set(target, value)
                } catch (t: Throwable) {
                    throw AssertionError("写入 " + target.javaClass.name + "." + fieldName + " 失败：" + t, t)
                }
                return
            }
            cls = cls.superclass
        }
        throw AssertionError(target.javaClass.name + " 上找不到字段 " + fieldName + " —— 源码里改过名字？请同步更新测试")
    }
}

/** 用内存 Map 顶替 SharedPreferences，取值语义与真实的 getXxx(key, defValue) 一致。 */
fun fakeSharedPreferences(values: Map<String, Any?> = emptyMap()): SharedPreferences {
    val handler = InvocationHandler { proxy, method, args ->
        val key = args?.getOrNull(0) as? String
        when (method.name) {
            "getString", "getStringSet", "getInt", "getLong", "getFloat", "getBoolean" ->
                if (key != null && values.containsKey(key)) values[key] else args?.getOrNull(1)
            "contains" -> key != null && values.containsKey(key)
            "getAll" -> HashMap(values)
            "toString" -> "FakeSharedPreferences" + values
            "hashCode" -> System.identityHashCode(proxy)
            "equals" -> proxy === args?.getOrNull(0)
            else -> defaultValueOf(method.returnType)
        }
    }
    return Proxy.newProxyInstance(
        SharedPreferences::class.java.classLoader,
        arrayOf<Class<*>>(SharedPreferences::class.java),
        handler
    ) as SharedPreferences
}

private fun defaultValueOf(type: Class<*>): Any? = when (type) {
    java.lang.Boolean.TYPE -> false
    java.lang.Integer.TYPE -> 0
    java.lang.Long.TYPE -> 0L
    java.lang.Float.TYPE -> 0f
    java.lang.Double.TYPE -> 0.0
    java.lang.Character.TYPE -> '\u0000'
    java.lang.Byte.TYPE -> 0.toByte()
    java.lang.Short.TYPE -> 0.toShort()
    else -> null
}

/** 造一个「构造函数没跑、但 prefs 字段指向内存 Map」的 PreferencesManager。 */
fun newPreferencesManager(values: Map<String, Any?> = emptyMap()): PreferencesManager {
    val pm = NoConstructorFactory.allocate(PreferencesManager::class.java)
    NoConstructorFactory.setField(pm, "prefs", fakeSharedPreferences(values))
    return pm
}
