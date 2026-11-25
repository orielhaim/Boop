package app.boop.plugins

import android.app.Activity
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.view.SurfaceHolder
import android.view.SurfaceView
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.SeekParameters
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import expo.modules.video.ManagedDataSourceRegistry
import expo.modules.video.enums.ContentType
import expo.modules.video.records.VideoSource
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.atomic.AtomicLong
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

class TorrentVideoRenderActivity : Activity() {
  lateinit var videoSurface: SurfaceView
    private set

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    videoSurface = SurfaceView(this)
    setContentView(videoSurface)
  }
}

@RunWith(AndroidJUnit4::class)
class TorrentProgressivePlaybackTest {
  @Test
  fun decodesMp4WithTrailingIndex() = decodeAndSeek("progressive-test.mp4", "video/mp4")

  @Test
  fun decodesMatroska() = decodeAndSeek("progressive-test.mkv", "video/x-matroska")

  @Test
  fun decodesWebM() = decodeAndSeek("progressive-test.webm", "video/webm")

  private fun decodeAndSeek(asset: String, mimeType: String) {
    val fixture = InstrumentationRegistry.getInstrumentation().context.assets
      .open(asset).use { it.readBytes() }
    val reader = MediaFixtureReader(fixture)
    val registration = ManagedDataSourceRegistry.register(
      "boop-media",
      TorrentManagedMediaDataSourceFactory(reader),
    )
    val firstFrame = CountDownLatch(1)
    val sought = CountDownLatch(1)
    val surfaceReady = CountDownLatch(1)
    val error = AtomicReference<PlaybackException?>()
    val playerRef = AtomicReference<ExoPlayer?>()
    val preparedAt = AtomicLong()
    val firstFrameMs = AtomicLong()
    val scenario = ActivityScenario.launch(TorrentVideoRenderActivity::class.java)

    try {
      scenario.onActivity { activity ->
        if (activity.videoSurface.holder.surface.isValid) surfaceReady.countDown()
        activity.videoSurface.holder.addCallback(object : SurfaceHolder.Callback {
          override fun surfaceCreated(holder: SurfaceHolder) = surfaceReady.countDown()
          override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) = Unit
          override fun surfaceDestroyed(holder: SurfaceHolder) = Unit
        })
      }
      assertTrue("Media3 surface did not become ready", surfaceReady.await(5, TimeUnit.SECONDS))

      scenario.onActivity { activity ->
        val player = ExoPlayer.Builder(activity)
          .setLoadControl(DefaultLoadControl.Builder().setBufferDurationsMs(500, 1_500, 100, 100).build())
          .build()
        playerRef.set(player)
        player.setVideoSurface(activity.videoSurface.holder.surface)
        player.setSeekParameters(SeekParameters.EXACT)
        player.addListener(object : Player.Listener {
          override fun onRenderedFirstFrame() {
            firstFrameMs.compareAndSet(0L, SystemClock.elapsedRealtime() - preparedAt.get())
            firstFrame.countDown()
          }

          override fun onPlayerError(playbackError: PlaybackException) {
            error.set(playbackError)
          }

          override fun onPositionDiscontinuity(
            oldPosition: Player.PositionInfo,
            newPosition: Player.PositionInfo,
            reason: Int,
          ) {
            if (reason == Player.DISCONTINUITY_REASON_SEEK) sought.countDown()
          }
        })
        val mediaSource = VideoSource(
          uri = Uri.parse("boop-media://test-token"),
          contentType = ContentType.PROGRESSIVE,
          mimeType = mimeType,
        ).toMediaSource(activity) ?: error("Managed video source was not created")
        player.setMediaSource(mediaSource)
        player.repeatMode = Player.REPEAT_MODE_ONE
        player.playWhenReady = true
        preparedAt.set(SystemClock.elapsedRealtime())
        player.prepare()
      }

      assertTrue("Media3 did not render a decoded video frame", firstFrame.await(15, TimeUnit.SECONDS))
      assertEquals(null, error.get())

      val opensBeforeSeek = reader.openPositions.size
      val startedSeeking = AtomicLong()
      scenario.onActivity {
        startedSeeking.set(SystemClock.elapsedRealtime())
        playerRef.get()?.seekTo(80_000)
      }
      assertTrue("Media3 did not complete the requested seek", sought.await(8, TimeUnit.SECONDS))
      var resumed = false
      while (!resumed && SystemClock.elapsedRealtime() - startedSeeking.get() < 8_000) {
        scenario.onActivity {
          val player = playerRef.get() ?: return@onActivity
          resumed = player.isPlaying && player.currentPosition > 80_100L
        }
        if (!resumed) SystemClock.sleep(25)
      }
      val seekWith100MsPlayback = SystemClock.elapsedRealtime() - startedSeeking.get()
      assertTrue("Media3 did not resume playback", resumed)
      assertEquals(null, error.get())
      assertTrue(reader.openedTokens.isNotEmpty())
      assertTrue(reader.openedTokens.all { it == "test-token" })
      val seekRanges = synchronized(reader.openPositions) { reader.openPositions.drop(opensBeforeSeek) }
      assertTrue("The seek did not open a nonzero media range", seekRanges.any { it >= fixture.size / 3 })
      Log.i("BoopProgressiveTest", "$mimeType firstFrameMs=${firstFrameMs.get()} seekAnd100MsPlaybackMs=$seekWith100MsPlayback bytes=${fixture.size}")
    } finally {
      scenario.onActivity { playerRef.getAndSet(null)?.release() }
      registration.close()
      scenario.close()
    }
  }

  private class MediaFixtureReader(private val bytes: ByteArray) : TorrentReaderBridge {
    private data class Reader(var position: Int)

    private var nextReaderId = 1L
    private val readers = mutableMapOf<Long, Reader>()
    val openedTokens = Collections.synchronizedList(mutableListOf<String>())
    val openPositions = Collections.synchronizedList(mutableListOf<Long>())

    @Synchronized
    override fun size(token: String): Long {
      openedTokens.add(token)
      return bytes.size.toLong()
    }

    @Synchronized
    override fun open(token: String, position: Long, length: Long): Long {
      openedTokens.add(token)
      openPositions.add(position)
      val id = nextReaderId++
      readers[id] = Reader(position.toInt())
      return id
    }

    @Synchronized
    override fun read(readerId: Long, destination: ByteArray, offset: Int, length: Int): Int {
      val reader = readers[readerId] ?: return -1
      if (reader.position >= bytes.size) return 0
      val count = minOf(length, bytes.size - reader.position)
      bytes.copyInto(destination, offset, reader.position, reader.position + count)
      reader.position += count
      return count
    }

    @Synchronized
    override fun cancel(readerId: Long) {
      readers.remove(readerId)
    }

    @Synchronized
    override fun close(readerId: Long) {
      readers.remove(readerId)
    }
  }
}
