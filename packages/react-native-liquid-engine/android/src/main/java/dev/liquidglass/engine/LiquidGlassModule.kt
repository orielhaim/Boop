package dev.liquidglass.engine

import android.graphics.Color
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class LiquidGlassModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LiquidGlassEngine")

    Constant("supportsRecordedBackdrop") { Build.VERSION.SDK_INT >= 33 }

    View(GlassBackdropView::class) {
      Name("GlassBackdropView")
      Prop("sourceId") { view: GlassBackdropView, sourceId: String? ->
        view.sourceId = sourceId
      }
    }

    View(GlassOpticsView::class) {
      Name("GlassOpticsView")
      Prop("sourceId") { view: GlassOpticsView, sourceId: String? -> view.sourceId = sourceId }
      Prop("captureEnabled", true) { view: GlassOpticsView, enabled: Boolean -> view.captureEnabled = enabled }
      Prop("sampleWindow", false) { view: GlassOpticsView, sample: Boolean -> view.sampleWindow = sample }
      Prop("refractContent", false) { view: GlassOpticsView, refract: Boolean -> view.refractContent = refract }
      Prop("geometry") { view: GlassOpticsView, values: List<Double> -> view.setGeometry(values) }
      Prop("optics") { view: GlassOpticsView, values: List<Double> -> view.setOptics(values) }
      Prop("opaqueColor") { view: GlassOpticsView, color: Int? -> view.fallbackColor = color ?: Color.DKGRAY }
      OnViewDidUpdateProps { view: GlassOpticsView -> view.commit() }
    }
  }
}
