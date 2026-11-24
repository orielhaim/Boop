import { usePreferences } from "@/components/glassyui/glass-provider";
import { themes } from "./tokens";

export { motion, radius, space, type } from "./tokens";
export const light = themes.light.colors;
export const dark = themes.dark.colors;
export const spring = themes.light.motion.press;

export function useTheme() {
  const preferences = usePreferences();
  return { ...preferences, colors: themes[preferences.theme].colors };
}
