import type { TextStyle } from "react-native";

export type ThemeName = "light" | "dark";

export const avatarGradients = [
  ["#466FC7", "#3045A1"],
  ["#AE5940", "#833223"],
  ["#7C64BE", "#4E3789"],
  ["#B8497A", "#912C5F"],
  ["#A4652F", "#804416"],
  ["#2B7E61", "#1B6047"],
  ["#247E8D", "#175D6E"],
  ["#677593", "#3E4D6B"],
] as const;

export function avatarGradient(identityKey: string | undefined) {
  if (!identityKey) return ["#747479", "#535359"] as const;
  // Match Chat Kit's per-user index so an identity has the same colors in its chat row.
  let hash = 0;
  for (let i = 0; i < identityKey.length; i++) {
    hash = (hash * 31 + identityKey.charCodeAt(i)) | 0;
  }
  return avatarGradients[Math.abs(hash % avatarGradients.length)];
}

const lightColors = {
  background: "#F0F2F5",
  grouped: "#FFFFFF",
  raised: "#FFFFFF",
  recessed: "#E7EBF1",
  overlay: "#FFFFFF",
  selected: "#E2E9FC",
  pressed: "#E9EDF4",
  text: "#191E2B",
  muted: "#555F72",
  line: "#DCE1E9",
  accent: "#3454B8",
  onAccent: "#FFFFFF",
  onMedia: "#FFFFFF",
  heroStart: "#E2E9F5",
  heroEnd: "#F3F5F8",
  danger: "#B52B47",
  onDanger: "#FFFFFF",
  outgoing: "#3556B9",
  outgoingInk: "#FFFFFF",
  positive: "#166A51",
  warning: "#865000",
};

const darkColors: typeof lightColors = {
  background: "#111318",
  grouped: "#1D2028",
  raised: "#252A35",
  recessed: "#171A21",
  overlay: "#2B303C",
  selected: "#293754",
  pressed: "#2A303C",
  text: "#F1F3F8",
  muted: "#B0BACD",
  line: "#353C4A",
  accent: "#B0C3FF",
  onAccent: "#182A59",
  onMedia: "#FFFFFF",
  heroStart: "#26334E",
  heroEnd: "#171D29",
  danger: "#FF9AAF",
  onDanger: "#340C17",
  outgoing: "#3B56AD",
  outgoingInk: "#FFFFFF",
  positive: "#75D9AE",
  warning: "#F5C06C",
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };
export const radius = {
  small: 8,
  input: 16,
  control: 16,
  group: 20,
  card: 24,
  round: 999,
};

export const motion = {
  press: { damping: 20, stiffness: 320, mass: 0.65 },
  settle: { damping: 18, stiffness: 260, mass: 1 },
  travel: {
    stiffness: 370,
    damping: 39,
    mass: 0.9,
    overshootClamping: true,
  },
  quickFade: 100,
  image: 160,
  themeReveal: 600,
};

export const type = {
  title: { fontSize: 38, letterSpacing: -1.35, fontWeight: "700" },
  heading: {
    fontSize: 20,
    lineHeight: 25,
    letterSpacing: -0.25,
    fontWeight: "600",
  },
  body: { fontSize: 16, lineHeight: 22 },
  label: { fontSize: 15, lineHeight: 20, fontWeight: "500" },
  caption: { fontSize: 13, lineHeight: 18 },
  screenTitle: {
    fontSize: 30,
    lineHeight: 36,
    letterSpacing: -0.8,
    fontWeight: "700",
  },
  profileName: {
    fontSize: 26,
    lineHeight: 32,
    letterSpacing: -0.45,
    fontWeight: "600",
  },
  section: { fontSize: 15, lineHeight: 20, fontWeight: "600" },
  rowTitle: { fontSize: 16, lineHeight: 21, fontWeight: "500" },
  description: { fontSize: 13, lineHeight: 18 },
  control: { fontSize: 15, lineHeight: 20, fontWeight: "600" },
  meta: { fontSize: 12, lineHeight: 16 },
  badge: { fontSize: 11, lineHeight: 14, fontWeight: "700" },
  message: { fontSize: 16, lineHeight: 22 },
} satisfies Record<string, TextStyle>;

export const callMaterial = {
  stage: ["#1B2337F2", "#192239F2", "#101822FA"],
  voiceMark: ["#6178BC", "#3F4597", "#2F315A"],
  panel: "#1C2435",
  control: "#27344A",
  selected: "#3E55A1",
  end: "#BA304B",
  answer: "#087959",
  ink: "#F6F8FF",
  muted: "#D2DCEF",
  rim: "#B0BFFF22",
  halo: "#9DB4FF12",
  haloStroke: "#D6DEFF60",
  focus: "#ACC0FF",
} as const;

