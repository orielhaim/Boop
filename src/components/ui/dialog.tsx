import { BlurView } from "expo-blur";
import { NavigationContext } from "expo-router/build/react-navigation/core/NavigationContext";
import { IsFocusedContext } from "expo-router/build/react-navigation/core/useIsFocused";
import {
  type ComponentRef,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import {
  AccessibilityInfo,
  ActivityIndicator,
  BackHandler,
  Modal,
  type ModalProps,
  Platform,
  Pressable,
  ScrollView,
  View,
  useWindowDimensions,
} from "react-native";
import Animated, {
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import { scheduleOnRN } from "react-native-worklets";
import { GlassSurface } from "@/components/glassyui/glass-surface";
import {
  GlassBackdropProvider,
  GlassBackdropTarget,
  useGlassBackdropTarget,
} from "@/components/glassyui/lib/glass-backdrop";
import { directionFor, resolveLanguage } from "@/i18n";
import { motion, useTheme } from "@/theme";
import {
  createDialogOwner,
  DialogAccessContext,
  DialogQueueContext,
  type DialogAccess,
} from "./dialog-context";
import {
  createDialogQueue,
  type DialogQueue,
  type DialogRequest,
} from "./dialog-queue";
import { Icon } from "./icon";
import { Ink, tapFeedback } from "./kit";

export type { DialogAction, DialogRequest } from "./dialog-queue";

function useQueue() {
  const context = useContext(DialogQueueContext);
  if (!context) throw new Error("Dialogs require a DialogBoundary");
  return context;
}

/** Scope requests to the calling component and its current period of route focus. */
export function useDialog() {
  const { queue } = useQueue();
  const navigation = useContext(NavigationContext);
  // Onboarding can invoke dialogs outside a navigator. When a route owns
  // the caller, consume the same focus context used by Expo's useIsFocused.
  const focused = useContext(IsFocusedContext) ?? true;
  const dialog = useMemo(() => {
    const owner = createDialogOwner(
      () => focused && (navigation?.isFocused() ?? true),
    );
    return {
      show: (request: DialogRequest) => queue.show(request, owner),
      activate: owner.activate,
      dispose() {
        owner.revoke();
        queue.revoke(owner);
      },
    };
  }, [focused, navigation, queue]);
  useLayoutEffect(() => {
    dialog.activate();
    return dialog.dispose;
  }, [dialog]);
  return dialog;
}

/** For handoffs that deliberately replace their origin route before reporting. */
export function useWindowDialog() {
  const { queue, windowOwner } = useQueue();
  return useMemo(
    () => ({
      show: (request: DialogRequest) => queue.show(request, windowOwner),
    }),
    [queue, windowOwner],
  );
}

export function DialogBoundary({
  access,
  children,
  modal = false,
  onBack,
}: {
  access?: DialogAccess;
  children: ReactNode;
  modal?: boolean;
  onBack?: (handler: () => boolean) => void;
}) {
  const parent = useContext(DialogAccessContext);
  const guard = access ?? parent;
  const allowed = useSyncExternalStore(guard.subscribe, guard.read);
  const context = useMemo(() => {
    const windowOwner = createDialogOwner(() => true);
    const queue = createDialogQueue(
      () => allowed && !windowOwner.signal.aborted && guard.read(),
    );
    return { queue, windowOwner };
  }, [allowed, guard]);
  const { queue } = context;

  useLayoutEffect(() => {
    context.windowOwner.activate();
    const stop = guard.subscribe(() => {
      if (!guard.read()) queue.revoke();
    });
    onBack?.(queue.dismiss);
    return () => {
      stop();
      onBack?.(() => false);
      context.windowOwner.revoke();
      queue.revoke();
    };
  }, [context, guard, onBack, queue]);

  return (
    <DialogAccessContext.Provider value={guard}>
      <DialogQueueContext.Provider value={context}>
        <GlassBackdropProvider>
          <DialogLayer queue={queue} modal={modal} allowed={allowed}>
            {children}
          </DialogLayer>
        </GlassBackdropProvider>
      </DialogQueueContext.Provider>
    </DialogAccessContext.Provider>
  );
}

/** Use for native windows that contain a flow capable of opening app dialogs. */
export function DialogModal({
  children,
  onRequestClose,
  ...props
}: ModalProps) {
  const back = useRef<() => boolean>(() => false);
  const setBack = useCallback((handler: () => boolean) => {
    back.current = handler;
  }, []);
  return (
    <Modal
      {...props}
      onRequestClose={(event) => {
        if (!back.current()) onRequestClose?.(event);
      }}
    >
      <SafeAreaProvider>
        <DialogBoundary modal onBack={setBack}>
          {children}
        </DialogBoundary>
      </SafeAreaProvider>
    </Modal>
  );
}

function DialogLayer({
  children,
  queue,
  modal,
  allowed,
}: {
  children: ReactNode;
  queue: DialogQueue;
  modal: boolean;
  allowed: boolean;
}) {
  const snapshot = useSyncExternalStore(queue.subscribe, queue.read);
  const shown = allowed && snapshot;
  const visible = Boolean(shown);

  useLayoutEffect(() => {
    if (!visible || modal) return;
    const subscription = BackHandler.addEventListener(
      "hardwareBackPress",
      queue.dismiss,
    );
    return () => subscription.remove();
  }, [modal, queue, visible]);

  return (
    <View style={styles.root}>
      <GlassBackdropTarget
        // Keep the content and Expo's Android target attached across dialogs.
        style={styles.root}
      >
        <View
          collapsable={false}
          style={styles.root}
          pointerEvents={visible ? "none" : "auto"}
          accessibilityElementsHidden={visible}
          importantForAccessibility={visible ? "no-hide-descendants" : "auto"}
        >
          {children}
        </View>
      </GlassBackdropTarget>
      {shown && (
        <DialogCard key={shown.dialog.id} snapshot={shown} queue={queue} />
      )}
    </View>
  );
}

// Adapted from Reacticx Dialog. One Reanimated progress value drives the scrim
// and card, and the queue retains the presentation until the exit finishes.
function DialogCard({
  queue,
  snapshot: { phase, dialog },
}: {
  queue: DialogQueue;
  snapshot: NonNullable<ReturnType<DialogQueue["read"]>>;
}) {
  const { t, i18n } = useTranslation("common");
  const { colors, reduceMotion, reduceTransparency, theme } = useTheme();
  const { width, fontScale } = useWindowDimensions();
  const direction = directionFor(resolveLanguage(i18n.resolvedLanguage));
  const target = useGlassBackdropTarget();
  const title = useRef<ComponentRef<typeof View>>(null);
  const progress = useSharedValue(0);
  const active = phase === "active";
  const pending = dialog.pendingIndex !== undefined;
  const tone =
    dialog.request.tone ??
    (dialog.actions?.some((action) => action.tone === "danger")
      ? "danger"
      : "info");
  const variant = styles.useVariants({ tone });
  const actions = dialog.actions ?? [{ label: t("done"), tone: "primary" }];
  const beside =
    actions.length === 2 &&
    Math.min(width - 48, 424) / fontScale >= 302 &&
    actions.every(({ label }) => label.length <= 16);

  useLayoutEffect(() => {
    if (active) {
      progress.set(reduceMotion ? 1 : withSpring(1, motion.travel));
    } else if (reduceMotion) {
      queue.finishExit(dialog.id);
    } else {
      progress.set(
        withTiming(0, { duration: motion.image }, (finished) => {
          if (finished) scheduleOnRN(queue.finishExit, dialog.id);
        }),
      );
    }
  }, [active, dialog.id, progress, queue, reduceMotion]);

  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (title.current)
        AccessibilityInfo.sendAccessibilityEvent(title.current, "focus");
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const overlay = useAnimatedStyle(() => ({
    opacity: interpolate(progress.get(), [0, 1], [0, 1], "clamp"),
  }));
  const card = useAnimatedStyle(() => {
    const value = progress.get();
    return {
      opacity: interpolate(value, [0, 1], [0, 1], "clamp"),
      transform: [
        { translateY: interpolate(value, [0, 1], [9, 0]) },
        { scale: interpolate(value, [0, 1], [0.96, 1]) },
      ],
    };
  });

  return (
    <View style={styles.overlayHost} pointerEvents={active ? "auto" : "none"}>
      <Animated.View style={[styles.fill, overlay]} pointerEvents="none">
        {!reduceTransparency && Platform.OS !== "web" && (
          <BlurView
            style={styles.fill}
            intensity={42}
            tint={theme}
            blurTarget={
              Platform.OS === "android" ? (target ?? undefined) : undefined
            }
            blurMethod={
              Platform.OS === "android" ? "dimezisBlurViewSdk31Plus" : undefined
            }
          />
        )}
        <View style={[styles.fill, styles.scrim]} />
      </Animated.View>
      <Pressable
        accessible={false}
        importantForAccessibility="no"
        style={styles.fill}
        onPress={queue.dismiss}
      />
      <SafeAreaView style={styles.viewport} pointerEvents="box-none">
        <Animated.View
          accessibilityViewIsModal
          accessibilityElementsHidden={!active}
          importantForAccessibility={active ? "yes" : "no-hide-descendants"}
          onAccessibilityEscape={queue.dismiss}
          style={[styles.card, card, { direction }]}
        >
          <GlassSurface
            preset="overlay"
            elevation="raised"
            style={styles.panel}
          >
            <ScrollView
              contentContainerStyle={styles.contents}
              keyboardShouldPersistTaps="handled"
              bounces={false}
            >
              <View
                style={variant.badge}
                accessible={false}
                importantForAccessibility="no"
              >
                <Icon
                  name={
                    tone === "danger"
                      ? "trash"
                      : tone === "error"
                        ? "warning"
                        : "info"
                  }
                  color={tone === "info" ? colors.accent : colors.danger}
                  size={22}
                  weight="bold"
                />
              </View>
              <View style={styles.copy}>
                <View
                  ref={title}
                  accessible
                  accessibilityRole="header"
                  accessibilityLabel={dialog.request.title}
                >
                  <Ink kind="heading" style={styles.title}>
                    {dialog.request.title}
                  </Ink>
                </View>
                {dialog.request.message ? (
                  <Ink kind="body" muted selectable>
                    {dialog.request.message}
                  </Ink>
                ) : null}
                {dialog.failed && (
                  <Ink
                    accessibilityLiveRegion="assertive"
                    style={styles.failure}
                  >
                    {t("dialogActionFailed")}
                  </Ink>
                )}
              </View>
              <View
                style={beside ? styles.actionsInline : styles.actionsStacked}
              >
                {actions.map((action, index) => (
                  <DialogButton
                    key={index}
                    label={action.label}
                    tone={
                      action.tone ??
                      (index === actions.length - 1 ? "primary" : "neutral")
                    }
                    disabled={!active || pending || action.disabled}
                    loading={dialog.pendingIndex === index}
                    inline={beside}
                    onPress={() => {
                      tapFeedback();
                      void queue.select(
                        dialog.id,
                        index,
                        t("dialogActionFailed"),
                      );
                    }}
                  />
                ))}
              </View>
            </ScrollView>
          </GlassSurface>
        </Animated.View>
      </SafeAreaView>
    </View>
  );
}

function DialogButton({
  label,
  tone,
  disabled,
  loading,
  inline,
  onPress,
}: {
  label: string;
  tone: "neutral" | "cancel" | "primary" | "danger";
  disabled?: boolean;
  loading: boolean;
  inline: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const variant = buttonStyles.useVariants({ tone });
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled, busy: loading }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        variant.button,
        inline && styles.inline,
        pressed && styles.pressed,
        disabled && !loading && styles.disabled,
      ]}
    >
      {loading ? (
        <ActivityIndicator
          color={
            tone === "danger"
              ? colors.onDanger
              : tone === "primary"
                ? colors.onAccent
                : colors.text
          }
        />
      ) : null}
      <Ink kind="control" style={variant.label}>
        {label}
      </Ink>
    </Pressable>
  );
}

