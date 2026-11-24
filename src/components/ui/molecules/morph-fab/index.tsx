import { useEffect, useState, type ReactNode } from "react";
import { BackHandler, Pressable, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import Animated, {
  interpolate,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { tapFeedback } from "@/components/ui/kit";
import { radius, space, useTheme } from "@/theme";
import {
  DEFAULT_SIDE_OFFSET,
  DEFAULT_SPACING,
  DEFAULT_STAGGER,
  MORPH_CLOSE_SPRING,
  MORPH_OPEN_SPRING,
} from "./const";
import { buildGeo, itemProgress, slotAt } from "./geo";
import type { IGeo } from "./types";

type FabAction = {
  label: string;
  icon: ReactNode;
  onSelect: () => void;
};

const triggerSize = 56;
const actionSize = 48;
const noActions: readonly FabAction[] = [];

// Reacticx Morph FAB geometry and stagger, painted as native animated circles.
export function MorphFab(
  props: {
    label: string;
    closeLabel: string;
    trigger: ReactNode;
    rtl: boolean;
  } & (
    | { mode: "menu"; actions: readonly FabAction[] }
    | { mode: "action"; onPress: () => void }
  ),
) {
  const { label, closeLabel, trigger, rtl, mode } = props;
  const actions = props.mode === "menu" ? props.actions : noActions;
  const { colors, reduceMotion } = useTheme();
  const [menuOpen, setOpen] = useState(false);
  const open = mode === "menu" && menuOpen;
  if (mode === "action" && menuOpen) setOpen(false);
  const progress = useSharedValue(0);
  const geo = buildGeo({
    triggerSize: { w: triggerSize, h: triggerSize },
    items: actions.map(() => ({ w: actionSize, h: actionSize })),
    direction: "up",
    align: "center",
    sideOffset: DEFAULT_SIDE_OFFSET,
    spacing: DEFAULT_SPACING,
    itemRadius: radius.round,
    triggerRadius: radius.round,
    padding: 0,
  });

  useEffect(() => {
    const target = open ? 1 : 0;
    progress.value =
      reduceMotion || mode === "action"
        ? target
        : withSpring(target, open ? MORPH_OPEN_SPRING : MORPH_CLOSE_SPRING);
  }, [mode, open, progress, reduceMotion]);

  useEffect(() => {
    if (!open) return;
    const subscription = BackHandler.addEventListener(
      "hardwareBackPress",
      () => {
        setOpen(false);
        return true;
      },
    );
    return () => subscription.remove();
  }, [open]);

  const triggerIcon = useAnimatedStyle(() => ({
    transform: [{ rotate: `${mode === "menu" ? 45 * progress.value : 0}deg` }],
  }));

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      {open && (
        <Pressable
          accessible={false}
          importantForAccessibility="no"
          onPress={() => setOpen(false)}
          style={StyleSheet.absoluteFill}
        />
      )}
      <View
        pointerEvents="box-none"
        style={[styles.positioner, { direction: rtl ? "rtl" : "ltr" }]}
      >
        <View
          pointerEvents="box-none"
          style={[styles.menu, { height: geo.layerH, width: geo.layerW }]}
        >
          {actions.map((action, index) => (
            <MorphAction
              key={action.label}
              action={action}
              index={index}
              geo={geo}
              progress={progress}
              open={open}
              onClose={() => setOpen(false)}
            />
          ))}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={open ? closeLabel : label}
            accessibilityState={
              mode === "menu" ? { expanded: open } : undefined
            }
            onPress={() => {
              tapFeedback();
              if (props.mode === "action") props.onPress();
              else setOpen(!open);
            }}
            style={[
              styles.trigger,
              {
                left: -geo.left,
                backgroundColor: colors.outgoing,
              },
            ]}
          >
            <Animated.View style={triggerIcon}>{trigger}</Animated.View>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function MorphAction({
  action,
  index,
  geo,
  progress,
  open,
  onClose,
}: {
  action: FabAction;
  index: number;
  geo: IGeo;
  progress: SharedValue<number>;
  open: boolean;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const slot = geo.slots[index];
  const surface = useAnimatedStyle(() => {
    const t = itemProgress(
      progress.value,
      index,
      geo.slots.length,
      DEFAULT_STAGGER,
    );
    const rect = slotAt(geo, index, t);
    return {
      opacity: interpolate(t, [0, 0.25, 1], [0, 1, 1]),
      transform: [
        { translateX: rect.x + rect.w / 2 - (slot.x + slot.w / 2) },
        { translateY: rect.y + rect.h / 2 - (slot.y + slot.h / 2) },
        { scale: rect.w / slot.w },
      ],
    };
  });
  const contents = useAnimatedStyle(() => {
    const t = itemProgress(
      progress.value,
      index,
      geo.slots.length,
      DEFAULT_STAGGER,
    );
    return { opacity: interpolate(t, [0, 0.6, 1], [0, 0, 1]) };
  });

  return (
    <View
      pointerEvents={open ? "box-none" : "none"}
      accessibilityElementsHidden={!open}
      importantForAccessibility={open ? "auto" : "no-hide-descendants"}
      style={{
        position: "absolute",
        left: slot.x - geo.left,
        top: slot.y - geo.top,
        width: slot.w,
        height: slot.h,
      }}
    >
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          { borderRadius: slot.r, backgroundColor: colors.outgoing },
          surface,
        ]}
      >
        <Pressable
          disabled={!open}
          accessibilityRole="button"
          accessibilityLabel={action.label}
          onPress={() => {
            tapFeedback();
            onClose();
            action.onSelect();
          }}
          style={({ pressed }) => [
            styles.action,
            { opacity: pressed ? 0.7 : 1 },
          ]}
        >
          <Animated.View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={contents}
          >
            {action.icon}
          </Animated.View>
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  positioner: {
    ...StyleSheet.absoluteFill,
    alignItems: "flex-end",
    justifyContent: "flex-end",
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
  },
  menu: { direction: "ltr" },
  trigger: {
    position: "absolute",
    bottom: 0,
    width: triggerSize,
    height: triggerSize,
    borderRadius: radius.round,
    alignItems: "center",
    justifyContent: "center",
    elevation: 3,
  },
  action: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.round,
  },
});
