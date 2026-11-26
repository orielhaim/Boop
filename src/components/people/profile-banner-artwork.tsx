import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTheme } from "@/theme";

export function ProfileBannerArtwork({ source }: { source?: string }) {
  const { colors, reduceTransparency } = useTheme();
  return (
    <View pointerEvents="none" style={styles.artwork}>
      {!reduceTransparency && (
        <LinearGradient
          colors={[colors.heroStart, colors.selected, colors.heroEnd]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
      )}
      {source ? (
        <Image
          source={source}
          contentFit="cover"
          style={StyleSheet.absoluteFill}
        />
      ) : (
        <View style={styles.orbit} />
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  artwork: { ...StyleSheet.absoluteFill, overflow: "hidden" },
  orbit: {
    position: "absolute",
    width: 280,
    height: 280,
    borderRadius: 140,
    borderWidth: 1,
    borderColor: theme.colors.line,
    end: -28,
    top: -160,
  },
}));
