import { useTranslation } from "react-i18next";
import {
  Pressable,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import {
  GlassSurface,
  type SurfaceElevation,
} from "@/components/glassyui/glass-surface";
import { Icon, tapFeedback } from "@/components/ui/kit";
import { useTheme } from "@/theme";

export const backButtonSize = 44;

export function GlassBackIcon({
  color,
  elevation,
}: {
  color?: string;
  elevation?: SurfaceElevation;
}) {
  const { colors } = useTheme();
  return (
    <GlassSurface
      preset="control"
      elevation={elevation}
      pointerEvents="none"
      style={styles.circle}
    >
      <Icon name="back" size={21} color={color ?? colors.text} />
    </GlassSurface>
  );
}

export function GlassBackButton({
  onPress,
  style,
  elevation,
}: {
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
  elevation?: SurfaceElevation;
}) {
  const { t } = useTranslation("common");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("back")}
      onPress={() => {
        tapFeedback();
        onPress();
      }}
      style={({ pressed }) => [style, pressed && styles.pressed]}
    >
      <GlassBackIcon elevation={elevation} />
    </Pressable>
  );
}

export function glassStackBack(goBack: () => void) {
  return {
    headerBackVisible: false,
    headerLeft: ({ canGoBack }: { canGoBack?: boolean }) =>
      canGoBack ? <GlassBackButton onPress={goBack} elevation="none" /> : null,
  };
}

const styles = StyleSheet.create({
  circle: {
    width: backButtonSize,
    height: backButtonSize,
    borderRadius: backButtonSize / 2,
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: { opacity: 0.72 },
});
