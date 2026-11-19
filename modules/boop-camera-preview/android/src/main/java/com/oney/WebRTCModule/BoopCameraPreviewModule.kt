package com.oney.WebRTCModule

import android.content.Context
import android.graphics.Outline
import android.graphics.SurfaceTexture
import android.view.TextureView
import android.view.View
import android.view.ViewOutlineProvider
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import com.facebook.react.bridge.ReactContext
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.views.ExpoView
import org.webrtc.EglBase
import org.webrtc.EglRenderer
import org.webrtc.GlRectDrawer
import org.webrtc.VideoTrack

class BoopCameraPreviewModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("BoopCameraPreview")
    View(BoopCameraPreviewView::class) {
      Prop("streamURL") { view: BoopCameraPreviewView, url: String? -> view.setStream(url) }
      Prop("mirror") { view: BoopCameraPreviewView, mirror: Boolean -> view.setMirror(mirror) }
    }
  }
}

// RTCView uses SurfaceView on Android. The PiP uses the same WebRTC track and EGL
// context in a TextureView so Android can clip the rendered pixels to the outline.
class BoopCameraPreviewView(context: Context, appContext: AppContext, rounded: Boolean = true) :
  ExpoView(context, appContext), TextureView.SurfaceTextureListener {
  override val shouldUseAndroidLayout = true
  private val texture = TextureView(context)
  private var renderer: EglRenderer? = null
  private var streamURL: String? = null
  private var mirrored = false

  @Volatile private var binding = 0
  private var attachedTrack: VideoTrack? = null
  private var attachedRenderer: EglRenderer? = null

  init {
    texture.surfaceTextureListener = this
    texture.outlineProvider = object : ViewOutlineProvider() {
      override fun getOutline(view: View, outline: Outline) {
        outline.setRoundRect(0, 0, view.width, view.height, 22 * resources.displayMetrics.density)
      }
    }
    texture.clipToOutline = rounded
    addView(texture, MATCH_PARENT, MATCH_PARENT)
  }

  fun setStream(url: String?) {
    if (streamURL == url) return
    streamURL = url
    renderer?.clearImage()
    bind()
  }

  fun setMirror(mirror: Boolean) {
    mirrored = mirror
    renderer?.setMirror(mirror)
  }

  private fun bind() {
    val revision = ++binding
    val target = renderer
    val url = streamURL
    val module = (appContext.reactContext as? ReactContext)?.getNativeModule(WebRTCModule::class.java)
    ThreadUtils.runOnExecutor {
      if (revision != binding) return@runOnExecutor
      val track: VideoTrack? = if (target != null && url != null) {
        module?.getStreamForReactTag(url)?.videoTracks?.firstOrNull()
      } else null

      val oldTrack = attachedTrack
      val oldRenderer = attachedRenderer
      attachedTrack = null
      attachedRenderer = null
      if (oldTrack != null && oldRenderer != null) {
        try {
          oldTrack.removeSink(oldRenderer)
        } catch (_: IllegalStateException) {
          // Stream teardown may already have disposed the native track.
        }
      }
      if (track != null && target != null) {
        track.addSink(target)
        attachedTrack = track
        attachedRenderer = target
      }
    }
  }

  override fun onSurfaceTextureAvailable(surface: SurfaceTexture, width: Int, height: Int) {
    val egl = EglUtils.getRootEglBaseContext() ?: return
    val viewRenderer = EglRenderer("BoopCameraPreview")
    viewRenderer.init(egl, EglBase.CONFIG_PLAIN, GlRectDrawer())
    viewRenderer.setMirror(mirrored)
    renderer = viewRenderer
    onSurfaceTextureSizeChanged(surface, width, height)
    viewRenderer.createEglSurface(surface)
    bind()
  }

  override fun onSurfaceTextureSizeChanged(surface: SurfaceTexture, width: Int, height: Int) {
    if (width > 0 && height > 0) renderer?.setLayoutAspectRatio(width.toFloat() / height)
  }

  override fun onSurfaceTextureDestroyed(surface: SurfaceTexture): Boolean {
    val previous = renderer
    renderer = null
    bind()
    previous?.release()
    return true
  }

  override fun onSurfaceTextureUpdated(surface: SurfaceTexture) = Unit
}
