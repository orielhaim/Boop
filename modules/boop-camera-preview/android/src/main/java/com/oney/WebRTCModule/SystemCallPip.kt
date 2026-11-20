
package com.oney.WebRTCModule

import android.app.Activity
import android.app.PictureInPictureParams
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Rect
import android.util.Rational
import android.view.ViewGroup
import java.lang.ref.WeakReference

object SystemCallPip {
  internal var newView: ((Activity) -> BoopCameraPreviewView)? = null
  internal var stream: String? = null
  private var host: WeakReference<Activity>? = null
  private var view: BoopCameraPreviewView? = null
  private var pipCallId: String? = null

  private fun supported(activity: Activity) =
    activity.packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)

  private fun eligible() = stream != null &&
    SystemCallSession.current?.let { it.answeredAt > 0 && !it.privateMode } == true

  private fun params(activity: Activity): PictureInPictureParams {
    val content = activity.findViewById<ViewGroup>(android.R.id.content)
    val bounds = Rect()
    content?.getGlobalVisibleRect(bounds)
    val ratio = if (bounds.width() >= bounds.height()) Rational(16, 9) else Rational(9, 16)
    return PictureInPictureParams.Builder()
      .setAspectRatio(ratio)
      .apply {
        if (!bounds.isEmpty) setSourceRectHint(bounds)
        setAutoEnterEnabled(eligible())
        setSeamlessResizeEnabled(true)
      }.build()
  }

  internal fun refresh(activity: Activity) {
    if (!supported(activity) || activity.isDestroyed) return
    host = WeakReference(activity)
    runCatching { activity.setPictureInPictureParams(params(activity)) }
    if (activity.isInPictureInPictureMode) {
      if (eligible()) show(activity)
      else leave(activity)
    }
  }

  fun transitioning(activity: Activity) {
    if (eligible()) show(activity)
  }

  fun modeChanged(activity: Activity, active: Boolean) {
    if (active) {
      val id = SystemCallSession.current?.id
      if (id != null && eligible()) {
        show(activity)
        pipCallId = id
        SystemCallSession.emit("pip-enter", id)
      } else leave(activity)
    } else {
      hide()
      val id = pipCallId ?: return
      pipCallId = null
      // A stopped Activity is being hidden/closed. An expanded PiP can resume
      // the same Activity, with the controller and its navigation untouched.
      activity.window.decorView.post {
        val kind = if (activity.isFinishing || activity.isDestroyed) "pip-close" else "pip-exit"
        SystemCallSession.emit(kind, id)
      }
    }
  }

  private fun show(activity: Activity) {
    val url = stream ?: return
    val existing = view
    if (existing != null) {
      existing.setStream(url)
      return
    }
    val content = activity.findViewById<ViewGroup>(android.R.id.content) ?: return
    val remote = newView?.invoke(activity) ?: return
    remote.setBackgroundColor(Color.BLACK)
    remote.importantForAccessibility = android.view.View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    remote.isForceDarkAllowed = false
    remote.setStream(url)
    // Keep the React root and the call controller mounted. The opaque native
    // view draws over the entire app and binds only the authorized remote track.
    content.addView(remote, ViewGroup.LayoutParams(-1, -1))
    view = remote
  }

  private fun hide() {
    val remote = view ?: return
    view = null
    remote.setStream(null)
    (remote.parent as? ViewGroup)?.removeView(remote)
  }

  private fun leave(activity: Activity) {
    // Android has no public API to dismiss PiP without restoring full screen.
    // Finishing this Activity removes its window; the process and FGS remain.
    if (!activity.isFinishing) activity.finish()
  }

  internal fun detach() {
    hide()
    val id = pipCallId
    pipCallId = null
    if (id != null) SystemCallSession.emit("pip-close", id)
    host = null
  }

  internal fun clear() {
    stream = null
    host?.get()?.let(::refresh)
  }
}
