package dev.liquidglass.engine

import android.graphics.Color
import android.graphics.HardwareRenderer
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.RenderEffect
import android.graphics.RenderNode
import android.graphics.RuntimeShader
import android.media.ImageReader
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GlassShaderTest {
  private fun shader(): RuntimeShader {
    val assets = InstrumentationRegistry.getInstrumentation().targetContext.assets
    return assets.open("dev.liquidglass.engine.agsl").bufferedReader().use {
      RuntimeShader(it.readText())
    }
  }

  @Test
  fun platformCompilesTheSharedShaderAndAcceptsItsUniformLayout() {
    val shader = shader()
    shader.setIntUniform("shapeCount", 2)
    shader.setFloatUniform("mergeRadius", 24f)
    shader.setFloatUniform("shapeRect", FloatArray(32))
    shader.setFloatUniform("shapeRadii", FloatArray(32))
    shader.setFloatUniform("shapeTransform", FloatArray(32))
    for (uniform in listOf("optics", "colorControls", "lighting", "finish", "extras", "tint", "fallback")) {
      shader.setFloatUniform(uniform, 1f, 1f, 1f, 1f)
    }
    shader.setFloatUniform("lightA", 12f, 4f, 1f)
    shader.setFloatUniform("lightB", 20f, 8f, 0.5f)
    RenderEffect.createRuntimeShaderEffect(shader, "backdrop")
  }

  @Test
  fun coherentUnionFillsTheGapAndBendsTheLiveBackdrop() {
    val split = render(0f, 0f)
    val merged = render(32f, 0f)
    val refracted = render(32f, 2f)
    assertTrue("Separated gap should be transparent", split[0][3] < 8)
    assertTrue("Smooth union should close the gap", merged[0][3] > 200)
    assertNotEquals("Refraction should shift sampling at the edge", merged[1][0], refracted[1][0])
  }

  @Test
  fun joinedShapesBlendTheirMaterialsThroughTheBridge() {
    val pixels = render(32f, 0f, varied = true)
    val center = pixels[0]
    val left = pixels[1]
    assertTrue("The left lens retains its own tint", left[0] > 210 && left[2] < 20)
    assertTrue("Red and blue materials both contribute to the join", center[0] > 90 && center[2] > 90)
    assertTrue("Near equal distance produces near equal tint weights", kotlin.math.abs(center[0] - center[2]) <= 12)
  }

  @Test
  fun contentLensDispersesBlackArtworkWithoutPaintingOverTransparentPixels() {
    val original = render(0f, 0f, content = true)
    val refracted = render(0f, 2f, content = true)
    assertEquals(listOf(0, 0, 0, 255), refracted[5])
    assertEquals(listOf(0, 0, 0, 0), refracted[90])
    assertTrue("Ink should shift inside the lens", original[14] != refracted[14])
    assertTrue("Separated coverage should produce a colored fringe", refracted.any {
      it[3] > 0 && (it[0] != it[1] || it[0] != it[2])
    })
  }

  private fun render(
    merge: Float,
    strength: Float,
    varied: Boolean = false,
    content: Boolean = false,
  ): List<List<Int>> {
    val size = 96
    val renderer = HardwareRenderer()
    val source = RenderNode("Test stripes")
    val output = RenderNode("Test optical layer")
    try {
      ImageReader.newInstance(size, size, PixelFormat.RGBA_8888, 2).use { reader ->
        source.setPosition(0, 0, size, size)
        val contentCanvas = source.beginRecording()
        val paint = Paint()
        if (content) {
          paint.color = Color.BLACK
          contentCanvas.drawRect(4f, 30f, 8f, 66f, paint)
          contentCanvas.drawRect(18f, 30f, 24f, 66f, paint)
        } else {
          for (x in 0 until size) {
            paint.color = Color.rgb(x * 2, 80, 215 - x)
            contentCanvas.drawRect(x.toFloat(), 0f, x + 1f, size.toFloat(), paint)
          }
        }
        source.endRecording()

        val shader = shader()
        val rects = FloatArray(32)
        floatArrayOf(30f, 48f, 16f, 16f, 66f, 48f, 16f, 16f).copyInto(rects)
        val transforms = FloatArray(32)
        transforms[0] = 1f
        transforms[4] = 1f
        shader.setIntUniform("shapeCount", 2)
        shader.setFloatUniform("shapeRect", rects)
        shader.setFloatUniform("shapeRadii", FloatArray(32) { 16f })
        shader.setFloatUniform("shapeTransform", transforms)
        shader.setFloatUniform("mergeRadius", merge)
        shader.setFloatUniform("optics", 0f, strength, 12f, 6f)
        shader.setFloatUniform("colorControls", 1f, 1f, 1f, 0f)
        shader.setFloatUniform("lighting", 0f, 0f, 0f, 0f)
        shader.setFloatUniform("finish", 0f, 0f, 0f, if (content) 0.45f else 0f)
        shader.setFloatUniform("extras", 0f, 0.75f, 14f, 1f)
        shader.setFloatUniform("tint", 0f, 0f, 0f, 0f)
        val matte = if (content) 1f else 0f
        shader.setFloatUniform("fallback", matte, matte, matte, 1f)
        shader.setIntUniform("refractContent", if (content) 1 else 0)
        shader.setFloatUniform("lightA", 0f, 0f, 0f)
        shader.setFloatUniform("lightB", 0f, 0f, 0f)
        shader.setIntUniform("usesShapeMaterials", if (varied) 1 else 0)
        if (varied) {
          val materials = FloatArray(192)
          for (offset in listOf(0, 24)) {
            floatArrayOf(0f, strength, 12f, 6f, 1f, 1f, 1f, 0f).copyInto(materials, offset)
            floatArrayOf(0f, 0.75f, 14f, 1f).copyInto(materials, offset + 16)
            materials[offset + 23] = 1f
          }
          materials[20] = 1f
          materials[46] = 1f
          shader.setFloatUniform("shapeMaterials", materials)
        }

        output.setPosition(0, 0, size, size)
        output.beginRecording().drawRenderNode(source)
        output.endRecording()
        output.setRenderEffect(RenderEffect.createRuntimeShaderEffect(shader, "backdrop"))
        renderer.isOpaque = false
        renderer.setSurface(reader.surface)
        renderer.setContentRoot(output)
        renderer.createRenderRequest().setWaitForPresent(true).syncAndDraw()
        val image = checkNotNull(reader.acquireNextImage())
        image.use {
          val plane = image.planes.first()
          val points = if (content) (0 until size).map { it to 48 } else listOf(48 to 48, 16 to 48)
          return points.map { (x, y) ->
            val offset = y * plane.rowStride + x * plane.pixelStride
            (0..3).map { channel -> plane.buffer.get(offset + channel).toInt() and 0xff }
          }
        }
      }
    } finally {
      renderer.destroy()
      output.discardDisplayList()
      source.discardDisplayList()
    }
  }
}
