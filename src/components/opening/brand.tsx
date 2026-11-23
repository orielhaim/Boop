import { Image } from "expo-image";
import type { ComponentProps } from "react";
import { Easing } from "react-native-reanimated";

export const openingMarkSize = 144;
export const openingPalette = {
  light: {
    base: "#EDF3FF",
    low: "#F8FAFF",
    ink: "#151C43",
    haze: "#C1CCFF",
    edge: "#7579E6",
    deep: "#292B96",
    bright: "#AED7FF",
    glint: "#FFFFFF",
  },
  dark: {
    base: "#121828",
    low: "#111626",
    ink: "#F2F4FF",
    haze: "#333A7C",
    edge: "#5E65D9",
    deep: "#202258",
    bright: "#859FFF",
    glint: "#D7F2FF",
  },
};

export const openingMotion = {
  intro: 2240,
  settle: 330,
  reveal: 760,
  reduced: 140,
  cinema: Easing.inOut(Easing.quad),
  glide: Easing.bezier(0.22, 0.72, 0.19, 1),
  unfold: Easing.bezier(0.45, 0.02, 0.24, 1),
  press: { duration: 210, dampingRatio: 1, overshootClamping: true },
};

type MarkEvents = Pick<ComponentProps<typeof Image>, "onDisplay" | "onError">;

export function OpeningMark(events: MarkEvents) {
  return (
    <Image
      {...events}
      source={require("../../../assets/images/opening-mark.png")}
      style={{ width: openingMarkSize, height: openingMarkSize }}
      contentFit="contain"
      accessible={false}
    />
  );
}
