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
import okhttp3.HttpUrl
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.HttpUrl.Companion.toHttpUrl
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.Inet4Address
import java.net.InetAddress
import java.net.Inet6Address
import java.net.Proxy
import java.net.URI
import java.nio.file.Files
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class AvatarTransportModule : Module() {
  private class Job {
    val cancelled = AtomicBoolean(false)
    @Volatile var cancelOnBackground = false
    @Volatile var call: Call? = null
    private val publishLock = Any()

    fun cancel() = synchronized(publishLock) {
      cancelled.set(true)
      call?.cancel()
    }

    fun publish(action: () -> Unit): Boolean = synchronized(publishLock) {
      if (cancelled.get()) false else {
        action()
        true
      }
    }
  }

  private val jobs = ConcurrentHashMap<String, Job>()
  @Volatile private var downloadsForeground = true
  private val allowedHost = Regex("(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z][a-z0-9-]{1,62}")
  private val localSuffix = Regex("\\.(localhost|local|internal|lan|home|test|invalid|example|onion|arpa)$")
  private val hashFilename = Regex("([a-f0-9]{64})(?:\\.[a-z0-9]{1,8})?")
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
    .callTimeout(300, TimeUnit.SECONDS)
    .build()

  override fun definition() = ModuleDefinition {
    Name("BoopAvatarTransport")
    Events("attachmentProgress")

    Function("available") { true }

    OnActivityEntersForeground { downloadsForeground = true }
    OnActivityEntersBackground {
      downloadsForeground = false
      jobs.values.filter { it.cancelOnBackground }.forEach { it.cancel() }
    }

    Function("prepare") { id: String ->
      require(jobs.putIfAbsent(id, Job()) == null)
    }

    Function("cancel") { id: String ->
      jobs[id]?.cancel()
    }

    AsyncFunction("download") { id: String, url: String, output: String, expectedHash: String? ->
      download(id, url, output, expectedHash, null)
    }
    AsyncFunction("downloadBlossom") { id: String, url: String, output: String, expectedHash: String, expectedSize: Int? ->
      downloadBlossom(id, url, output, expectedHash, expectedSize)
    }
    AsyncFunction("downloadNip05") { id: String, url: String, output: String ->
      download(id, url, output, null, false, true)
    }
    AsyncFunction("downloadPreview") { id: String, url: String, output: String, image: Boolean ->
      download(id, url, output, null, image)
    }
    AsyncFunction("blossomCommand") { id: String, url: String, headers: Map<String, String>, body: String? ->
      val job = jobs[id] ?: throw IOException("Media operation missing")
      try {
        val address = url.toHttpUrl()
        require(address.isHttps && address.port == 443 && address.username.isEmpty() &&
          address.password.isEmpty() && allowedHost.matches(address.host) &&
          !localSuffix.containsMatchIn(address.host) &&
          address.encodedPath == (if (body == null) "/upload" else "/mirror") &&
          (body == null || body.toByteArray().size <= 8192) &&
          address.query == null && address.fragment == null)
        val request = Request.Builder().url(address)
        if (body == null) request.head()
        else request.put(body.toRequestBody("application/json".toMediaType()))
        headers.forEach { (key, value) -> request.header(key, value) }
        val call = client.newCall(request.build())
        job.call = call
        if (job.cancelled.get()) call.cancel()
        call.execute().use { response ->
          val data = if (body == null) null else response.body?.source()
          if (data?.request(8193) == true) throw IOException("Media response too large")
          mapOf("status" to response.code, "body" to (data?.readUtf8() ?: ""))
        }
      } finally {
        jobs.remove(id, job)
      }
    }

  }

  private fun downloadBlossom(id: String, url: String, output: String, expectedHash: String, expectedSize: Int?): Int {
    val job = jobs[id] ?: throw IOException("MEDIA_OPERATION_MISSING")
    job.cancelOnBackground = true
    if (!downloadsForeground) job.cancel()
    val maxBlossomBytes = 1024L * 1024 * 1024
    val expectedBytes = expectedSize?.toLong()
    try {
      if (job.cancelled.get()) throw IOException("MEDIA_CANCELLED")
      require(expectedHash.matches(Regex("[a-f0-9]{64}")) &&
        (expectedBytes == null || expectedBytes in 0..maxBlossomBytes)) { "MEDIA_DESTINATION" }
      var address = url.toHttpUrl()
      require(isBlossomAddress(address)) { "MEDIA_DESTINATION" }
      val context = appContext.reactContext ?: throw IOException("MEDIA_UNAVAILABLE")
      val blossomRoot = File(context.filesDir.canonicalFile, "blossom-downloads")
      val root = blossomRoot.canonicalFile
      require(root == blossomRoot) { "MEDIA_DESTINATION" }
      val target = File(URI(output)).canonicalFile
      require(target.parentFile?.parentFile == root &&
        target.parentFile?.name?.matches(Regex("[a-f0-9]{64}")) == true &&
        target.name == "$expectedHash.bin" && expectedHash.matches(Regex("[a-f0-9]{64}"))) {
        "MEDIA_DESTINATION"
      }
      if (!target.parentFile!!.exists() && !target.parentFile!!.mkdirs()) throw IOException("MEDIA_STORAGE")
      val incoming = File(target.path + ".download")
      require(!Files.isSymbolicLink(incoming.toPath())) { "MEDIA_DESTINATION" }
      require(!incoming.exists() || (incoming.isFile && incoming.canonicalFile.path == incoming.absolutePath &&
        incoming.canonicalFile.parentFile == target.parentFile)) { "MEDIA_DESTINATION" }
      if (target.exists()) throw IOException("MEDIA_EXISTS")
      var offset = if (incoming.isFile) incoming.length() else 0L
      if (offset > maxBlossomBytes || (expectedBytes != null && offset > expectedBytes)) {
        incoming.delete()
        offset = 0
      }
      val digest = MessageDigest.getInstance("SHA-256")
      if (offset > 0) incoming.inputStream().use { source ->
        val buffer = ByteArray(64 * 1024)
        while (true) {
          if (job.cancelled.get()) throw IOException("MEDIA_CANCELLED")
          val read = source.read(buffer)
          if (read < 0) break
          digest.update(buffer, 0, read)
        }
      }
      var restarted = false
      var redirects = 0
      val blossomClient = attachmentClient.newBuilder().callTimeout(3600, TimeUnit.SECONDS).build()
      while (true) {
        if (job.cancelled.get()) throw IOException("MEDIA_CANCELLED")
        val request = Request.Builder().url(address)
          .header("Accept-Encoding", "identity")
          .apply { if (offset > 0) header("Range", "bytes=$offset-") }
          .get().build()
        val call = blossomClient.newCall(request)
        job.call = call
        if (job.cancelled.get()) call.cancel()
        val followedRedirect = call.execute().use { response ->
          if (response.code in listOf(301, 302, 303, 307, 308)) {
            val next = response.header("Location")?.let(address::resolve)
            if (redirects >= 3 || next == null || !isBlossomAddress(next)) throw IOException("MEDIA_REDIRECT")
            address = next
            redirects += 1
            return@use true
          }
          if (response.code == 404) throw IOException("MEDIA_MISSING")
          if (offset > 0 && response.code == 200) {
            if (restarted) throw IOException("MEDIA_RANGE")
            incoming.delete()
            offset = 0
            digest.reset()
            restarted = true
            return@use false
          }
          if (offset > 0 && response.code == 416 && !restarted) {
            incoming.delete()
            offset = 0
            digest.reset()
            restarted = true
            return@use false
          }
          if (response.code != if (offset > 0) 206 else 200) throw mediaHttpError(response.code)
          val body = response.body ?: throw IOException("MEDIA_RESPONSE")
          val total = if (response.code == 206) {
            val range = parseContentRange(response.header("Content-Range")) ?: throw IOException("MEDIA_RANGE")
            if (range.start != offset || range.end + 1 != range.total ||
              body.contentLength() < 0 || range.end - range.start + 1 != body.contentLength())
              throw IOException("MEDIA_RANGE")
            range.total
          } else body.contentLength().takeIf { it >= 0 }
          if (total != null && (total > maxBlossomBytes || (expectedBytes != null && total != expectedBytes))) {
            incoming.delete()
            throw IOException("MEDIA_INTEGRITY")
          }
          try {
            body.byteStream().use { source ->
              val outputStream = try { FileOutputStream(incoming, offset > 0) }
                catch (error: IOException) { throw mediaIoError(error) }
              outputStream.use { sink ->
              val buffer = ByteArray(64 * 1024)
              var received = offset
              var lastProgress = received
              while (true) {
                val read = source.read(buffer)
                if (read < 0) break
                if (job.cancelled.get()) throw IOException("MEDIA_CANCELLED")
                received += read
                if (received > maxBlossomBytes || (expectedBytes != null && received > expectedBytes)) {
                  incoming.delete()
                  throw IOException("MEDIA_TOO_LARGE")
                }
                digest.update(buffer, 0, read)
                try { sink.write(buffer, 0, read) }
                catch (error: IOException) { throw mediaIoError(error) }
                if (received - lastProgress >= 64 * 1024 || (total != null && received == total)) {
                  lastProgress = received
                  sendEvent("attachmentProgress", mapOf("id" to id, "received" to received, "total" to (expectedBytes ?: total ?: -1L)))
                }
              }
              try { sink.fd.sync() } catch (error: IOException) { throw mediaIoError(error) }
              if (total != null && received != total) throw IOException("MEDIA_INTERRUPTED")
              if (expectedBytes != null && received != expectedBytes) {
                incoming.delete()
                throw IOException("MEDIA_INTEGRITY")
              }
              val actualHash = digest.digest().joinToString("") { "%02x".format(it) }
              if (actualHash != expectedHash) {
                incoming.delete()
                throw IOException("MEDIA_INTEGRITY")
              }
              if (!job.publish {
                if (target.exists()) throw IOException("MEDIA_EXISTS")
                try { Files.move(incoming.toPath(), target.toPath()) }
                catch (_: java.nio.file.FileAlreadyExistsException) { throw IOException("MEDIA_EXISTS") }
                catch (error: Exception) { throw mediaIoError(error, "MEDIA_PUBLISH") }
              }) throw IOException("MEDIA_CANCELLED")
              sendEvent("attachmentProgress", mapOf("id" to id, "received" to received, "total" to (expectedBytes ?: total ?: -1L)))
              return target.length().toInt()
              }
            }
          } catch (error: IOException) {
            throw mediaIoError(error, "MEDIA_INTERRUPTED")
          }
        }
        if (followedRedirect || (incoming.length() == 0L && offset == 0L && restarted)) continue
        throw IOException("MEDIA_TRANSFER")
      }
    } finally {
      jobs.remove(id, job)
    }
  }

  private fun isBlossomAddress(address: HttpUrl) =
    address.isHttps && address.port == 443 && address.username.isEmpty() &&
      address.password.isEmpty() && allowedHost.matches(address.host) &&
      !localSuffix.containsMatchIn(address.host)

  private fun hashAt(address: HttpUrl) =
    hashFilename.matchEntire(address.encodedPathSegments.last())?.groupValues?.get(1)

  private fun mediaResponse(initial: HttpUrl, accept: String, hash: String?, job: Job): okhttp3.Response {
    var address = initial
    var redirects = 0
    while (true) {
      val call = client.newCall(Request.Builder().url(address)
        .header("Accept", accept).header("Accept-Encoding", "identity").build())
      job.call = call
      if (job.cancelled.get()) call.cancel()
      val response = call.execute()
      if (hash == null || response.code !in listOf(301, 302, 303, 307, 308)) return response
      response.use {
        val next = it.header("Location")?.let(address::resolve)
        if (redirects >= 3 || next == null || !isBlossomAddress(next) || hashAt(next) != hash)
          throw IOException("MEDIA_REDIRECT")
        address = next
        redirects++
      }
    }
  }

  internal data class ContentRange(val start: Long, val end: Long, val total: Long)

  internal fun parseContentRange(value: String?): ContentRange? {
    val match = Regex("bytes (\\d+)-(\\d+)/(\\d+)").matchEntire(value ?: "") ?: return null
    val start = match.groupValues[1].toLongOrNull() ?: return null
    val end = match.groupValues[2].toLongOrNull() ?: return null
    val total = match.groupValues[3].toLongOrNull() ?: return null
    if (total <= 0 || start > end || end >= total) return null
    return ContentRange(start, end, total)
  }

  private fun mediaHttpError(code: Int) = IOException(
    if (code == 408 || code == 425 || code == 429 || code in 500..599)
      "MEDIA_HTTP_TEMPORARY_$code"
    else "MEDIA_HTTP_PERMANENT_$code"
  )

  private fun mediaIoError(error: Exception, fallback: String = "MEDIA_STORAGE"): IOException {
    var current: Throwable? = error
    while (current != null) {
      if (current is android.system.ErrnoException && current.errno == android.system.OsConstants.ENOSPC)
        return IOException("MEDIA_STORAGE_FULL", error)
      if (current.message?.contains("ENOSPC", ignoreCase = true) == true ||
        current.message?.contains("No space left on device", ignoreCase = true) == true)
        return IOException("MEDIA_STORAGE_FULL", error)
      current = current.cause
    }
    return if (error is IOException && error.message?.startsWith("MEDIA_") == true) error
      else IOException(fallback, error)
  }

  private fun download(id: String, url: String, output: String, expectedHash: String?, previewImage: Boolean?, nip05: Boolean = false): Int {
      val job = jobs[id] ?: throw IOException("Avatar operation missing")
      try {
        if (job.cancelled.get()) throw IOException("Avatar cancelled")
        val address = url.toHttpUrl()
        require(isBlossomAddress(address))
        val target = File(URI(output)).canonicalFile
        val context = appContext.reactContext ?: throw IOException("No React context")
        val html = previewImage == false && !nip05
        val images = !html && !nip05
        val limit = if (nip05) 64 * 1024 else if (html) 512 * 1024 else maxBytes
        val root = if (previewImage != null) File(context.cacheDir, "link-previews")
          else File(context.filesDir, "avatar-cache")
        val extension = if (images) ".jpg" else if (html) ".html" else ".bin"
        require(target.path.startsWith(root.canonicalPath + File.separator) && target.name.endsWith(extension))
        val accept = if (nip05) "application/json" else if (html) "text/html" else "image/jpeg, image/png, image/webp"
        val redirectHash = expectedHash?.takeIf { previewImage == null && hashAt(address) == it }
        val incoming = File(target.path + ".download")
        try {
          val digest = MessageDigest.getInstance("SHA-256")
          mediaResponse(address, accept, redirectHash, job).use { response ->
            if (response.code != 200) throw IOException("Avatar HTTP ${response.code}")
            val body = response.body ?: throw IOException("No avatar body")
            val mime = body.contentType()?.let { "${it.type}/${it.subtype}" }
            if ((images && mime !in types) || (html && mime != "text/html") || (nip05 && mime != "application/json" && mime != "text/plain") || body.contentLength() > limit)
              throw IOException("Unsupported avatar")
            body.byteStream().use { source ->
              incoming.outputStream().use { sink ->
                val buffer = ByteArray(16 * 1024)
                var total = 0
                while (true) {
                  val read = source.read(buffer)
                  if (read < 0) break
                  total += read
                  if (total > limit || job.cancelled.get()) throw IOException("Avatar size or cancellation")
                  digest.update(buffer, 0, read)
                  sink.write(buffer, 0, read)
                }
              }
            }
          }
          val hash = digest.digest().joinToString("") { "%02x".format(it) }
          if (expectedHash != null && hash != expectedHash) throw IOException("MEDIA_INTEGRITY")
          if (!images) {
            if (job.cancelled.get() || incoming.length() < 1 || target.exists() ||
                !incoming.renameTo(target)) throw IOException("Public document transfer failed")
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
            if (job.cancelled.get()) throw IOException("Avatar cancelled")
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
