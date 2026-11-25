import type { ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { GestureDetector } from "react-native-gesture-handler";
import Animated, {
  type ScrollHandlerProcessed,
  useComposedEventHandler,
} from "react-native-reanimated";
import { useAnimateScrollView } from "../hooks/useAnimatedScrollView";

// Adapted from Reacticx's parallax-header. Only the artwork zooms, so the
// navigation controls retain their native touch targets and sizes.
export function ParallaxScrollView({
  children,
  bodyStyle,
  header,
  headerControls,
  stickyTabs,
  headerMaxHeight,
  headerOverlap,
  backgroundColor,
  onScroll,
}: {
  children: ReactNode;
  bodyStyle: StyleProp<ViewStyle>;
  header: ReactNode;
  headerControls: ReactNode;
  stickyTabs?: ReactNode;
  headerMaxHeight: number;
  headerOverlap: number;
  backgroundColor: string;
  onScroll?: ScrollHandlerProcessed;
}) {
  const motion = useAnimateScrollView(headerMaxHeight);
  const scrollHandler = useComposedEventHandler([
    motion.onScroll,
    onScroll ?? null,
  ]);
  const scrollView = (
    <Animated.ScrollView
      alwaysBounceVertical={!motion.reduceMotion}
      bounces={!motion.reduceMotion}
      overScrollMode={motion.reduceMotion ? "auto" : "never"}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      onScroll={scrollHandler}
      scrollEventThrottle={16}
      stickyHeaderIndices={stickyTabs ? [1] : undefined}
    >
      <View
        pointerEvents="box-none"
        style={{ height: headerMaxHeight - headerOverlap }}
      >
        <Animated.View
          pointerEvents="none"
          style={[styles.artwork, { height: headerMaxHeight }, motion.artwork]}
        >
          {header}
        </Animated.View>
        {headerControls}
      </View>
      {stickyTabs}
      <Animated.View style={[bodyStyle, motion.body]}>
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            { top: headerOverlap, backgroundColor },
          ]}
        />
        {children}
      </Animated.View>
    </Animated.ScrollView>
  );

  return motion.android && !motion.reduceMotion ? (
    <GestureDetector gesture={motion.androidGesture}>
      {scrollView}
    </GestureDetector>
  ) : (
    scrollView
  );
}

const styles = StyleSheet.create({
  artwork: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    overflow: "hidden",
    transformOrigin: "center top",
  },
});
