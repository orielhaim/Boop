package app.boop.marmot

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import java.io.DataInputStream
import java.io.File
import java.io.FileNotFoundException
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal object SocialStorageKey {
  private const val prefix = "app.boop.social.storage.v1."
  private const val ivSize = 12
  private const val keySize = 32
  private const val tagSize = 16
  private val publicKey = Regex("[0-9a-f]{64}")

  @Synchronized
  fun load(context: Context, account: String): ByteArray {
    require(publicKey.matches(account))
    val alias = prefix + account
    val file = keyFile(context, account)
    val store = keyStore()
    val stored = try {
      DataInputStream(file.openRead()).use { input ->
        val sealed = ByteArray(ivSize + keySize + tagSize)
        input.readFully(sealed)
        check(input.read() == -1)
        sealed
      }
    } catch (_: FileNotFoundException) {
      null
    }
    val existing = store.getKey(alias, null) as? SecretKey
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    if (stored != null) {
      check(stored.size == ivSize + keySize + tagSize)
      cipher.init(Cipher.DECRYPT_MODE, checkNotNull(existing), GCMParameterSpec(128, stored, 0, ivSize))
      cipher.updateAAD(alias.toByteArray(Charsets.US_ASCII))
      return cipher.doFinal(stored, ivSize, stored.size - ivSize)
    }

    val wrapper = existing ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
      init(
        KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
          .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
          .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
          .setKeySize(256)
          .build()
      )
      generateKey()
    }
    val key = ByteArray(keySize).also(SecureRandom()::nextBytes)
    try {
      cipher.init(Cipher.ENCRYPT_MODE, wrapper)
      check(cipher.iv.size == ivSize)
      cipher.updateAAD(alias.toByteArray(Charsets.US_ASCII))
      val sealed = cipher.iv + cipher.doFinal(key)
      val output = file.startWrite()
      try {
        output.write(sealed)
        file.finishWrite(output)
      } catch (error: Throwable) {
        file.failWrite(output)
        throw error
      }
      return key
    } catch (error: Throwable) {
      key.fill(0)
      throw error
    }
  }

  @Synchronized
  fun remove(context: Context, account: String) {
    require(publicKey.matches(account))
    val file = keyFile(context, account)
    file.delete()
    val alias = prefix + account
    val store = keyStore()
    store.deleteEntry(alias)
    check(!file.baseFile.exists() && !store.containsAlias(alias))
  }

  private fun keyStore() = KeyStore.getInstance("AndroidKeyStore").also { it.load(null) }

  private fun keyFile(context: Context, account: String) =
    AtomicFile(File(context.noBackupFilesDir, "social-keys/$account.bin"))
}


