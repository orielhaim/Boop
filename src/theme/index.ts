import { usePreferences } from "@/components/glassyui/glass-provider";

export const light = {
  background: "#F3F6FC",
  surface: "#FFFFFF",
  text: "#141D33",
  muted: "#526079",
  line: "#DCE4F2",
  accent: "#344DC3",
  accentSoft: "#E3E9FF",
  heroStart: "#DDE8FF",
  heroEnd: "#F4F8FF",
  danger: "#BE304A",
  onDanger: "#FFFFFF",
  outgoing: "#344DC3",
  outgoingInk: "#FFFFFF",
};
export const dark: typeof light = {
  background: "#101524",
  surface: "#1A2338",
  text: "#F3F6FF",
  muted: "#ABB8D4",
  line: "#35425D",
  accent: "#B0BEFF",
  accentSoft: "#303D66",
  heroStart: "#293862",
  heroEnd: "#19243C",
  danger: "#FF95A6",
  onDanger: "#2C0C14",
  outgoing: "#465BCC",
  outgoingInk: "#FFFFFF",
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };
export const radius = { input: 16, card: 24, round: 999 };
export const spring = { damping: 20, stiffness: 320, mass: 0.65 };
export const type = {
  title: { fontSize: 38, letterSpacing: -1.5, fontWeight: "700" },
  heading: { fontSize: 20, letterSpacing: -0.35, fontWeight: "700" },
  body: { fontSize: 16, lineHeight: 22 },
  label: { fontSize: 15, fontWeight: "600" },
  caption: { fontSize: 13, lineHeight: 18 },
} satisfies Record<string, import("react-native").TextStyle>;

export function useTheme() {
  const preferences = usePreferences();
  return {
    ...preferences,
    colors: preferences.theme === "dark" ? dark : light,
  };
}
