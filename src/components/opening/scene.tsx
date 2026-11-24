import { useEffect } from "react";
import { LinearGradient } from "expo-linear-gradient";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import Animated, {
  cancelAnimation,
  interpolate,
  type SharedValue,
  useAnimatedProps,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, {
  ClipPath,
  Defs,
  Ellipse,
  G,
  LinearGradient as Paint,
  Path,
  RadialGradient,
  Stop,
} from "react-native-svg";
import { useTheme } from "@/theme";
import { OpeningMark, openingMotion, openingPalette } from "./brand";

const AnimatedPath = Animated.createAnimatedComponent(Path);

// All contours share the same six cubic segments so the fold can open
// asymmetrically without morphing through a circle or changing topology.
function foldContour(open: number, turn: number) {
  "worklet";
  const pull = (1 - open) * 36;
  const curl = turn * 27;
  return `M ${25 + pull} ${173 - curl} C ${38 + pull} ${121 + pull} 95 ${125 + pull} 141 81 C 191 ${33 + pull} 232 24 284 ${49 + curl} C 333 ${72 + curl} ${356 - pull} 114 336 161 C 315 212 268 211 226 ${248 - curl} C 178 ${291 - pull} 128 303 79 273 C 36 246 ${12 + pull} 221 ${25 + pull} ${173 - curl} Z`;
}

function Fold({
  palette,
  opening,
  turn,
}: {
  palette: typeof openingPalette.light;
  opening: SharedValue<number>;
  turn: SharedValue<number>;
}) {
  const contour = useDerivedValue(() => foldContour(opening.get(), turn.get()));
  const path = useAnimatedProps(() => ({ d: contour.get() }));
  return (
    <Svg width={360} height={320} viewBox="0 0 360 320">
      <Defs>
        <ClipPath id="fold-edge">
          <AnimatedPath animatedProps={path} />
        </ClipPath>
        <RadialGradient id="fold-haze">
          <Stop offset={0} stopColor={palette.haze} stopOpacity={0.95} />
          <Stop offset={1} stopColor={palette.haze} stopOpacity={0} />
        </RadialGradient>
        <Paint id="fold-body" x1="12%" y1="88%" x2="75%" y2="6%">
          <Stop offset={0} stopColor={palette.bright} />
          <Stop offset={0.37} stopColor={palette.deep} />
          <Stop offset={0.72} stopColor={palette.deep} />
          <Stop offset={1} stopColor={palette.edge} />
        </Paint>
        <Paint id="fold-silk" x1="9%" y1="63%" x2="92%" y2="30%">
          <Stop offset={0} stopColor={palette.bright} stopOpacity={0.14} />
          <Stop offset={0.38} stopColor={palette.edge} stopOpacity={0.64} />
          <Stop offset={0.72} stopColor={palette.glint} stopOpacity={0.72} />
          <Stop offset={1} stopColor={palette.bright} stopOpacity={0.15} />
        </Paint>
      </Defs>
      <Ellipse cx={172} cy={174} rx={180} ry={149} fill="url(#fold-haze)" />
      <AnimatedPath animatedProps={path} fill="url(#fold-body)" />
      <G clipPath="url(#fold-edge)">
        <Path
          d="M 0 203 C 82 241 136 216 206 168 C 262 130 312 116 367 123 L 367 169 C 306 165 272 183 218 221 C 147 270 54 295 0 248 Z"
          fill="url(#fold-silk)"
        />
        <Path
          d="M 16 202 C 80 240 138 213 206 166 C 263 127 313 113 354 120"
          fill="none"
          stroke={palette.glint}
          strokeOpacity={0.42}
          strokeWidth={1}
        />
        <Path
          d="M 16 174 C 52 151 92 162 141 117 C 201 62 265 45 319 79"
          fill="none"
          stroke={palette.glint}
          strokeOpacity={0.26}
          strokeWidth={1}
        />
      </G>
      <AnimatedPath
        animatedProps={path}
        fill="none"
        stroke={palette.bright}
        strokeOpacity={0.32}
      />
    </Svg>
  );
}

export function OpeningScene({
  intro,
  form,
  restore,
  busy,
  holding,
  scroll,
  height,
  heroCenter,
  heroSize,
  formCenter,
}: {
  intro: SharedValue<number>;
  form: SharedValue<number>;
  restore: SharedValue<number>;
  busy: SharedValue<number>;
  holding: boolean;
  scroll: SharedValue<number>;
  height: number;
  heroCenter: number;
  heroSize: number;
  formCenter: number;
}) {
  const { theme, reduceMotion } = useTheme();
  const palette = openingPalette[theme];
  const breath = useSharedValue(0);
  useEffect(() => {
    if (!holding || reduceMotion) return;
    breath.set(
      withRepeat(
        withTiming(1, { duration: 950, easing: openingMotion.unfold }),
        -1,
        true,
      ),
    );
    return () => {
      cancelAnimation(breath);
      breath.set(0);
    };
  }, [breath, holding, reduceMotion]);
  const contourOpening = useDerivedValue(() =>
    reduceMotion ? 1 : interpolate(intro.get(), [0.1, 0.64], [0, 1], "clamp"),
  );
  const contourTurn = useDerivedValue(() =>
    reduceMotion ? 0 : form.get() * (2 * restore.get() - 1),
  );
  const backdrop = useAnimatedStyle(() => ({
    opacity:
      interpolate(intro.get(), [0.1, 0.85], [0, 1], "clamp") * (1 - busy.get()),
  }));
  const position = useAnimatedStyle(() => {
    const p = intro.get();
    const f = form.get();
    const b = busy.get();
    const destination =
      heroCenter + (formCenter - heroCenter - scroll.get()) * f;
    const travel = reduceMotion
      ? p >= 0.48
        ? 1
        : 0
      : interpolate(p, [0.47, 0.94], [0, 1], "clamp");
    return {
      transform: [
        { translateY: (destination - height / 2) * travel * (1 - b) },
      ],
    };
  });
  const fold = useAnimatedStyle(() => {
    const p = intro.get();
    const f = form.get();
    const r = restore.get();
    const b = busy.get();
    const opening = reduceMotion
      ? 1
      : interpolate(p, [0, 0.24, 0.62, 1], [0.22, 0.45, 1.04, 1]);
    return {
      opacity:
        (reduceMotion
          ? interpolate(p, [0.5, 1], [0, 1], "clamp")
          : interpolate(p, [0.03, 0.32, 0.68], [0, 0.64, 1], "clamp")) *
        (1 - f * 0.2) *
        (1 - b),
      transform: [
        {
          rotate: `${reduceMotion ? 0 : (1 - p) * -24 + f * (-12 + 24 * r)}deg`,
        },
        { scale: opening * (heroSize + (0.35 - heroSize) * f) },
        {
          scaleY: reduceMotion
            ? 1
            : interpolate(p, [0, 0.32, 0.72, 1], [0.18, 0.48, 1.08, 1]),
        },
      ],
    };
  });
  const mark = useAnimatedStyle(() => {
    const p = intro.get();
    const f = form.get();
    const b = busy.get();
    const scale = interpolate(p, [0, 0.25, 0.52, 1], [1, 0.73, 1.18, 1.12]);
    return {
      opacity: reduceMotion
        ? interpolate(p, [0, 0.38, 0.52, 1], [1, 0, 0, 1])
        : 1,
      transform: [
        { translateY: reduceMotion ? 0 : -9 * p * (1 - b) },
        {
          scale:
            (reduceMotion ? 1.12 : scale) * (1 - f * 0.56) * (1 - b) +
            b * (1 + breath.get() * 0.033),
        },
      ],
    };
  });

  return (
    <View
      pointerEvents="none"
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={[StyleSheet.absoluteFill, { backgroundColor: palette.base }]}
    >
      <Animated.View style={[StyleSheet.absoluteFill, backdrop]}>
        <LinearGradient
          colors={[palette.base, palette.low]}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
      <Animated.View style={[styles.center, position]}>
        <Animated.View style={[styles.center, fold]}>
          <Fold palette={palette} opening={contourOpening} turn={contourTurn} />
        </Animated.View>
        <Animated.View style={mark}>
          <OpeningMark />
        </Animated.View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
  },
});
