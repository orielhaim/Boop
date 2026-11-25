import { useEffect, useMemo } from "react";
import { View, useWindowDimensions } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  type SharedValue,
} from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";
import { scheduleOnRN } from "react-native-worklets";
import { Ink, tapFeedback } from "@/components/ui/kit";
import { motion, useTheme } from "@/theme";

type Column = {
  label: string;
  items: readonly string[];
  index: number;
  onIndex: (index: number) => void;
};

type Time = { hours: number; minutes: number };

const hours = Array.from({ length: 24 }, (_, index) => index);
const minutes = Array.from({ length: 60 }, (_, index) => index);

// Adapted from Kinetik UI's Time Wheel. Each column uses the same drum
// geometry, including the optional date column.
export function TimeWheel({
  value,
  onChange,
  date,
  labels,
  locale,
  rtl,
  compact,
  disabled,
  onSettlingChange,
}: {
  value: Time;
  onChange: (change: Partial<Time>) => void;
  date?: Column;
  labels: { hours: string; minutes: string };
  locale: string;
  rtl?: boolean;
  compact?: boolean;
  disabled?: boolean;
  onSettlingChange?: (column: "date" | keyof Time, settling: boolean) => void;
}) {
  const { fontScale } = useWindowDimensions();
  const rowHeight = Math.round(42 * Math.max(1, fontScale));
  const height = rowHeight * (compact ? 3 : 5);
  const [hourLabels, minuteLabels] = useMemo(() => {
    const number = new Intl.NumberFormat(locale, { minimumIntegerDigits: 2 });
    return [
      hours.map((hour) => number.format(hour)),
      minutes.map((minute) => number.format(minute)),
    ];
  }, [locale]);
  const options = { height, rowHeight, disabled };
  const direction = rtl ? "rtl" : "ltr";

  return (
    <View style={[styles.wheels, { height, direction }]}>
      <View
        pointerEvents="none"
        style={[
          styles.band,
          { height: rowHeight, top: (height - rowHeight) / 2 },
        ]}
      />
      {date && (
        <Wheel
          {...options}
          {...date}
          wide
          onSettling={(active) => onSettlingChange?.("date", active)}
        />
      )}
      <View style={styles.time}>
        <Wheel
          {...options}
          label={labels.hours}
          items={hourLabels}
          index={value.hours}
          onIndex={(hours) => onChange({ hours })}
          onSettling={(active) => onSettlingChange?.("hours", active)}
        />
        <Ink accessible={false} importantForAccessibility="no" kind="heading">
          :
        </Ink>
        <Wheel
          {...options}
          label={labels.minutes}
          items={minuteLabels}
          index={value.minutes}
          onIndex={(minutes) => onChange({ minutes })}
          onSettling={(active) => onSettlingChange?.("minutes", active)}
        />
      </View>
    </View>
  );
}

function bound(index: number, last: number) {
  "worklet";
  return Math.max(0, Math.min(last, index));
}

