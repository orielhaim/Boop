import {
  forwardRef,
  type ComponentRef,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { type TabListProps, type TabTriggerSlotProps } from "expo-router/ui";
import { BackHandler, Platform, Pressable, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  interpolateColor,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import {
  useSafeAreaFrame,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import { scheduleOnRN, scheduleOnUI } from "react-native-worklets";
import {
  DockContentLens,
  GlassRenderer,
} from "@/components/glassyui/glass-renderer";
import { Icon } from "@/components/ui/icon";
import { tapFeedback } from "@/components/ui/tap-feedback";
import { useTheme } from "@/theme";
import {
  AVATAR_INSET,
  AVATAR_SIZE,
  EXPANDED_HEIGHT,
  MAX_DOCK_WIDTH,
  MORPH_SPRING,
  SCREEN_INSET,
  STRIP_INSET,
  dockLensIntensity,
  resolveDockFrame,
} from "./dock-geometry";
import {
  animateDockSelection,
  LENS_SPRING,
  setMinimized,
  useDockMotion,
} from "./dock-motion";
import { DockMorph } from "./dock-morph";

const GLASS_BLEED = 18;
const THUMB_HEIGHT = EXPANDED_HEIGHT - 2 * STRIP_INSET;
const TAB_ICON_SIZE = 22;
const androidDock = Platform.OS === "android";

export type DockItem = {
  name: string;
  label: string;
  renderIcon: (props: { tint: string; size: number }) => ReactNode;
  renderIconOverlay?: () => ReactNode;
};

type DockProps = Omit<TabListProps, "asChild" | "children"> & {
  children: ReactNode;
  items: readonly DockItem[];
  bottomOffset: number;
  hidden: boolean;
  accountAvatar: ReactNode;
  accountLabel: string;
  accountName: string;
  direction: "ltr" | "rtl";
  profileActionLabel: string;
  qrLabel: string;
  closeLabel: string;
  onAccountPress: () => void;
  onQrPress: () => void;
  onTabSelect: (name: string) => void;
};

export function ExpandableDock({
  children,
  style,
  items,
  bottomOffset,
  hidden,
  accountAvatar,
  accountLabel,
  accountName,
  direction,
  profileActionLabel,
  qrLabel,
  closeLabel,
  onAccountPress,
  onQrPress,
  onTabSelect,
  ...props
}: DockProps) {
  const { colors, reduceMotion, theme } = useTheme();
  const motion = useDockMotion();
  const tabNames = useMemo(() => items.map(({ name }) => name), [items]);
  const insets = useSafeAreaInsets();
  const viewport = useSafeAreaFrame();
  const available = Math.max(0, viewport.width - insets.left - insets.right);
  const width = Math.min(
    MAX_DOCK_WIDTH,
    Math.max(0, available - 2 * SCREEN_INSET),
  );
  const left = insets.left + (available - width) / 2;
  const rtl = direction === "rtl";
  const closedFrame = resolveDockFrame(width, 0, 0, rtl);
  const openAccount = resolveDockFrame(width, 1, 0, rtl).profile;
  const collapsedNav = closedFrame.nav;
  const closedAvatarX = closedFrame.profile.x + AVATAR_INSET;
  const openAvatarX =
    openAccount.x +
    (rtl ? openAccount.width - AVATAR_INSET - AVATAR_SIZE : AVATAR_INSET);
  const stripWidth = Math.max(0, collapsedNav.width - STRIP_INSET * 2);
  const itemCount = Math.max(items.length, 1);
  const itemWidth = stripWidth / itemCount;
  const frame = useDerivedValue(() =>
    resolveDockFrame(
      width,
      motion.profileProgress.get(),
      motion.minimized.get(),
      rtl,
    ),
  );
  const stripClarity = useDerivedValue(() => 1 - frame.get().progress);
  const iconClarity = useDerivedValue(() => frame.get().progress);
  const profileClarity = useDerivedValue(() => frame.get().focus);
  const avatarClarity = useDerivedValue(
    () => 1 - Math.sin(Math.PI * profileClarity.get()),
  );

  const [profileOpen, setProfileOpen] = useState(false);
  const setProfile = useCallback(
    (open: boolean) => {
      setProfileOpen(open);
      motion.profileProgress.set(
        reduceMotion ? Number(open) : withSpring(Number(open), MORPH_SPRING),
      );
      if (open) setMinimized(motion, 0, reduceMotion);
    },
    [motion, reduceMotion],
  );
  const closeProfile = useCallback(() => setProfile(false), [setProfile]);
  useEffect(() => {
    if (!profileOpen) return;
    if (hidden) {
      const pending = requestAnimationFrame(closeProfile);
      return () => cancelAnimationFrame(pending);
    }
    const subscription = BackHandler.addEventListener(
      "hardwareBackPress",
      () => {
        closeProfile();
        return true;
      },
    );
    return () => subscription.remove();
  }, [closeProfile, hidden, profileOpen]);

  const press = useSharedValue(0);
  const dragOriginX = useSharedValue(0);
  const dragOriginIndex = useSharedValue(0);
  const detent = useSharedValue(-1);

  const scene = useDerivedValue(() => {
    const { nav, profile, focus } = frame.get();
    const fusion = Math.sin(Math.PI * focus);
    return {
      shapes: [
        { ...nav, x: nav.x + GLASS_BLEED, y: nav.y + GLASS_BLEED },
        { ...profile, x: profile.x + GLASS_BLEED, y: profile.y + GLASS_BLEED },
      ],
      mergeSmoothness: reduceMotion ? 0 : 31 * fusion,
      light: { x: width * 0.38 + GLASS_BLEED, y: GLASS_BLEED - 68 },
    };
  });

  const thumb = useDerivedValue(() => {
    const { nav, progress } = frame.get();
    const scale = 1 - 0.45 * progress;
    const slot = motion.slideIndex.get() * itemWidth;
    const dragStretch =
      Math.min(13, Math.abs(motion.dragVelocity.get()) * 0.009) * press.get();
    const w = itemWidth * scale + dragStretch;
    const h = Math.max(0, THUMB_HEIGHT * scale + 4 * press.get());
    const stripLeft = rtl
      ? nav.x + nav.width - (stripWidth + STRIP_INSET) * scale
      : nav.x + STRIP_INSET * scale;
    const start = stripLeft + slot * scale - dragStretch / 2;
    const x = Math.max(start, nav.x + STRIP_INSET);
    return {
      x,
      y: nav.y + (nav.height - h) / 2,
      width: Math.max(
        0,
        Math.min(start + w, nav.x + nav.width - STRIP_INSET) - x,
      ),
      height: h,
      radius: h / 2,
    };
  });
  const pressure = useDerivedValue(() => {
    if (reduceMotion || stripClarity.get() <= 0.5)
      return { surface: 0, content: 0 };
    return dockLensIntensity(
      motion.slideIndex.get(),
      motion.slideTarget.get(),
      press.get(),
    );
  });
  const lensIntensity = useDerivedValue(
    () => pressure.get().surface * stripClarity.get(),
  );
  const lensScene = useDerivedValue(() => {
    const shape = thumb.get();
    return {
      shapes:
        lensIntensity.get() > 0.01
          ? [{ ...shape, x: shape.x + GLASS_BLEED, y: shape.y + GLASS_BLEED }]
          : [],
      light: { x: shape.x + shape.width / 2 + GLASS_BLEED, y: 0 },
    };
  });
  const contentLensIntensity = useDerivedValue(
    () => pressure.get().content * stripClarity.get(),
  );
  const contentLensScene = useDerivedValue(() => {
    if (contentLensIntensity.get() <= 0.01) return { shapes: [] };
    const shape = thumb.get();
    const { nav } = frame.get();
    return { shapes: [{ ...shape, x: shape.x - nav.x, y: shape.y - nav.y }] };
  });
  const lensAppearance = useAnimatedStyle(() => ({
    opacity: lensIntensity.get(),
  }));
  const thumbAppearance = useAnimatedStyle(() => {
    const t = thumb.get();
    const intensity = lensIntensity.get();
    return {
      transform: [
        { translateX: t.x },
        { translateY: t.y },
        { scaleX: t.width / Math.max(1, itemWidth) },
        { scaleY: t.height / THUMB_HEIGHT },
      ],
      opacity: stripClarity.get() * (androidDock ? 1 : 1 - intensity),
    };
  });

  const gesture = useMemo(() => {
    const select = (index: number) => {
      "worklet";
      const name = tabNames[index];
      if (name === undefined) return;
      if (!reduceMotion) motion.pageIntent.set(name);
      scheduleOnRN(onTabSelect, name);
    };
    const lift = (next: number) => {
      "worklet";
      press.set(reduceMotion ? next : withSpring(next, LENS_SPRING));
    };
    const pickIndex = (x: number) => {
      "worklet";
      return Math.min(
        Math.max(
          Math.floor(
            (x - left - collapsedNav.x - STRIP_INSET) / Math.max(1, itemWidth),
          ),
          0,
        ),
        itemCount - 1,
      );
    };
    const pan = Gesture.Pan()
      .activeOffsetX([-10, 10])
      .failOffsetY([-14, 14])
      .onTouchesDown(() => {
        if (frame.get().progress < 0.5) lift(1);
      })
      .onStart(({ absoluteX }) => {
        const collapsed = frame.get().progress > 0.5;
        const index = collapsed
          ? motion.selectedIndex.get()
          : pickIndex(absoluteX);
        if (motion.profileProgress.get() > 0.5) scheduleOnRN(closeProfile);
        setMinimized(motion, 0, reduceMotion);
        cancelAnimation(motion.slideIndex);
        dragOriginX.set(absoluteX);
        dragOriginIndex.set(index);
        detent.set(index);
        motion.dragging.set(true);
        motion.slideIndex.set(index);
        lift(1);
      })
      .onUpdate(({ absoluteX, velocityX }) => {
        const index = Math.min(
          Math.max(
            dragOriginIndex.get() +
              (absoluteX - dragOriginX.get()) / Math.max(1, itemWidth),
            0,
          ),
          itemCount - 1,
        );
        motion.slideIndex.set(index);
        motion.dragVelocity.set(velocityX);
        const next = Math.round(index);
        if (next !== detent.get()) {
          detent.set(next);
          scheduleOnRN(tapFeedback);
        }
      })
      .onFinalize(({ velocityX }, success) => {
        lift(0);
        if (!motion.dragging.get()) return;
        motion.dragging.set(false);
        const velocity = velocityX / Math.max(1, itemWidth);
        const index = success
          ? Math.min(
              Math.max(
                Math.round(motion.slideIndex.get() + velocity * 0.08),
                0,
              ),
              itemCount - 1,
            )
          : motion.selectedIndex.get();
        motion.dragVelocity.set(reduceMotion ? 0 : withSpring(0, LENS_SPRING));
        animateDockSelection(
          motion,
          index,
          reduceMotion,
          success ? velocity * 0.35 : 0,
        );
        if (success) select(index);
      });
    const tap = Gesture.Tap()
      .maxDistance(14)
      .onEnd(({ absoluteX }, success) => {
        if (!success) return;
        lift(0);
        if (motion.profileProgress.get() > 0.5) {
          scheduleOnRN(closeProfile);
        } else if (motion.minimized.get() > 0.5) {
          setMinimized(motion, 0, reduceMotion);
        } else {
          const index = pickIndex(absoluteX);
          animateDockSelection(motion, index, reduceMotion);
          if (androidDock) select(index);
        }
      });
    return Gesture.Race(pan, tap);
  }, [
    closeProfile,
    collapsedNav.x,
    detent,
    dragOriginIndex,
    dragOriginX,
    frame,
    itemCount,
    itemWidth,
    left,
    motion,
    onTabSelect,
    press,
    reduceMotion,
    tabNames,
  ]);

  const navStyle = useAnimatedStyle(() => {
    const { nav } = frame.get();
    return {
      left: nav.x,
      top: nav.y,
      width: nav.width,
      height: nav.height,
      borderRadius: nav.radius,
    };
  });
  const profileStyle = useAnimatedStyle(() => {
    const { profile } = frame.get();
    return {
      left: profile.x,
      top: profile.y,
      width: profile.width,
      height: profile.height,
      borderRadius: profile.radius,
    };
  });
  const foldedGlyphPosition = useAnimatedStyle(() => ({
    top: (frame.get().nav.height - EXPANDED_HEIGHT) / 2,
  }));
  const avatarStyle = useAnimatedStyle(() => {
    const { profile } = frame.get();
    const center = profile.x + (profile.width - AVATAR_SIZE) / 2;
    const p = profileClarity.get();
    return {
      left:
        frame.get().scroll > 0
          ? center
          : closedAvatarX + (openAvatarX - closedAvatarX) * p,
      top: profile.y + (profile.height - AVATAR_SIZE) / 2,
    };
  });

  return (
    <View
      {...props}
      pointerEvents="box-none"
      style={[styles.root, style, hidden && styles.hidden]}
    >
      {profileOpen && (
        <Pressable
          accessible={false}
          importantForAccessibility="no"
          style={StyleSheet.absoluteFill}
          onPress={closeProfile}
        />
      )}
      <View
        pointerEvents="box-none"
        onAccessibilityEscape={closeProfile}
        style={[styles.stage, { left, width, bottom: bottomOffset }]}
      >
        <GlassRenderer
          preset="dock"
          scene={scene}
          shapeCount={2}
          style={styles.glass}
        />
        <Animated.View
          pointerEvents="none"
          style={[
            styles.thumb,
            {
              width: itemWidth,
              backgroundColor:
                theme === "dark"
                  ? "rgba(255,255,255,0.13)"
                  : "rgba(20,24,32,0.06)",
            },
            thumbAppearance,
          ]}
        >
          {/* Android refracts the tab artwork over the dock's existing backdrop. */}
          {androidDock && (
            <Animated.View
              style={[
                styles.thumbRelief,
                theme === "dark"
                  ? styles.thumbReliefDark
                  : styles.thumbReliefLight,
                lensAppearance,
              ]}
            />
          )}
        </Animated.View>
        {!androidDock && (
          <Animated.View
            pointerEvents="none"
            style={[styles.glass, lensAppearance]}
          >
            <GlassRenderer
              preset="lens"
              scene={lensScene}
              shapeCount={1}
              style={StyleSheet.absoluteFill}
            />
          </Animated.View>
        )}
        <GestureDetector gesture={gesture}>
          <Animated.View style={[styles.clip, navStyle]} collapsable={false}>
            <DockContentLens
              scene={contentLensScene}
              intensity={contentLensIntensity}
              enabled={!reduceMotion}
              style={StyleSheet.absoluteFill}
              pointerEvents="box-none"
            >
              <DockMorph
                clarity={stripClarity}
                minScale={0.55}
                reduceMotion={reduceMotion}
                pointerEvents={profileOpen ? "none" : "auto"}
                accessibilityElementsHidden={profileOpen}
                importantForAccessibility={
                  profileOpen ? "no-hide-descendants" : "auto"
                }
                style={[
                  styles.strip,
                  {
                    width: stripWidth,
                    transformOrigin: rtl ? "right center" : "left center",
                    ...(rtl ? { right: STRIP_INSET } : { left: STRIP_INSET }),
                  },
                ]}
              >
                <View style={styles.tabRow}>{children}</View>
              </DockMorph>
            </DockContentLens>
            <DockMorph
              clarity={iconClarity}
              minScale={0.5}
              reduceMotion={reduceMotion}
              pointerEvents={profileOpen ? "auto" : "none"}
              accessibilityElementsHidden={!profileOpen}
              importantForAccessibility={
                profileOpen ? "auto" : "no-hide-descendants"
              }
              style={[
                styles.activeGlyph,
                styles.foldedAction,
                rtl ? { right: 0 } : { left: 0 },
                foldedGlyphPosition,
              ]}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={closeLabel}
                onPress={closeProfile}
                style={styles.foldedAction}
              >
                {items.map((item, index) => (
                  <CollapsedGlyph
                    key={item.name}
                    item={item}
                    index={index}
                    color={colors.text}
                  />
                ))}
              </Pressable>
            </DockMorph>
          </Animated.View>
        </GestureDetector>
        <Animated.View
          pointerEvents={profileOpen ? "box-none" : "none"}
          style={[styles.clip, profileStyle]}
          accessibilityElementsHidden={!profileOpen}
          importantForAccessibility={
            profileOpen ? "auto" : "no-hide-descendants"
          }
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={profileActionLabel}
            accessibilityHint={accountName}
            onPress={() => {
              closeProfile();
              onAccountPress();
            }}
            style={[styles.details, { direction }]}
          >
            <DockMorph
              clarity={profileClarity}
              minScale={0.78}
              reduceMotion={reduceMotion}
              pointerEvents="none"
              style={styles.detailButton}
            >
              <View style={styles.profileRow}>
                <Text
                  numberOfLines={1}
                  style={[styles.name, { color: colors.text }]}
                >
                  {accountName}
                </Text>
                <Text
                  numberOfLines={1}
                  style={[styles.caption, { color: colors.muted }]}
                >
                  {profileActionLabel}
                </Text>
              </View>
            </DockMorph>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={qrLabel}
            onPress={() => {
              closeProfile();
              onQrPress();
            }}
            style={[styles.qr, rtl ? { left: 6 } : { right: 6 }]}
          >
            <DockMorph
              clarity={profileClarity}
              minScale={0.5}
              reduceMotion={reduceMotion}
              pointerEvents="none"
              style={styles.detailButton}
            >
              <View style={[styles.profileRow, styles.centered]}>
                <View
                  style={[
                    styles.qrFace,
                    {
                      backgroundColor:
                        theme === "dark"
                          ? "rgba(255,255,255,0.12)"
                          : "rgba(20,24,32,0.06)",
                    },
                  ]}
                >
                  <Icon name="qr" size={18} color={colors.text} />
                </View>
              </View>
            </DockMorph>
          </Pressable>
        </Animated.View>
        <Animated.View style={[styles.avatar, avatarStyle]}>
          <Pressable
            accessibilityLabel={accountLabel}
            accessibilityRole="button"
            accessibilityHint={accountName}
            accessibilityState={{ expanded: profileOpen }}
            hitSlop={3}
            onPress={() => {
              tapFeedback();
              setProfile(!profileOpen);
            }}
            style={styles.glyphButton}
          >
            <DockMorph
              clarity={avatarClarity}
              minScale={0.9}
              blur={14}
              fade={false}
              reduceMotion={reduceMotion}
              style={styles.avatarContent}
            >
              {accountAvatar}
            </DockMorph>
          </Pressable>
        </Animated.View>
      </View>
    </View>
  );
}

function CollapsedGlyph({
  item,
  index,
  color,
}: {
  item: DockItem;
  index: number;
  color: string;
}) {
  const { selectedIndex } = useDockMotion();
  const visibility = useAnimatedStyle(() => ({
    opacity: selectedIndex.get() === index ? 1 : 0,
  }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.glyphButton, StyleSheet.absoluteFill, visibility]}
    >
      {item.renderIcon({ size: 22, tint: color })}
    </Animated.View>
  );
}

type DockTabButtonProps = Omit<TabTriggerSlotProps, "ref"> & {
  item: DockItem;
  index: number;
  visible?: boolean;
  onTabSelect: (name: string) => void;
};

export const DockTabButton = forwardRef<
  ComponentRef<typeof View>,
  DockTabButtonProps
>(function DockTabButton(
  { item, index, isFocused, visible = true, onTabSelect, ...props },
  ref,
) {
  const { colors, reduceMotion } = useTheme();
  const motion = useDockMotion();
  const selectedWeight = useDerivedValue(() => {
    const distance = Math.min(1, Math.abs(motion.slideIndex.get() - index));
    return 1 - distance * distance * (3 - 2 * distance);
  });
  const idleIcon = useAnimatedStyle(() => ({
    opacity: 1 - selectedWeight.get(),
  }));
  const selectedIcon = useAnimatedStyle(() => ({
    opacity: selectedWeight.get(),
  }));
  const labelAppearance = useAnimatedStyle(() => ({
    color: interpolateColor(
      selectedWeight.get(),
      [0, 1],
      [colors.text, colors.accent],
    ),
  }));
  useLayoutEffect(() => {
    if (!isFocused || !visible) return;
    scheduleOnUI(() => {
      "worklet";
      motion.selectedIndex.set(index);
      if (!motion.dragging.get())
        animateDockSelection(motion, index, reduceMotion);
    });
  }, [index, isFocused, motion, reduceMotion, visible]);

  if (!visible) return null;
  return (
    <Pressable
      {...props}
      ref={ref}
      accessibilityRole="tab"
      accessibilityState={{ selected: isFocused }}
      onLongPress={undefined}
      onPress={(event) => {
        // Android's dock gesture owns touch release. Non-touch clicks still
        // reach the Pressable via keyboard and accessibility activation.
        if (androidDock && event.nativeEvent.changedTouches?.length) return;
        scheduleOnUI(animateDockSelection, motion, index, reduceMotion);
        onTabSelect(item.name);
      }}
      style={(state) => [
        typeof props.style === "function" ? props.style(state) : props.style,
        styles.tabButton,
      ]}
    >
      <View style={styles.glyph}>
        <Animated.View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, idleIcon]}
        >
          {item.renderIcon({ tint: colors.text, size: TAB_ICON_SIZE })}
        </Animated.View>
        <Animated.View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, selectedIcon]}
        >
          {item.renderIcon({ tint: colors.accent, size: TAB_ICON_SIZE })}
        </Animated.View>
        {item.renderIconOverlay && (
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            {item.renderIconOverlay()}
          </View>
        )}
      </View>
      <Animated.Text numberOfLines={1} style={[styles.label, labelAppearance]}>
        {item.label}
      </Animated.Text>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  root: { ...StyleSheet.absoluteFill, zIndex: 20 },
  hidden: { display: "none" },
  stage: { position: "absolute", height: EXPANDED_HEIGHT, direction: "ltr" },
  glass: {
    position: "absolute",
    left: -GLASS_BLEED,
    top: -GLASS_BLEED,
    right: -GLASS_BLEED,
    bottom: -GLASS_BLEED,
  },
  clip: { position: "absolute", overflow: "hidden" },
  strip: {
    position: "absolute",
    top: 0,
    height: EXPANDED_HEIGHT,
  },
  tabRow: { flex: 1, flexDirection: "row" },
  thumb: {
    position: "absolute",
    left: 0,
    top: 0,
    height: THUMB_HEIGHT,
    borderRadius: THUMB_HEIGHT / 2,
    transformOrigin: "top left",
  },
  thumbRelief: {
    ...StyleSheet.absoluteFill,
    borderRadius: THUMB_HEIGHT / 2,
    borderWidth: StyleSheet.hairlineWidth,
  },
  thumbReliefLight: {
    borderColor: "rgba(65,73,87,0.22)",
    boxShadow:
      "0px 2px 5px rgba(32,42,59,0.17), 0px 5px 12px rgba(32,42,59,0.09)",
  },
  thumbReliefDark: {
    borderColor: "rgba(255,255,255,0.18)",
    boxShadow: "0px 2px 6px rgba(0,0,0,0.45), 0px 5px 12px rgba(0,0,0,0.18)",
  },
  tabButton: {
    flex: 1,
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
    minWidth: 0,
  },
  glyph: {
    width: TAB_ICON_SIZE,
    height: TAB_ICON_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  label: {
    fontSize: 12,
    lineHeight: 15,
    includeFontPadding: false,
    fontWeight: "500",
    maxWidth: "96%",
  },
  activeGlyph: {
    position: "absolute",
  },
  foldedAction: {
    width: EXPANDED_HEIGHT,
    height: EXPANDED_HEIGHT,
  },
  glyphButton: { flex: 1, justifyContent: "center", alignItems: "center" },
  avatar: { position: "absolute", width: AVATAR_SIZE, height: AVATAR_SIZE },
  avatarContent: { width: AVATAR_SIZE, height: AVATAR_SIZE },
  details: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    height: EXPANDED_HEIGHT,
    paddingStart: AVATAR_INSET + AVATAR_SIZE + 10,
    paddingEnd: 58,
  },
  detailButton: { height: EXPANDED_HEIGHT, minWidth: 0 },
  profileRow: { height: EXPANDED_HEIGHT, justifyContent: "center" },
  centered: { alignItems: "center" },
  name: { fontSize: 16, fontWeight: "600" },
  caption: { fontSize: 11, fontWeight: "500" },
  qr: {
    position: "absolute",
    width: 48,
    top: 0,
    height: EXPANDED_HEIGHT,
    alignItems: "center",
  },
  qrFace: {
    width: 40,
    aspectRatio: 1,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
});
