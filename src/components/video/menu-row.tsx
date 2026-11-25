import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export function MenuRow({
  label,
  detail,
  selected,
  disabled,
  action,
}: {
  label: string;
  detail?: string;
  selected?: boolean;
  disabled?: boolean;
  action(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={action}
      style={({ pressed }) => [
        styles.row,
        (pressed || disabled) && styles.dimmed,
      ]}
    >
      <Text style={styles.label}>{label}</Text>
      {detail && <Text style={styles.detail}>{detail}</Text>}
      {selected && <View style={styles.selected} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.15)",
  },
  dimmed: { opacity: 0.65 },
  label: { color: "#fff", fontSize: 15, flex: 1 },
  detail: { color: "rgba(255,255,255,0.7)", fontSize: 12 },
  selected: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: "#fff",
  },
});
