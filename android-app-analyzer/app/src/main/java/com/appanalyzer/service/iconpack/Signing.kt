package com.appanalyzer.service.iconpack

import com.android.apksig.ApkSigner
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.Signature
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.spec.PKCS8EncodedKeySpec
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * 极简 DER（ASN.1）编码器 —— 只够写一张自签名 X.509 证书。
 *
 * 为什么不用 BouncyCastle：它会让 APK 大好几 MB，而这里需要的只是「一张能通过
 * CertificateFactory 解析、能给 apksig 用的 v1 自签名证书」，几十行就够了。
 */
object Der {

    fun tlv(tag: Int, content: ByteArray): ByteArray {
        val out = ByteArrayOutputStream(content.size + 6)
        out.write(tag)
        out.write(encodedLength(content.size))
        out.write(content)
        return out.toByteArray()
    }

    fun encodedLength(length: Int): ByteArray = when {
        length < 0x80 -> byteArrayOf(length.toByte())
        length < 0x100 -> byteArrayOf(0x81.toByte(), length.toByte())
        length < 0x10000 -> byteArrayOf(0x82.toByte(), (length ushr 8).toByte(), (length and 0xFF).toByte())
        else -> byteArrayOf(
            0x83.toByte(),
            (length ushr 16).toByte(),
            ((length ushr 8) and 0xFF).toByte(),
            (length and 0xFF).toByte(),
        )
    }

    fun concat(parts: Array<out ByteArray>): ByteArray {
        val out = ByteArrayOutputStream(parts.sumOf { it.size })
        for (part in parts) out.write(part, 0, part.size)
        return out.toByteArray()
    }

    fun sequence(vararg parts: ByteArray): ByteArray = tlv(0x30, concat(parts))

    fun set(vararg parts: ByteArray): ByteArray = tlv(0x31, concat(parts))

    /** INTEGER：BigInteger.toByteArray() 本身就是最短补码表示。 */
    fun integer(value: BigInteger): ByteArray = tlv(0x02, value.toByteArray())

    fun oid(dotted: String): ByteArray {
        val parts = dotted.split('.').map { it.toInt() }
        require(parts.size >= 2) { "OID 格式非法: $dotted" }
        val body = ByteArrayOutputStream()
        body.write(parts[0] * 40 + parts[1])
        for (i in 2 until parts.size) {
            var value = parts[i]
            val encoded = ArrayList<Int>()
            encoded.add(value and 0x7F)
            value = value ushr 7
            while (value > 0) {
                encoded.add(0x80 or (value and 0x7F))
                value = value ushr 7
            }
            for (j in encoded.indices.reversed()) body.write(encoded[j])
        }
        return tlv(0x06, body.toByteArray())
    }

    fun utf8String(value: String): ByteArray = tlv(0x0C, value.toByteArray(Charsets.UTF_8))

    fun nullValue(): ByteArray = byteArrayOf(0x05, 0x00)

    /** BIT STRING：内容前面要多一个「未使用位数」字节。 */
    fun bitString(value: ByteArray): ByteArray = tlv(0x03, concat(arrayOf(byteArrayOf(0), value)))

    fun time(value: Date): ByteArray {
        val utc = SimpleDateFormat("yyMMddHHmmss'Z'", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }.format(value)
        val year = SimpleDateFormat("yyyy", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }.format(value).toInt()
        return if (year in 1950..2049) {
            tlv(0x17, utc.toByteArray(Charsets.US_ASCII))
        } else {
            val general = SimpleDateFormat("yyyyMMddHHmmss'Z'", Locale.US).apply {
                timeZone = TimeZone.getTimeZone("UTC")
            }.format(value)
            tlv(0x18, general.toByteArray(Charsets.US_ASCII))
        }
    }

    /** [n] EXPLICIT 包装（例如 version 字段）。 */
    fun explicit(tagNumber: Int, content: ByteArray): ByteArray = tlv(0xA0 or tagNumber, content)
}

/**
 * 生成一张自签名的 X.509 证书（v1，不带扩展）。
 *
 * 图标包需要签名才能装，而设备上没有现成的证书可用；本类用纯 JVM 的
 * KeyPairGenerator + Signature 现场签一张，再用 CertificateFactory 解析回来，
 * 保证产出的 DER 是真能被 JVM/Android 的证书解析器接受的。
 */
object SelfSignedCertificate {

