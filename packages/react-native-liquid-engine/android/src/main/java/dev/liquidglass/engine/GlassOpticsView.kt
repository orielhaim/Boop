package dev.liquidglass.engine

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.RenderEffect
import android.graphics.RenderNode
import android.graphics.RuntimeShader
import android.os.Build
import android.util.Log
import android.view.ViewTreeObserver
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

private const val MaxShapes = 8
private const val SceneHeader = 7
private const val ShapeStride = 10
private const val MaterialStride = 22
private const val MaterialUniforms = 24
private const val EngineTag = "LiquidGlassEngine"

internal class GlassOpticsView(context: Context, private val modules: AppContext) :
  ExpoView(context, modules) {
  var sourceId: String? = null
  var captureEnabled = true
  var sampleWindow = false
  var refractContent = false
  private var contentEffectActive = false
  var fallbackColor = Color.rgb(32, 34, 40)

  private val density = resources.displayMetrics.density
  private val effectNode = if (Build.VERSION.SDK_INT >= 33) RenderNode("Glass region") else null
  private val platformBackdrop = if (Build.VERSION.SDK_INT >= 33) runCatching {
    RenderNode::class.java.getMethod("setBackdropRenderEffect", RenderEffect::class.java)
  }.getOrNull() else null
  private val optics by lazy(LazyThreadSafetyMode.NONE) {
    runCatching { RuntimeShader(shaderSource(context)) }.onFailure {
      Log.w(EngineTag, "Unable to compile glass shader", it)
    }.getOrNull()
  }
  private val fallbackPaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val path = Path()
  private val cornerRadii = FloatArray(8)
  private val shapeRect = RectF()
  private val sampleBounds = Rect()
  private val previousBounds = Rect()
  private val sourceToRenderer = Matrix()
  private val nextTransform = Matrix()
  private val rendererToGlobal = Matrix()
  private val globalToRenderer = Matrix()
  private val rectUniform = FloatArray(MaxShapes * 4)
  private val cornerUniform = FloatArray(MaxShapes * 4)
  private val transformUniform = FloatArray(MaxShapes * 4)
  private val shapeMaterials = FloatArray(MaxShapes * MaterialUniforms)
  private val baseMaterial = FloatArray(MaterialUniforms)
  private val materialUniform = FloatArray(4)

  private var source: GlassBackdropView? = null
  private var effectDirty = true
  private var lastFallback = 0
  private var previousWindowMode = false
  private var useWindow = false
  private var failed = false
  private var scene = FloatArray(SceneHeader)
  private var material = FloatArray(MaterialStride)
  private var observer: ViewTreeObserver? = null

  init {
    setWillNotDraw(false)
  }

  fun setGeometry(value: List<Double>) {
    if (value.size < SceneHeader || value.size > SceneHeader + MaxShapes * ShapeStride ||
        (value.size - SceneHeader) % ShapeStride != 0) return
    scene = FloatArray(value.size) { value[it].finiteFloat(0f) }
    effectDirty = true
    invalidate()
  }

  fun setOptics(value: List<Double>) {
    if (value.size < MaterialStride || value.size > MaterialStride * (MaxShapes + 1) ||
        value.size % MaterialStride != 0) return
    material = FloatArray(value.size) { value[it].finiteFloat(0f) }
    effectDirty = true
    invalidate()
  }

  private val preDraw = ViewTreeObserver.OnPreDrawListener {
    updateSource()
    true
  }

  fun sourceRecorded() {
    invalidate()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    observer = viewTreeObserver
    observer?.addOnPreDrawListener(preDraw)
  }

  override fun onDetachedFromWindow() {
    observer?.takeIf { it.isAlive }?.removeOnPreDrawListener(preDraw)
    observer = null
    bindSource(null)
    clearContentEffect()
    forgetRegion()
    super.onDetachedFromWindow()
  }

  override fun onWindowVisibilityChanged(visibility: Int) {
    super.onWindowVisibilityChanged(visibility)
    if (visibility != VISIBLE) {
      useWindow = false
      clearContentEffect()
      bindSource(null)
      forgetRegion()
    } else {
      invalidate()
    }
  }

  fun commit() {
    effectDirty = true
    updateSource()
    invalidate()
  }

  private fun forgetRegion() {
    effectNode?.setRenderEffect(null)
    if (previousWindowMode) runCatching { platformBackdrop?.invoke(effectNode, null) }
    effectNode?.discardDisplayList()
    previousWindowMode = false
    previousBounds.setEmpty()
  }

  private fun bindSource(next: GlassBackdropView?) {
    if (source === next) return
    source?.release(this)
    source = next
    source?.acquire(this)
    forgetRegion()
    invalidate()
  }

  private fun updateSource() {
    val allowed = captureEnabled && effectNode != null && !failed && allowsGlass(modules)
    if (refractContent) {
      bindSource(null)
      val count = (scene.size - SceneHeader) / ShapeStride
      val shader = if (allowed) optics else null
      if (shader == null || count == 0) {
        clearContentEffect()
      } else if (effectDirty || !contentEffectActive) {
        try {
          setRenderEffect(makeEffect(shader, count, 0, 0))
          contentEffectActive = true
          effectDirty = false
        } catch (error: Exception) {
          Log.w(EngineTag, "Unable to refract glass content", error)
          failed = true
          clearContentEffect()
        }
      }
      return
    }
    clearContentEffect()
    val window = allowed && sampleWindow && platformBackdrop != null
    if (useWindow != window) {
      useWindow = window
      forgetRegion()
      effectDirty = true
      invalidate()
    }
    val id = sourceId
    if (!allowed || window || id == null) {
      bindSource(null)
      return
    }

    val candidate = backdropInWindow(id)?.takeIf { it.allowsGlass(modules) }
    bindSource(candidate)
    if (candidate == null) return

    rendererToGlobal.reset()
    transformMatrixToGlobal(rendererToGlobal)
    if (!rendererToGlobal.invert(globalToRenderer)) {
      bindSource(null)
      return
    }
    nextTransform.reset()
    candidate.transformMatrixToGlobal(nextTransform)
    nextTransform.postConcat(globalToRenderer)
    if (nextTransform != sourceToRenderer) {
      sourceToRenderer.set(nextTransform)
      previousBounds.setEmpty()
      invalidate()
    }
  }

  private fun clearContentEffect() {
    if (!contentEffectActive) return
    setRenderEffect(null)
    contentEffectActive = false
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    if (refractContent) return
    val count = (scene.size - SceneHeader) / ShapeStride
    if (count == 0) return

    val node = effectNode
    val backdrop = source?.recording
    val ready = backdrop?.hasDisplayList() == true
    if (node != null && canvas.isHardwareAccelerated && !failed && captureEnabled &&
        allowsGlass(modules) && (ready || useWindow) && drawOptics(canvas, node, backdrop, count)) return

    drawFallback(canvas, count)
  }

  private fun drawOptics(canvas: Canvas, node: RenderNode, backdrop: RenderNode?, count: Int): Boolean {
    val shader = optics
    if (shader == null) {
      failed = true
      bindSource(null)
      return false
    }
    try {
      var sampleRadius = 18f
      for (i in material.indices step MaterialStride) {
        val radius = material[i].coerceIn(0f, 36f) + abs(material[i + 1]).coerceAtMost(2f) *
          material[i + 3].coerceIn(0f, 36f) * (1 + material[i + 4].coerceIn(0f, 0.6f)) +
          abs(material[i + 5]).coerceAtMost(1f) * material[i + 2].coerceIn(0f, 80f)
        sampleRadius = max(sampleRadius, radius)
      }
      val padding = density * (sampleRadius + scene[0].coerceIn(0f, 80f) * 0.25f)
      sampleBounds.setEmpty()
      for (index in 0 until count) {
        val n = SceneHeader + index * ShapeStride
        val halfWidth = scene[n + 2].coerceAtLeast(0f) * density / 2
        val halfHeight = scene[n + 3].coerceAtLeast(0f) * density / 2
        val angle = scene[n + 8]
        val centerX = scene[n] * density + halfWidth
        val centerY = scene[n + 1] * density + halfHeight
        val c = cos(angle)
        val s = sin(angle)
        val boundX = abs(c) * halfWidth + abs(s) * halfHeight + padding
        val boundY = abs(s) * halfWidth + abs(c) * halfHeight + padding
        sampleBounds.union(floor(centerX - boundX).toInt(), floor(centerY - boundY).toInt(),
          ceil(centerX + boundX).toInt(), ceil(centerY + boundY).toInt())
      }
      if (!sampleBounds.intersect(-padding.toInt(), -padding.toInt(),
          width + padding.toInt(), height + padding.toInt())) return true

      if (sampleBounds != previousBounds || !node.hasDisplayList() || lastFallback != fallbackColor) {
        node.setPosition(sampleBounds.left, sampleBounds.top, sampleBounds.right, sampleBounds.bottom)
        val recording = node.beginRecording()
        try {
          if (useWindow) {
            // A transparent node supplies bounds for the platform backdrop effect.
            recording.drawColor(Color.TRANSPARENT)
          } else {
            recording.drawColor(fallbackColor)
            recording.translate(-sampleBounds.left.toFloat(), -sampleBounds.top.toFloat())
            recording.concat(sourceToRenderer)
            if (backdrop != null) recording.drawRenderNode(backdrop)
          }
        } finally {
          node.endRecording()
        }
        previousBounds.set(sampleBounds)
        lastFallback = fallbackColor
        effectDirty = true
      }

      if (effectDirty) {
        val effect = makeEffect(shader, count, sampleBounds.left, sampleBounds.top)
        if (useWindow) {
          platformBackdrop?.invoke(node, effect)
          previousWindowMode = true
        } else {
          node.setRenderEffect(effect)
        }
        effectDirty = false
      }
      canvas.drawRenderNode(node)
      return true
    } catch (error: Exception) {
      Log.w(EngineTag, "Unable to render glass", error)
      failed = true
      bindSource(null)
      forgetRegion()
      return false
    }
  }

  private fun makeEffect(shader: RuntimeShader, count: Int, originX: Int, originY: Int): RenderEffect {
    for (index in 0 until count) {
      val n = SceneHeader + index * ShapeStride
      val halfWidth = scene[n + 2].coerceAtLeast(0f) * density / 2
      val halfHeight = scene[n + 3].coerceAtLeast(0f) * density / 2
      val i = index * 4
      rectUniform[i] = scene[n] * density + halfWidth - originX
      rectUniform[i + 1] = scene[n + 1] * density + halfHeight - originY
      rectUniform[i + 2] = halfWidth
      rectUniform[i + 3] = halfHeight
      for (corner in 0..3) {
        cornerUniform[i + corner] = (scene[n + 4 + corner] * density).coerceIn(0f, min(halfWidth, halfHeight))
      }
      transformUniform[i] = cos(scene[n + 8])
      transformUniform[i + 1] = sin(scene[n + 8])
      transformUniform[i + 2] = scene[n + 9]
    }
    shader.setFloatUniform("shapeRect", rectUniform)
    shader.setFloatUniform("shapeRadii", cornerUniform)
    shader.setFloatUniform("shapeTransform", transformUniform)
    shader.setIntUniform("shapeCount", count)
    shader.setIntUniform("refractContent", if (refractContent) 1 else 0)
    shader.setFloatUniform("mergeRadius", scene[0].coerceIn(0f, 80f) * density)
    applyMaterial(shader, count)
    shader.setFloatUniform("fallback", Color.red(fallbackColor) / 255f,
      Color.green(fallbackColor) / 255f, Color.blue(fallbackColor) / 255f, 1f)
    shader.setFloatUniform("lightA", scene[1] * density - originX,
      scene[2] * density - originY, scene[3].coerceIn(0f, 2f))
    shader.setFloatUniform("lightB", scene[4] * density - originX,
      scene[5] * density - originY, scene[6].coerceIn(0f, 2f))
    return RenderEffect.createRuntimeShaderEffect(shader, "backdrop")
  }

  private fun applyMaterial(shader: RuntimeShader, count: Int) {
    writeMaterial(0, baseMaterial, 0)
    for ((index, name) in MaterialNames.withIndex()) {
      baseMaterial.copyInto(materialUniform, 0, index * 4, index * 4 + 4)
      shader.setFloatUniform(name, materialUniform)
    }
    val varies = material.size == (count + 1) * MaterialStride
    shader.setIntUniform("usesShapeMaterials", if (varies) 1 else 0)
    if (varies) {
      for (i in 0 until count) writeMaterial((i + 1) * MaterialStride, shapeMaterials, i * MaterialUniforms)
      shader.setFloatUniform("shapeMaterials", shapeMaterials)
    }
  }

  private fun writeMaterial(from: Int, to: FloatArray, i: Int) {
    to[i] = material[from].coerceIn(0f, 36f) * density
    to[i + 1] = material[from + 1].coerceIn(-2f, 2f)
    to[i + 2] = material[from + 2].coerceIn(0f, 80f) * density
    to[i + 3] = material[from + 3].coerceIn(0f, 36f) * density
    for (j in 0..2) to[i + 4 + j] = material[from + 6 + j].coerceIn(0f, 3f)
    to[i + 7] = material[from + 9].coerceIn(-1f, 2f)
    to[i + 8] = material[from + 10].unit()
    to[i + 9] = material[from + 11].unit()
    to[i + 10] = material[from + 12].coerceIn(0f, 16f) * density
    to[i + 11] = material[from + 13].unit()
    to[i + 12] = material[from + 14].unit()
    to[i + 13] = material[from + 15].unit()
    to[i + 14] = material[from + 16].unit()
    to[i + 15] = material[from + 4].coerceIn(0f, 0.6f)
    to[i + 16] = material[from + 5].coerceIn(-1f, 1f)
    to[i + 17] = 0.75f
    to[i + 18] = 14f * density
    to[i + 19] = material[from + 17].unit()
    for (j in 0..3) to[i + 20 + j] = material[from + 18 + j].unit()
  }

  private fun drawFallback(canvas: Canvas, count: Int) {
    fallbackPaint.color = fallbackColor or 0xff000000.toInt()
    for (index in 0 until count) {
      val n = SceneHeader + index * ShapeStride
      val x = scene[n] * density
      val y = scene[n + 1] * density
      val w = scene[n + 2] * density
      val h = scene[n + 3] * density
      if (w <= 0 || h <= 0) continue
      shapeRect.set(x, y, x + w, y + h)
      val save = canvas.save()
      canvas.rotate(scene[n + 8] * (180 / Math.PI).toFloat(), x + w / 2, y + h / 2)
      if (scene[n + 9] == 1f) {
        canvas.drawOval(shapeRect, fallbackPaint)
      } else {
        for (corner in 0..3) {
          val r = (scene[n + 4 + corner] * density).coerceIn(0f, min(w, h) / 2)
          cornerRadii[corner * 2] = r
          cornerRadii[corner * 2 + 1] = r
        }
        path.rewind()
        path.addRoundRect(shapeRect, cornerRadii, Path.Direction.CW)
        canvas.drawPath(path, fallbackPaint)
      }
      canvas.restoreToCount(save)
    }
  }
}

private fun Double.finiteFloat(default: Float): Float =
  if (isFinite()) coerceIn(-1_000_000.0, 1_000_000.0).toFloat() else default

private fun Float.unit(): Float = coerceIn(0f, 1f)

private val MaterialNames = listOf("optics", "colorControls", "lighting", "finish", "extras", "tint")

private var cachedShader: String? = null

private fun shaderSource(context: Context): String =
  cachedShader ?: context.assets.open("dev.liquidglass.engine.agsl")
    .bufferedReader().use { it.readText() }.also { cachedShader = it }
