import { useTranslation } from "react-i18next";
import { Pressable, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  GlassSurface,
  type SurfaceElevation,
} from "@/components/glassyui/glass-surface";
import { Icon, tapFeedback } from "@/components/ui/kit";
import { directionFor, resolveLanguage } from "@/i18n";
import { space, useTheme } from "@/theme";

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
      lensTint
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
  dimOnPress = true,
}: {
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
  elevation?: SurfaceElevation;
  dimOnPress?: boolean;
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
      style={({ pressed }) => [style, dimOnPress && pressed && styles.pressed]}
    >
      <GlassBackIcon elevation={elevation} />
    </Pressable>
  );
}

export function ChatProfileBackButton({ onPress }: { onPress: () => void }) {
  const { top, left, right } = useSafeAreaInsets();
  const { i18n } = useTranslation();
  const rtl = directionFor(resolveLanguage(i18n.resolvedLanguage)) === "rtl";
  return (
    <GlassBackButton
      onPress={onPress}
      elevation="none"
      dimOnPress={false}
      style={[
        styles.profileBack,
        {
          top: top + space.xs,
          ...(rtl ? { right: right + space.sm } : { left: left + space.sm }),
        },
      ]}
    />
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
  profileBack: { position: "absolute", zIndex: 1 },
});