    fun create(
        keyPair: KeyPair,
        commonName: String,
        notBefore: Date = Date(System.currentTimeMillis() - 24 * 3600 * 1000L),
        notAfter: Date = Date(System.currentTimeMillis() + 30L * 365 * 24 * 3600 * 1000L),
    ): X509Certificate {
        val signatureAlgorithm = when (keyPair.private.algorithm.uppercase(Locale.US)) {
            "RSA" -> "SHA256withRSA"
            "EC", "ECDSA" -> "SHA256withECDSA"
            else -> throw IllegalArgumentException("不支持的签名算法: ${keyPair.private.algorithm}")
        }
        val algorithmIdentifier = when (signatureAlgorithm) {
            "SHA256withRSA" -> Der.sequence(Der.oid("1.2.840.113549.1.1.11"), Der.nullValue())
            else -> Der.sequence(Der.oid("1.2.840.10045.4.3.2"))
        }
        val name = Der.sequence(
            Der.set(
                Der.sequence(
                    Der.oid("2.5.4.3"),              // commonName
                    Der.utf8String(commonName),
                ),
            ),
        )
        val tbs = Der.sequence(
            Der.integer(BigInteger.valueOf(System.currentTimeMillis())),   // serialNumber
            algorithmIdentifier,
            name,                                                          // issuer
            Der.sequence(Der.time(notBefore), Der.time(notAfter)),         // validity
            name,                                                          // subject（自签名：与 issuer 相同）
            keyPair.public.encoded,                                        // SubjectPublicKeyInfo
        )
        val signer = Signature.getInstance(signatureAlgorithm)
        signer.initSign(keyPair.private)
        signer.update(tbs)
        val signature = signer.sign()
        val certificateDer = Der.sequence(tbs, algorithmIdentifier, Der.bitString(signature))
        return CertificateFactory.getInstance("X.509")
            .generateCertificate(ByteArrayInputStream(certificateDer)) as X509Certificate
    }
}

/**
 * 图标包的签名身份（私钥 + 自签名证书）。
 *
 * 生成的密钥会存到应用私有目录里，**同一个应用装出的所有图标包都用同一把钥匙** ——
 * 这一点很重要：Android 只允许用同一签名覆盖安装，换钥匙就得先卸载旧的图标包。
 */
class SigningKey(
    val privateKey: PrivateKey,
    val certificate: X509Certificate,
) {

    fun save(dir: File) {
        dir.mkdirs()
        File(dir, KEY_FILE_NAME).writeBytes(privateKey.encoded)
        File(dir, CERT_FILE_NAME).writeBytes(certificate.encoded)
    }

    override fun toString(): String = "SigningKey(subject=${certificate.subjectX500Principal.name})"

    companion object {
        const val KEY_FILE_NAME = "iconpack-signing.pk8"
        const val CERT_FILE_NAME = "iconpack-signing.der"
        const val DEFAULT_COMMON_NAME = "AppAnalyzer IconPack"

        /** 现生成一把 RSA-2048 密钥并签一张自签名证书。 */
        fun generate(commonName: String = DEFAULT_COMMON_NAME): SigningKey {
            val generator = KeyPairGenerator.getInstance("RSA")
            generator.initialize(2048)
            val keyPair = generator.generateKeyPair()
            return SigningKey(keyPair.private, SelfSignedCertificate.create(keyPair, commonName))
        }

        /** 从目录读取；文件缺失或损坏时返回 null。 */
        fun load(dir: File): SigningKey? {
            val keyFile = File(dir, KEY_FILE_NAME)
            val certFile = File(dir, CERT_FILE_NAME)
            if (!keyFile.isFile || !certFile.isFile) return null
            return try {
                val certificate = CertificateFactory.getInstance("X.509")
                    .generateCertificate(ByteArrayInputStream(certFile.readBytes())) as X509Certificate
                val keyFactory = KeyFactory.getInstance(certificate.publicKey.algorithm)
                val privateKey = keyFactory.generatePrivate(PKCS8EncodedKeySpec(keyFile.readBytes()))
                SigningKey(privateKey, certificate)
            } catch (e: Exception) {
                null
            }
        }

        /** 有就用旧的，没有就生成并落盘。 */
        fun loadOrCreate(dir: File, commonName: String = DEFAULT_COMMON_NAME): SigningKey {
            load(dir)?.let { return it }
            val created = generate(commonName)
            created.save(dir)
            return created
        }
    }
}

/**
 * 用 apksig（com.android.tools.build:apksig，即 apksigner 的同一套实现）做 **APK Signature Scheme v2** 签名。
 *
 * 为什么必须 v2：Android 8+ 对 targetSdk >= 26 的包默认只认 v2/v3 签名，
 * 只写 META-INF 里的 v1（jar 签名）在部分场景会被判为「未签名」而拒绝安装。
 * 图标包没有任何代码，v1 的 MANIFEST.MF 也毫无意义，所以直接 v2-only，最省事也最可靠。
 */
object ApkSignerV2 {

    fun sign(
        unsignedApk: ByteArray,
        signingKey: SigningKey,
        workDir: File? = null,
        minSdkVersion: Int = 26,
    ): ByteArray {
        val dir = workDir ?: File(System.getProperty("java.io.tmpdir") ?: ".")
        dir.mkdirs()
        val input = File.createTempFile("iconpack-unsigned", ".apk", dir)
        val output = File.createTempFile("iconpack-signed", ".apk", dir)
        return try {
            input.writeBytes(unsignedApk)
            val signerConfig = ApkSigner.SignerConfig.Builder(
                "AppAnalyzer",
                signingKey.privateKey,
                listOf(signingKey.certificate),
            ).build()
            ApkSigner.Builder(listOf(signerConfig))
                .setInputApk(input)
                .setOutputApk(output)
                .setMinSdkVersion(minSdkVersion)
                .setV1SigningEnabled(false)
                .setV2SigningEnabled(true)
                .setV3SigningEnabled(false)
                .setV4SigningEnabled(false)
                .setDebuggableApkPermitted(true)
                .setCreatedBy("AppAnalyzer IconPack Builder")
                .build()
                .sign()
            output.readBytes()
        } finally {
            input.delete()
            output.delete()
        }
    }
}
