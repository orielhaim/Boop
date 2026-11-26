package dev.liquidglass.engine

import android.content.Context
import android.graphics.Canvas
import android.graphics.RenderNode
import android.os.Build
import android.view.View
import android.view.WindowManager
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView
import java.lang.ref.WeakReference
import java.util.WeakHashMap

internal fun View.allowsGlass(appContext: AppContext): Boolean {
  val activity = appContext.currentActivity ?: return false
  val windowFlags = activity.window.attributes.flags
  val rootFlags = (rootView.layoutParams as? WindowManager.LayoutParams)?.flags ?: 0
  return isAttachedToWindow && isShown && windowVisibility == View.VISIBLE &&
    (windowFlags or rootFlags) and WindowManager.LayoutParams.FLAG_SECURE == 0
}

internal class GlassBackdropView(context: Context, private val modules: AppContext) :
  ExpoView(context, modules) {
  var sourceId: String? = null
    set(value) {
      if (value == field) return
      unregister()
      field = value
      if (isAttachedToWindow) register()
      invalidate()
    }
  private var sourceRoot: View? = null
  internal val recording = if (Build.VERSION.SDK_INT >= 33) RenderNode("Glass source") else null
  private val consumers = LinkedHashSet<GlassOpticsView>()

  fun acquire(consumer: GlassOpticsView) {
    if (consumers.add(consumer) && consumers.size == 1) invalidate()
  }

  fun release(consumer: GlassOpticsView) {
    if (consumers.remove(consumer) && consumers.isEmpty()) {
      // Remove the discarded node from this view's own display list, too.
      recording?.discardDisplayList()
      invalidate()
    }
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) = Unit

  private fun register() {
    val id = sourceId ?: return
    val root = rootView
    sourceRoot = root
    val peers = sources.getOrPut(root) { HashMap() }.getOrPut(id) { ArrayList() }
    peers.add(WeakReference(this))
  }

  private fun unregister() {
    val root = sourceRoot ?: return
    sourceRoot = null
    val index = sources[root] ?: return
    val peers = index[sourceId] ?: return
    peers.removeAll { val peer = it.get(); peer == null || peer === this }
    if (peers.isEmpty()) index.remove(sourceId)
    if (index.isEmpty()) sources.remove(root)
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    register()
  }

  override fun dispatchDraw(canvas: Canvas) {
    val node = recording
    if (node == null || !canvas.isHardwareAccelerated || width <= 0 || height <= 0 ||
        consumers.isEmpty() || !allowsGlass(modules)) {
      node?.discardDisplayList()
      super.dispatchDraw(canvas)
      return
    }

    node.setPosition(0, 0, width, height)
    val target = node.beginRecording()
    try {
      // The view background is otherwise drawn outside dispatchDraw.
      background?.draw(target)
      super.dispatchDraw(target)
    } finally {
      node.endRecording()
    }
    super.dispatchDraw(canvas)
    val save = canvas.save()
    canvas.clipRect(0, 0, 0, 0)
    canvas.drawRenderNode(node)
    canvas.restoreToCount(save)
    for (consumer in consumers) consumer.sourceRecorded()
  }

  override fun onDetachedFromWindow() {
    unregister()
    recording?.discardDisplayList()
    for (consumer in consumers) consumer.sourceRecorded()
    consumers.clear()
    super.onDetachedFromWindow()
  }
}

internal fun View.backdropInWindow(id: String): GlassBackdropView? {
  val candidates = sources[rootView]?.get(id) ?: return null
  var match: GlassBackdropView? = null
  for (entry in candidates) {
    val candidate = entry.get() ?: continue
    if (match != null) return null
    match = candidate
  }
  val backdrop = match ?: return null
  val outerSource = closestBackdropAncestor()
  if (outerSource == null) return backdrop

  // A consumer inside a recording may read a separate, strictly deeper
  // recording in that scope. Requiring downward dependencies prevents cycles.
  var ancestor = backdrop.parent
  while (ancestor is View) {
    if (ancestor === outerSource) return backdrop
    ancestor = ancestor.parent
  }
  return null
}

private fun View.closestBackdropAncestor(): GlassBackdropView? {
  var ancestor = parent
  while (ancestor is View) {
    if (ancestor is GlassBackdropView) return ancestor
    ancestor = ancestor.parent
  }
  return null
}

private val sources = WeakHashMap<View, MutableMap<String, MutableList<WeakReference<GlassBackdropView>>>>()
