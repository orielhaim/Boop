import { Children, type ComponentProps, type ReactNode } from "react";
import { Pressable, StyleSheet, Switch, View } from "react-native";
import { Card, Icon, Ink, Section, tapFeedback } from "@/components/ui/kit";
import { space, useTheme } from "@/theme";

export function SettingsGroup({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.group}>
      {title && <Section>{title}</Section>}
      <Card style={styles.card}>
        {Children.map(Children.toArray(children), (child, index) => (
          <>
            {index > 0 && (
              <View
                style={[styles.divider, { backgroundColor: colors.line }]}
              />
            )}
            {child}
          </>
        ))}
      </Card>
    </View>
  );
}

export function SettingsDescription({ children }: { children: ReactNode }) {
  return (
    <Ink
      kind="caption"
      muted
      style={styles.description}
      accessibilityLiveRegion="polite"
    >
      {children}
    </Ink>
  );
}

export function SettingsRow({
  title,
  detail,
  value,
  icon,
  accent,
  onPress,
  selected,
  expanded,
  disabled = false,
  trailing,
}: {
  title: string;
  detail?: string;
  value?: string;
  icon?: ComponentProps<typeof Icon>["name"];
  accent?: string;
  onPress?: () => void;
  selected?: boolean;
  expanded?: boolean;
  disabled?: boolean;
  trailing?: ReactNode;
}) {
  const { colors } = useTheme();
  const content = (
    <>
      {icon && (
        <View
          style={[styles.icon, { backgroundColor: accent ?? colors.outgoing }]}
        >
          <Icon name={icon} size={19} color="#fff" />
        </View>
      )}
      <View style={styles.label}>
        <Ink kind="label">{title}</Ink>
        {detail && (
          <Ink kind="caption" muted>
            {detail}
          </Ink>
        )}
      </View>
      {value && (
        <Ink kind="caption" muted style={styles.value}>
          {value}
        </Ink>
      )}
      {selected ? (
        <Icon name="check" size={18} />
      ) : (
        (trailing ??
        (onPress && selected === undefined ? (
          <Icon name="next" size={17} color={colors.muted} />
        ) : null))
      )}
    </>
  );
  return onPress ? (
    <Pressable
      disabled={disabled}
      accessibilityRole={selected === undefined ? "button" : "radio"}
      accessibilityState={{ disabled, expanded, checked: selected }}
      onPress={() => {
        tapFeedback();
        onPress();
      }}
      style={({ pressed }) => [
        styles.row,
        disabled && { opacity: 0.5 },
        selected && { backgroundColor: colors.accentSoft },
        pressed && { backgroundColor: colors.background },
      ]}
    >
      {content}
    </Pressable>
  ) : (
    <View style={styles.row}>{content}</View>
  );
}

export function SettingsToggle({
  title,
  detail,
  value,
  onChange,
  disabled,
}: {
  title: string;
  detail?: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <SettingsRow
      title={title}
      detail={detail}
      trailing={
        <Switch
          accessibilityLabel={title}
          value={value}
          onValueChange={onChange}
          disabled={disabled}
          trackColor={{ true: colors.accent }}
        />
      }
    />
  );
}

const styles = StyleSheet.create({
  group: { gap: space.sm },
  card: { overflow: "hidden" },
  divider: { height: StyleSheet.hairlineWidth, marginHorizontal: space.lg },
  row: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  icon: {
    width: 32,
    height: 32,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  label: { flex: 1, gap: 3 },
  value: { flexShrink: 1, maxWidth: "48%" },
  description: { marginHorizontal: space.sm },
});
