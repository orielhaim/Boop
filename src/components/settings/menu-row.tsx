import type { ComponentProps } from "react";
import { StyleSheet, View } from "react-native";
import { ActionMenu } from "@/components/ui/action-menu";
import { Icon, Ink, tapFeedback } from "@/components/ui/kit";
import { space, useTheme } from "@/theme";
import { SettingsRow } from "./group";

export function SettingsMenuRow<Value extends string | number>({
  title,
  detail,
  icon,
  value,
  options,
  disabled = false,
  onChange,
  onTitlePress,
  menuLabel = title,
}: {
  title: string;
  detail?: string;
  icon?: ComponentProps<typeof Icon>["name"];
  value: Value;
  options: readonly { value: Value; label: string }[];
  disabled?: boolean;
  onChange: (value: Value) => void;
  onTitlePress?: () => void;
  menuLabel?: string;
}) {
  const { colors } = useTheme();
  const label = options.find((option) => option.value === value)?.label;
  return (
    <SettingsRow
      title={title}
      detail={detail}
      icon={icon}
      onTitlePress={onTitlePress}
      trailing={
        disabled ? (
          <Ink kind="caption" muted>
            {label}
          </Ink>
        ) : (
          <ActionMenu
            style={styles.menu}
            label={menuLabel}
            value={label}
            actions={options.map((option) => ({
              id: String(option.value),
              title: option.label,
              state: option.value === value ? "on" : "off",
            }))}
            onSelect={(id) => {
              const option = options.find(
                (option) => String(option.value) === id,
              );
              if (!option || option.value === value) return;
              tapFeedback();
              onChange(option.value);
            }}
          >
            <View style={styles.trigger}>
              <Ink kind="caption" muted style={styles.label}>
                {label}
              </Ink>
              <Icon name="expand" size={15} color={colors.muted} />
            </View>
          </ActionMenu>
        )
      }
    />
  );
}

const styles = StyleSheet.create({
  menu: { maxWidth: "48%", flexShrink: 1 },
  trigger: {
    minHeight: 44,
    minWidth: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
  },
  label: { flexShrink: 1 },
});
