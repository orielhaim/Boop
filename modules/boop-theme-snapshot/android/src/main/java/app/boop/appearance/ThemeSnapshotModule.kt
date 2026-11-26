package app.boop.appearance

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.view.PixelCopy
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.nio.ByteBuffer
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

class ThemeSnapshotModule : Module() {
  private val mainHandler = Handler(Looper.getMainLooper())

  override fun definition() = ModuleDefinition {
    Name("BoopThemeSnapshot")

    AsyncFunction("copy").Coroutine<ByteArray?, Int, Int, Int> { tag, width, height ->
      if (width <= 0 || height <= 0 || width.toLong() * height > 1_500_000) {
        return@Coroutine null
      }
      withContext(Dispatchers.Main) {
        val window = appContext.currentActivity?.window ?: return@withContext null
        val frame = copyFrame(window, tag, width, height) ?: return@withContext null
        try {
          val pixels = withContext(Dispatchers.Default) {
            if (frame.rowBytes != width * 4) null
            else ByteBuffer.allocate(frame.byteCount).also(frame::copyPixelsToBuffer).array()
          }
          pixels.takeIf { canCapture(window) && window.decorView.hasWindowFocus() }
        } finally {
          frame.recycle()
        }
      }
    }

    AsyncFunction("awaitFrameCover").Coroutine<Boolean, Int, Double, Double> { tag, x, y ->
      withContext(Dispatchers.Main) { awaitFrameCover(tag, x, y) }
    }
  }

  private suspend fun awaitFrameCover(tag: Int, x: Double, y: Double): Boolean {
    if (!x.isFinite() || !y.isFinite()) return false
    val window = appContext.currentActivity?.window ?: return false
    val root = window.decorView.findViewById<View>(tag) ?: return false
    val pixel = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)
    try {
      return withTimeoutOrNull(450) {
        while (root.isAttachedToWindow && canCapture(window) && window.decorView.hasWindowFocus()) {
          val overlay = root.surfaceView()
          val holder = overlay?.holder
          if (holder != null && holder.surface.isValid) {
            val frame = holder.surfaceFrame
            if (frame.width() > 2 && frame.height() > 2) {
              val sampleX = (x * frame.width()).toInt().coerceIn(1, frame.width() - 2)
              val sampleY = (y * frame.height()).toInt().coerceIn(1, frame.height() - 2)
              val copied = suspendCoroutine { continuation ->
                try {
                  PixelCopy.request(holder.surface, Rect(sampleX, sampleY, sampleX + 1, sampleY + 1), pixel, { result ->
                    continuation.resume(result == PixelCopy.SUCCESS)
                  }, mainHandler)
                } catch (_: IllegalArgumentException) {
                  continuation.resume(false)
                }
              }
              if (copied && canCapture(window) && window.decorView.hasWindowFocus() &&
                  Color.alpha(pixel.getPixel(0, 0)) != 0) return@withTimeoutOrNull true
            }
          }
          delay(16)
        }
        false
      } ?: false
    } finally {
      pixel.recycle()
    }
  }

  private fun View.surfaceView(): SurfaceView? =
    when (this) {
      is SurfaceView -> this
      is ViewGroup -> (0 until childCount).firstNotNullOfOrNull { getChildAt(it).surfaceView() }
      else -> null
    }

  private fun canCapture(window: Window): Boolean =
    appContext.currentActivity?.window === window &&
      window.decorView.isAttachedToWindow &&
      window.decorView.windowVisibility == View.VISIBLE &&
      window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE == 0

  private suspend fun copyFrame(window: Window, tag: Int, width: Int, height: Int): Bitmap? {
    repeat(4) { attempt ->
      if (!canCapture(window)) return null
      val view = window.decorView.findViewById<View>(tag) ?: return null
      if (!view.isAttachedToWindow || view.width <= 0 || view.height <= 0) return null
      if (window.decorView.hasWindowFocus()) {
        val origin = IntArray(2).also(view::getLocationInWindow)
        val bounds = Rect(origin[0], origin[1], origin[0] + view.width, origin[1] + view.height)
        val frame = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val result = requestCopy(window, bounds, frame)
        if (result == PixelCopy.SUCCESS && canCapture(window) && window.decorView.hasWindowFocus()) {
          return frame
        }
        frame.recycle()
        if (result != PixelCopy.ERROR_SOURCE_NO_DATA) return null
      }
      // The activity can be visible before its first frame or window focus is ready.
      if (attempt < 3) delay(16)
    }
    return null
  }

  private suspend fun requestCopy(window: Window, bounds: Rect, frame: Bitmap): Int =
    suspendCoroutine { continuation ->
      try {
        PixelCopy.request(window, bounds, frame, continuation::resume, mainHandler)
      } catch (_: IllegalArgumentException) {
        continuation.resume(PixelCopy.ERROR_SOURCE_INVALID)
      }
    }
}
