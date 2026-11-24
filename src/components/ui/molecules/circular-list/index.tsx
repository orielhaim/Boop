import type { ReactNode } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useState } from "react";
import Animated, {
  Extrapolation,
  interpolate,
  type SharedValue,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import type { ICircularList } from "./types";

const itemWidth = 104;

// Reacticx Circular List's scroll-linked arc, adapted to render Boop's contacts.
export function CircularList<T>({
  data,
  initialWidth,
  rtl,
  reduceMotion,
  renderItem,
  keyExtractor,
  onViewableItemsChanged,
  viewabilityConfig,
}: ICircularList<T>) {
  const [measuredWidth, setMeasuredWidth] = useState<number>();
  const width = measuredWidth ?? initialWidth;
  const [initialOffset] = useState(() => ({
    x: data.length > 1 ? itemWidth : 0,
    y: 0,
  }));
  const offset = useSharedValue(initialOffset.x);
  const onScroll = useAnimatedScrollHandler((event) => {
    offset.value = event.contentOffset.x;
  });

  function measure(event: LayoutChangeEvent) {
    setMeasuredWidth(event.nativeEvent.layout.width);
  }

  return (
    <View style={styles.viewport} onLayout={measure}>
      <Animated.FlatList
        data={data}
        horizontal
        inverted={rtl}
        scrollEnabled={data.length > 1}
        showsHorizontalScrollIndicator={false}
        contentOffset={initialOffset}
        contentContainerStyle={{
          paddingHorizontal: Math.max(0, (width - itemWidth) / 2),
        }}
        snapToInterval={itemWidth}
        decelerationRate="fast"
        scrollEventThrottle={16}
        onScroll={onScroll}
        keyExtractor={keyExtractor}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
        renderItem={({ item, index }) => (
          <CircularListItem
            index={index}
            offset={offset}
            reduceMotion={reduceMotion}
          >
            {renderItem(item)}
          </CircularListItem>
        )}
      />
    </View>
  );
}

function CircularListItem({
  index,
  offset,
  reduceMotion,
  children,
}: {
  index: number;
  offset: SharedValue<number>;
  reduceMotion: boolean;
  children: ReactNode;
}) {
  const animated = useAnimatedStyle(() => {
    if (reduceMotion) return { transform: [{ translateY: 0 }, { scale: 1 }] };
    const distance = Math.abs(offset.value / itemWidth - index);
    return {
      transform: [
        {
          translateY: interpolate(
            distance,
            [0, 1, 2],
            [0, 9, 19],
            Extrapolation.CLAMP,
          ),
        },
        {
          scale: interpolate(
            distance,
            [0, 1, 2],
            [1.07, 0.99, 0.94],
            Extrapolation.CLAMP,
          ),
        },
      ],
    };
  });

  return (
    <Animated.View style={[styles.cell, animated]}>{children}</Animated.View>
  );
}

const styles = StyleSheet.create({
  viewport: { direction: "ltr" },
  cell: { width: itemWidth, paddingTop: 6, paddingBottom: 25 },
});
