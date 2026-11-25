import { useLayoutEffect, useState, type ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { motion, useTheme } from "@/theme";

type BadgeProps = {
  count: number;
  children?: ReactNode;
  size?: "compact" | "regular";
  tone?: "danger" | "accent" | "muted";
  ringColor?: string;
  badgeStyle?: StyleProp<ViewStyle>;
};

// Adapted from Kinetik UI's Count Badge. The surrounding control announces
// its full count and provides the touch target.
export function CountBadge({
  count,
  children,
  size = "regular",
  tone = "danger",
  ringColor,
  badgeStyle,
}: BadgeProps) {
  const { i18n } = useTranslation("common");
  const { reduceMotion } = useTheme();
  const corner = children !== undefined;
  const visible = count > 0;
  const formatted = new Intl.NumberFormat(i18n.resolvedLanguage).format(
    Math.min(99, count),
  );
  const text = count > 99 ? formatted + "+" : formatted;
  const [roll, setRoll] = useState({
    count,
    text,
    previous: text,
    sign: 1,
    visible,
  });
  if (roll.visible !== visible || (visible && roll.text !== text)) {
    setRoll({
      count,
      text: visible ? text : roll.text,
      previous: visible && !roll.visible ? text : roll.text,
      sign: count >= roll.count ? 1 : -1,
      visible,
    });
  }

  const shown = useSharedValue(visible ? 1 : 0);
  const jump = useSharedValue(1);
  const progress = useSharedValue(1);

  useLayoutEffect(() => {
    shown.set(
      reduceMotion
        ? Number(visible)
        : visible
          ? withSpring(1, motion.travel)
          : withTiming(0, { duration: motion.quickFade }),
    );
  }, [reduceMotion, shown, visible]);

  const rolling = visible && !reduceMotion && roll.previous !== roll.text;
  const sign = roll.sign;
  useLayoutEffect(() => {
    if (!rolling) {
      progress.set(1);
      jump.set(1);
      return;
    }
    progress.set(0);
    progress.set(withTiming(1, { duration: motion.image }));
    if (sign > 0)
      jump.set(
        withSequence(
          withTiming(1.16, { duration: motion.quickFade }),
          withSpring(1, motion.press),
        ),
      );
  }, [jump, progress, roll.text, rolling, sign]);

  const bubble = useAnimatedStyle(() => ({
    opacity: Math.min(1, shown.get() * 2),
    transform: [{ scale: Math.max(0, shown.get()) * jump.get() }],
  }));
  const incoming = useAnimatedStyle(() => ({
    opacity: progress.get(),
    transform: [{ translateY: (1 - progress.get()) * 14 * sign }],
  }));
  const outgoing = useAnimatedStyle(() => ({
    opacity: 1 - progress.get(),
    transform: [{ translateY: -progress.get() * 14 * sign }],
  }));
  const variant = styles.useVariants({ size, tone });
  const badge = (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        variant.bubble,
        corner && styles.corner,
        ringColor && { borderColor: ringColor, borderWidth: 1 },
        badgeStyle,
        bubble,
      ]}
    >
      <View style={styles.window}>
        {rolling && (
          <Animated.Text
            maxFontSizeMultiplier={1.25}
            style={[variant.number, styles.ghost, outgoing]}
            numberOfLines={1}
          >
            {roll.previous}
          </Animated.Text>
        )}
        <Animated.Text
          maxFontSizeMultiplier={1.25}
          style={[variant.number, incoming]}
          numberOfLines={1}
        >
          {roll.text}
        </Animated.Text>
      </View>
    </Animated.View>
  );
  return corner ? (
    <View>
      {children}
      {badge}
    </View>
  ) : (
    badge
  );
}

const styles = StyleSheet.create(({ colors, radius, space, type }) => ({
  bubble: {
    borderRadius: radius.round,
    paddingHorizontal: space.xs,
    alignItems: "center",
    alignSelf: "center",
    justifyContent: "center",
    variants: {
      size: {
        compact: { minHeight: 16, minWidth: 16, paddingHorizontal: 3 },
        regular: { minHeight: 22, minWidth: 22 },
      },
      tone: {
        danger: { backgroundColor: colors.danger },
        accent: { backgroundColor: colors.outgoing },
        muted: { backgroundColor: colors.muted },
      },
    },
  },
  number: {
    ...type.badge,
    fontVariant: ["tabular-nums"],
    textAlign: "center",
    writingDirection: "ltr",
    variants: {
      size: {
        compact: { fontSize: 9, lineHeight: 12 },
        regular: {},
      },
      tone: {
        danger: { color: colors.onDanger },
        accent: { color: colors.outgoingInk },
        muted: { color: colors.background },
      },
    },
  },
  corner: { position: "absolute", end: -7, top: -5 },
  window: {
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  ghost: { position: "absolute" },
}));
