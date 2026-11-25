import type { ComponentRef, RefObject } from "react";
import { BlurView } from "expo-blur";
import { GlassView } from "expo-glass-effect";
import { Children, forwardRef } from "react";
import { Platform, StyleSheet, Text, View, type ViewProps } from "react-native";
import { useGlassTheme } from "./glass-provider";
import { resolveGlassMaterial } from "./lib/material";
import { mediaMaterial, radius } from "@/theme/tokens";

export type SurfacePreset =
  "subtle" | "standard" | "prominent" | "control" | "overlay" | "cinematic";

export type SurfaceElevation = "none" | "base" | "raised";

export type GlassSurfaceProps = ViewProps & {
  /** Floating glass casts a shadow; glass set into a layout does not. Defaults to base. */
  elevation?: SurfaceElevation;
  /**
   * How much frost: subtle shows the most of what lies behind, prominent the least. Overlay is
   * for floating layers such as dialogs and menus: its denser tint keeps text at 4.5:1 over any
   * backdrop.
   */
  preset?: SurfacePreset;
  /**
   * Colours the glass, as the prominent button's blue does. Use an opaque colour. Where the glass
   * is a blur, the tint covers 92% of it, so white text on a tint that holds 4.5:1 alone still
   * does over a white backdrop.
   */
  tint?: string;
  /** Android blur samples this separate backdrop view. */
  blurTarget?: RefObject<ComponentRef<typeof View> | null>;
  /** Keep the glass tint and rim on Android controls without a blur target. */
  translucentFallback?: boolean;
};

// How strongly each preset blurs where the system's glass is unavailable. On the web these
// land on the same blur radii as the CSS glass.
const BLUR_INTENSITY: Record<SurfacePreset, number> = {
  subtle: 40,
  control: 50,
  standard: 70,
  prominent: 90,
  overlay: 90,
  cinematic: 28,
};

/**
 * Uses system glass on iOS 26 and the platform surface elsewhere.
 * Reduce Transparency turns the glass opaque.
 */
export const GlassSurface = forwardRef<
  ComponentRef<typeof View>,
  GlassSurfaceProps
>(
  (
    {
      children,
      blurTarget,
      elevation = "base",
      preset = "standard",
      style,
      tint,
      translucentFallback = false,
      ...rest
    },
    ref,
  ) => {
    const { colors, preferences } = useGlassTheme();
    const cinematic = preset === "cinematic";
    const material = resolveGlassMaterial(
      preferences.reduceTransparency,
      Boolean(blurTarget),
      translucentFallback || cinematic,
    );
    const shape = StyleSheet.flatten(style);
    const corners = {
      borderRadius: shape?.borderRadius ?? radius.control,
      borderBottomLeftRadius: shape?.borderBottomLeftRadius,
      borderBottomRightRadius: shape?.borderBottomRightRadius,
      borderCurve: "continuous",
    } as const;
    const lens = translucentFallback ? colors.lens : undefined;
    const rim = cinematic ? mediaMaterial.rim : (lens?.rim ?? colors.rim);
    const rimHighlight = cinematic
      ? mediaMaterial.glint
      : (lens?.glint ?? colors.rimHighlight);

    return (
      <View
        ref={ref}
        style={[
          corners,
          elevation !== "none" && {
            boxShadow: cinematic
              ? mediaMaterial.shadow
              : elevation === "raised"
                ? colors.shadowRaised
                : colors.shadow,
          },
          style,
        ]}
        {...rest}
      >
        {material === "liquid" ? (
          <GlassView
            style={[StyleSheet.absoluteFill, corners, styles.layer]}
            colorScheme={cinematic ? "dark" : preferences.theme}
            glassEffectStyle={
              cinematic || preset === "subtle" ? "clear" : "regular"
            }
            tintColor={tint}
          />
        ) : null}
        {material === "blur" || material === "tinted" ? (
          <View
            style={[
              StyleSheet.absoluteFill,
              corners,
              styles.layer,
              styles.clip,
            ]}
          >
            {material === "blur" && (
              <BlurView
                style={StyleSheet.absoluteFill}
                intensity={BLUR_INTENSITY[preset]}
                tint={
                  cinematic
                    ? "default"
                    : preferences.theme === "dark"
                      ? "systemUltraThinMaterialDark"
                      : "systemUltraThinMaterialLight"
                }
                blurTarget={Platform.OS === "android" ? blurTarget : undefined}
                blurMethod={
                  Platform.OS === "android"
                    ? "dimezisBlurViewSdk31Plus"
                    : undefined
                }
              />
            )}
            {(!cinematic || tint) && (
              <View
                style={[
                  StyleSheet.absoluteFill,
                  tint
                    ? { backgroundColor: tint, opacity: 0.92 }
                    : {
                        backgroundColor:
                          lens?.frost ??
                          (preset === "overlay"
                            ? colors.overlaySurface
                            : preset === "prominent"
                              ? colors.glassFill.tinted
                              : colors.glassFill.clear),
                      },
                ]}
              />
            )}
            <View
              style={[
                StyleSheet.absoluteFill,
                corners,
                {
                  boxShadow: `inset 0px 1px 0px ${rimHighlight}, inset 0px 0px 0px 1px ${rim}`,
                },
              ]}
            />
          </View>
        ) : null}
        {material === "solid" ? (
          <View
            style={[
              StyleSheet.absoluteFill,
              corners,
              styles.layer,
              {
                backgroundColor:
                  tint ??
                  (cinematic ? mediaMaterial.opaque : colors.opaqueSurface),
                borderColor: cinematic ? mediaMaterial.rim : colors.border,
                borderWidth: StyleSheet.hairlineWidth,
              },
            ]}
          />
        ) : null}
        {Children.map(children, (child) =>
          // Children.map yields null, elements or text; only text needs a Text to render in.
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
      </View>
    );
  },
);

GlassSurface.displayName = "GlassSurface";

const styles = StyleSheet.create({
  clip: { overflow: "hidden" },
  layer: { pointerEvents: "none" },
});
