import type { ComponentRef } from "react";
import { BlurView } from "expo-blur";
import { GlassView } from "expo-glass-effect";
import { Children, forwardRef } from "react";
import { StyleSheet, Text, View, type ViewProps } from "react-native";
import { useGlassTheme } from "./glass-provider";
import { resolveGlassMaterial } from "./lib/material";
import { GLASS_RADIUS } from "./lib/tokens";

export type SurfacePreset =
  "subtle" | "standard" | "prominent" | "control" | "overlay";

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
};

// How strongly each preset blurs where the system's glass is unavailable. On the web these
// land on the same blur radii as the CSS glass.
const BLUR_INTENSITY: Record<SurfacePreset, number> = {
  subtle: 40,
  control: 50,
  standard: 70,
  prominent: 90,
  overlay: 90,
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
    { children, elevation = "base", preset = "standard", style, tint, ...rest },
    ref,
  ) => {
    const { colors, preferences } = useGlassTheme();
    const material = resolveGlassMaterial(preferences.reduceTransparency);
    const radius = StyleSheet.flatten(style)?.borderRadius ?? GLASS_RADIUS.md;
    const corners = {
      borderRadius: radius,
      borderCurve: "continuous",
    } as const;

    return (
      <View
        ref={ref}
        style={[
          corners,
          elevation !== "none" && {
            boxShadow:
              elevation === "raised" ? colors.shadowRaised : colors.shadow,
          },
          style,
        ]}
        {...rest}
      >
        {material === "liquid" ? (
          <GlassView
            style={[StyleSheet.absoluteFill, corners, styles.layer]}
            colorScheme={preferences.theme}
            glassEffectStyle={preset === "subtle" ? "clear" : "regular"}
            tintColor={
              tint ??
              (preferences.mode === "tinted"
                ? colors.glassFill.tinted
                : undefined)
            }
          />
        ) : null}
        {material === "blur" ? (
          <View
            style={[
              StyleSheet.absoluteFill,
              corners,
              styles.layer,
              styles.clip,
            ]}
          >
            <BlurView
              style={StyleSheet.absoluteFill}
              intensity={BLUR_INTENSITY[preset]}
              tint={
                preferences.theme === "dark"
                  ? "systemUltraThinMaterialDark"
                  : "systemUltraThinMaterialLight"
              }
              blurMethod="none"
            />
            <View
              style={[
                StyleSheet.absoluteFill,
                tint
                  ? { backgroundColor: tint, opacity: 0.92 }
                  : {
                      backgroundColor:
                        preset === "overlay"
                          ? colors.overlaySurface
                          : colors.glassFill[preferences.mode],
                    },
              ]}
            />
            <View
              style={[
                StyleSheet.absoluteFill,
                corners,
                {
                  boxShadow: `inset 0px 1px 0px ${colors.rimHighlight}, inset 0px 0px 0px 1px ${colors.rim}`,
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
                backgroundColor: tint ?? colors.opaqueSurface,
                borderColor: colors.border,
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
                color: tint ? colors.accentForeground : colors.foreground,
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
