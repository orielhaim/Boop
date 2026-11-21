package app.boop.avatars

import android.graphics.Bitmap
import android.graphics.ImageDecoder
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import okhttp3.Call
import okhttp3.ConnectionPool
import okhttp3.CookieJar
import okhttp3.Dns
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.HttpUrl.Companion.toHttpUrl
import java.io.File
import java.io.IOException
import java.net.Inet4Address
import java.net.InetAddress
import java.net.Inet6Address
import java.net.Proxy
import java.net.URI
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class AvatarTransportModule : Module() {
  private class Job {
    val cancelled = AtomicBoolean(false)
    @Volatile var call: Call? = null
  }

  private val jobs = ConcurrentHashMap<String, Job>()
  private val allowedHost = Regex("(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z][a-z0-9-]{1,62}")
  private val localSuffix = Regex("\\.(localhost|local|internal|lan|home|test|invalid|example|onion|arpa)$")
  private val maxBytes = 2 * 1024 * 1024
  private val types = setOf("image/jpeg", "image/png", "image/webp")

  private fun isPublic(address: InetAddress): Boolean {
    val bytes = address.address.map { it.toInt() and 255 }
    val (a, b, c, d) = bytes
    if (address is Inet6Address) {
      return a in 0x20..0x3f && !(a == 0x20 && b == 0x02) &&
        !(a == 0x20 && b == 0x01 && (c < 2 || (c == 0x0d && d == 0xb8))) &&
        !(a == 0x3f && b == 0xff)
    }
    if (address !is Inet4Address) return false
    return a in 1..223 && a != 10 && a != 127 &&
      !(a == 100 && b in 64..127) &&
      !(a == 169 && b == 254) &&
      !(a == 172 && b in 16..31) &&
      !(a == 192 && (b == 168 || (b == 0 && c in setOf(0, 2)) ||
        (b == 88 && c == 99))) &&
      !(a == 198 && (b in 18..19 || (b == 51 && c == 100))) &&
      !(a == 203 && b == 0 && c == 113)
  }

  private val client = OkHttpClient.Builder()
    .dns(object : Dns {
      override fun lookup(hostname: String): List<InetAddress> {
        val addresses = Dns.SYSTEM.lookup(hostname)
        if (addresses.isEmpty() || addresses.any { !isPublic(it) })
          throw IOException("Avatar destination rejected")
        return addresses
      }
    })
    .proxy(Proxy.NO_PROXY)
    .cookieJar(CookieJar.NO_COOKIES)
    .followRedirects(false)
    .followSslRedirects(false)
    .retryOnConnectionFailure(false)
    .callTimeout(12, TimeUnit.SECONDS)
    .build()

  private val attachmentClient = client.newBuilder()
    .connectionPool(ConnectionPool(0, 1, TimeUnit.SECONDS))
    .callTimeout(58, TimeUnit.SECONDS)
    .build()

  override fun definition() = ModuleDefinition {
    Name("BoopAvatarTransport")
    Events("attachmentProgress")

    Function("available") { true }

    Function("prepare") { id: String ->
      require(jobs.putIfAbsent(id, Job()) == null)
    }

    Function("cancel") { id: String ->
      jobs[id]?.let {
        it.cancelled.set(true)
        it.call?.cancel()
      }
    }

    AsyncFunction("download") { id: String, url: String, output: String, expectedHash: String?, attachmentLimit: Int? ->
      download(id, url, output, expectedHash, attachmentLimit, null)
    }
    AsyncFunction("downloadPreview") { id: String, url: String, output: String, image: Boolean ->
      download(id, url, output, null, null, image)
    }
  }

  private fun download(id: String, url: String, output: String, expectedHash: String?, attachmentLimit: Int?, previewImage: Boolean?): Int {
      val job = jobs[id] ?: throw IOException("Avatar operation missing")
      try {
        if (job.cancelled.get()) throw IOException("Avatar cancelled")
        val address = url.toHttpUrl()
        require(address.isHttps && address.port == 443 && address.username.isEmpty() &&
          address.password.isEmpty() && allowedHost.matches(address.host) &&
          !localSuffix.containsMatchIn(address.host))
        val target = File(URI(output)).canonicalFile
        val context = appContext.reactContext ?: throw IOException("No React context")
        val html = previewImage == false
        val images = attachmentLimit == null && !html
        val limit = if (html) 512 * 1024 else attachmentLimit ?: maxBytes
        require(attachmentLimit == null || (limit in 17..(32 * 1024 * 1024) &&
          expectedHash?.matches(Regex("[a-f0-9]{64}")) == true))
        val root = if (previewImage != null) File(context.cacheDir, "link-previews")
          else if (attachmentLimit == null) File(context.filesDir, "avatar-cache")
          else File(context.cacheDir, "attachment-work")
        val extension = if (images) ".jpg" else if (html) ".html" else ".bin"
        require(target.path.startsWith(root.canonicalPath + File.separator) && target.name.endsWith(extension))
        val call = (if (attachmentLimit != null) attachmentClient else client).newCall(Request.Builder().url(address)
          .header("Accept", if (html) "text/html" else if (images) "image/jpeg, image/png, image/webp" else "*/*")
          .header("Accept-Encoding", "identity").build())
        job.call = call
        if (job.cancelled.get()) call.cancel()
        val incoming = File(target.path + ".download")
        try {
          val digest = MessageDigest.getInstance("SHA-256")
          call.execute().use { response ->
            if (attachmentLimit != null && response.code == 404) throw IOException("MEDIA_MISSING")
            if (response.code != 200) throw IOException("Avatar HTTP ${response.code}")
            val body = response.body ?: throw IOException("No avatar body")
            val mime = body.contentType()?.let { "${it.type}/${it.subtype}" }
            if ((images && mime !in types) || (html && mime != "text/html") || body.contentLength() > limit)
              throw IOException("Unsupported avatar")
            body.byteStream().use { source ->
              incoming.outputStream().use { sink ->
                val buffer = ByteArray(16 * 1024)
                val expected = body.contentLength().takeIf { it > 0 } ?: -1
                var lastProgress = 0
                var total = 0
                while (true) {
                  val read = source.read(buffer)
                  if (read < 0) break
                  total += read
                  if (total > limit || call.isCanceled()) throw IOException("Avatar size or cancellation")
                  digest.update(buffer, 0, read)
                  sink.write(buffer, 0, read)
                  if (attachmentLimit != null && expected > 0 &&
                      (total - lastProgress >= 64 * 1024 || total.toLong() == expected)) {
                    lastProgress = total
                    sendEvent("attachmentProgress", mapOf("id" to id, "received" to total, "total" to expected))
                  }
                }
              }
            }
          }
          val hash = digest.digest().joinToString("") { "%02x".format(it) }
          if (expectedHash != null && hash != expectedHash) throw IOException("MEDIA_INTEGRITY")
          if (!images) {
            if (call.isCanceled() || incoming.length() < (if (html) 1 else 17) || target.exists() ||
                !incoming.renameTo(target)) throw IOException("Attachment transfer failed")
            return target.length().toInt()
          }
          val bitmap = ImageDecoder.decodeBitmap(ImageDecoder.createSource(incoming)) { decoder, info, _ ->
            val width = info.size.width
            val height = info.size.height
            if (info.mimeType !in types || info.isAnimated || width !in 1..4096 ||
                height !in 1..4096 || width.toLong() * height > 8_000_000)
              throw IOException("Unsupported avatar dimensions or format")
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            val scale = maxOf(width, height) / 512.0
            if (scale > 1) decoder.setTargetSize(
              maxOf(1, (width / scale).toInt()), maxOf(1, (height / scale).toInt()))
          }
          try {
            if (call.isCanceled()) throw IOException("Avatar cancelled")
            target.outputStream().use {
              if (!bitmap.compress(Bitmap.CompressFormat.JPEG, 86, it))
                throw IOException("Avatar encode failed")
            }
          } finally {
            bitmap.recycle()
          }
          return target.length().toInt()
        } finally {
          incoming.delete()
        }
      } finally {
        jobs.remove(id, job)
      }
  }
}
