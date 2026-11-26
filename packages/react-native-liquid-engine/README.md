# React Native Liquid Glass Engine

Render optical materials over normal React Native content. Applications control the source, shape, material, and motion. Keep buttons, text, and gesture targets in native views above the renderer.

## Install

The current package lives in a Bun workspace. For an external app, copy the package or install its tarball with `bun add ./react-native-liquid-engine-0.1.0.tgz`. The package exports TypeScript for Metro. It requires React Native's New Architecture, Expo Modules, Expo Glass Effect, Reanimated, and Worklets. In an Expo app, install the compatible peers and rebuild the development client. A bare React Native app must install and configure Expo Modules and its autolinker. A bare build has not been exercised.

The root import only uses native Android and system iOS rendering. The `/skia` entry point additionally requires React Native Skia. The `/playground` entry point requires Skia and Gesture Handler 3.

## Render a lens

```tsx
import { View, Text, StyleSheet } from "react-native";
import {
  useDerivedValue,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import {
  GlassBackdrop,
  GlassProvider,
  GlassRenderer,
  glassMaterials,
  type GlassScene,
} from "react-native-liquid-engine";

export function Example() {
  const x = useSharedValue(22);
  const scene = useDerivedValue<GlassScene>(() => ({
    shapes: [
      { x: x.get(), y: 36, width: 104, height: 54, radius: 27 },
      { x: 130, y: 36, width: 92, height: 54, radius: 27 },
    ],
    mergeSmoothness: 28,
    light: { x: x.get(), y: 16 },
  }));
  return (
    <GlassProvider>
      <View style={{ height: 136 }}>
        <GlassBackdrop style={StyleSheet.absoluteFill}>
          <View style={{ flex: 1, backgroundColor: "#284169" }} />
        </GlassBackdrop>
        <GlassRenderer
          scene={scene}
          shapeCount={2}
          material={glassMaterials.lens}
          style={StyleSheet.absoluteFill}
        />
        <Text accessibilityRole="button" onPress={() => x.set(withSpring(42))}>
          Move lens
        </Text>
      </View>
    </GlassProvider>
  );
}
```

## API

