import { useEffect } from "react";
import { View } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";
import { Action, Icon, Ink } from "@/components/ui/kit";
import { useTheme } from "@/theme";

// Adapted from Reacticx Empty Inbox V1.
const rows = [
  { opacity: 1, scale: 1, lines: ["60%", "100%", "35%"] },
  { opacity: 0.55, scale: 0.97, lines: ["48%", "88%", "29%"] },
  { opacity: 0.24, scale: 0.94, lines: ["39%", "75%", "24%"] },
] as const;

export function EmptyInbox({
  title,
  detail,
  actionLabel,
  onAction,
  focused,
}: {
  title: string;
  detail: string;
  actionLabel: string;
  onAction: () => void;
  focused: boolean;
}) {
  const { colors, reduceMotion } = useTheme();
  const pulse = useSharedValue(1);
  useEffect(() => {
    pulse.set(
      focused && !reduceMotion
        ? withRepeat(
            withTiming(0.65, {
              duration: 1100,
              easing: Easing.inOut(Easing.quad),
            }),
            2,
            true,
          )
        : 1,
    );
    return () => cancelAnimation(pulse);
  }, [focused, pulse, reduceMotion]);
  const animation = useAnimatedStyle(() => ({ opacity: pulse.get() }));
  return (
    <View style={styles.container}>
      <Animated.View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
        style={[styles.art, animation]}
      >
        {rows.map(({ opacity, scale, lines }) => (
          <View
            key={opacity}
            style={[styles.row, { opacity, transform: [{ scale }] }]}
          >
            <View style={styles.avatar} />
            <View style={styles.lines}>
              {lines.map((width, index) => (
                <View
                  key={width}
                  style={[
                    styles.line,
                    index === 0 && styles.strongLine,
                    { width },
                  ]}
                />
              ))}
            </View>
          </View>
        ))}
      </Animated.View>
      <View style={styles.copy}>
        <Ink kind="heading" accessibilityRole="header" style={styles.text}>
          {title}
        </Ink>
        <Ink muted style={styles.text}>
          {detail}
        </Ink>
      </View>
      <Action
        variant="prominent"
        size="lg"
        accessibilityLabel={actionLabel}
        onPress={onAction}
        style={styles.action}
      >
        <Icon name="add" color={colors.outgoingInk} size={20} weight="bold" />
        {actionLabel}
      </Action>
    </View>
  );
}

const styles = StyleSheet.create(({ colors, radius, space }) => ({
  container: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.xl,
    paddingVertical: space.xxl,
    gap: space.xl,
  },
  art: { width: "100%", maxWidth: 256, gap: space.lg },
  row: { flexDirection: "row", alignItems: "center", gap: space.lg },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: radius.round,
    backgroundColor: colors.line,
  },
  lines: { flex: 1, gap: space.xs },
  line: { height: 8, borderRadius: radius.round, backgroundColor: colors.line },
  strongLine: { backgroundColor: colors.selected },
  copy: { width: "100%", maxWidth: 320, gap: space.sm },
  text: { textAlign: "center" },
  action: { alignSelf: "center" },
}));
