package app.boop.appearance

import android.graphics.Bitmap
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.view.PixelCopy
import android.view.View
import android.view.WindowManager
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.nio.ByteBuffer
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class ThemeSnapshotModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("BoopThemeSnapshot")

    AsyncFunction("copy").Coroutine<ByteArray?, Int, Int, Int> { tag, width, height ->
      if (width <= 0 || height <= 0 || width.toLong() * height > 1_500_000) {
        return@Coroutine null
      }
      withContext(Dispatchers.Main) {
        val frame = copyFrame(tag, width, height) ?: return@withContext null
        try {
          withContext(Dispatchers.Default) {
            if (frame.rowBytes != width * 4) null
            else ByteBuffer.allocate(frame.byteCount).also(frame::copyPixelsToBuffer).array()
          }
        } finally {
          frame.recycle()
        }
      }
    }
  }

  private suspend fun copyFrame(tag: Int, width: Int, height: Int): Bitmap? {
    val window = appContext.currentActivity?.window ?: return null
    if (!window.decorView.hasWindowFocus()) return null
    if (window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0) {
      return null
    }
    val view = window.decorView.findViewById<View>(tag) ?: return null
    if (!view.isAttachedToWindow || view.width <= 0 || view.height <= 0) return null

    val origin = IntArray(2).also(view::getLocationInWindow)
    val bounds = Rect(origin[0], origin[1], origin[0] + view.width, origin[1] + view.height)
    val frame = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    return suspendCoroutine { continuation ->
      try {
        PixelCopy.request(window, bounds, frame, { result ->
          if (result == PixelCopy.SUCCESS) {
            continuation.resume(frame)
          } else {
            frame.recycle()
            continuation.resume(null)
          }
        }, Handler(Looper.getMainLooper()))
      } catch (_: IllegalArgumentException) {
        frame.recycle()
        continuation.resume(null)
      }
    }
  }
}
