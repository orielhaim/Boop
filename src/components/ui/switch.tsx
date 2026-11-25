import { useCallback, useEffect, useMemo } from "react";
import { I18nManager, Pressable, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import Animated, {
  ReduceMotion,
  interpolate,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  type SharedValue,
} from "react-native-reanimated";
import { tapFeedback } from "@/components/ui/kit";
import { spring, useTheme } from "@/theme";

const trackWidth = 51;
const trackHeight = 31;
const inset = 2;
const thumbSize = trackHeight - inset * 2;
const travel = trackWidth - thumbSize - inset * 2;
type SwitchInteraction = {
  progress: SharedValue<number>;
  pressed: SharedValue<number>;
  toggle: () => void;
  onPressIn: () => void;
  onPressOut: () => void;
};

export function useSwitchInteraction({
  checked,
  onCheckedChange,
  disabled = false,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}): SwitchInteraction {
  const { reduceMotion } = useTheme();
  const progress = useSharedValue(checked ? 1 : 0);
  const pressed = useSharedValue(0);
  const motion = useMemo(
    () => ({
      ...spring,
      reduceMotion: reduceMotion ? ReduceMotion.Always : ReduceMotion.System,
    }),
    [reduceMotion],
  );

  useEffect(() => {
    progress.value = withSpring(checked ? 1 : 0, motion);
  }, [checked, motion, progress]);

  const toggle = useCallback(() => {
    if (!disabled) onCheckedChange(!checked);
  }, [checked, disabled, onCheckedChange]);
  const onPressIn = useCallback(() => {
    if (!disabled) pressed.set(withSpring(1, motion));
  }, [disabled, motion, pressed]);
  const onPressOut = useCallback(() => {
    pressed.set(withSpring(0, motion));
  }, [motion, pressed]);

  return { progress, pressed, toggle, onPressIn, onPressOut };
}

export function SwitchVisual({
  interaction,
  rtl,
}: {
  interaction: SwitchInteraction;
  rtl?: boolean;
}) {
  const { colors } = useTheme();
  const direction = rtl ?? I18nManager.isRTL;
  const offTrack = colors.muted;
  const onTrack = colors.accent;
  const { progress, pressed } = interaction;
  const thumbAnimation = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      progress.value,
      [0, 1],
      [colors.raised, colors.onAccent],
    ),
  }));
  const trackAnimation = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      progress.value,
      [0, 1],
      [offTrack, onTrack],
    ),
  }));
  const thumbPosition = useAnimatedStyle(() => {
    const stretch = interpolate(pressed.value, [0, 1], [1, 1.25]);
    const directionSign = direction ? -1 : 1;
    const anchor = interpolate(
      progress.value,
      [0, 1],
      [directionSign, -directionSign],
    );
    const overflow = (thumbSize * (stretch - 1)) / 2;
    const offset = direction
      ? (1 - progress.value) * travel
      : progress.value * travel;
    return {
      transform: [
        { translateX: offset + anchor * overflow },
        { scaleX: stretch },
      ],
    };
  });

  return (
    <View pointerEvents="none" style={styles.target}>
      <Animated.View
        style={[styles.track, { backgroundColor: offTrack }, trackAnimation]}
      >
        <Animated.View
          style={[
            styles.thumb,
            { backgroundColor: colors.raised },
            thumbAnimation,
            thumbPosition,
          ]}
        />
      </Animated.View>
    </View>
  );
}

export function Switch({
  checked,
  onCheckedChange,
  accessibilityLabel,
  disabled = false,
  rtl,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  accessibilityLabel: string;
  disabled?: boolean;
  rtl?: boolean;
}) {
  const interaction = useSwitchInteraction({
    checked,
    onCheckedChange,
    disabled,
  });

  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={() => {
        tapFeedback();
        interaction.toggle();
      }}
      onPressIn={interaction.onPressIn}
      onPressOut={interaction.onPressOut}
      style={({ pressed }) => [
        styles.standalone,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
      ]}
    >
      <SwitchVisual interaction={interaction} rtl={rtl} />
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  standalone: {
    minWidth: 48,
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.round,
  },
  target: {
    minWidth: 48,
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  track: {
    width: trackWidth,
    height: trackHeight,
    padding: inset,
    borderRadius: trackHeight / 2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.line,
    justifyContent: "center",
    direction: "ltr",
  },
  thumb: {
    width: thumbSize,
    height: thumbSize,
    borderRadius: thumbSize / 2,
    shadowColor: theme.colors.text,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.18,
    shadowRadius: 3,
    elevation: 2,
  },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.86 },
}));
