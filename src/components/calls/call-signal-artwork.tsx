import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Icon } from "@/components/ui/kit";
import { useTheme } from "@/theme";

const wave = [
  4, 12, 20, 34, 22, 44, 27, 16, 8, 13, 20, 27, 23, 16, 8, 13, 24, 15, 30, 39,
  22, 14, 8, 4,
];

export function CallSignalArtwork() {
  const { colors } = useTheme();

  return (
    <View style={styles.scene}>
      <View style={[styles.ring, styles.outerRing]}>
        <View style={[styles.marker, styles.firstMarker]} />
        <View style={[styles.marker, styles.secondMarker]} />
      </View>
      <View style={[styles.ring, styles.innerRing]} />
      <View style={styles.axis} />
      <View style={styles.waveform}>
        {wave.map((height, index) => (
          <View
            key={index}
            style={[styles.bar, { height }, height >= 20 && styles.strongBar]}
          />
        ))}
      </View>
      <View style={styles.receiver}>
        <View style={styles.receiverFace}>
          <Icon name="phone" size={32} weight="duotone" color={colors.accent} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create(({ colors, radius }) => ({
  scene: {
    width: "100%",
    maxWidth: 228,
    height: 152,
    alignItems: "center",
    justifyContent: "center",
  },
  ring: {
    position: "absolute",
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.round,
  },
  outerRing: { width: 140, height: 140 },
  innerRing: { width: 102, height: 102, backgroundColor: colors.recessed },
  marker: {
    position: "absolute",
    width: 7,
    height: 7,
    borderRadius: radius.round,
    backgroundColor: colors.selected,
    borderWidth: 1,
    borderColor: colors.line,
  },
  firstMarker: { top: 12, end: 24 },
  secondMarker: { bottom: 13, start: 23 },
  axis: {
    position: "absolute",
    width: "94%",
    height: 1,
    backgroundColor: colors.line,
  },
  waveform: {
    width: "94%",
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  bar: { width: 3, borderRadius: radius.round, backgroundColor: colors.line },
  strongBar: { backgroundColor: colors.accent, opacity: 0.22 },
  receiver: {
    position: "absolute",
    width: 74,
    height: 74,
    borderWidth: 1,
    borderBottomWidth: 3,
    borderColor: colors.line,
    borderRadius: radius.round,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.raised,
  },
  receiverFace: {
    width: 58,
    height: 58,
    borderRadius: radius.round,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.selected,
  },
}));
