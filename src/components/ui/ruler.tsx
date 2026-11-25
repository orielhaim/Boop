/*
 * Adapted from Reacticx Ruler, Copyright (c) 2026 rit3zh.
 * https://github.com/rit3zh/reacticx/blob/main/src/components/base/ruler
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { useEffect, useMemo } from "react";
import { View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import {
  useDerivedValue,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { Canvas, Group, Line } from "react-native-skia";
import { StyleSheet } from "react-native-unistyles";
import { useTheme } from "@/theme";
import { motion } from "@/theme/tokens";

const spacing = 12;
const height = 58;

export function Ruler({
  width,
  ticks,
  value,
  onValueChange,
  onValueCommit,
  label,
  valueText,
}: {
  width: number;
  ticks: readonly { major: boolean }[];
  value: number;
  onValueChange: (index: number) => void;
  onValueCommit: (index: number) => void;
  label: string;
  valueText: string;
}) {
  const { colors, reduceMotion } = useTheme();
  const maximum = ticks.length - 1;
  const center = width / 2;
  const translation = useSharedValue(-value * spacing);
  const selected = useSharedValue(value);
  const dragging = useSharedValue(false);

  useEffect(() => {
    if (dragging.get()) return;
    selected.set(value);
    translation.set(-value * spacing);
  }, [dragging, selected, translation, value]);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-4, 4])
        .failOffsetY([-10, 10])
        .onStart(() => dragging.set(true))
        .onChange(({ changeX }) => {
          const next = Math.max(
            -maximum * spacing,
            Math.min(0, translation.get() + changeX),
          );
          translation.set(next);
          const index = Math.round(-next / spacing);
          if (index !== selected.get()) {
            selected.set(index);
            scheduleOnRN(onValueChange, index);
          }
        })
        .onFinalize(() => {
          if (!dragging.get()) return;
          const index = selected.get();
          dragging.set(false);
          scheduleOnRN(onValueCommit, index);
          const target = -index * spacing;
          translation.set(
            reduceMotion ? target : withSpring(target, motion.travel),
          );
        }),
    [
      dragging,
      maximum,
      onValueChange,
      onValueCommit,
      reduceMotion,
      selected,
      translation,
    ],
  );

  const transform = useDerivedValue(() => [{ translateX: translation.get() }]);

  return (
    <GestureDetector gesture={pan}>
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityValue={{ text: valueText }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={({ nativeEvent }) => {
          const offset = nativeEvent.actionName === "increment" ? 1 : -1;
          const next = Math.max(0, Math.min(maximum, value + offset));
          if (next !== value) onValueCommit(next);
        }}
        collapsable={false}
        style={styles.track}
      >
        <Canvas style={{ width, height }} pointerEvents="none">
          <Group transform={transform}>
            {ticks.map(({ major }, index) => {
              const x = center + index * spacing;
              return (
                <Line
                  key={index}
                  p1={{ x, y: major ? 18 : 29 }}
                  p2={{ x, y: 47 }}
                  color={major ? colors.muted : colors.line}
                  strokeWidth={2}
                  strokeCap="round"
                />
              );
            })}
          </Group>
          <Line
            p1={{ x: center, y: 8 }}
            p2={{ x: center, y: 49 }}
            color={colors.accent}
            strokeWidth={3}
            strokeCap="round"
          />
        </Canvas>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create((theme) => ({
  track: {
    borderRadius: theme.radius.input,
    backgroundColor: theme.colors.recessed,
    overflow: "hidden",
    direction: "ltr",
  },
}));
