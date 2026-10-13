package com.appanalyzer.service.iconpack

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayInputStream
import java.security.cert.CertificateFactory

/** 自签名证书与签名身份持久化的单元测试。 */
class SigningKeyTest {

    @get:Rule
    val temp = TemporaryFolder()

    /** 手写 DER 出来的证书必须能被标准 X.509 解析器接受，并且能用公钥验签。 */
    @Test
    fun selfSignedCertificateIsValidX509() {
        val key = SigningKey.generate("AppAnalyzer IconPack Test")
        val certificate = key.certificate
        certificate.verify(certificate.publicKey)
        assertEquals("CN=AppAnalyzer IconPack Test", certificate.subjectX500Principal.name)
        assertEquals(certificate.subjectX500Principal, certificate.issuerX500Principal)
        assertTrue("证书应当是 X.509 版本 1~3", certificate.version in 1..3)
        assertTrue("有效期应当覆盖现在", certificate.notAfter.time > System.currentTimeMillis())
        assertTrue(certificate.notBefore.time <= System.currentTimeMillis())
    }

    /** 证书 DER 重新解析一次应当完全一致（说明编码是规范 DER，而不是「碰巧能读」）。 */
    @Test
    fun certificateReEncodesToSameDer() {
        val key = SigningKey.generate("RoundTrip")
        val parsed = CertificateFactory.getInstance("X.509")
            .generateCertificate(ByteArrayInputStream(key.certificate.encoded))
        assertTrue(parsed.encoded.contentEquals(key.certificate.encoded))
    }

    /** 私钥 + 证书要能存盘再读回来，否则每次打包都会换签名，用户就再也覆盖安装不了。 */
    @Test
    fun signingIdentitySurvivesSaveAndLoad() {
        val dir = temp.newFolder("signing")
        val created = SigningKey.loadOrCreate(dir, "Persisted")
        assertTrue(dir.listFiles()!!.isNotEmpty())

        val loaded = SigningKey.load(dir)
        assertNotNull(loaded)
        assertTrue(loaded!!.certificate.encoded.contentEquals(created.certificate.encoded))
        assertEquals(created.privateKey.algorithm, loaded.privateKey.algorithm)

        // 第二次 loadOrCreate 必须拿到同一把钥匙，而不是重新生成
        val again = SigningKey.loadOrCreate(dir, "Persisted")
        assertTrue(again.certificate.encoded.contentEquals(created.certificate.encoded))
    }

    @Test
    fun loadReturnsNullForEmptyOrBrokenDirectory() {
        val empty = temp.newFolder("empty")
        assertNull(SigningKey.load(empty))

        val broken = temp.newFolder("broken")
        broken.resolve(SigningKey.KEY_FILE_NAME).writeText("not a key")
        broken.resolve(SigningKey.CERT_FILE_NAME).writeText("not a cert")
        assertNull(SigningKey.load(broken))
    }
}
