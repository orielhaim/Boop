import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Ink } from "@/components/ui/kit";
import { MorphLoader } from "@/components/ui/organisms/morph-loader";
import { space } from "@/theme";

export function LoadingStatus({
  label,
  color,
}: {
  label: string;
  color?: string;
}) {
  return (
    <View
      accessible
      accessibilityLabel={label}
      accessibilityLiveRegion="polite"
      accessibilityState={{ busy: true }}
      style={styles.row}
    >
      <MorphLoader color={color} />
      <Ink
        kind="caption"
        muted
        style={[styles.label, color ? { color } : undefined]}
      >
        {label}
      </Ink>
    </View>
  );
}
const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
  },
  label: { flexShrink: 1 },
});
