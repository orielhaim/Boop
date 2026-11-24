import { useAvatar } from "@/core/avatars/use-avatar";
import * as Haptics from "expo-haptics";
import type { ReactNode } from "react";
import {
  Pressable,
  ScrollView,
  Text,
  type TextProps,
  View,
  type ViewStyle,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import {
  GlassAvatar,
  type GlassAvatarSize,
} from "@/components/glassyui/glass-avatar";
import {
  GlassButton,
  type GlassButtonProps,
} from "@/components/glassyui/glass-button";
import {
  GlassInput,
  type GlassInputProps,
} from "@/components/glassyui/glass-input";
import { ScreenInsets } from "@/components/ui/screen-insets";
import { useAppPreferences } from "@/stores/preferences";
import { space, spring, type, useTheme } from "@/theme";
import { Icon, type IconName } from "./icon";

export { Icon } from "./icon";
export type { IconName, IconWeight } from "./icon";

export function Ink({
  kind = "body",
  muted,
  style,
  ...props
}: TextProps & { kind?: keyof typeof type; muted?: boolean }) {
  const variant = inkStyles.useVariants({
    kind,
    tone: muted ? "muted" : "normal",
  });
  return <Text {...props} style={[variant.text, style]} />;
}

const inkStyles = StyleSheet.create(({ colors, type }) => ({
  text: {
    textAlign: "auto",
    variants: {
      kind: type,
      tone: { normal: { color: colors.text }, muted: { color: colors.muted } },
    },
  },
}));

export function IconButton({
  icon,
  label,
  onPress,
  disabled,
  tone = "normal",
  iconColor,
  iconSize,
  style,
}: {
  icon: IconName;
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  tone?: "normal" | "danger" | "accent" | "plain";
  iconColor?: string;
  iconSize?: number;
  style?: ViewStyle;
}) {
  const { colors, reduceMotion } = useTheme();
  const scale = useSharedValue(1);
  const motion = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));
  const background =
    tone === "danger"
      ? colors.danger
      : tone === "accent"
        ? colors.outgoing
        : tone === "plain"
          ? "transparent"
          : colors.selected;
  const tint =
    tone === "danger"
      ? colors.onDanger
      : tone === "accent"
        ? colors.outgoingInk
        : tone === "plain"
          ? colors.text
          : colors.accent;
  const animate = (value: number) => {
    scale.set(
      withSpring(value, {
        ...spring,
        reduceMotion: reduceMotion ? ReduceMotion.Always : ReduceMotion.System,
      }),
    );
  };
  return (
    <Animated.View style={motion}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        disabled={disabled}
        onPressIn={() => animate(0.93)}
        onPressOut={() => animate(1)}
        onPress={() => {
          tapFeedback();
          onPress?.();
        }}
        style={[
          styles.iconButton,
          { backgroundColor: background, opacity: disabled ? 0.5 : 1 },
          style,
        ]}
      >
        <Icon name={icon} color={iconColor ?? tint} size={iconSize} />
      </Pressable>
    </Animated.View>
  );
}

export function tapFeedback() {
  if (useAppPreferences.getState().haptics)
    void Haptics.selectionAsync().catch(() => {});
}

export function Action({ onPress, ...props }: GlassButtonProps) {
  return (
    <GlassButton
      {...props}
      onPress={
        onPress &&
        ((event) => {
          tapFeedback();
          onPress(event);
        })
      }
    />
  );
}

export function Section({ children }: { children: ReactNode }) {
  return (
    <Ink kind="section" accessibilityRole="header" style={styles.section}>
      {children}
    </Ink>
  );
}

export function Screen({
  children,
  scroll = true,
  tab = false,
  topInset = tab,
  onScroll,
  compact = false,
  navigationHeader,
}: {
  children: ReactNode;
  scroll?: boolean;
  tab?: boolean;
  topInset?: boolean;
  compact?: boolean;
  navigationHeader?: ReactNode;
  onScroll?: React.ComponentProps<typeof Animated.ScrollView>["onScroll"];
}) {
  return (
    <ScreenInsets
      edges={
        tab
          ? topInset
            ? ["top", "left", "right"]
            : ["left", "right"]
          : topInset || navigationHeader
            ? ["top", "left", "right", "bottom"]
            : ["left", "right", "bottom"]
      }
      style={styles.screen}
    >
      {navigationHeader}
      {scroll && onScroll ? (
        <Animated.ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={
            compact ? [styles.body, styles.compactBody] : styles.body
          }
          onScroll={onScroll}
          scrollEventThrottle={16}
        >
          {children}
        </Animated.ScrollView>
      ) : scroll ? (
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={
            compact ? [styles.body, styles.compactBody] : styles.body
          }
        >
          {children}
        </ScrollView>
      ) : (
        children
      )}
    </ScreenInsets>
  );
}

