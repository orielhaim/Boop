import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Icon } from "@/components/ui/kit";
import { useTheme } from "@/theme";

export function ContactCardArtwork() {
  const { colors } = useTheme();

  return (
    <View style={styles.scene}>
      <View style={[styles.card, styles.backCard]}>
        <View style={styles.indexTab} />
        <View style={styles.ghostPortrait} />
        <View style={[styles.line, styles.longLine]} />
      </View>
      <View style={[styles.card, styles.middleCard]}>
        <View style={styles.ghostPortrait} />
        <View style={[styles.line, styles.longLine]} />
        <View style={[styles.line, styles.shortLine]} />
      </View>
      <View style={[styles.card, styles.frontCard]}>
        <View style={styles.portrait}>
          <Icon
            name="person"
            size={42}
            weight="duotone"
            color={colors.accent}
          />
        </View>
        <View style={[styles.line, styles.name]} />
        <View style={[styles.line, styles.shortLine]} />
      </View>
      <View style={styles.badge}>
        <Icon name="add" size={15} weight="bold" color={colors.accent} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create(({ colors, radius }) => ({
  scene: { direction: "ltr", width: "100%", maxWidth: 222, height: 152 },
  card: {
    position: "absolute",
    width: "45%",
    height: 106,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.grouped,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  backCard: {
    start: "11%",
    top: 28,
    backgroundColor: colors.recessed,
    transform: [{ rotate: "-18deg" }],
  },
  indexTab: {
    position: "absolute",
    start: 15,
    top: -5,
    width: 24,
    height: 5,
    borderTopLeftRadius: 4,
    borderTopRightRadius: 4,
    backgroundColor: colors.line,
  },
  middleCard: {
    end: "11%",
    top: 25,
    backgroundColor: colors.raised,
    transform: [{ rotate: "16deg" }],
  },
  frontCard: {
    start: "27.5%",
    top: 16,
    height: 116,
    borderBottomWidth: 3,
    gap: 7,
  },
  ghostPortrait: {
    width: 34,
    height: 34,
    borderRadius: radius.round,
    backgroundColor: colors.line,
  },
  portrait: {
    width: 52,
    height: 52,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.round,
    backgroundColor: colors.selected,
  },
  line: { height: 5, borderRadius: radius.round, backgroundColor: colors.line },
  name: { width: "55%", marginTop: 2, backgroundColor: colors.selected },
  longLine: { width: "53%" },
  shortLine: { width: "34%" },
  badge: {
    position: "absolute",
    end: "21%",
    bottom: 13,
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: colors.background,
    borderRadius: radius.round,
    backgroundColor: colors.selected,
  },
}));
