import { StyleSheet, View } from "react-native";
import { Ink } from "@/components/ui/kit";
import { MorphLoader } from "@/components/ui/organisms/morph-loader";
import { space } from "@/theme";

export function LoadingStatus({ label }: { label: string }) {
  return (
    <View
      accessible
      accessibilityLabel={label}
      accessibilityLiveRegion="polite"
      accessibilityState={{ busy: true }}
      style={styles.row}
    >
      <MorphLoader />
      <Ink kind="caption" muted style={styles.label}>
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
