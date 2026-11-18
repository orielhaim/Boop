import { requireNativeView } from "expo";
import { LinearGradient } from "expo-linear-gradient";
import { type ReactNode, useEffect, useState } from "react";
import {
  AccessibilityInfo,
  Platform,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
  type ViewProps,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  clamp,
  FadeIn,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { RTCView } from "react-native-webrtc";
import { scheduleOnRN } from "react-native-worklets";
import type { VideoState } from "@/core/calling/video";
import { spring } from "@/theme";

type Corner = VideoState["corner"];
const hideAfter = 3_800;
const AndroidPreview =
  Platform.OS === "android"
    ? requireNativeView<ViewProps & { streamURL: string; mirror: boolean }>(
        "BoopCameraPreview",
      )
    : null;

export function VideoStage({
  stageUrl,
  previewUrl,
  mirrorStage,
  mirrorPreview,
  corner,
  blockHiding,
  toggleLabel,
  swapLabel,
  header,
  controls,
  notice,
  onSwap,
  onCorner,
}: {
  stageUrl: string;
  previewUrl: string | null;
  mirrorStage: boolean;
  mirrorPreview: boolean;
  corner: Corner;
  blockHiding: boolean;
  toggleLabel: string;
  swapLabel: string;
  header: ReactNode;
  controls: ReactNode;
  notice: ReactNode;
  onSwap: () => void;
  onCorner: (corner: Corner) => void;
}) {
  const insets = useSafeAreaInsets();
  const [reader, setReader] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [activity, refresh] = useState(Date.now);
  const keepVisible = blockHiding || reader;
  const visible = keepVisible || !hidden;
  const opacity = useSharedValue(1);
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isScreenReaderEnabled().then((enabled) => {
      if (mounted) setReader(enabled);
    });
    const listener = AccessibilityInfo.addEventListener(
      "screenReaderChanged",
      setReader,
    );
    return () => {
      mounted = false;
      listener.remove();
    };
  }, []);
  useEffect(() => {
    if (keepVisible || !visible) return;
    const remaining = Math.max(
      hideAfter - (Date.now() - activity),
      hideAfter / 2,
    );
    const timer = setTimeout(() => setHidden(true), remaining);
    return () => clearTimeout(timer);
  }, [keepVisible, visible, activity]);
  useEffect(() => {
    opacity.value = withTiming(visible ? 1 : 0, {
      duration: 190,
      reduceMotion: ReduceMotion.System,
    });
  }, [opacity, visible]);
  const top = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: (1 - opacity.value) * -8 }],
  }));
  const bottom = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: (1 - opacity.value) * 8 }],
  }));
  const interact = () => {
    setHidden(false);
    refresh(Date.now());
  };
  const toggle = () => {
    if (keepVisible) return;
    refresh(Date.now());
    setHidden((value) => !value);
  };
  return (
    <Animated.View
      entering={FadeIn.duration(200).reduceMotion(ReduceMotion.System)}
      style={styles.stage}
    >
      <RTCView
        streamURL={stageUrl}
        mirror={mirrorStage}
        objectFit="cover"
        zOrder={0}
        style={StyleSheet.absoluteFill}
      />
      <Pressable
        accessible={!keepVisible}
        accessibilityRole="button"
        accessibilityLabel={toggleLabel}
        onPress={toggle}
        style={StyleSheet.absoluteFill}
      />
      <Animated.View
        pointerEvents={visible ? "box-none" : "none"}
        accessibilityElementsHidden={!visible}
        importantForAccessibility={visible ? "auto" : "no-hide-descendants"}
        style={[styles.top, { paddingTop: insets.top + 8 }, top]}
      >
        <LinearGradient
          pointerEvents="none"
          colors={["#0C1223C9", "#0C122300"]}
          style={StyleSheet.absoluteFill}
        />
        <View onTouchStart={interact} style={styles.header}>
          {header}
        </View>
      </Animated.View>
      {previewUrl && (
        <VideoPreview
          url={previewUrl}
          mirror={mirrorPreview}
          corner={corner}
          label={swapLabel}
          onSwap={() => {
            interact();
            onSwap();
          }}
          onCorner={(next) => {
            interact();
            onCorner(next);
          }}
        />
      )}
      {!!notice && (
        <View
          pointerEvents="none"
          style={[styles.notice, { bottom: insets.bottom + 98 }]}
        >
          {notice}
        </View>
      )}
      <Animated.View
        pointerEvents={visible ? "box-none" : "none"}
        accessibilityElementsHidden={!visible}
        importantForAccessibility={visible ? "auto" : "no-hide-descendants"}
        style={[styles.bottom, { paddingBottom: insets.bottom + 14 }, bottom]}
      >
        <LinearGradient
          pointerEvents="none"
          colors={["#0C122300", "#0C1223DA"]}
          style={StyleSheet.absoluteFill}
        />
        <View onTouchStart={interact} style={styles.controls}>
          {controls}
        </View>
      </Animated.View>
    </Animated.View>
  );
}