export type GlassTone =
  "neutral" | "blue" | "green" | "orange" | "red" | "purple";

type ConversationMaterial = {
  canvas: [string, string, string];
  contours: string;
  panel: string;
  rim: string;
  incoming: string;
  outgoing: [string, string];
};

function buildTheme(name: ThemeName, colors: typeof lightColors) {
  const dark = name === "dark";
  const conversation: ConversationMaterial = {
    canvas: dark
      ? [colors.background, "#17202C", "#17282B"]
      : [colors.background, "#E6ECF4", "#E5EFEE"],
    contours: colors.muted,
    panel: colors.raised,
    rim: colors.line,
    incoming: colors.grouped,
    outgoing: dark
      ? ["#4C4796", colors.outgoing]
      : ["#444A9C", colors.outgoing],
  };
  return {
    name,
    colors,
    space,
    radius,
    type,
    motion,
    conversation,
    glass: {
      dock: dark
        ? {
            tint: "rgba(30, 52, 79, 0.30)",
            rim: "rgba(180, 205, 240, 0.21)",
            opaque: "#242F40",
          }
        : {
            tint: "rgba(212, 226, 247, 0.52)",
            rim: "rgba(63, 90, 133, 0.23)",
            opaque: "#E0E8F4",
          },
      lens: dark
        ? {
            frost: "rgba(17, 30, 50, 0.55)",
            rim: "rgba(175, 198, 232, 0.25)",
            glint: "rgba(228, 239, 255, 0.31)",
          }
        : {
            frost: "rgba(251, 253, 255, 0.55)",
            rim: "rgba(106, 133, 174, 0.25)",
            glint: "rgba(255, 255, 255, 0.92)",
          },
      accent: colors.outgoing,
      accentForeground: colors.outgoingInk,
      border: colors.line,
      controlSurface: colors.recessed,
      focusedSurface: colors.grouped,
      pressedSurface: colors.pressed,
      wellShadow: dark
        ? "inset 0px 1px 2px rgba(0, 0, 0, 0.20)"
        : "inset 0px 1px 2px rgba(26, 38, 65, 0.08)",
      focusRing: colors.accent,
      foreground: colors.text,
      glassFill: {
        clear: dark ? "rgba(20, 24, 34, 0.38)" : "rgba(250, 252, 255, 0.40)",
        tinted: dark ? "rgba(26, 31, 42, 0.65)" : "rgba(250, 252, 255, 0.72)",
      },
      invalid: colors.danger,
      knob: colors.onMedia,
      mutedForeground: colors.muted,
      opaqueSurface: colors.raised,
      overlaySurface: dark
        ? "rgba(43, 48, 60, 0.91)"
        : "rgba(255, 255, 255, 0.92)",
      rim: dark ? "rgba(219, 230, 255, 0.15)" : "rgba(255, 255, 255, 0.64)",
      rimHighlight: dark
        ? "rgba(219, 230, 255, 0.28)"
        : "rgba(255, 255, 255, 0.90)",
      scrim: dark ? "rgba(0, 0, 0, 0.48)" : "rgba(14, 21, 38, 0.23)",
      shadow: dark
        ? "0px 1px 2px rgba(0, 0, 0, 0.16), 0px 8px 24px -4px rgba(0, 0, 0, 0.28)"
        : "0px 1px 2px rgba(26, 38, 65, 0.06), 0px 8px 24px -6px rgba(26, 38, 65, 0.16)",
      shadowRaised: dark
        ? "0px 2px 6px rgba(0, 0, 0, 0.20), 0px 30px 60px -18px rgba(0, 0, 0, 0.55)"
        : "0px 2px 6px rgba(26, 38, 65, 0.06), 0px 28px 56px -18px rgba(26, 38, 65, 0.26)",
      tones: {
        neutral: colors.muted,
        blue: colors.accent,
        green: colors.positive,
        orange: colors.warning,
        red: colors.danger,
        purple: dark ? "#BCA7FA" : "#7252BF",
      } satisfies Record<GlassTone, string>,
      track: dark ? "rgba(147, 155, 181, 0.36)" : "rgba(79, 91, 124, 0.22)",
    },
  };
}

export const themes = {
  light: buildTheme("light", lightColors),
  dark: buildTheme("dark", darkColors),
};
