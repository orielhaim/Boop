package app.boop.plugins

import android.net.Uri
import androidx.media3.common.C
import androidx.media3.common.PlaybackException
import androidx.media3.datasource.BaseDataSource
import androidx.media3.datasource.DataSourceException
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.TransferListener
import androidx.media3.common.util.UnstableApi
import java.io.IOException
import java.io.InterruptedIOException
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ExecutionException
import java.util.concurrent.Future
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

private const val MAX_NATIVE_READ_BYTES = 64 * 1024

private val nativeReads = ThreadPoolExecutor(
  2,
  4,
  30,
  TimeUnit.SECONDS,
  ArrayBlockingQueue(4),
  { task -> Thread(task, "BoopTorrentMediaRead").apply { isDaemon = true } },
  ThreadPoolExecutor.AbortPolicy(),
)

internal interface TorrentReaderBridge {
  fun size(token: String): Long
  fun open(token: String, position: Long, length: Long): Long
  fun read(readerId: Long, destination: ByteArray, offset: Int, length: Int): Int
  fun cancel(readerId: Long)
  fun close(readerId: Long)
}

private object JniTorrentReaderBridge : TorrentReaderBridge {
  override fun size(token: String) = TorrentNative.torrentStreamSize(token)
  override fun open(token: String, position: Long, length: Long) = TorrentNative.openReader(token, position, length)
  override fun read(readerId: Long, destination: ByteArray, offset: Int, length: Int) =
    TorrentNative.read(readerId, destination, offset, length)
  override fun cancel(readerId: Long) = TorrentNative.cancelReader(readerId)
  override fun close(readerId: Long) = TorrentNative.closeReader(readerId)
}

internal class TorrentManagedMediaDataSourceFactory(
  private val reader: TorrentReaderBridge = JniTorrentReaderBridge,
) : androidx.media3.datasource.DataSource.Factory {
  override fun createDataSource(): androidx.media3.datasource.DataSource = TorrentManagedMediaDataSource(reader)
}

@androidx.annotation.OptIn(UnstableApi::class)
internal class TorrentManagedMediaDataSource(private val reader: TorrentReaderBridge) : BaseDataSource(false) {
  private data class ReaderSession(
    val id: Long,
    val scratch: ByteArray = ByteArray(MAX_NATIVE_READ_BYTES),
    val readInProgress: AtomicBoolean = AtomicBoolean(false),
  )

  private val readerSession = AtomicReference<ReaderSession?>(null)
  @Volatile private var openedUri: Uri? = null
  @Volatile private var remaining = C.LENGTH_UNSET.toLong()
  @Volatile private var transferOpen = false

  override fun open(dataSpec: DataSpec): Long {
    if (transferOpen || readerSession.get() != null) close()
    val uri = dataSpec.uri
    if (
      uri.scheme != "boop-media" || uri.host.isNullOrBlank() ||
      uri.userInfo != null || uri.port != -1 || uri.query != null || uri.fragment != null ||
      uri.path.orEmpty() !in listOf("", "/")
    ) {
      throw IOException("Invalid managed media URI")
    }

    val fileSize = reader.size(uri.host!!)
    if (fileSize < 0) throw IOException("Managed media size is unavailable")
    if (dataSpec.position > fileSize) {
      throw DataSourceException(
        "Managed media position is outside the resource",
        PlaybackException.ERROR_CODE_IO_READ_POSITION_OUT_OF_RANGE,
      )
    }
    val available = fileSize - dataSpec.position
    val readableLength = if (dataSpec.length == C.LENGTH_UNSET.toLong()) {
      available
    } else {
      minOf(dataSpec.length, available)
    }
    transferInitializing(dataSpec)
    if (readableLength == 0L) {
      openedUri = uri
      remaining = 0
      transferStarted(dataSpec)
      transferOpen = true
      return dataSpec.length.takeIf { it != C.LENGTH_UNSET.toLong() } ?: 0L
    }

    val id = reader.open(uri.host!!, dataSpec.position, dataSpec.length)
    if (id <= 0) throw IOException("Managed media lease is unavailable")

    readerSession.set(ReaderSession(id))
    openedUri = uri
    remaining = readableLength
    transferStarted(dataSpec)
    transferOpen = true
    return dataSpec.length.takeIf { it != C.LENGTH_UNSET.toLong() } ?: readableLength
  }

  override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
    if (length == 0) return 0
    if (offset < 0 || length < 0 || offset.toLong() + length > buffer.size) {
      throw IOException("Invalid managed media read buffer")
    }
    if (remaining == 0L) return C.RESULT_END_OF_INPUT
    val session = readerSession.get() ?: throw IOException("Managed media reader is closed")
    if (!session.readInProgress.compareAndSet(false, true)) throw IOException("Concurrent media reads are unsupported")

    try {
      val requested = minOf(
        length,
        MAX_NATIVE_READ_BYTES,
        if (remaining == C.LENGTH_UNSET.toLong()) Int.MAX_VALUE else remaining.coerceAtMost(Int.MAX_VALUE.toLong()).toInt(),
      )
      val future = try {
        nativeReads.submit<Int> { reader.read(session.id, session.scratch, 0, requested) }
      } catch (error: java.util.concurrent.RejectedExecutionException) {
        throw IOException("Managed media reader is busy", error)
      }
      val count = awaitRead(session.id, future)
      if (count < 0) throw IOException("Managed media read failed (code $count)")
      if (count == 0) {
        if (remaining == 0L) return C.RESULT_END_OF_INPUT
        throw IOException("Managed media reader ended before the requested range")
      }
      if (count > requested) throw IOException("Managed media reader returned an invalid byte count")
      if (readerSession.get() !== session) throw InterruptedIOException("Managed media reader was closed")
      System.arraycopy(session.scratch, 0, buffer, offset, count)
      if (remaining != C.LENGTH_UNSET.toLong()) remaining -= count
      bytesTransferred(count)
      return count
    } finally {
      session.readInProgress.set(false)
    }
  }

  private fun awaitRead(id: Long, future: Future<Int>): Int = try {
    future.get()
  } catch (error: InterruptedException) {
    reader.cancel(id)
    future.cancel(true)
    Thread.currentThread().interrupt()
    throw InterruptedIOException("Managed media read was interrupted").apply { initCause(error) }
  } catch (error: ExecutionException) {
    throw IOException("Managed media read failed", error.cause)
  }

  override fun getUri(): Uri? = openedUri

  override fun close() {
    val session = readerSession.getAndSet(null)
    openedUri = null
    remaining = C.LENGTH_UNSET.toLong()
    if (session != null) {
      reader.cancel(session.id)
      reader.close(session.id)
    }
    if (transferOpen) {
      transferOpen = false
      transferEnded()
    }
  }
}
