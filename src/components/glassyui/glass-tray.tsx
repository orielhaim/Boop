/*
 * Adapted from Reacticx Tray, Copyright (c) 2026 rit3zh.
 * https://github.com/rit3zh/reacticx/blob/main/src/components/organisms/tray
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
import {
  Children,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  BackHandler,
  Pressable,
  Text,
  View,
  useWindowDimensions,
  type ViewProps,
} from "react-native";
import { useTranslation } from "react-i18next";
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from "react-native-gesture-handler";
import Animated, {
  LinearTransition,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import { Icon } from "@/components/ui/icon";
import { directionFor, resolveLanguage } from "@/i18n";
import { motion } from "@/theme/tokens";
import { useGlassTheme } from "./glass-provider";
import { GlassSurface } from "./glass-surface";
import { ModalLayerHost, useLayerPresence } from "./lib/modal-layer";

type TrayNavigation = {
  push: (screen: string) => void;
  pop: () => void;
  canGoBack: boolean;
  screen: string;
};

const TrayNavigationContext = createContext<TrayNavigation | null>(null);

export function useGlassTray() {
  const context = useContext(TrayNavigationContext);
  if (!context) throw new Error("useGlassTray must be used inside GlassTray");
  return context;
}

type Screen = { children: ReactNode; name: string; title: string };

export function GlassTrayScreen(_props: Screen) {
  return null;
}

function isScreen(child: ReactNode): child is ReactElement<Screen> {
  return isValidElement<Screen>(child) && child.type === GlassTrayScreen;
}

type GlassTrayProps = ViewProps & {
  children: ReactNode;
  open: boolean;
  presentation?: "inline" | "sheet";
  onOpenChange: (open: boolean) => void;
  initialScreen: string;
  showHeader?: boolean;
  backLabel?: string;
  closeLabel?: string;
  onCoverageChange?: (coverage: TrayCoverage) => void;
};

export type TrayCoverage = { edge: "left" | "right" | "bottom"; size: number };

type History = {
  stack: string[];
  previous?: string;
  direction: 1 | -1;
  revision: number;
};

const resize = LinearTransition.springify()
  .damping(39)
  .stiffness(370)
  .overshootClamping(true);

export function GlassTray({
  children,
  initialScreen,
  showHeader = true,
  onOpenChange,
  open,
  presentation = "inline",
  backLabel,
  closeLabel,
  onCoverageChange,
  style,
  ...rest
}: GlassTrayProps) {
  const { preferences, colors } = useGlassTheme();
  const { i18n, t } = useTranslation("common");
  const rtl = directionFor(resolveLanguage(i18n.resolvedLanguage)) === "rtl";
  const { height, width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [present, hide] = useLayerPresence(open, preferences.reduceMotion);
  const [opening, setOpening] = useState({ open, initialScreen });
  const [history, setHistory] = useState<History>({
    stack: [initialScreen],
    direction: 1,
    revision: 0,
  });
  if (open && (!opening.open || opening.initialScreen !== initialScreen)) {
    setOpening({ open, initialScreen });
    setHistory({ stack: [initialScreen], direction: 1, revision: 0 });
  } else if (!open && opening.open) {
    setOpening({ ...opening, open });
  }

  const show = useSharedValue(0);
  const slide = useSharedValue(1);
  const drag = useSharedValue(0);
  const extent = useSharedValue(200);
  const screen = history.stack.at(-1) ?? initialScreen;
  const screens = Children.toArray(children).filter(isScreen);
  const active = screens.find((page) => page.props.name === screen);
  const previous = screens.find((page) => page.props.name === history.previous);
  const reduce = preferences.reduceMotion;
  const sheet = presentation === "sheet";
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const push = useCallback((name: string) => {
    setHistory((current) => {
      if (current.stack.at(-1) === name) return current;
      return {
        stack: [...current.stack, name],
        previous: current.stack.at(-1),
        direction: 1,
        revision: current.revision + 1,
      };
    });
  }, []);
  const pop = useCallback(() => {
    setHistory((current) =>
      current.stack.length < 2
        ? current
        : {
            stack: current.stack.slice(0, -1),
            previous: current.stack.at(-1),
            direction: -1,
            revision: current.revision + 1,
          },
    );
  }, []);
  const back = useCallback(() => {
    if (history.stack.length > 1) pop();
    else close();
  }, [close, history.stack.length, pop]);

  useEffect(() => {
    if (!open || sheet) return;
    const listener = BackHandler.addEventListener("hardwareBackPress", () => {
      back();
      return true;
    });
    return () => listener.remove();
  }, [back, open, sheet]);

  useEffect(() => {
    if (!present) return;
    if (reduce) {
      show.set(open ? 1 : 0);
      drag.set(0);
      return;
    }
    if (open) drag.set(0);
    show.set(
      withTiming(open ? 1 : 0, { duration: open ? 230 : 175 }, (finished) => {
        if (finished && !open) scheduleOnRN(hide);
      }),
    );
    return () => cancelAnimation(show);
  }, [drag, hide, open, present, reduce, show]);

  const finishPage = useCallback((revision: number) => {
    setHistory((current) =>
      current.revision === revision
        ? { ...current, previous: undefined }
        : current,
    );
  }, []);
  useEffect(() => {
    if (!history.previous || reduce) return;
    const revision = history.revision;
    slide.set(0);
    slide.set(
      withTiming(1, { duration: 190 }, (finished) => {
        if (finished) scheduleOnRN(finishPage, revision);
      }),
    );
    return () => cancelAnimation(slide);
  }, [finishPage, history.previous, history.revision, reduce, slide]);

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(open)
        .activeOffsetY(5)
        .failOffsetX([-16, 16])
        .onBegin(() => cancelAnimation(drag))
        .onUpdate(({ translationY }) => {
          if (!reduce) drag.set(Math.max(0, translationY));
        })
        .onEnd(({ translationY, velocityY }) => {
          if (
            translationY > Math.min(95, extent.get() * 0.26) ||
            (translationY > 18 && velocityY > 600)
          ) {
            scheduleOnRN(close);
          }
        })
        .onFinalize(() => drag.set(reduce ? 0 : withSpring(0, motion.travel))),
    [close, drag, extent, open, reduce],
  );

  const landscape = width > height && width >= 660;
  const direction = history.direction * (rtl ? -1 : 1);
  const transitioning = Boolean(previous) && !reduce;
  const scrim = useAnimatedStyle(() => ({ opacity: show.get() }));
  const panel = useAnimatedStyle(() => ({
    transform: [
      {
        translateY:
          (1 - show.get()) * (extent.get() + insets.bottom + 24) + drag.get(),
      },
    ],
    opacity: show.get(),
  }));
  const nextPage = useAnimatedStyle(() => {
    const progress = transitioning ? slide.get() : 1;
    return {
      opacity: progress,
      transform: [
        { translateX: direction * (1 - progress) * 32 },
        { scale: 0.986 + progress * 0.014 },
      ],
    };
  });
  const oldPage = useAnimatedStyle(() => ({
    opacity: 1 - slide.get(),
    transform: [
      { translateX: -direction * slide.get() * 23 },
      { scale: 1 - slide.get() * 0.014 },
    ],
  }));

  const navigation = useMemo(
    () => ({
      push,
      pop,
      canGoBack: history.stack.length > 1,
      screen,
    }),
    [history.stack.length, pop, push, screen],
  );

  if (!present || !active) return null;
  const content = (
    <TrayNavigationContext.Provider value={navigation}>
      <View
        pointerEvents={open ? "box-none" : "none"}
        accessibilityElementsHidden={!open}
        importantForAccessibility={open ? "auto" : "no-hide-descendants"}
        style={styles.host}
      >
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            scrim,
            { backgroundColor: colors.scrim },
          ]}
        />
        <Pressable
          accessible={false}
          importantForAccessibility="no"
          style={StyleSheet.absoluteFill}
          onPress={close}
        />
        <View
          pointerEvents="box-none"
          style={[
            styles.frame,
            {
              paddingLeft: sheet && !landscape ? 0 : insets.left + 8,
              paddingRight: sheet && !landscape ? 0 : insets.right + 8,
              paddingBottom: sheet ? 0 : Math.max(insets.bottom, 8),
            },
            landscape && styles.sideFrame,
            { direction: rtl ? "rtl" : "ltr" },
          ]}
        >
          <Animated.View
            onLayout={({ nativeEvent: { layout } }) => {
              extent.set(layout.height);
              if (open)
                onCoverageChange?.(
                  landscape
                    ? {
                        edge: rtl ? "left" : "right",
                        size:
                          layout.width +
                          (rtl ? insets.left : insets.right) +
                          16,
                      }
                    : {
                        edge: "bottom",
                        size: layout.height + Math.max(insets.bottom, 8) + 8,
                      },
                );
            }}
            layout={reduce ? undefined : resize}
            style={[
              styles.panel,
              panel,
              sheet && styles.dockedPanel,
              landscape && styles.sidePanel,
            ]}
          >
            <GlassSurface
              {...rest}
              accessibilityViewIsModal
              onAccessibilityEscape={back}
              elevation="raised"
              preset="overlay"
              style={[
                styles.surface,
                sheet && styles.dockedSurface,
                sheet && { paddingBottom: insets.bottom + 8 },
                {
                  maxHeight: Math.max(
                    180,
                    height - insets.top - (sheet ? 12 : insets.bottom + 20),
                  ),
                },
                style,
              ]}
            >
              <GestureDetector gesture={gesture}>
                <View collapsable={false} style={styles.handleTouch}>
                  <View style={styles.handle} />
                </View>
              </GestureDetector>
              {showHeader && (
                <View
                  style={[styles.header, { direction: rtl ? "rtl" : "ltr" }]}
                >
                  {navigation.canGoBack && (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={backLabel ?? t("back")}
                      onPress={pop}
                      style={styles.button}
                    >
                      <Icon name="back" size={22} />
                    </Pressable>
                  )}
                  <Text
                    accessibilityRole="header"
                    style={styles.title}
                    numberOfLines={2}
                  >
                    {active.props.title}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={closeLabel ?? t("closeSheet")}
                    onPress={close}
                    style={styles.button}
                  >
                    <Icon name="close" size={20} />
                  </Pressable>
                </View>
              )}
              <View
                style={[
                  styles.body,
                  sheet && {
                    paddingLeft: landscape ? 0 : insets.left,
                    paddingRight: landscape ? 0 : insets.right,
                  },
                ]}
              >
                {previous && !reduce && (
                  <Animated.View
                    key={previous.props.name}
                    pointerEvents="none"
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                    style={[styles.previous, oldPage]}
                  >
                    {previous.props.children}
                  </Animated.View>
                )}
                <Animated.View
                  key={active.props.name}
                  style={[styles.page, nextPage]}
                >
                  {active.props.children}
                </Animated.View>
              </View>
            </GlassSurface>
          </Animated.View>
        </View>
      </View>
    </TrayNavigationContext.Provider>
  );
  return sheet ? (
    <ModalLayerHost onRequestClose={back} present={present}>
      <GestureHandlerRootView style={styles.modalRoot}>
        {content}
      </GestureHandlerRootView>
    </ModalLayerHost>
  ) : (
    content
  );
}

const styles = StyleSheet.create((theme) => ({
  host: { ...StyleSheet.absoluteFillObject, zIndex: 30 },
  modalRoot: { flex: 1 },
  frame: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "flex-end",
    alignItems: "center",
  },
  sideFrame: { alignItems: "flex-end" },
  panel: { width: "100%", maxWidth: 500 },
  dockedPanel: { maxWidth: 660 },
  sidePanel: { maxWidth: 400 },
  surface: {
    borderRadius: theme.radius.card + 4,
    overflow: "hidden",
    paddingBottom: theme.space.sm,
  },
  dockedSurface: { borderBottomLeftRadius: 0, borderBottomRightRadius: 0 },
  handleTouch: { alignItems: "center", justifyContent: "center", height: 26 },
  handle: {
    width: 32,
    height: 4,
    borderRadius: theme.radius.round,
    backgroundColor: theme.glass.track,
  },
  header: {
    minHeight: 46,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.sm,
    paddingStart: theme.space.lg,
    paddingEnd: theme.space.md,
    paddingBottom: theme.space.xs,
  },
  title: { ...theme.type.heading, flex: 1, color: theme.colors.text },
  button: {
    height: 44,
    width: 44,
    borderRadius: theme.radius.round,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.recessed,
  },
  body: { flexShrink: 1, overflow: "hidden" },
  page: { flexShrink: 1 },
  previous: { ...StyleSheet.absoluteFillObject },
}));
