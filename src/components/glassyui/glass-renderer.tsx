import { processColor } from "react-native";
import { useDerivedValue, type SharedValue } from "react-native-reanimated";
import {
  GlassContentLens as EngineContentLens,
  GlassRenderer as EngineRenderer,
  glassMaterials,
  type GlassColor,
  type GlassContentLensProps,
  type GlassRendererProps as EngineRendererProps,
} from "react-native-liquid-engine";
import { useGlassTheme } from "./glass-provider";

const dockContentMaterial = {
  ...glassMaterials.lens,
  refractionStrength: 0.9,
  refractionDepth: 20,
  thickness: 8,
  magnification: 0.065,
  chromaticAberration: 0.09,
};

export function DockContentLens({
  scene,
  intensity,
  ...props
}: Omit<GlassContentLensProps, "material" | "matteColor"> & {
  intensity: SharedValue<number>;
}) {
  const { colors, preferences } = useGlassTheme();
  const opticalScene = useDerivedValue(() => ({
    ...scene.get(),
    material: {
      ...dockContentMaterial,
      refractionStrength:
        dockContentMaterial.refractionStrength * intensity.get(),
      magnification: dockContentMaterial.magnification * intensity.get(),
    },
  }));
  return (
    <EngineContentLens
      {...props}
      enabled={props.enabled !== false && !preferences.reduceTransparency}
      scene={opticalScene}
      matteColor={colors.dock.opaque}
    />
  );
}

export function glassTint(color: string): GlassColor {
  const rgba = processColor(color);
  if (typeof rgba !== "number") return [0, 0, 0, 0];
  return [
    ((rgba >>> 16) & 255) / 255,
    ((rgba >>> 8) & 255) / 255,
    (rgba & 255) / 255,
    (rgba >>> 24) / 255,
  ];
}

type GlassRendererProps = Pick<
  EngineRendererProps,
  "scene" | "shapeCount" | "style" | "testID" | "enabled"
> & {
  preset: "dock" | "lens";
};

export function GlassRenderer({
  preset,
  enabled = true,
  ...props
}: GlassRendererProps) {
  const { colors, preferences } = useGlassTheme();
  const lens = preset === "lens";
  const dark = preferences.theme === "dark";
  const [r, g, b, alpha] = glassTint(colors.dock.tint);
  const material = lens
    ? {
        ...glassMaterials.lens,
        refractionDepth: 16,
        thickness: 8,
        tint: [r, g, b, dark ? 0.19 : 0.12] as const,
        outerShadow: 0.07,
      }
    : {
        ...glassMaterials.liquid,
        blurRadius: 6,
        refractionDepth: 13,
        thickness: 7,
        fresnelStrength: dark ? 0.6 : 0.25,
        specularIntensity: 0.32,
        innerShadow: 0.13,
        outerShadow: dark ? 0.15 : 0.04,
        brightness: dark ? 0.84 : 1,
        tint: [r, g, b, alpha] as const,
      };
  const inputScene = props.scene;
  const scene = useDerivedValue(() => {
    const frame = inputScene.get();
    const pulse = Math.min((frame.mergeSmoothness ?? 0) / 31, 1);
    return {
      ...frame,
      material: {
        ...material,
        blurRadius: material.blurRadius + pulse * 4,
        thickness: material.thickness + pulse * 2,
      },
    };
  });
  return (
    <EngineRenderer
      {...props}
      scene={scene}
      enabled={enabled && !preferences.reduceTransparency}
      backdrop="window"
      colorScheme={preferences.theme}
      systemStyle={lens ? "clear" : "regular"}
      systemSpacing={6}
      opaqueColor={lens ? colors.focusedSurface : colors.dock.opaque}
      systemTint={colors.dock.tint}
    />
  );
}
