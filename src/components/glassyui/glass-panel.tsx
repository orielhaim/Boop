import type { ComponentRef } from "react";
import { forwardRef } from "react";
import type { View } from "react-native";
import { GlassSurface, type GlassSurfaceProps } from "./glass-surface";
import { radius } from "@/theme/tokens";

type PanelVariant = "panel" | "card" | "pill";

type PanelElevation = "base" | "raised";

export type GlassPanelProps = Omit<GlassSurfaceProps, "elevation"> & {
  variant?: PanelVariant;
  elevation?: PanelElevation;
};

// Shape and spacing come first, so a consumer's style always wins.
const VARIANT_STYLE = {
  panel: { borderRadius: radius.card, padding: 24 },
  card: { borderRadius: radius.control, padding: 20 },
  pill: {
    borderRadius: radius.round,
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
} as const;

/** Glass cards, panels and pills for anything that floats above your content. */
export const GlassPanel = forwardRef<
  ComponentRef<typeof View>,
  GlassPanelProps
>(
  (
    {
      elevation = "base",
      variant = "panel",
      preset = variant === "pill" ? "control" : "standard",
      style,
      ...rest
    },
    ref,
  ) => (
    <GlassSurface
      ref={ref}
      elevation={elevation}
      preset={preset}
      style={[VARIANT_STYLE[variant], style]}
      {...rest}
    />
  ),
);

GlassPanel.displayName = "GlassPanel";