function VideoPreview({
  url,
  mirror,
  corner,
  label,
  onSwap,
  onCorner,
}: {
  url: string;
  mirror: boolean;
  corner: Corner;
  label: string;
  onSwap: () => void;
  onCorner: (corner: Corner) => void;
}) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const tileWidth = Math.min(184, width * 0.29, height * 0.22);
  const tileHeight = tileWidth * 1.3;
  const left = insets.left + 16;
  const right = Math.max(left, width - insets.right - tileWidth - 16);
  const top = insets.top + 78;
  const bottom = Math.max(top, height - insets.bottom - tileHeight - 116);
  const x = useSharedValue(corner.right ? right : left);
  const y = useSharedValue(corner.bottom ? bottom : top);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  useEffect(() => {
    x.set(withSpring(corner.right ? right : left, spring));
    y.set(withSpring(corner.bottom ? bottom : top, spring));
  }, [bottom, corner.bottom, corner.right, left, right, top, x, y]);
  const position = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }],
  }));
  const pan = Gesture.Pan()
    .minDistance(8)
    .onStart(() => {
      startX.set(x.value);
      startY.set(y.value);
    })
    .onUpdate((event) => {
      x.set(clamp(startX.value + event.translationX, left, right));
      y.set(clamp(startY.value + event.translationY, top, bottom));
    })
    .onFinalize((event, success) => {
      if (!success) {
        x.set(withSpring(corner.right ? right : left, spring));
        y.set(withSpring(corner.bottom ? bottom : top, spring));
        return;
      }
      const snapRight = x.value + event.velocityX * 0.1 >= (left + right) / 2;
      const snapBottom = y.value + event.velocityY * 0.1 >= (top + bottom) / 2;
      x.set(withSpring(snapRight ? right : left, spring));
      y.set(withSpring(snapBottom ? bottom : top, spring));
      scheduleOnRN(onCorner, { right: snapRight, bottom: snapBottom });
    });
  const tap = Gesture.Tap()
    .maxDistance(7)
    .onEnd((_, success) => {
      if (success) scheduleOnRN(onSwap);
    });
  return (
    <GestureDetector gesture={Gesture.Exclusive(pan, tap)}>
      <Animated.View
        accessible
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityActions={[{ name: "activate" }]}
        onAccessibilityAction={({ nativeEvent }) => {
          if (nativeEvent.actionName === "activate") onSwap();
        }}
        style={[
          styles.preview,
          { width: tileWidth, height: tileHeight },
          position,
        ]}
      >
        {AndroidPreview ? (
          <AndroidPreview
            streamURL={url}
            mirror={mirror}
            style={StyleSheet.absoluteFill}
          />
        ) : (
          <RTCView
            streamURL={url}
            mirror={mirror}
            objectFit="cover"
            zOrder={1}
            style={StyleSheet.absoluteFill}
          />
        )}
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  stage: { ...StyleSheet.absoluteFill, backgroundColor: "#101522" },
  top: { position: "absolute", top: 0, left: 0, right: 0 },
  header: { paddingHorizontal: 16, paddingBottom: 8 },
  bottom: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    paddingTop: 14,
  },
  controls: { alignItems: "center", paddingHorizontal: 8 },
  notice: { position: "absolute", left: 16, right: 16, alignItems: "center" },
  preview: {
    position: "absolute",
    left: 0,
    top: 0,
    borderRadius: 22,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#F1F4FF70",
    backgroundColor: "#242C42",
  },
});