export function Card({
  children,
  style,
}: {
  children: ReactNode;
  style?: ViewStyle;
}) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Avatar({
  name,
  publicKey,
  autoLoad = true,
  size = "md",
}: {
  name: string;
  publicKey?: string;
  autoLoad?: boolean;
  size?: GlassAvatarSize;
}) {
  const uri = useAvatar(publicKey, autoLoad);
  return (
    <GlassAvatar
      importantForAccessibility="no"
      name={name}
      identityKey={publicKey}
      src={uri ?? undefined}
      size={size}
    />
  );
}

export function Search(props: GlassInputProps) {
  return (
    <GlassInput
      returnKeyType="search"
      clearButtonMode="while-editing"
      autoCorrect={false}
      {...props}
    />
  );
}

export function Empty({
  icon,
  title,
  detail,
  children,
}: {
  icon: IconName;
  title: string;
  detail: string;
  children?: ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <Card style={styles.empty}>
      <View style={[styles.iconButton, { backgroundColor: colors.selected }]}>
        <Icon name={icon} />
      </View>
      <Ink kind="heading" style={styles.center}>
        {title}
      </Ink>
      <Ink muted style={styles.center}>
        {detail}
      </Ink>
      {children ? <View style={styles.emptyActions}>{children}</View> : null}
    </Card>
  );
}

export function Row({
  leading,
  leadingAction,
  title,
  detail,
  trailing,
  onPress,
  onLongPress,
  accessibilityLabel,
  expanded,
}: {
  leading?: ReactNode;
  leadingAction?: { label: string; onPress: () => void };
  title: string;
  detail?: string;
  trailing?: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  accessibilityLabel?: string;
  expanded?: boolean;
}) {
  const { colors } = useTheme();
  const copy = (
    <View style={styles.rowCopy}>
      <Ink kind="label">{title}</Ink>
      {detail ? (
        <Ink kind="caption" muted numberOfLines={2}>
          {detail}
        </Ink>
      ) : null}
    </View>
  );
  if (leadingAction) {
    return (
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={leadingAction.label}
          onPress={leadingAction.onPress}
          style={({ pressed }) => [
            styles.rowLeading,
            pressed && { opacity: 0.7 },
          ]}
        >
          {leading}
        </Pressable>
        {onPress ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            accessibilityHint={detail}
            onPress={onPress}
            style={({ pressed }) => [
              styles.rowAction,
              pressed && { opacity: 0.7 },
            ]}
          >
            {copy}
            {trailing}
          </Pressable>
        ) : (
          <>
            {copy}
            {trailing}
          </>
        )}
      </View>
    );
  }
  const content = (
    <>
      {leading}
      {copy}
      {trailing}
    </>
  );
  return onPress ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={expanded === undefined ? undefined : { expanded }}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [
        styles.row,
        pressed && { backgroundColor: colors.selected },
      ]}
    >
      {content}
    </Pressable>
  ) : (
    <View style={styles.row}>{content}</View>
  );
}

export const layout = StyleSheet.create({
  inset: { paddingHorizontal: space.xl },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    flexWrap: "wrap",
  },
  stack: { gap: space.lg },
  center: { alignItems: "center", gap: space.md },
});

const styles = StyleSheet.create(({ colors, radius, space }) => ({
  screen: { flex: 1, backgroundColor: colors.background },
  body: {
    width: "100%",
    maxWidth: { wide: 720 },
    alignSelf: "center",
    gap: space.lg,
    paddingHorizontal: {
      compact: space.lg,
      regular: space.xl,
      wide: space.xxl,
    },
    paddingTop: space.md,
    paddingBottom: space.xxl,
  },
  compactBody: {
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    gap: space.md,
  },
  section: { marginTop: space.sm },
  card: {
    borderRadius: radius.card,
    backgroundColor: colors.raised,
    overflow: "hidden",
  },
  empty: { padding: space.xl, alignItems: "center", gap: space.md },
  emptyActions: { alignItems: "center", maxWidth: "100%" },
  center: { textAlign: "center" },
  iconButton: {
    width: 46,
    height: 46,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.round,
  },
  row: {
    minHeight: 68,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
  },
  rowCopy: { flex: 1, gap: 2 },
  rowLeading: {
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  rowAction: {
    flex: 1,
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    borderRadius: radius.input,
  },
}));
