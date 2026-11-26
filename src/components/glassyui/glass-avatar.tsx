import { Image } from "expo-image";
import {
  type ComponentProps,
  type ComponentRef,
  forwardRef,
  useCallback,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Text, View, type ViewProps } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { avatarGradient, motion, type GlassTone } from "@/theme/tokens";
import { useGlassTheme } from "./glass-provider";
import { wrapPlainText } from "./lib/plain-text";

export type GlassAvatarSize = "xs" | "sm" | "md" | "dock" | "lg" | "xl" | "xxl";

export type GlassAvatarStatus = "online" | "away" | "busy" | "offline";
type AvatarSource = ComponentProps<typeof Image>["source"];

export type GlassAvatarProps = Omit<ViewProps, "children"> & {
  /** Describes the image. Defaults to `name`. */
  alt?: string;
  animateArrival?: boolean;
  /** Shown when there is no image or it fails to load. Defaults to the initials of `name`. */
  fallback?: ReactNode;
  /** The initials use the display name. The gradient uses the stable identity. */
  name?: string;
  identityKey?: string;
  size?: GlassAvatarSize;
  /** A bundled image, as `require('./photo.jpg')` gives it. Use `src` for an address. */
  source?: AvatarSource;
  /** The image's address. */
  src?: string;
  /** A presence dot on the corner. */
  status?: GlassAvatarStatus;
};

const SIZE = {
  xs: { diameter: 24, dot: 7 },
  sm: { diameter: 32, dot: 8 },
  md: { diameter: 40, dot: 10 },
  dock: { diameter: 46, dot: 11 },
  lg: { diameter: 56, dot: 14 },
  xl: { diameter: 80, dot: 18 },
  xxl: { diameter: 96, dot: 20 },
} as const;

// The face's hairline rim and the light along its top.
const RIM = {
  dark: "inset 0px 0px 0px 1px rgba(255, 255, 255, 0.18), inset 0px 1px 0px rgba(255, 255, 255, 0.22)",
  light:
    "inset 0px 0px 0px 1px rgba(0, 0, 0, 0.1), inset 0px 1px 0px rgba(255, 255, 255, 0.3)",
} as const;

const STATUS_TONE = {
  away: "orange",
  busy: "red",
  offline: "neutral",
  online: "green",
} as const satisfies Record<GlassAvatarStatus, GlassTone>;

// The web cuts the face away around the dot. React Native has no masks,
// so a ring in the surface colour draws that gap instead.
const GAP = 2;

function initialsOf(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);

  if (words.length === 0) return "";

  const first = Array.from(words[0])[0] ?? "";
  const last =
    words.length > 1 ? (Array.from(words[words.length - 1])[0] ?? "") : "";

  return `${first}${last}`.toUpperCase();
}

type FaceProps = {
  animateArrival: boolean;
  fallback: ReactNode;
  source: AvatarSource;
  tone: readonly [string, string];
};

function Face({ animateArrival, fallback, source, tone }: FaceProps) {
  const { preferences } = useGlassTheme();
  const [failed, setFailed] = useState(false);
  const handleError = useCallback(() => setFailed(true), []);

  return (
    <>
      <View
        style={[
          StyleSheet.absoluteFill,
          styles.center,
          {
            backgroundColor: tone[0],
            experimental_backgroundImage: `linear-gradient(145deg, ${tone[0]}, ${tone[1]})`,
          },
        ]}
      >
        {fallback}
      </View>
      {source && !failed ? (
        <Image
          accessible={false}
          onError={handleError}
          cachePolicy="memory"
          transition={
            animateArrival && !preferences.reduceMotion ? motion.image : 0
          }
          contentFit="cover"
          source={source}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
    </>
  );
}

/** A round photo that falls back to coloured initials, with an optional presence dot. */
export const GlassAvatar = forwardRef<
  ComponentRef<typeof View>,
  GlassAvatarProps
>(
  (
    {
      alt,
      animateArrival = true,
      fallback,
      identityKey,
      name,
      size = "md",
      source,
      src,
      status,
      style,
      ...rest
    },
    ref,
  ) => {
    const { colors, preferences } = useGlassTheme();
    const { diameter, dot } = SIZE[size];
    const image = useMemo(
      () => source ?? (src ? { uri: src } : undefined),
      [source, src],
    );
    // A new image starts over, showing the fallback until it loads.
    const imageKey = image ? JSON.stringify(image) : "none";
    const described = [alt ?? name, status].filter(Boolean).join(", ");
    // The dot's centre sits on the circle's edge, at its lower trailing corner.
    const center = diameter * 0.8536;

    const content = wrapPlainText(
      fallback ?? (name ? initialsOf(name) : null),
      (text) => (
        <Text style={[styles.initials, { fontSize: diameter * 0.38 }]}>
          {text}
        </Text>
      ),
    );

    return (
      <View
        ref={ref}
        accessibilityLabel={described || undefined}
        accessibilityRole={described ? "image" : undefined}
        accessible={described.length > 0}
        style={[{ height: diameter, width: diameter }, style]}
        {...rest}
      >
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[
            styles.face,
            {
              backgroundColor: colors.controlSurface,
              borderRadius: diameter / 2,
            },
          ]}
        >
          <Face
            key={imageKey}
            animateArrival={animateArrival}
            fallback={content}
            source={image}
            tone={avatarGradient(identityKey)}
          />
          <View
            style={[
              StyleSheet.absoluteFill,
              styles.rim,
              { borderRadius: diameter / 2, boxShadow: RIM[preferences.theme] },
            ]}
          />
        </View>
        {status ? (
          <View
            style={[
              styles.dot,
              {
                backgroundColor: colors.tones[STATUS_TONE[status]],
                borderColor: colors.opaqueSurface,
                borderRadius: dot / 2 + GAP,
                height: dot + GAP * 2,
                start: center - dot / 2 - GAP,
                top: center - dot / 2 - GAP,
                width: dot + GAP * 2,
              },
            ]}
          />
        ) : null}
      </View>
    );
  },
);

GlassAvatar.displayName = "GlassAvatar";

const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center" },
  dot: { borderWidth: GAP, pointerEvents: "none", position: "absolute" },
  face: { height: "100%", overflow: "hidden", width: "100%" },
  initials: {
    color: "#ffffff",
    fontWeight: "600",
    textShadowColor: "rgba(0, 0, 0, 0.22)",
    textShadowOffset: { height: 1, width: 0 },
    textShadowRadius: 1,
  },
  rim: { pointerEvents: "none" },
});
