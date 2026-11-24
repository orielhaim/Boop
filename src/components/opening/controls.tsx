import { LinearGradient } from "expo-linear-gradient";
import {
  Pressable,
  Text,
  TextInput,
  type TextInputProps,
  View,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { Icon, tapFeedback } from "@/components/ui/kit";
import { useTheme } from "@/theme";
import { openingMotion, openingPalette } from "./brand";

export function OpeningButton({
  label,
  onPress,
  primary = false,
  disabled = false,
  icon = "continue",
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  disabled?: boolean;
  icon?: "continue" | "download" | "check";
}) {
  const { colors, theme, reduceMotion, reduceTransparency } = useTheme();
  const pressed = useSharedValue(0);
  const ink = primary ? "#FFFFFF" : openingPalette[theme].ink;
  const press = useAnimatedStyle(() => ({
    transform: [{ scale: reduceMotion ? 1 : 1 - 0.024 * pressed.get() }],
  }));
  const gloss = useAnimatedStyle(() => ({ opacity: pressed.get() * 0.12 }));
  function setPressed(value: number) {
    pressed.set(
      value
        ? withTiming(value, { duration: 105, easing: openingMotion.glide })
        : withSpring(value, openingMotion.press),
    );
  }
  return (
    <Animated.View style={press}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={() => {
          tapFeedback();
          onPress();
        }}
        onPressIn={() => setPressed(1)}
        onPressOut={() => setPressed(0)}
        style={[
          styles.button,
          {
            backgroundColor: primary
              ? "#373DB8"
              : reduceTransparency
                ? colors.raised
                : theme === "dark"
                  ? "#242D4A"
                  : "#FFFFFFB8",
            borderColor: primary
              ? "#767CED"
              : theme === "dark"
                ? "#424F77"
                : "#C4CFFF",
            opacity: disabled ? 0.51 : 1,
          },
        ]}
      >
        {primary && (
          <LinearGradient
            colors={
              theme === "dark" ? ["#505ACC", "#3835A6"] : ["#444BD1", "#322F9F"]
            }
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
        )}
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: primary ? "#FFF" : colors.accent },
            gloss,
          ]}
        />
        <Text style={[styles.buttonLabel, { color: ink }]}>{label}</Text>
        <Icon name={icon} size={20} color={ink} />
      </Pressable>
    </Animated.View>
  );
}

export function OpeningField({
  label,
  ...input
}: TextInputProps & { label: string }) {
  const { colors, theme, reduceMotion } = useTheme();
  const focus = useSharedValue(0);
  const border = useAnimatedStyle(() => ({ opacity: focus.get() }));
  function changeFocus(value: number) {
    focus.set(withTiming(value, { duration: reduceMotion ? 0 : 160 }));
  }
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: openingPalette[theme].ink }]}>
        {label}
      </Text>
      <View
        style={[
          styles.inputShell,
          {
            borderColor: colors.line,
            backgroundColor: colors.raised,
          },
        ]}
      >
        <Animated.View
          pointerEvents="none"
          style={[styles.inputBorder, { borderColor: colors.accent }, border]}
        />
        <TextInput
          {...input}
          accessibilityLabel={label}
          cursorColor={colors.accent}
          selectionColor={colors.selected}
          onFocus={(event) => {
            changeFocus(1);
            input.onFocus?.(event);
          }}
          onBlur={(event) => {
            changeFocus(0);
            input.onBlur?.(event);
          }}
          style={[
            styles.input,
            input.multiline && styles.multiline,
            { color: colors.text },
            input.style,
          ]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    overflow: "hidden",
    borderRadius: 23,
    borderWidth: 1,
    minHeight: 60,
    paddingHorizontal: 21,
    paddingVertical: 15,
    gap: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  buttonLabel: { fontSize: 17, fontWeight: "700", flexShrink: 1 },
  field: { gap: 8 },
  label: { fontSize: 14, fontWeight: "600" },
  inputShell: { borderRadius: 18, borderWidth: 1 },
  inputBorder: {
    ...StyleSheet.absoluteFill,
    borderWidth: 1.5,
    borderRadius: 17,
  },
  input: {
    minHeight: 56,
    fontSize: 17,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  multiline: { minHeight: 92, textAlignVertical: "top" },
});
