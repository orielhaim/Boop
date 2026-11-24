import {
  isGlassEffectAPIAvailable,
  isLiquidGlassAvailable,
} from "expo-glass-effect";
import { Platform } from "react-native";

/**
 * How glass is drawn: the system's own glass on iOS 26 and later, a blur of what lies
 * behind on earlier iOS, Android and the web. Android controls can use a tint
 * when they sit over a flat surface. Reduce Transparency always uses a solid fill.
 */
export type GlassMaterial = "liquid" | "blur" | "tinted" | "solid";

// Both checks return false off iOS. The second guards early iOS 26 builds that lack the API.
const systemGlass = isLiquidGlassAvailable() && isGlassEffectAPIAvailable();

export function resolveGlassMaterial(
  reduceTransparency: boolean,
  hasBackdrop: boolean,
  translucentFallback: boolean,
): GlassMaterial {
  if (reduceTransparency) return "solid";
  if (Platform.OS === "android" && !hasBackdrop)
    return translucentFallback ? "tinted" : "solid";

  return systemGlass ? "liquid" : "blur";
}
