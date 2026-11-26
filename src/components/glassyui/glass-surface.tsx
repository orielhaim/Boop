import { Children, type ComponentRef, forwardRef } from "react";
import { StyleSheet, Text, View, type ViewProps } from "react-native";
import {
  GlassSurface as EngineSurface,
  glassMaterials,
  type GlassCorners,
  type GlassMaterial,
} from "react-native-liquid-engine";
import { useGlassTheme } from "./glass-provider";
import { glassTint } from "./glass-renderer";
import { mediaMaterial, radius } from "@/theme/tokens";

export type SurfacePreset =
  "subtle" | "standard" | "prominent" | "control" | "overlay" | "cinematic";

export type SurfaceElevation = "none" | "base" | "raised";

export type GlassSurfaceProps = ViewProps & {
  elevation?: SurfaceElevation;
  preset?: SurfacePreset;
  tint?: string;
  lensTint?: boolean | string;
};

const optics = {
  subtle: glassMaterials.clear,
  control: glassMaterials.clear,
  standard: glassMaterials.regular,
  prominent: glassMaterials.frosted,
  overlay: glassMaterials.frosted,
  cinematic: glassMaterials.clear,
} satisfies Record<SurfacePreset, GlassMaterial>;

function numericRadius(radius: number | string | undefined, fallback: number) {
  return typeof radius === "number" ? radius : fallback;
}

export const GlassSurface = forwardRef<
  ComponentRef<typeof View>,
  GlassSurfaceProps
>(
  (
    {
      children,
      elevation = "base",
      preset = "standard",
      style,
      tint,
      lensTint = false,
      ...props
    },
    ref,
  ) => {
    const { colors, preferences } = useGlassTheme();
    const cinematic = preset === "cinematic";
    const shape = StyleSheet.flatten(style);
    const base = numericRadius(shape?.borderRadius, radius.control);
    const corners: GlassCorners = [
      numericRadius(shape?.borderTopLeftRadius, base),
      numericRadius(shape?.borderTopRightRadius, base),
      numericRadius(shape?.borderBottomRightRadius, base),
      numericRadius(shape?.borderBottomLeftRadius, base),
    ];
    const lensColor = typeof lensTint === "string" ? lensTint : undefined;
    const fill =
      tint ??
      (cinematic
        ? mediaMaterial.opaque
        : preset === "overlay"
          ? colors.overlaySurface
          : lensTint
            ? (lensColor ?? colors.lens.frost)
            : preset === "prominent"
              ? colors.glassFill.tinted
              : colors.glassFill.clear);
    const [red, green, blue] = glassTint(fill);
    const opaque =
      tint ?? (cinematic ? mediaMaterial.opaque : colors.opaqueSurface);
    return (
      <EngineSurface
        {...props}
        ref={ref}
        style={[
          { borderRadius: base },
          elevation !== "none" && {
            boxShadow: cinematic
              ? mediaMaterial.shadow
              : elevation === "raised"
                ? colors.shadowRaised
                : colors.shadow,
          },
          style,
          { borderCurve: "circular" },
        ]}
        enabled={!preferences.reduceTransparency}
        shape={{ radius: corners, kind: "roundedRect" }}
        material={{
          ...optics[preset],
          tint: tint ? [red, green, blue, 0.92] : glassTint(fill),
          outerShadow: 0,
        }}
        opaqueColor={opaque}
        colorScheme={cinematic ? "dark" : preferences.theme}
        systemStyle={cinematic || preset === "subtle" ? "clear" : "regular"}
        systemTint={tint ?? lensColor}
      >
        {Children.map(children, (child) =>
          child === null || child instanceof Object ? (
            child
          ) : (
            <Text
              style={{
                color: cinematic
                  ? mediaMaterial.ink
                  : tint
                    ? colors.accentForeground
                    : colors.foreground,
              }}
            >
              {child}
            </Text>
          ),
        )}
      </EngineSurface>
    );
  },
);
GlassSurface.displayName = "GlassSurface";
