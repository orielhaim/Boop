import { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import {
  Canvas,
  Fill,
  ImageShader,
  Shader,
  Skia,
  type SkImage,
  type SkRect,
  type Uniforms,
} from "react-native-skia";
import { useDerivedValue } from "react-native-reanimated";
import {
  GlassRenderer,
  useGlassSceneEnabled,
  type GlassRendererProps,
} from "./components";
import {
  MAX_GLASS_SHAPES,
  packScene,
  packSceneOptics,
  type GlassScene,
} from "./geometry";
import {
  resolveGlassMaterial,
  type GlassColor,
  type GlassMaterial,
} from "./material";
import { glassShader } from "./shader";

const clamp = (n: number, low: number, high: number) => {
  "worklet";
  return Number.isFinite(n) ? Math.max(low, Math.min(high, n)) : low;
};

function materialUniforms(m: number[], i: number) {
  "worklet";
  return {
    optics: [
      clamp(m[i], 0, 36),
      clamp(m[i + 1], -2, 2),
      clamp(m[i + 2], 0, 80),
      clamp(m[i + 3], 0, 36),
    ],
    colorControls: [
      clamp(m[i + 6], 0, 3),
      clamp(m[i + 7], 0, 3),
      clamp(m[i + 8], 0, 3),
      clamp(m[i + 9], -1, 2),
    ],
    lighting: [
      clamp(m[i + 10], 0, 1),
      clamp(m[i + 11], 0, 1),
      clamp(m[i + 12], 0, 16),
      clamp(m[i + 13], 0, 1),
    ],
    finish: [
      clamp(m[i + 14], 0, 1),
      clamp(m[i + 15], 0, 1),
      clamp(m[i + 16], 0, 1),
      clamp(m[i + 4], 0, 0.6),
    ],
    extras: [clamp(m[i + 5], -1, 1), 0.5, 14, clamp(m[i + 17], 0, 1)],
    tint: [
      clamp(m[i + 18], 0, 1),
      clamp(m[i + 19], 0, 1),
      clamp(m[i + 20], 0, 1),
      clamp(m[i + 21], 0, 1),
    ],
  };
}

function uniformsFor(
  frame: GlassScene,
  material: GlassMaterial,
  fallback: GlassColor,
): Uniforms {
  "worklet";
  const packed = packScene(frame);
  const shapeCount = (packed.length - 7) / 10;
  const shapeRect = new Array<number>(MAX_GLASS_SHAPES * 4).fill(0);
  const shapeRadii = new Array<number>(MAX_GLASS_SHAPES * 4).fill(0);
  const shapeTransform = new Array<number>(MAX_GLASS_SHAPES * 4).fill(0);
  for (let i = 0; i < shapeCount; i++) {
    const offset = 7 + i * 10;
    const w = packed[offset + 2] / 2;
    const h = packed[offset + 3] / 2;
    const angle = packed[offset + 8];
    const slot = i * 4;
    shapeRect[slot] = packed[offset] + w;
    shapeRect[slot + 1] = packed[offset + 1] + h;
    shapeRect[slot + 2] = w;
    shapeRect[slot + 3] = h;
    for (let corner = 0; corner < 4; corner++) {
      shapeRadii[slot + corner] = clamp(
        packed[offset + 4 + corner],
        0,
        Math.min(w, h),
      );
    }
    shapeTransform[slot] = Math.cos(angle);
    shapeTransform[slot + 1] = Math.sin(angle);
    shapeTransform[slot + 2] = packed[offset + 9];
  }
  const packedOptics = packSceneOptics(frame, material);
  const usesShapeMaterials = packedOptics.length > 22;
  const mats = new Array<number>(MAX_GLASS_SHAPES * 24).fill(0);
  for (let i = 0; usesShapeMaterials && i < shapeCount; i++) {
    const { optics, colorControls, lighting, finish, extras, tint } =
      materialUniforms(packedOptics, (i + 1) * 22);
    const values = [
      ...optics,
      ...colorControls,
      ...lighting,
      ...finish,
      ...extras,
      ...tint,
    ];
    for (let j = 0; j < values.length; j++) mats[i * 24 + j] = values[j];
  }
  return {
    shapeRect,
    shapeRadii,
    shapeTransform,
    shapeCount,
    mergeRadius: clamp(packed[0], 0, 80),
    ...materialUniforms(packedOptics, 0),
    usesShapeMaterials: Number(usesShapeMaterials),
    shapeMaterials: mats,
    fallback,
    refractContent: 0,
    lightA: [packed[1], packed[2], clamp(packed[3], 0, 2)],
    lightB: [packed[4], packed[5], clamp(packed[6], 0, 2)],
  };
}

export interface SkiaGlassProps extends Pick<
  GlassRendererProps,
  "scene" | "material" | "style" | "enabled"
> {
  /** Consumer-owned, authorized image. The renderer never captures a React Native view. */
  image: SkImage | null;
  /** Where the source image lies in the renderer's local coordinates. */
  imageRect: SkRect;
  fallback: GlassColor;
  shapeCount?: number;
  /** Optional replacement SkSL with the same uniforms and one backdrop child shader. */
  shader?: string;
}

export function SkiaGlass({
  scene,
  material,
  style,
  enabled = true,
  image,
  imageRect,
  fallback,
  shader,
  shapeCount = MAX_GLASS_SHAPES,
}: SkiaGlassProps) {
  const active = useGlassSceneEnabled(enabled);
  const effect = useMemo(() => {
    try {
      return Skia.RuntimeEffect.Make(shader ?? glassShader);
    } catch {
      return null;
    }
  }, [shader]);
  const resolved = resolveGlassMaterial(material);
  const uniforms = useDerivedValue(() =>
    uniformsFor(scene.get(), resolved, fallback),
  );
  if (!active || !effect || !image) {
    const opaque = `rgb(${fallback
      .slice(0, 3)
      .map((channel) => Math.round(channel * 255))
      .join(",")})`;
    return (
      <GlassRenderer
        enabled={false}
        scene={scene}
        shapeCount={shapeCount}
        style={style}
        opaqueColor={opaque}
      />
    );
  }
  return (
    <View
      style={style}
      pointerEvents="none"
      accessible={false}
      importantForAccessibility="no-hide-descendants"
    >
      <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
        <Fill>
          <Shader source={effect} uniforms={uniforms}>
            <ImageShader
              image={image}
              rect={imageRect}
              tx="clamp"
              ty="clamp"
              fit="fill"
            />
          </Shader>
        </Fill>
      </Canvas>
    </View>
  );
}