function Wheel({
  label,
  items,
  index,
  onIndex,
  height,
  rowHeight,
  disabled,
  wide,
  onSettling,
}: Column & {
  height: number;
  rowHeight: number;
  disabled?: boolean;
  wide?: boolean;
  onSettling: (active: boolean) => void;
}) {
  const { reduceMotion } = useTheme();
  const position = useSharedValue(index);
  const origin = useSharedValue(index);
  const moving = useSharedValue(false);
  const dragging = useSharedValue(false);
  const last = items.length - 1;

  useEffect(() => {
    position.set(index);
  }, [index, position]);

  useAnimatedReaction(
    () => Math.round(position.get()),
    (current, previous) => {
      if (previous !== null && current !== previous && moving.get())
        scheduleOnRN(tapFeedback);
    },
  );

  const commit = (next: number) => {
    onIndex(next);
    onSettling(false);
  };

  const snap = (next: number) => {
    "worklet";
    if (reduceMotion) {
      position.set(next);
      moving.set(false);
      scheduleOnRN(commit, next);
      return;
    }
    position.set(
      withSpring(next, motion.travel, (finished) => {
        if (!finished) return;
        moving.set(false);
        scheduleOnRN(commit, next);
      }),
    );
  };

  const pan = Gesture.Pan()
    .enabled(!disabled)
    .activeOffsetY([-5, 5])
    .failOffsetX([-22, 22])
    .onStart(() => {
      cancelAnimation(position);
      origin.set(position.get());
      moving.set(true);
      dragging.set(true);
      scheduleOnRN(onSettling, true);
    })
    .onUpdate(({ translationY }) => {
      position.set(bound(origin.get() - translationY / rowHeight, last));
    })
    .onEnd(({ velocityY }) => {
      const travel = Math.max(-7, Math.min(7, (velocityY * 0.12) / rowHeight));
      snap(bound(Math.round(position.get() - travel), last));
    })
    .onFinalize((_, success) => {
      if (!success && dragging.get())
        snap(bound(Math.round(position.get()), last));
      dragging.set(false);
    });

  const tap = Gesture.Tap()
    .enabled(!disabled)
    .onEnd(({ y }, success) => {
      if (!success) return;
      const delta = Math.floor((y - (height - rowHeight) / 2) / rowHeight);
      const next = bound(Math.round(position.get()) + delta, last);
      if (next === position.get()) return;
      moving.set(true);
      scheduleOnRN(onSettling, true);
      snap(next);
    });
  const translate = useAnimatedStyle(() => ({
    transform: [
      { translateY: (height - rowHeight) / 2 - position.get() * rowHeight },
    ],
  }));

  return (
    <GestureDetector gesture={Gesture.Exclusive(pan, tap)}>
      <View
        collapsable={false}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityValue={{ text: items[index] ?? "" }}
        accessibilityState={{ disabled }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={({ nativeEvent }) => {
          if (disabled) return;
          const delta = nativeEvent.actionName === "increment" ? 1 : -1;
          const next = bound(index + delta, last);
          if (next !== index) {
            tapFeedback();
            commit(next);
          }
        }}
        style={[styles.column, wide && styles.wide]}
      >
        <Animated.View
          pointerEvents="none"
          importantForAccessibility="no-hide-descendants"
          accessibilityElementsHidden
          style={translate}
        >
          {items.map((text, row) => (
            <WheelRow
              key={row}
              text={text}
              index={row}
              position={position}
              height={rowHeight}
              reduced={reduceMotion}
              wide={wide}
            />
          ))}
        </Animated.View>
      </View>
    </GestureDetector>
  );
}

function WheelRow({
  text,
  index,
  position,
  height,
  reduced,
  wide,
}: {
  text: string;
  index: number;
  position: SharedValue<number>;
  height: number;
  reduced: boolean;
  wide?: boolean;
}) {
  const animated = useAnimatedStyle(() => {
    const distance = index - position.get();
    const fade = Math.min(Math.abs(distance), 3);
    return {
      opacity: 1 - fade * 0.3,
      transform: reduced
        ? []
        : [
            { perspective: 500 },
            { rotateX: `${Math.max(-65, Math.min(65, -distance * 22))}deg` },
            { scale: 1 - fade * 0.045 },
          ],
    };
  });
  return (
    <Animated.View
      style={[styles.row, wide && styles.dateRow, { height }, animated]}
    >
      <Ink
        kind={wide ? "rowTitle" : "heading"}
        numberOfLines={1}
        style={styles.digits}
      >
        {text}
      </Ink>
    </Animated.View>
  );
}

const styles = StyleSheet.create((theme) => ({
  wheels: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  band: {
    position: "absolute",
    start: 0,
    end: 0,
    backgroundColor: theme.colors.selected,
    borderRadius: theme.radius.input,
  },
  time: {
    direction: "ltr",
    flexDirection: "row",
    alignItems: "center",
    height: "100%",
    justifyContent: "center",
  },
  column: { overflow: "hidden", height: "100%", minWidth: 52 },
  wide: { flex: 1, minWidth: 0 },
  row: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.space.sm,
  },
  dateRow: { alignItems: "flex-start", paddingHorizontal: theme.space.lg },
  digits: { fontVariant: ["tabular-nums"] },
}));