| Export                                                         | Role                                                                                                                                                                                                                                       |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GlassProvider`                                                | Owns one backdrop source. Use sibling or nested providers for independent sources. Set `active` from route focus, account authorization, and app-specific capture policy. An inactive parent disables nested scopes.                       |
| `GlassBackdrop`                                                | Wraps the content to sample. Put it behind the renderer in the same window, outside the renderer's subtree.                                                                                                                                |
| `GlassRenderer`                                                | Draws a scene from a Reanimated shared or derived value. Use `enabled={false}` for an opaque fallback. `shapeCount` sets the number of shape slots for iOS and the JavaScript fallback.                                                    |
| `GlassContentLens`                                             | Refracts its React Native children in place using a scene in local coordinates. It preserves native input and accessibility. Android applies displacement and channel separation through HWUI. Other platforms draw the children normally. |
| `GlassSurface`                                                 | Sizes a single glass shape to a laid-out native view and renders native children above it.                                                                                                                                                 |
| `GlassScene`, `GlassShape`, `GlassLight`                       | Describe scene-local geometry, up to two lights, and optional animatable material overrides.                                                                                                                                               |
| `glassMaterials`, `resolveGlassMaterial`                       | Presets and custom material defaults. A material object can override any numeric control or tint.                                                                                                                                          |
| `interpolateGlassMaterial`, `stretchGlassShape`, `smoothUnion` | Worklet-safe operations for interpolation, gesture deformation, and distance fields.                                                                                                                                                       |
| `getGlassCapabilities`                                         | Reports the default backend available on the current build. Secure-window checks run at draw time.                                                                                                                                         |
| `SkiaGlass` from `/skia`                                       | Runs the shared optical shader on a consumer-owned, authorized Skia image. Optionally supply SkSL with the same uniform layout.                                                                                                            |
| `GlassPlayground` from `/playground`                           | A standalone tuning screen. Mount under `GestureHandlerRootView` in a native development client.                                                                                                                                           |

### Materials and geometry

Use `GlassContentLens` around content that should bend under a moving lens, such as tab labels and icons. Set `matteColor` to the color directly behind transparent artwork to blend chromatic edges. Content refraction uses the material’s refraction strength, depth, thickness, magnification, chromatic aberration, and opacity. Pair it with a separate `GlassRenderer` when the surface also needs backdrop refraction or lighting. An empty scene, a protected window, or `enabled={false}` removes the content effect.

Use `clear`, `regular`, `frosted`, `thick`, `tinted`, `lens`, `liquid`, or `opaque` as a starting point. To animate material properties, write `scene.material` from a worklet. The optical backends mix tint and backdrop color, bend the backdrop along the surface normal, offset color channels, and add lighting and grain. Opacity controls output alpha. Use the renderer's disabled state when you require a fully opaque fallback independent of the source and material.

Shapes have a top-left origin in layout points. Rotation is in radians around the shape center. Set an ellipse with `kind: "ellipse"`, a capsule with a radius equal to half the smaller dimension, or four clockwise corner radii. The continuous profile uses an approximate superellipse corner. The optical backends shade up to eight shapes as a single field. The refraction, shadows, and highlights follow the normal of that combined field. Set a shape's `material` to override individual optical properties. The smooth-union weights blend those properties across each join.

`mergeSmoothness` is a smoothing radius in points. For two mirrored contours, a gap smaller than half the radius can close. Larger values also soften the neck. Animating shape size, pose, radius, material and light from one derived value keeps them aligned. The two optical backends share the shader source. Android clamps lengths, light intensity and color controls at the renderer boundary.

## Backend and resource ownership

| Backend           | Source                                                                                                                                               | Limits                                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Android API 33+   | Explicit named source with shared HWUI display lists. The renderer replays the source into one bounded region per scene.                             | SurfaceView, separate windows, and recursive sources cannot supply pixels. Blur uses a small sampled kernel.               |
| Android API 37.2+ | Request `backdrop="window"` to use RenderNode's public backdrop effect. Android falls back to the explicit named source when the API is unavailable. | Samples the composited content behind the renderer in its own window. This path requires validation on SDK 37.2 hardware.  |
| iOS 26+           | UIKit Liquid Glass via Expo Glass Effect and its glass container.                                                                                    | UIKit owns optics, shape merging, and reflection behavior. Use the Skia entry point for custom shader controls.            |
| Skia              | An authorized image or shared-device texture provided by the caller.                                                                                 | The caller owns acquisition, synchronization, and lifetime. There is no live arbitrary UIKit view capture in this backend. |
| Opaque            | Layout geometry with a solid fill.                                                                                                                   | Opaque rendering uses ordinary rounded shapes.                                                                             |

The Android source records only while it has a consumer. Source and consumer must be attached to the same window. A renderer inside a backdrop can sample a separate source nested inside that same backdrop. This keeps capture dependencies moving down the view tree and prevents cycles. Protected windows use the opaque fallback. Source recordings are discarded when the last consumer detaches or disables sampling. No production renderer writes an image to disk or reads a backdrop through the CPU. Reanimated supplies geometry and material changes directly. Content and position changes trigger display-list updates without a package-owned continuous frame loop.

For Skia texture sharing, use the device returned by `importDevice(Skia.getNativeDevice())` and a texture with `TEXTURE_BINDING`. Wrap it with `Skia.Image.MakeFromGPUTexture()`. Submit texture writes before the draw that reads them and keep the texture alive while the image is rendered. Destroying the imported device also destroys Skia's device. Callers must invalidate the image or texture when its source or authorization changes.

## Implementation references

The Android path uses HWUI for native view content and regional GPU shading. The WebGPU route would require a separate view rasterization, asynchronous render submission, and shared-device synchronization for each updated region. Both installed versions expose the requested APIs (WebGPU 0.26.0 and Skia 3.13.1). On Android, WebGPU can import a hardware buffer but has a fallback which reads pixels. The Apple path can rasterize UIKit into a CPU-backed IOSurface. For those reasons, the production dock does not drive backdrop capture through WebGPU. The Skia path is used for explicitly supplied imagery.

- [Expo Android Glass View 2.0 display-list source, regional alignment and invalidation](https://github.com/kagantemizkan/expo-android-glass-view/blob/7e3a038643cb646e71ced06f279dd2f20bd67ecb/android/src/main/java/expo/modules/androidglassview/GlassBackdropSource.kt)
- [AndroidLiquidGlass backdrop transform and layered effects](https://github.com/Kyant0/AndroidLiquidGlass/blob/eb4a0ea2e17542ea28c2e71088f7dd9acf77aad5/backdrop/src/commonMain/kotlin/com/kyant/backdrop/DrawBackdropModifier.kt)
- [LiquidGlass recorder and consumer lifetime](https://github.com/Abdullajon1881/LiquidGlass/blob/72ad05c49628ea2270116b2943629cd81c0cc496/liquidglass-view/src/main/kotlin/dev/liquidglass/view/BackdropRecorder.kt)
- [Liquid Glass Android capture recursion and window fallbacks](https://github.com/QWEA0/Liquid-Glass-Android/blob/ea7908990247c56d6a9635e89ed36cb022434508/liquidglass/src/main/java/com/example/liquidglass/BackdropCapture.kt)
- [Expandable Bottom Tabs geometry and expansion](https://github.com/rit3zh/expandable-bottom-tabs/tree/4c57f1c2ff7ebd513ac058553b76774759a7a241/src/components/expandable-tab-bar)
- [Expo Liquid Lens frame scheduling and resource teardown](https://github.com/rit3zh/expo-liquid-lens/blob/1fc634c2bb1c8d97daef763b7f9d8fc510fd2756/src/hooks/use-lens-engine.ts)
- [React Native WebGPU queue interop](https://github.com/wcandillon/react-native-webgpu/blob/eea2f3cd03afb8331d7dc013d6c4d3792a170af0/packages/webgpu/cpp/rnwgpu/api/GPUQueue.cpp)
- [React Native Skia texture ownership](https://github.com/wcandillon/react-native-skia/blob/13bdf30cb2600d750340c2b6f39d45911377e6e7/packages/skia/cpp/api/JsiSkImageFactory.h)

## Verify changes

Run `bun test ./tests` from the package folder. From Boop's Android folder, run `./gradlew :react-native-liquid-engine:connectedDebugAndroidTest` with a local Android target. The native tests compile the generated AGSL and compare actual HWUI pixels for refraction and smooth merging.

Use the playground for scrolling, an animated backdrop, light and dark palettes, material transitions, and eight intersecting shapes. Its FPS readout counts UI frame callbacks and is useful for comparisons on the same device. It does not measure GPU time. Profile a release build with HWUI frame statistics and Perfetto before tuning production limits. Keep device refresh rate, source content, animation, brightness, and interaction count constant when comparing backends. Record frame distribution, GPU duration, memory and idle overhead. No physical-device release measurements are included.

The [WebGPU probe](examples/webgpu-probe.tsx) is a standalone example for an app with WebGPU and Skia. It captures a fixed synthetic region once on request, imports the result into Skia, and reports the interval to texture submission and queue completion. Supply the host's capture authorization and route state through `captureAllowed`. This probe measures the snapshot path and does not participate in production backdrop rendering.

## Contributing

Keep platform-independent geometry and material operations usable from a worklet. Preserve the shader uniform contract across Android and Skia when editing the shared shader. Add a test that checks the affected output. Keep OS permission, route, and account policy in the caller and carry the authorization into both capture and draw. Document any new platform differences in the backend table.
