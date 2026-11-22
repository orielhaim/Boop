import { useAvatar } from "@/core/avatars/use-avatar";
import * as Haptics from "expo-haptics";
import { LinearGradient } from "expo-linear-gradient";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Platform,
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
import { ScreenInsets } from "@/components/ui/screen-insets";
import { directionFor, resolveLanguage } from "@/i18n";
import { useAppPreferences } from "@/stores/preferences";
import { radius, space, spring, type, useTheme } from "@/theme";

const icons = {
  phone: { ios: "phone.fill", android: "call" },
  chat: { ios: "bubble.left.fill", android: "chat_bubble" },
  invitations: { ios: "envelope", android: "mail_outline" },
  person: { ios: "person.crop.circle", android: "account_circle" },
  people: { ios: "person.2", android: "group" },
  add: { ios: "plus", android: "add" },
  subtract: { ios: "minus", android: "remove" },
  addPerson: { ios: "person.badge.plus", android: "person_add" },
  search: { ios: "magnifyingglass", android: "search" },
  media: { ios: "photo.on.rectangle", android: "perm_media" },
  bell: { ios: "bell", android: "notifications_none" },
  bellOff: { ios: "bell.slash", android: "notifications_off" },
  more: { ios: "ellipsis", android: "more_horiz" },
  back: { ios: "arrow.left", android: "arrow_back" },
  previous: { ios: "chevron.left", android: "chevron_left" },
  language: { ios: "globe", android: "language" },
  next: { ios: "chevron.right", android: "chevron_right" },
  continue: { ios: "arrow.right", android: "arrow_forward" },
  expand: { ios: "chevron.down", android: "expand_more" },
  collapse: { ios: "chevron.up", android: "expand_less" },
  info: { ios: "info.circle", android: "info" },
  settings: { ios: "gearshape", android: "settings" },
  star: { ios: "star", android: "star_border" },
  favorite: { ios: "star.fill", android: "star" },
  outgoing: { ios: "arrow.up.right", android: "north_east" },
  incoming: { ios: "arrow.down.left", android: "south_west" },
  missed: { ios: "phone.down.fill", android: "call_missed" },
  hangup: { ios: "xmark", android: "close" },
  download: { ios: "arrow.down", android: "download" },
  refresh: { ios: "arrow.clockwise", android: "refresh" },
  play: { ios: "play.fill", android: "play_arrow" },
  storage: { ios: "internaldrive", android: "storage" },
  audio: { ios: "headphones", android: "headphones" },
  qr: { ios: "qrcode.viewfinder", android: "qr_code_scanner" },
  copy: { ios: "document.on.document", android: "content_copy" },
  send: { ios: "arrow.up", android: "arrow_upward" },
  reply: { ios: "arrowshape.turn.up.left", android: "reply" },
  forward: { ios: "arrowshape.turn.up.right", android: "forward" },
  edit: { ios: "pencil", android: "edit" },
  erase: { ios: "delete.left", android: "backspace" },
  mic: { ios: "mic.slash", android: "mic_off" },
  microphone: { ios: "mic.fill", android: "mic" },
  camera: { ios: "video.fill", android: "videocam" },
  photo: { ios: "camera.fill", android: "photo_camera" },
  cameraOff: { ios: "video.slash.fill", android: "videocam_off" },
  cameraSwitch: { ios: "camera.rotate.fill", android: "flip_camera_ios" },
  speaker: { ios: "speaker.wave.2", android: "volume_up" },
  history: { ios: "clock", android: "history" },
  timedLock: { ios: "lock.fill", android: "lock" },
  fingerprint: { ios: "touchid", android: "fingerprint" },
  faceId: { ios: "faceid", android: "face" },
  lock: { ios: "lock.shield.fill", android: "shield" },
  key: { ios: "key.fill", android: "key" },
  palette: { ios: "circle.lefthalf.filled", android: "contrast" },
  connection: { ios: "antenna.radiowaves.left.and.right", android: "sensors" },
  check: { ios: "checkmark", android: "check" },
  pin: { ios: "pin.fill", android: "push_pin" },
} satisfies Record<string, SymbolViewProps["name"]>;

type IconName = keyof typeof icons;
const directionalIcons = new Set<IconName>([
  "back",
  "previous",
  "next",
  "continue",
  "outgoing",
  "incoming",
  "reply",
  "forward",
  "erase",
]);

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
  const { i18n } = useTranslation("common");
  const rtl = directionFor(resolveLanguage(i18n.resolvedLanguage)) === "rtl";
  const mirror =
    directionalIcons.has(name) ||
    (name === "missed" && Platform.OS === "android");
  const symbol = icons[name];
  return (
    <SymbolView
      name={{ ...symbol, web: symbol.android }}
      size={size}
      tintColor={color ?? colors.accent}
      style={rtl && mirror ? { transform: [{ scaleX: -1 }] } : undefined}
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
  topInset = false,
  onScroll,
  compact = false,
}: {
  children: ReactNode;
  scroll?: boolean;
  tab?: boolean;
  topInset?: boolean;
  compact?: boolean;
  onScroll?: React.ComponentProps<typeof Animated.ScrollView>["onScroll"];
}) {
  const { colors } = useTheme();
  return (
    <ScreenInsets
      edges={
        tab
          ? ["top", "left", "right"]
          : topInset
            ? ["top", "left", "right", "bottom"]
            : ["left", "right", "bottom"]
      }
      style={[styles.screen, { backgroundColor: colors.background }]}
    >
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
  compactBody: {
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    gap: space.md,
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
});
