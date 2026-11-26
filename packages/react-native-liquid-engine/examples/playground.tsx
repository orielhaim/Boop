import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useDerivedValue,
  useFrameCallback,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { Skia, rect } from "react-native-skia";
import {
  GlassBackdrop,
  GlassProvider,
  GlassRenderer,
  getGlassCapabilities,
} from "../src/components";
import { stretchGlassShape, type GlassScene } from "../src/geometry";
import { glassMaterials, interpolateGlassMaterial } from "../src/material";
import { SkiaGlass } from "../src/skia";

const defaultLabels = {
  blur: "Blur",
  depth: "Depth",
  refraction: "Refraction",
  merge: "Merge",
  dispersion: "Dispersion",
  light: "Lighting",
  shape: "Shape",
  material: "Material",
  motion: "Animate backdrop",
  pattern: "Backdrop pattern",
  stress: "Eight shapes",
  backend: "Use Skia scene",
  frames: "Sample UI frame rate",
  theme: "Dark background",
  decrease: "Decrease",
  increase: "Increase",
};

export type GlassPlaygroundLabels = typeof defaultLabels;
const stageHeight = 216;
const palettes = [
  ["#1b2741", "#f67247", "#ffd36a", "#296db8", "#9ee6cf"],
  ["#101521", "#163545", "#496aaf", "#87395f", "#fad9ac"],
];

