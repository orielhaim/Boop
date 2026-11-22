import type { ComponentProps, ReactNode } from "react";
import {
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Icon, Ink, tapFeedback } from "@/components/ui/kit";
import { radius, space, useTheme } from "@/theme";

type IconName = ComponentProps<typeof Icon>["name"];

export function CompactHeader({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <View style={styles.header}>
      <Ink kind="heading" accessibilityRole="header" style={styles.title}>
        {title}
      </Ink>
      <View style={styles.trailing}>{children}</View>
    </View>
  );
}

export function QuietState({
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
  return (
    <View style={styles.quiet}>
      <Icon name={icon} size={24} />
      <Ink kind="label" style={styles.center}>
        {title}
      </Ink>
      {detail ? (
        <Ink kind="caption" muted style={styles.center}>
          {detail}
        </Ink>
      ) : null}
      {children}
    </View>
  );
}

export function CompactAction({
  icon,
  label,
  onPress,
  prominent,
  iconOnly,
  disabled,
  style,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  prominent?: boolean;
  iconOnly?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={() => {
        tapFeedback();
        onPress();
      }}
      style={({ pressed }) => [
        styles.action,
        {
          backgroundColor: prominent ? colors.outgoing : colors.surface,
          opacity: disabled ? 0.45 : pressed ? 0.72 : 1,
        },
        iconOnly && styles.iconOnly,
        style,
      ]}
    >
      <Icon
        name={icon}
        size={17}
        color={prominent ? colors.outgoingInk : colors.accent}
      />
      {!iconOnly && (
        <Ink
          kind="caption"
          numberOfLines={1}
          style={{
            fontWeight: "600",
            color: prominent ? colors.outgoingInk : colors.text,
          }}
        >
          {label}
        </Ink>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: {
    minHeight: 46,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.sm,
  },
  title: { flexShrink: 1, fontSize: 22 },
  trailing: { flexDirection: "row", gap: space.xs },
  quiet: {
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.xl,
    paddingVertical: space.xl,
  },
  center: { textAlign: "center", maxWidth: 320 },
  action: {
    minHeight: 44,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: space.md,
  },
  iconOnly: { width: 44, borderRadius: radius.round, paddingHorizontal: 0 },
});
