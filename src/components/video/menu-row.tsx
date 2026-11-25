import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Icon, type IconName } from "@/components/ui/icon";
import { useTheme } from "@/theme";

export function MenuRow({
  label,
  detail,
  selected,
  disabled,
  action,
  icon,
  navigates = false,
}: {
  label: string;
  detail?: string;
  selected?: boolean;
  disabled?: boolean;
  action(): void;
  icon?: IconName;
  navigates?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      accessibilityLabel={label}
      accessibilityValue={detail ? { text: detail } : undefined}
      disabled={disabled}
      onPress={action}
      style={({ pressed }) => [
        styles.row,
        selected && styles.selected,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      {icon && <Icon name={icon} size={20} color={colors.muted} />}
      <Text style={styles.label} numberOfLines={2}>
        {label}
      </Text>
      {!!detail && (
        <Text style={styles.detail} numberOfLines={1}>
          {detail}
        </Text>
      )}
      {navigates ? (
        <Icon name="next" size={17} color={colors.muted} />
      ) : (
        selected !== undefined && (
          <View style={styles.indicator}>
            {selected && (
              <Icon
                name="check"
                size={19}
                color={colors.accent}
                weight="bold"
              />
            )}
          </View>
        )
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.sm,
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.sm,
    borderRadius: theme.radius.input,
  },
  selected: { backgroundColor: theme.colors.selected },
  pressed: { backgroundColor: theme.colors.pressed },
  disabled: { opacity: 0.55 },
  label: { ...theme.type.label, color: theme.colors.text, flex: 1 },
  detail: {
    ...theme.type.caption,
    color: theme.colors.muted,
    flexShrink: 1,
    maxWidth: "42%",
  },
  indicator: { width: 19, alignItems: "center" },
}));
