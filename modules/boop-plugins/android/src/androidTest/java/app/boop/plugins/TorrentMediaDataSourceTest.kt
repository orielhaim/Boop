package app.boop.plugins

import android.net.Uri
import androidx.media3.common.C
import androidx.media3.common.PlaybackException
import androidx.media3.datasource.DataSourceException
import androidx.media3.datasource.DataSpec
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.IOException
import java.io.InterruptedIOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class TorrentMediaDataSourceTest {
  @Test
  fun readsRequestedRangeAndEndsAtTheDeclaredLength() {
    val bytes = byteArrayOf(10, 11, 12, 13, 14, 15, 16, 17)
    val reader = FixtureReader(bytes)
    val source = TorrentManagedMediaDataSource(reader)
    val length = source.open(spec(position = 2, length = 3))
    val target = ByteArray(6)

    assertEquals(3L, length)
    assertEquals(3, source.read(target, 1, target.size - 1))
    assertArrayEquals(byteArrayOf(0, 12, 13, 14, 0, 0), target)
    assertEquals(C.RESULT_END_OF_INPUT, source.read(target, 0, target.size))
    source.close()
    assertTrue(reader.closed.get())
  }

  @Test
  fun anOpenAtExactEofReturnsAnEmptyRange() {
    val reader = FixtureReader(byteArrayOf(1, 2, 3))
    val source = TorrentManagedMediaDataSource(reader)

    assertEquals(0L, source.open(spec(position = 3, length = C.LENGTH_UNSET.toLong())))
    assertEquals(C.RESULT_END_OF_INPUT, source.read(ByteArray(1), 0, 1))
    source.close()
    assertTrue(reader.closed.get().not())
  }

  @Test
  fun boundedOpenKeepsRequestedLengthWhileReadsStopAtEof() {
    val reader = FixtureReader(byteArrayOf(1, 2, 3, 4))
    val source = TorrentManagedMediaDataSource(reader)
    val target = ByteArray(4)

    assertEquals(4L, source.open(spec(position = 2, length = 4)))
    assertEquals(2, source.read(target, 0, target.size))
    assertArrayEquals(byteArrayOf(3, 4, 0, 0), target)
    assertEquals(C.RESULT_END_OF_INPUT, source.read(target, 0, target.size))
    source.close()
  }

  @Test
  fun aPositionPastEofUsesTheMedia3ReadPositionError() {
    val source = TorrentManagedMediaDataSource(FixtureReader(byteArrayOf(1, 2, 3)))

    try {
      source.open(spec(position = 4, length = C.LENGTH_UNSET.toLong()))
      throw AssertionError("Expected an out-of-range DataSourceException")
    } catch (error: DataSourceException) {
      assertEquals(PlaybackException.ERROR_CODE_IO_READ_POSITION_OUT_OF_RANGE, error.reason)
    } finally {
      source.close()
    }
  }

  @Test
  fun readsPositionsBeyondFourGibibytes() {
    val position = 5L * 1024 * 1024 * 1024
    var openedAt = -1L
    val reader = object : TorrentReaderBridge {
      override fun size(token: String) = position + 2
      override fun open(token: String, position: Long, length: Long): Long {
        openedAt = position
        return 1L
      }
      override fun read(readerId: Long, destination: ByteArray, offset: Int, length: Int): Int {
        destination[offset] = 91
        destination[offset + 1] = 92
        return 2
      }
      override fun cancel(readerId: Long) = Unit
      override fun close(readerId: Long) = Unit
    }
    val source = TorrentManagedMediaDataSource(reader)
    try {
      assertEquals(2L, source.open(spec(position = position, length = C.LENGTH_UNSET.toLong())))
      assertEquals(position, openedAt)
      val buffer = ByteArray(2)
      assertEquals(2, source.read(buffer, 0, buffer.size))
      assertArrayEquals(byteArrayOf(91, 92), buffer)
      assertEquals(C.RESULT_END_OF_INPUT, source.read(buffer, 0, buffer.size))
    } finally {
      source.close()
    }
  }

  @Test
  fun closingADataSourceCancelsABlockedNativeRead() {
    val reader = BlockingReader()
    val source = TorrentManagedMediaDataSource(reader)
    source.open(spec(position = 0, length = 1))
    val error = AtomicReference<Throwable?>()
    val thread = Thread {
      try {
        source.read(ByteArray(1), 0, 1)
      } catch (failure: Throwable) {
        error.set(failure)
      }
    }
    thread.start()

    assertTrue(reader.entered.await(2, TimeUnit.SECONDS))
    source.close()
    thread.join(2_000)

    assertTrue(!thread.isAlive)
    assertTrue(error.get() is IOException)
    assertTrue(reader.cancelled.get())
    assertTrue(reader.closed.get())
  }

  @Test
  fun interruptingTheMedia3LoaderCancelsTheNativeRead() {
    val reader = BlockingReader()
    val source = TorrentManagedMediaDataSource(reader)
    source.open(spec(position = 0, length = 1))
    val error = AtomicReference<Throwable?>()
    val thread = Thread {
      try {
        source.read(ByteArray(1), 0, 1)
      } catch (failure: Throwable) {
        error.set(failure)
      }
    }
    thread.start()

    assertTrue(reader.entered.await(2, TimeUnit.SECONDS))
    thread.interrupt()
    thread.join(2_000)

    assertTrue(!thread.isAlive)
    assertTrue(error.get() is InterruptedIOException)
    assertTrue(reader.cancelled.get())
    source.close()
  }

  private fun spec(position: Long, length: Long) = DataSpec.Builder()
    .setUri(Uri.parse("boop-media://test-token"))
    .setPosition(position)
    .setLength(length)
    .build()

  private open class FixtureReader(private val content: ByteArray) : TorrentReaderBridge {
    protected var cursor = 0
    val closed = AtomicBoolean()

    override fun size(token: String): Long {
      assertEquals("test-token", token)
      return content.size.toLong()
    }

    override fun open(token: String, position: Long, length: Long): Long {
      cursor = position.toInt()
      return 7
    }

    override fun read(readerId: Long, destination: ByteArray, offset: Int, length: Int): Int {
      if (cursor >= content.size) return 0
      val count = minOf(length, content.size - cursor)
      content.copyInto(destination, offset, cursor, cursor + count)
      cursor += count
      return count
    }

    override fun cancel(readerId: Long) = Unit

    override fun close(readerId: Long) {
      closed.set(true)
    }
  }

  private class BlockingReader : FixtureReader(byteArrayOf(1)) {
    val entered = CountDownLatch(1)
    val released = CountDownLatch(1)
    val cancelled = AtomicBoolean()

    override fun read(readerId: Long, destination: ByteArray, offset: Int, length: Int): Int {
      entered.countDown()
      released.await()
      return -1
    }

    override fun cancel(readerId: Long) {
      cancelled.set(true)
      released.countDown()
    }
  }
}
