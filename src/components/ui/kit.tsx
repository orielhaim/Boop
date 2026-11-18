import * as Haptics from "expo-haptics";
import { LinearGradient } from "expo-linear-gradient";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import type { ReactNode } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  type TextProps,
  View,
  type ViewStyle,
} from "react-native";
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  GlassAvatar,
  type GlassAvatarSize,
} from "@/components/glassyui/glass-avatar";
import { GlassBackdrop } from "@/components/glassyui/glass-backdrop";
import {
  GlassButton,
  type GlassButtonProps,
} from "@/components/glassyui/glass-button";
import {
  GlassInput,
  type GlassInputProps,
} from "@/components/glassyui/glass-input";
import { GlassPanel } from "@/components/glassyui/glass-panel";
import { useAppPreferences } from "@/stores/preferences";
import { radius, space, spring, type, useTheme } from "@/theme";

const icons = {
  phone: { ios: "phone.fill", android: "call" },
  chat: { ios: "bubble.left.fill", android: "chat_bubble" },
  person: { ios: "person.crop.circle", android: "account_circle" },
  add: { ios: "plus", android: "add" },
  search: { ios: "magnifyingglass", android: "search" },
  next: { ios: "chevron.forward", android: "chevron_right" },
  expand: { ios: "chevron.down", android: "expand_more" },
  collapse: { ios: "chevron.up", android: "expand_less" },
  info: { ios: "info.circle", android: "info" },
  settings: { ios: "gearshape", android: "settings" },
  star: { ios: "star", android: "star_border" },
  favorite: { ios: "star.fill", android: "star" },
  outgoing: { ios: "arrow.up.right", android: "north_east" },
  incoming: { ios: "arrow.down.left", android: "south_west" },
  missed: { ios: "phone.down.fill", android: "call_missed" },
  qr: { ios: "qrcode.viewfinder", android: "qr_code_scanner" },
  copy: { ios: "document.on.document", android: "content_copy" },
  send: { ios: "arrow.up", android: "arrow_upward" },
  mic: { ios: "mic.slash", android: "mic_off" },
  speaker: { ios: "speaker.wave.2", android: "volume_up" },
  history: { ios: "clock", android: "history" },
} satisfies Record<string, SymbolViewProps["name"]>;

type IconName = keyof typeof icons;

export function Icon({
  name,
  size = 22,
  color,
}: {
  name: IconName;
  size?: number;
  color?: string;
}) {
  const { colors } = useTheme();
  const symbol = icons[name];
  return (
    <SymbolView
      name={{ ...symbol, web: symbol.android }}
      size={size}
      tintColor={color ?? colors.accent}
      accessible={false}
    />
  );
}

export function Ink({
  kind = "body",
  muted,
  style,
  ...props
}: TextProps & { kind?: keyof typeof type; muted?: boolean }) {
  const { colors } = useTheme();
  return (
    <Text
      {...props}
      style={[
        type[kind],
        { color: muted ? colors.muted : colors.text, textAlign: "auto" },
        style,
      ]}
    />
  );
}

export function IconButton({
  icon,
  label,
  onPress,
  disabled,
  tone = "normal",
}: {
  icon: IconName;
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  tone?: "normal" | "danger" | "accent";
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
        : colors.accentSoft;
  const tint =
    tone === "danger"
      ? colors.onDanger
      : tone === "accent"
        ? colors.outgoingInk
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
        ]}
      >
        <Icon name={icon} color={tint} />
      </Pressable>
    </Animated.View>
  );
}

function tapFeedback() {
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

export function Header({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <View style={styles.header}>
      <Ink kind="title" accessibilityRole="header" style={styles.headerTitle}>
        {title}
      </Ink>
      <View style={styles.actions}>{children}</View>
    </View>
  );
}

export function Section({ children }: { children: ReactNode }) {
  return (
    <Ink kind="heading" accessibilityRole="header" style={styles.section}>
      {children}
    </Ink>
  );
}

export function Screen({
  children,
  scroll = true,
  tab = false,
}: {
  children: ReactNode;
  scroll?: boolean;
  tab?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <SafeAreaView
      edges={tab ? ["top", "left", "right"] : ["left", "right", "bottom"]}
      style={[styles.screen, { backgroundColor: colors.background }]}
    >
      {scroll ? (
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={styles.body}
        >
          {children}
        </ScrollView>
      ) : (
        children
      )}
    </SafeAreaView>
  );
}

export function Hero({ children }: { children: ReactNode }) {
  const { colors, reduceTransparency } = useTheme();
  return (
    <GlassBackdrop
      style={styles.hero}
      backdrop={
        reduceTransparency ? undefined : (
          <LinearGradient
            colors={[colors.heroStart, colors.heroEnd]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
        )
      }
    >
      <GlassPanel style={[styles.heroPanel, { borderColor: colors.line }]}>
        {children}
      </GlassPanel>
    </GlassBackdrop>
  );
}

export function Card({
  children,
  style,
}: {
  children: ReactNode;
  style?: ViewStyle;
}) {
  const { colors } = useTheme();
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: colors.surface, borderColor: colors.line },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function Avatar({
  name,
  uri,
  size = "md",
}: {
  name: string;
  uri?: string | null;
  size?: GlassAvatarSize;
}) {
  return (
    <GlassAvatar
      importantForAccessibility="no"
      name={name}
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
      <View style={[styles.iconButton, { backgroundColor: colors.accentSoft }]}>
        <Icon name={icon} />
      </View>
      <Ink kind="heading" style={styles.center}>
        {title}
      </Ink>
      <Ink muted style={styles.center}>
        {detail}
      </Ink>
      {children}
    </Card>
  );
}

export function Row({
  leading,
  title,
  detail,
  trailing,
  onPress,
  expanded,
}: {
  leading?: ReactNode;
  title: string;
  detail?: string;
  trailing?: ReactNode;
  onPress?: () => void;
  expanded?: boolean;
}) {
  const { colors } = useTheme();
  const content = (
    <>
      {leading}
      <View style={styles.rowCopy}>
        <Ink kind="label">{title}</Ink>
        {detail ? (
          <Ink kind="caption" muted numberOfLines={2}>
            {detail}
          </Ink>
        ) : null}
      </View>
      {trailing}
    </>
  );
  return onPress ? (
    <Pressable
      accessibilityRole="button"
      accessibilityState={expanded === undefined ? undefined : { expanded }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        pressed && { backgroundColor: colors.accentSoft },
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

const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: {
    gap: space.lg,
    paddingHorizontal: space.xl,
    paddingTop: space.md,
    paddingBottom: space.xxl,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.sm,
    minHeight: 58,
  },
  headerTitle: { flexShrink: 1 },
  actions: { flexDirection: "row", gap: space.sm },
  section: { marginTop: space.sm },
  hero: { borderRadius: radius.card, overflow: "hidden" },
  heroPanel: { padding: space.xl, gap: space.sm, borderRadius: radius.card },
  card: {
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  empty: { padding: space.xl, alignItems: "center", gap: space.md },
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
});