const styles = StyleSheet.create(({ colors, glass, radius, space }) => ({
  root: { flex: 1 },
  fill: { ...StyleSheet.absoluteFill },
  overlayHost: { ...StyleSheet.absoluteFill, zIndex: 100 },
  scrim: { backgroundColor: glass.scrim },
  viewport: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    margin: space.xl,
  },
  card: { width: "100%", maxWidth: 424, maxHeight: "100%", flexShrink: 1 },
  panel: {
    borderRadius: radius.card,
    flexShrink: 1,
    backgroundColor: colors.raised,
  },
  contents: { padding: space.xl, gap: space.lg },
  badge: {
    alignSelf: "center",
    alignItems: "center",
    justifyContent: "center",
    width: 44,
    height: 44,
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    variants: {
      tone: {
        info: { backgroundColor: colors.selected },
        error: { backgroundColor: colors.recessed },
        danger: { backgroundColor: colors.recessed },
      },
    },
  },
  copy: { gap: space.sm },
  title: { textAlign: "center" },
  actionsInline: { flexDirection: "row", gap: space.sm },
  actionsStacked: { gap: space.sm },
  inline: { flex: 1 },
  pressed: { opacity: 0.78 },
  disabled: { opacity: 0.48 },
  failure: { color: colors.danger },
}));

const buttonStyles = StyleSheet.create(({ colors, radius, space }) => ({
  button: {
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.control,
    borderCurve: "continuous",
    variants: {
      tone: {
        neutral: { backgroundColor: colors.selected },
        cancel: { backgroundColor: colors.recessed },
        primary: { backgroundColor: colors.accent },
        danger: { backgroundColor: colors.danger },
      },
    },
  },
  label: {
    flexShrink: 1,
    textAlign: "center",
    variants: {
      tone: {
        neutral: { color: colors.text },
        cancel: { color: colors.text },
        primary: { color: colors.onAccent },
        danger: { color: colors.onDanger },
      },
    },
  },
}));
