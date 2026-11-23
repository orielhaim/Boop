import { memo, useEffect, useMemo, useState } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import {
  Blur,
  Canvas,
  ColorMatrix,
  Group,
  Paint,
  Paragraph,
  Skia,
  TextAlign,
  TextDirection,
  type SkParagraph,
} from "react-native-skia";
import {
  cancelAnimation,
  Easing,
  useDerivedValue,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useTranslation } from "react-i18next";
import { Ink } from "@/components/ui/kit";
import { type, useTheme } from "@/theme";
import { THRESHOLD_MATRIX } from "./conf";
import { calculateBlur, calculateOpacity } from "./helpers";

function GooeyLayer({
  paragraph,
  progress,
  outgoing,
  width,
}: {
  paragraph: SkParagraph;
  progress: SharedValue<number>;
  outgoing?: boolean;
  width: number;
}) {
  const blur = useDerivedValue(() =>
    calculateBlur(outgoing ? 1 - progress.value : progress.value),
  );
  const opacity = useDerivedValue(() =>
    calculateOpacity(outgoing ? 1 - progress.value : progress.value),
  );
  return (
    <Group
      opacity={opacity}
      layer={
        <Paint>
          <Blur blur={blur} />
        </Paint>
      }
    >
      <Paragraph paragraph={paragraph} x={0} y={0} width={width} />
    </Group>
  );
}

function MorphTitle({
  before,
  after,
  width,
}: {
  before: string;
  after: string;
  width: number;
}) {
  const { colors } = useTheme();
  const { i18n } = useTranslation();
  const { fontScale } = useWindowDimensions();
  const rtl = i18n.dir(i18n.resolvedLanguage) === "rtl";
  const progress = useSharedValue(0);
  const [finished, setFinished] = useState(false);
  const paragraphs = useMemo(
    () =>
      [before, after].map((text) => {
        return Skia.ParagraphBuilder.Make({
          maxLines: 3,
          ellipsis: "…",
          textDirection: rtl ? TextDirection.RTL : TextDirection.LTR,
          textAlign: TextAlign.Center,
          textStyle: {
            color: Skia.Color(colors.text),
            fontSize: type.title.fontSize * fontScale,
            letterSpacing: type.title.letterSpacing,
            fontStyle: { weight: 700 },
          },
        })
          .addText(text)
          .build();
      }),
    [after, before, colors.text, fontScale, rtl],
  );

  useEffect(() => {
    progress.set(
      withTiming(
        1,
        { duration: 280, easing: Easing.out(Easing.quad) },
        (completed) => {
          if (completed) scheduleOnRN(setFinished, true);
        },
      ),
    );
    return () => cancelAnimation(progress);
  }, [progress]);

  return (
    <>
      <Ink
        kind="title"
        accessibilityRole="header"
        numberOfLines={3}
        style={[styles.title, !finished && styles.transparent]}
      >
        {after}
      </Ink>
      {!finished && (
        <Canvas
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
          importantForAccessibility="no"
        >
          <Group
            layer={
              <Paint>
                <ColorMatrix matrix={THRESHOLD_MATRIX} />
              </Paint>
            }
          >
            <GooeyLayer
              paragraph={paragraphs[0]}
              progress={progress}
              width={width}
              outgoing
            />
            <GooeyLayer
              paragraph={paragraphs[1]}
              progress={progress}
              width={width}
            />
          </Group>
        </Canvas>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  title: { textAlign: "center" },
  transparent: { opacity: 0 },
});

export default memo(function GooeyText({ text }: { text: string }) {
  const [transition, setTransition] = useState({ before: "", after: text });
  const [width, setWidth] = useState(0);
  if (transition.after !== text)
    setTransition({ before: transition.after, after: text });
  return (
    <View onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}>
      {transition.before && width > 0 ? (
        <MorphTitle
          key={transition.after}
          before={transition.before}
          after={transition.after}
          width={width}
        />
      ) : (
        <Ink
          kind="title"
          accessibilityRole="header"
          numberOfLines={3}
          style={styles.title}
        >
          {text}
        </Ink>
      )}
    </View>
  );
});
