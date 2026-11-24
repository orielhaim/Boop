import { useMemo } from "react";
import { Platform } from "react-native";
import { Easing, interpolate } from "react-native-reanimated";
import Transition, {
  type ScreenInterpolationProps,
  type ScreenStyleInterpolator,
} from "react-native-screen-transitions";
import type { BlankStackNavigationOptions } from "react-native-screen-transitions/expo-router";
import { useTranslation } from "react-i18next";
import {
  profileElementId,
  profileMorphParam,
} from "@/core/marmot/conversation-route";
import { directionFor, resolveLanguage } from "@/i18n";
import { useTheme } from "@/theme";

export const travelSpring = {
  stiffness: 370,
  damping: 39,
  mass: 0.9,
  overshootClamping: true,
};

const travel = { open: travelSpring, close: travelSpring };
const fade = { duration: 100, easing: Easing.out(Easing.quad) };

const dissolve: ScreenStyleInterpolator = ({ current, focused }) => {
  "worklet";
  return focused ? { content: { opacity: current.progress } } : null;
};
const mediaControls = ({ current }: ScreenInterpolationProps) => {
  "worklet";
  return {
    opacity: interpolate(current.progress, [0.45, 0.9], [0, 1], "clamp"),
  };
};

function horizontal(
  { progress, layouts }: ScreenInterpolationProps,
  sign: number,
) {
  "worklet";
  const { width } = layouts.screen;
  return {
    content: {
      transform: [
        {
          translateX:
            interpolate(
              progress,
              [0, 1, 2],
              [width, 0, -width * 0.24],
              "clamp",
            ) * sign,
        },
      ],
    },
  };
}

export function useNavigationMotion() {
  const { i18n } = useTranslation();
  const { reduceMotion } = useTheme();
  const rtl = directionFor(resolveLanguage(i18n.resolvedLanguage)) === "rtl";
  return useMemo(
    () => navigationMotion(rtl, reduceMotion),
    [rtl, reduceMotion],
  );
}

function navigationMotion(rtl: boolean, reduceMotion: boolean) {
  const sign = rtl ? -1 : 1;
  const push: BlankStackNavigationOptions = {
    inactiveBehavior: "hide",
    gestureEnabled: !reduceMotion,
    gestureDirection: [
      { gesture: rtl ? "horizontal-inverted" : "horizontal", area: "edge" },
    ],
    transitionSpec: reduceMotion ? { open: fade, close: fade } : travel,
    screenStyleInterpolator: reduceMotion
      ? dissolve
      : (props) => {
          "worklet";
          return horizontal(props, sign);
        },
  };

  function zoom(media: boolean): BlankStackNavigationOptions {
    return {
      ...push,
      ...(media
        ? {
            gestureDirection: ["vertical", "pinch-in"] as const,
            backdropBehavior: "block" as const,
          }
        : {}),
      transitionSpec: Transition.Specs.Zoom,
      screenStyleInterpolator: (props) => {
        "worklet";
        const params = props.active.route.params;
        const id = params && "origin" in params ? params.origin : undefined;
        const source = typeof id === "string" ? props.bounds(id) : undefined;
        const style = source?.link()
          ? source.navigation.zoom({
              target: "fullscreen",
              borderRadius: media ? 0 : 24,
              backgroundScale: 0.97,
            })
          : media
            ? dissolve(props)
            : horizontal(props, sign);
        return media ? { ...style, overlay: mediaControls(props) } : style;
      },
    };
  }
  const detail = reduceMotion ? push : zoom(false);
  const media = reduceMotion ? push : zoom(true);
  const profileMorph: BlankStackNavigationOptions = reduceMotion
    ? push
    : {
        ...push,
        screenStyleInterpolator: (props) => {
          "worklet";
          const { active, bounds, focused } = props;
          const profile = profileMorphParam(active.route.params);
          if (!profile) return horizontal(props, sign);
          const progress = Math.max(0, Math.min(1, active.progress));
          const avatar = profileElementId(profile, "avatar");
          const name = profileElementId(profile, "name");
          const avatarBounds = bounds(avatar);
          const nameBounds = bounds(name);
          // Keep the handoff short so differently wrapped titles don't ghost.
          const nameHandoff = interpolate(
            progress,
            [0.44, 0.5],
            [0, 1],
            "clamp",
          );
          return {
            ...(focused ? { content: { opacity: progress } } : {}),
            ...(avatarBounds.link()?.status === "complete"
              ? { [avatar]: avatarBounds.styles({ scaleMode: "uniform" }) }
              : {}),
            ...(nameBounds.link()?.status === "complete"
              ? {
                  [name]: {
                    ...nameBounds.styles({ scaleMode: "uniform" }),
                    opacity: focused ? nameHandoff : 1 - nameHandoff,
                  },
                }
              : {}),
          };
        },
      };

  const modal: BlankStackNavigationOptions = reduceMotion
    ? { ...push, gestureEnabled: false }
    : Transition.Presets.SlideFromBottom({
        gestureEnabled: Platform.OS === "ios",
        gestureDirection: [{ gesture: "vertical", area: "edge" }],
        transitionSpec: travel,
      });
  return { push, detail, media, modal, profileMorph };
}
