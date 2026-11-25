import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentRef,
} from "react";
import {
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type LayoutChangeEvent,
  useWindowDimensions,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import Animated, {
  Extrapolation,
  ReduceMotion,
  interpolate,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { useTranslation } from "react-i18next";
import { Canvas, Fill, Shader, Skia, type Uniforms } from "react-native-skia";
import { Icon, tapFeedback } from "@/components/ui/kit";
import { directionFor, namespaces, resolveLanguage } from "@/i18n";
import { space, useTheme } from "@/theme";
import { GooeyContext, TabContext, useGooey, useTab } from "./context";
import { GOOEY_SHADER } from "./conf";
import {
  DEFAULT_INTENSITY,
  DEFAULT_SPRING,
  GAP,
  H_PADDING,
  HEIGHT,
  ICON_SIZE,
} from "./const";
import { parseColor } from "./utils";
import type {
  IGooeySearchTabs,
  IGooeyTab,
  IGooeyTabIcon,
  IGooeyTabLabel,
  IGooeyTabs,
  IGooeyTrigger,
  ITabLayout,
} from "./types";

const EFFECT = Skia.RuntimeEffect.Make(GOOEY_SHADER);

const CLOSE_W = HEIGHT;
const PAD_V = 8;

const hasChildType = (children: React.ReactNode, type: unknown): boolean =>
  React.Children.toArray(children).some(
    (c) => React.isValidElement(c) && c.type === type,
  );

/* -------------------------------------------------------------------------- */
/*                                    Root                                    */
/* -------------------------------------------------------------------------- */

const GooeyRoot: React.FC<IGooeySearchTabs> &
  React.FunctionComponent<IGooeySearchTabs> = memo<IGooeySearchTabs>(
  ({
    children,
    value: controlledValue,
    defaultValue = "",
    onChange,
    onSearch,
    activeTab: controlledActiveTab,
    defaultActiveTab,
    onTabChange,
    defaultExpanded = false,
    onExpandedChange,
    placeholder: requestedPlaceholder,
    intensity = DEFAULT_INTENSITY,
    springConfig = DEFAULT_SPRING,
    colorScheme,
    style,
    textStyle,
  }: IGooeySearchTabs): React.JSX.Element => {
    const { width: screenWidth } = useWindowDimensions();
    const { colors, reduceMotion } = useTheme();
    const { i18n, t } = useTranslation(namespaces);
    const rtl = directionFor(resolveLanguage(i18n.resolvedLanguage)) === "rtl";
    const placeholder =
      requestedPlaceholder ?? t("messages:sharedMedia.search");
    const scheme = useMemo(
      () => ({
        bg: colors.background,
        fg: colors.text,
        muted: colors.muted,
        indicator: colors.selected,
        ...colorScheme,
      }),
      [
        colorScheme,
        colors.background,
        colors.muted,
        colors.selected,
        colors.text,
      ],
    );
    const colorRGB = useMemo(() => parseColor(scheme.bg), [scheme.bg]);
    const kGoo = 2 + Math.max(0, Math.min(1, intensity)) * 30;
    const total = Math.min(screenWidth - space.md * 2, 600);
    const tabsW = Math.max(0, total - HEIGHT - GAP);
    const compact = total < 360;

    const progress = useSharedValue(defaultExpanded ? 1 : 0);
    const [expanded, setExpanded] = useState(defaultExpanded);
    const [internalValue, setInternalValue] = useState(defaultValue);
    const [order, setOrder] = useState<string[]>([]);
    const [internalActive, setInternalActive] = useState(
      defaultActiveTab ?? "",
    );
    const [layouts, setLayouts] = useState<Record<string, ITabLayout>>({});

    const inputRef = useRef<ComponentRef<typeof TextInput>>(null);

    const value = controlledValue ?? internalValue;
    const activeTab = controlledActiveTab ?? internalActive ?? order[0] ?? "";

    const registerTab = useCallback((v: string) => {
      setOrder((prev) => (prev.includes(v) ? prev : [...prev, v]));
    }, []);

    const unregisterTab = useCallback((v: string) => {
      setOrder((prev) => prev.filter((x) => x !== v));
      setLayouts((prev) => {
        if (!(v in prev)) return prev;
        const next = { ...prev };
        delete next[v];
        return next;
      });
    }, []);

    const reportLayout = useCallback((v: string, layout: ITabLayout) => {
      setLayouts((prev) =>
        prev[v]?.x === layout.x && prev[v]?.width === layout.width
          ? prev
          : { ...prev, [v]: layout },
      );
    }, []);

    const animate = useCallback(
      (value: number) => {
        progress.value = withSpring(value, {
          ...springConfig,
          reduceMotion: reduceMotion
            ? ReduceMotion.Always
            : ReduceMotion.System,
        });
      },
      [progress, reduceMotion, springConfig],
    );

    useEffect(() => {
      if (!internalActive && order.length > 0) setInternalActive(order[0]);
    }, [order, internalActive]);

    const expand = useCallback(() => {
      setExpanded(true);
      onExpandedChange?.(true);
      animate(1);
      requestAnimationFrame(() => inputRef.current?.focus());
    }, [animate, onExpandedChange]);

    const collapse = useCallback(() => {
      setExpanded(false);
      onExpandedChange?.(false);
      animate(0);
      if (controlledValue === undefined) setInternalValue("");
      inputRef.current?.blur();
    }, [animate, controlledValue, onExpandedChange]);

    const toggle = useCallback(
      () => (expanded ? collapse() : expand()),
      [expanded, expand, collapse],
    );

    const setValue = useCallback(
      (v: string) => {
        if (controlledValue === undefined) setInternalValue(v);
        onChange?.(v);
      },
      [controlledValue, onChange],
    );

    const selectTab = useCallback(
      (v: string) => {
        if (controlledActiveTab === undefined) setInternalActive(v);
        onTabChange?.(v);
      },
      [controlledActiveTab, onTabChange],
    );

    const contextValue = useMemo(
      () => ({
        progress,
        expanded,
        expand,
        collapse,
        toggle,
        value,
        setValue,
        activeTab,
        selectTab,
        registerTab,
        unregisterTab,
        reportLayout,
        layouts,
        tabsWidth: tabsW,
        colorScheme: scheme,
        springConfig,
        rtl,
        compact,
        searchLabel: placeholder,
      }),
      [
        progress,
        expanded,
        expand,
        collapse,
        toggle,
        value,
        setValue,
        activeTab,
        selectTab,
        registerTab,
        unregisterTab,
        reportLayout,
        layouts,
        tabsW,
        scheme,
        springConfig,
        rtl,
        compact,
        placeholder,
      ],
    );

    const uniforms = useDerivedValue<Uniforms>(() => {
      const p = progress.value;
      const sW = HEIGHT + (tabsW - HEIGHT) * p;
      const rW = tabsW + (CLOSE_W - tabsW) * p;
      return {
        u_resolution: [total, HEIGHT + PAD_V * 2],
        u_search: [rtl ? total - sW : 0, PAD_V, sW, HEIGHT],
        u_right: [rtl ? 0 : total - rW, PAD_V, rW, HEIGHT],
        u_radius: HEIGHT / 2,
        u_k: kGoo,
        u_color: colorRGB,
      };
    }, [progress, total, tabsW, kGoo, colorRGB, rtl]);

    const inputStyle = useAnimatedStyle(() => ({
      opacity: interpolate(
        progress.value,
        [0.35, 0.9],
        [0, 1],
        Extrapolation.CLAMP,
      ),
      transform: [
        {
          translateX: interpolate(
            progress.value,
            [0, 1],
            [-10, 0],
            Extrapolation.CLAMP,
          ),
        },
      ],
    }));

    const closeStyle = useAnimatedStyle(() => ({
      opacity: interpolate(
        progress.value,
        [0.55, 1],
        [0, 1],
        Extrapolation.CLAMP,
      ),
      transform: [
        {
          scale: interpolate(
            progress.value,
            [0.5, 1],
            [0.6, 1],
            Extrapolation.CLAMP,
          ),
        },
      ],
    }));

    const showDefaultTrigger = !hasChildType(children, GooeyTrigger);

    return (
      <GooeyContext.Provider value={contextValue}>
        <View
          style={[
            styles.root,
            style,
            { width: total, height: HEIGHT, direction: rtl ? "rtl" : "ltr" },
          ]}
        >
          {EFFECT && tabsW > 0 ? (
            <Canvas
              pointerEvents="none"
              style={[styles.canvas, { height: HEIGHT + PAD_V * 2 }]}
            >
              <Fill>
                <Shader source={EFFECT} uniforms={uniforms} />
              </Fill>
            </Canvas>
          ) : null}

          {showDefaultTrigger ? <GooeyTrigger /> : null}

          {children}

          <Animated.View
            style={[styles.inputWrap, inputStyle]}
            pointerEvents={expanded ? "auto" : "none"}
            accessibilityElementsHidden={!expanded}
            importantForAccessibility={
              expanded ? "auto" : "no-hide-descendants"
            }
          >
            <TextInput
              ref={inputRef}
              style={[styles.input, { color: scheme.fg }, textStyle]}
              placeholder={placeholder}
              placeholderTextColor={scheme.muted}
              accessibilityLabel={placeholder}
              value={value}
              editable={expanded}
              onChangeText={setValue}
              onSubmitEditing={() => onSearch?.(value)}
              autoCorrect={false}
              returnKeyType="search"
            />
          </Animated.View>

          <Animated.View
            style={[styles.closeButton, closeStyle]}
            pointerEvents={expanded ? "auto" : "none"}
            accessibilityElementsHidden={!expanded}
            importantForAccessibility={
              expanded ? "auto" : "no-hide-descendants"
            }
          >
            <Pressable
              style={styles.iconInner}
              accessibilityRole="button"
              accessibilityLabel={t("common:close")}
              onPress={() => {
                tapFeedback();
                collapse();
              }}
              hitSlop={8}
            >
              <Icon name="close" size={ICON_SIZE} color={scheme.fg} />
            </Pressable>
          </Animated.View>
        </View>
      </GooeyContext.Provider>
    );
  },
);

GooeyRoot.displayName = "GooeySearchTabs";

/* -------------------------------------------------------------------------- */
/*                                  Trigger                                   */
/* -------------------------------------------------------------------------- */

const GooeyTrigger = memo<IGooeyTrigger>(
  ({ children, style }: IGooeyTrigger): React.JSX.Element => {
    const { expanded, expand, colorScheme, searchLabel } = useGooey();
    return (
      <Pressable
        style={[styles.trigger, style]}
        accessibilityRole="button"
        accessibilityLabel={searchLabel}
        accessibilityState={{ expanded }}
        accessibilityElementsHidden={expanded}
        importantForAccessibility={expanded ? "no-hide-descendants" : "auto"}
        onPress={
          expanded
            ? undefined
            : () => {
                tapFeedback();
                expand();
              }
        }
        hitSlop={8}
      >
        {children ?? (
          <Icon name="search" size={ICON_SIZE} color={colorScheme.fg} />
        )}
      </Pressable>
    );
  },
);

GooeyTrigger.displayName = "GooeySearchTabs.Trigger";

/* -------------------------------------------------------------------------- */
/*                                   Tabs                                     */
/* -------------------------------------------------------------------------- */

const GooeyTabs = memo<IGooeyTabs>(
  ({ children, style }: IGooeyTabs): React.JSX.Element => {
    const {
      progress,
      expanded,
      activeTab,
      layouts,
      tabsWidth,
      colorScheme,
      springConfig,
    } = useGooey();
    const { reduceMotion } = useTheme();

    const idxX = useSharedValue(0);
    const idxW = useSharedValue(0);
    const scroll = useRef<ComponentRef<typeof ScrollView>>(null);

    useEffect(() => {
      const l = layouts[activeTab];
      if (!l) return;
      const immediate = idxW.value === 0;
      idxX.value = immediate ? l.x : withSpring(l.x, springConfig);
      idxW.value = immediate ? l.width : withSpring(l.width, springConfig);
      scroll.current?.scrollTo({
        x: Math.max(0, l.x + l.width / 2 - tabsWidth / 2),
        animated: !reduceMotion,
      });
    }, [activeTab, layouts, reduceMotion, springConfig, tabsWidth, idxX, idxW]);

    const rowStyle = useAnimatedStyle(() => ({
      opacity: interpolate(
        progress.value,
        [0, 0.45],
        [1, 0],
        Extrapolation.CLAMP,
      ),
    }));

    const indicatorStyle = useAnimatedStyle(() => ({
      transform: [{ translateX: idxX.value }],
      width: idxW.value,
    }));

    return (
      <Animated.View
        style={[styles.tabsRow, { width: tabsWidth }, rowStyle, style]}
        pointerEvents={expanded ? "none" : "auto"}
      >
        <ScrollView
          ref={scroll}
          horizontal
          scrollEnabled={!expanded}
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          style={styles.tabsViewport}
          contentContainerStyle={[styles.tabsContent, { minWidth: tabsWidth }]}
        >
          <View style={styles.tabsContentInner}>
            <Animated.View
              style={[
                styles.indicator,
                { backgroundColor: colorScheme.indicator },
                indicatorStyle,
              ]}
            />
            {children}
          </View>
        </ScrollView>
      </Animated.View>
    );
  },
);

GooeyTabs.displayName = "GooeySearchTabs.Tabs";

/* -------------------------------------------------------------------------- */
/*                                    Tab                                     */
/* -------------------------------------------------------------------------- */

const GooeyTab = memo<IGooeyTab>(
  ({
    value,
    accessibilityLabel,
    children,
    tabPaddingHorizontal = 3,
    onPress,
    style,
  }: IGooeyTab): React.JSX.Element => {
    const {
      activeTab,
      compact,
      selectTab,
      registerTab,
      unregisterTab,
      reportLayout,
    } = useGooey();

    useEffect(() => {
      registerTab(value);
      return () => unregisterTab(value);
    }, [value, registerTab, unregisterTab]);

    const active = value === activeTab;
    const tabCtx = useMemo(() => ({ value, active }), [value, active]);

    return (
      <TabContext.Provider value={tabCtx}>
        <Pressable
          accessibilityRole="tab"
          accessibilityLabel={accessibilityLabel ?? value}
          accessibilityState={{ selected: active }}
          style={[
            styles.tab,
            {
              minWidth: compact ? 48 : 76,
              paddingHorizontal: compact ? 2 : tabPaddingHorizontal,
            },
            style,
          ]}
          onPress={() => {
            if (!active) tapFeedback();
            selectTab(value);
            onPress?.(value);
          }}
          onLayout={(e: LayoutChangeEvent) =>
            reportLayout(value, {
              x: e.nativeEvent.layout.x,
              width: e.nativeEvent.layout.width,
            })
          }
        >
          {children}
        </Pressable>
      </TabContext.Provider>
    );
  },
);

GooeyTab.displayName = "GooeySearchTabs.Tab";

/* -------------------------------------------------------------------------- */
/*                                 TabIcon                                    */
/* -------------------------------------------------------------------------- */

const GooeyTabIcon = memo<IGooeyTabIcon>(
  ({ children, style }: IGooeyTabIcon): React.JSX.Element => {
    const { active } = useTab();
    return (
      <View
        accessible={false}
        style={[styles.tabIcon, { opacity: active ? 1 : 0.6 }, style]}
      >
        {children}
      </View>
    );
  },
);

GooeyTabIcon.displayName = "GooeySearchTabs.TabIcon";

/* -------------------------------------------------------------------------- */
/*                                 TabLabel                                   */
/* -------------------------------------------------------------------------- */

const GooeyTabLabel = memo<IGooeyTabLabel>(
  ({ children, style }: IGooeyTabLabel): React.JSX.Element | null => {
    const { active } = useTab();
    const { colorScheme, compact } = useGooey();
    if (compact) return null;
    return (
      <Text
        style={[
          styles.tabLabel,
          { color: active ? colorScheme.fg : colorScheme.muted },
          style,
        ]}
        numberOfLines={1}
        ellipsizeMode="tail"
      >
        {children}
      </Text>
    );
  },
);

GooeyTabLabel.displayName = "GooeySearchTabs.TabLabel";

/* -------------------------------------------------------------------------- */
/*                            Compound wiring                                 */
/* -------------------------------------------------------------------------- */

const GooeySearchTabs = Object.assign(GooeyRoot, {
  Trigger: GooeyTrigger,
  Tabs: GooeyTabs,
  Tab: GooeyTab,
  TabIcon: GooeyTabIcon,
  TabLabel: GooeyTabLabel,
});

export { GooeySearchTabs };
export default GooeySearchTabs;
export type { IGooeySearchTabs } from "./types";

const styles = StyleSheet.create((theme) => ({
  root: {
    alignSelf: "center",
    justifyContent: "center",
  },
  canvas: {
    position: "absolute",
    start: 0,
    end: 0,
    top: -PAD_V,
  },
  trigger: {
    position: "absolute",
    start: 0,
    top: 0,
    width: HEIGHT,
    height: HEIGHT,
    alignItems: "center",
    justifyContent: "center",
  },
  iconInner: {
    width: HEIGHT,
    height: HEIGHT,
    alignItems: "center",
    justifyContent: "center",
  },
  inputWrap: {
    position: "absolute",
    start: HEIGHT,
    end: HEIGHT,
    top: 0,
    height: HEIGHT,
    justifyContent: "center",
    paddingEnd: H_PADDING,
  },
  input: {
    fontSize: 15,
    paddingVertical: 0,
  },
  tabsRow: {
    position: "absolute",
    end: 0,
    top: 0,
    height: HEIGHT,
    alignItems: "center",
  },
  tabsViewport: { flex: 1, height: HEIGHT },
  tabsContent: { flexGrow: 1 },
  tabsContentInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.xs,
    minHeight: HEIGHT,
    position: "relative",
  },
  indicator: {
    position: "absolute",
    top: (HEIGHT - 32) / 2,
    left: 0,
    height: 32,
    borderRadius: 16,
  },
  tab: {
    flexGrow: 1,
    flexShrink: 0,
    height: HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  tabIcon: {
    alignItems: "center",
    justifyContent: "center",
  },
  tabLabel: {
    flexShrink: 1,
    fontSize: 12,
    fontWeight: "500",
    textAlign: "center",
  },
  closeButton: {
    position: "absolute",
    end: 0,
    top: 0,
    width: CLOSE_W,
    height: HEIGHT,
    alignItems: "center",
    justifyContent: "center",
  },
}));