export function GlassPlayground({
  labels = defaultLabels,
  dark: initialDark = false,
  reduceMotion = false,
  reduceTransparency = false,
}: {
  labels?: GlassPlaygroundLabels;
  dark?: boolean;
  reduceMotion?: boolean;
  reduceTransparency?: boolean;
}) {
  const [dark, setDark] = useState(initialDark);
  const [width, setWidth] = useState(0);
  const [blur, setBlur] = useState(4);
  const [depth, setDepth] = useState(18);
  const [refraction, setRefraction] = useState(1);
  const [merge, setMerge] = useState(34);
  const [dispersion, setDispersion] = useState(0.2);
  const [light, setLight] = useState(1);
  const [geometry, setGeometry] = useState(0);
  const [frosted, setFrosted] = useState(false);
  const [pattern, setPattern] = useState(0);
  const [moving, setMoving] = useState(false);
  const [stress, setStress] = useState(false);
  const [skia, setSkia] = useState(false);
  const [sampling, setSampling] = useState(false);
  const [fps, setFps] = useState(0);
  const firstFrame = useSharedValue(0);
  const frameCount = useSharedValue(0);
  const pan = useSharedValue(0);
  const velocity = useSharedValue(0);
  const drift = useSharedValue(0);
  const mix = useSharedValue(0);
  const shapeWidth = Math.min(122, width * 0.42);
  const palette = palettes[dark ? 1 : 0];
  const ink = dark ? "#f8faff" : "#162134";

  useEffect(() => {
    drift.set(
      moving && !reduceMotion
        ? withRepeat(withTiming(-64, { duration: 1250 }), -1, true)
        : 0,
    );
    return () => cancelAnimation(drift);
  }, [drift, moving, reduceMotion]);
  useEffect(() => {
    mix.set(
      reduceMotion
        ? Number(frosted)
        : withTiming(Number(frosted), { duration: 420 }),
    );
  }, [frosted, mix, reduceMotion]);

  const frameMonitor = useFrameCallback(({ timestamp }) => {
    if (!firstFrame.get()) firstFrame.set(timestamp);
    frameCount.set(frameCount.get() + 1);
    const elapsed = timestamp - firstFrame.get();
    if (elapsed >= 1000) {
      scheduleOnRN(setFps, Math.round((frameCount.get() * 1000) / elapsed));
      frameCount.set(0);
      firstFrame.set(timestamp);
    }
  }, false);
  const toggleMonitor = () => {
    frameCount.set(0);
    firstFrame.set(0);
    frameMonitor.setActive(!sampling);
    setSampling(!sampling);
  };

  const scene = useDerivedValue<GlassScene>(() => {
    const x = Math.max(
      12,
      Math.min(width - shapeWidth - 12, width / 2 + pan.get() - shapeWidth / 3),
    );
    const shape = stretchGlassShape(
      {
        x,
        y: 68,
        width: shapeWidth,
        height: 76,
        radius: [40, 22, 40, 22],
        kind:
          geometry === 1
            ? "ellipse"
            : geometry === 2
              ? "continuous"
              : "roundedRect",
        rotation: geometry === 2 ? 0.1 : 0,
      },
      velocity.get(),
      0,
      reduceMotion ? 0 : 0.7,
    );
    const material = interpolateGlassMaterial(
      glassMaterials.liquid,
      glassMaterials.frosted,
      mix.get(),
    );
    const shapes = [
      {
        x: Math.max(12, width / 2 - shapeWidth + 12),
        y: 75,
        width: shapeWidth,
        height: 62,
        radius: 31,
      },
      shape,
    ];
    if (stress) {
      for (let i = 0; i < 6; i++) {
        shapes.push({
          x: (((i % 3) + 0.5) * width) / 3 - 18,
          y: i < 3 ? 22 : 154,
          width: 36,
          height: 36,
          radius: 18,
        });
      }
    }
    return {
      shapes,
      lights: [
        { x: width * 0.2, y: 18, intensity: light },
        { x, y: 180, intensity: light * 0.5 },
      ],
      mergeSmoothness: merge,
      material: {
        ...material,
        blurRadius: blur + mix.get() * 8,
        refractionDepth: depth,
        refractionStrength: refraction,
        chromaticAberration: dispersion,
      },
    };
  });

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-8, 8])
        .onUpdate((event) => {
          pan.set(event.translationX);
          velocity.set(event.velocityX);
        })
        .onFinalize(() => {
          pan.set(reduceMotion ? 0 : withSpring(0));
          velocity.set(reduceMotion ? 0 : withSpring(0));
        }),
    [pan, reduceMotion, velocity],
  );
  const backgroundMotion = useAnimatedStyle(() => ({
    transform: [{ translateX: drift.get() }],
  }));
  const image = useMemo(() => {
    if (!skia || width <= 0) return null;
    const surface = Skia.Surface.MakeOffscreen(Math.ceil(width), stageHeight);
    if (!surface) return null;
    try {
      const canvas = surface.getCanvas();
      const paint = Skia.Paint();
      canvas.clear(Skia.Color(palette[0]));
      for (let x = 0; x < width; x += 24) {
        for (let y = 0; y < stageHeight; y += 24) {
          paint.setColor(
            Skia.Color(palette[1 + ((x / 24 + (y / 24) * pattern) % 4)]),
          );
          canvas.drawRect(rect(x, y, 20, 20), paint);
        }
      }
      surface.flush();
      return surface.makeImageSnapshot();
    } catch {
      return null;
    } finally {
      surface.dispose();
    }
  }, [palette, pattern, skia, width]);
  useEffect(() => () => image?.dispose(), [image]);

  const copy = (
    label: string,
    state: boolean,
    change: (next: boolean) => void,
  ) => (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: state }}
      style={styles.action}
      onPress={() => change(!state)}
    >
      <Text style={{ color: ink }}>
        {state ? "● " : "○ "}
        {label}
      </Text>
    </Pressable>
  );
  const adjust = (
    label: string,
    value: number,
    update: (next: number) => void,
    step: number,
    max: number,
  ) => (
    <View style={styles.setting}>
      <Text style={[styles.parameter, { color: ink }]}>
        {label} · {Number(value.toFixed(2))}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${labels.decrease} ${label}`}
        style={styles.step}
        disabled={value <= 0}
        onPress={() => update(Math.max(0, value - step))}
      >
        <Text style={{ color: ink }}>−</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${labels.increase} ${label}`}
        style={styles.step}
        disabled={value >= max}
        onPress={() => update(Math.min(max, value + step))}
      >
        <Text style={{ color: ink }}>+</Text>
      </Pressable>
    </View>
  );

  return (
    <View
      style={[
        styles.playground,
        { backgroundColor: dark ? "#20283b" : "#e8eef8" },
      ]}
    >
      <GlassProvider active={!reduceTransparency}>
        <View
          style={[styles.stage, { backgroundColor: palette[0] }]}
          onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        >
          <GlassBackdrop style={StyleSheet.absoluteFill}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <Animated.View style={[styles.pattern, backgroundMotion]}>
                {Array.from({ length: 30 }, (_, index) => (
                  <View
                    key={index}
                    style={{
                      width: 30 + pattern * 12,
                      height: stageHeight,
                      backgroundColor: palette[index % 5],
                    }}
                  >
                    <View
                      style={{
                        marginTop: 20 + (index % 4) * 32,
                        height: 42,
                        backgroundColor: palette[(index + 2) % 5],
                      }}
                    />
                  </View>
                ))}
              </Animated.View>
            </ScrollView>
          </GlassBackdrop>
          <GestureDetector gesture={gesture}>
            <View style={styles.grip} />
          </GestureDetector>
          {skia && image && !reduceTransparency ? (
            <SkiaGlass
              scene={scene}
              style={StyleSheet.absoluteFill}
              image={image}
              imageRect={rect(0, 0, width, stageHeight)}
              fallback={[0.2, 0.2, 0.25, 1]}
            />
          ) : (
            <GlassRenderer
              scene={scene}
              shapeCount={stress ? 8 : 2}
              style={StyleSheet.absoluteFill}
              colorScheme={dark ? "dark" : "light"}
              opaqueColor={dark ? "#31415b" : "#edf2fa"}
            />
          )}
        </View>
      </GlassProvider>
      <Text style={{ color: ink }}>
        {skia && image ? "Skia" : getGlassCapabilities().backend}
        {sampling && fps > 0 ? ` · ${fps} FPS` : ""}
      </Text>
      <View style={styles.actions}>
        {copy(labels.theme, dark, setDark)}
        {copy(labels.motion, moving, setMoving)}
        {copy(labels.material, frosted, setFrosted)}
        {copy(labels.stress, stress, setStress)}
        {copy(labels.backend, skia, setSkia)}
        {copy(labels.frames, sampling, toggleMonitor)}
        <Pressable
          accessibilityRole="button"
          style={styles.action}
          onPress={() => setPattern((n) => (n + 1) % 3)}
        >
          <Text style={{ color: ink }}>{labels.pattern}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          style={styles.action}
          onPress={() => setGeometry((n) => (n + 1) % 3)}
        >
          <Text style={{ color: ink }}>{labels.shape}</Text>
        </Pressable>
      </View>
      {adjust(labels.blur, blur, setBlur, 2, 24)}
      {adjust(labels.refraction, refraction, setRefraction, 0.2, 2)}
      {adjust(labels.depth, depth, setDepth, 2, 40)}
      {adjust(labels.merge, merge, setMerge, 4, 60)}
      {adjust(labels.dispersion, dispersion, setDispersion, 0.05, 0.6)}
      {adjust(labels.light, light, setLight, 0.2, 2)}
    </View>
  );
}

const styles = StyleSheet.create({
  playground: { borderRadius: 22, padding: 12, gap: 8 },
  stage: { height: stageHeight, borderRadius: 14, overflow: "hidden" },
  grip: {
    position: "absolute",
    top: 64,
    start: "45%",
    width: "55%",
    height: 92,
  },
  pattern: { flexDirection: "row" },
  setting: { flexDirection: "row", alignItems: "center", gap: 4 },
  parameter: { flex: 1, fontVariant: ["tabular-nums"] },
  step: {
    minHeight: 44,
    minWidth: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  actions: { flexDirection: "row", flexWrap: "wrap" },
  action: { paddingHorizontal: 8, minHeight: 44, justifyContent: "center" },
});
