import {
  type ComponentRef,
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  Animated,
  Easing,
  I18nManager,
  Pressable,
  Text,
  type ModalProps,
  type StyleProp,
  type TextProps,
  type ViewStyle,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  initialWindowMetrics,
  SafeAreaInsetsContext,
} from "react-native-safe-area-context";
import { useGlassTheme } from "../glass-provider";
import { Icon } from "@/components/ui/icon";
import { DialogModal } from "@/components/ui/dialog";

/** Arrivals ease out on the library's curve (`--lg-ease-out`); exits ease in. */
export const LAYER_EASING = {
  in: Easing.bezier(0.42, 0, 1, 1),
  out: Easing.bezier(0.32, 0.72, 0, 1),
};

// Without these, iOS turns a landscape screen back to portrait while a layer is open.
const ORIENTATIONS = [
  "portrait",
  "portrait-upside-down",
  "landscape",
  "landscape-left",
  "landscape-right",
] satisfies ModalProps["supportedOrientations"];

/**
 * The screen's safe-area insets, with start and end following the layout direction. Reads the
 * nearest SafeAreaProvider, or the window's first measurement when there is none.
 */
export function useSafeInsets() {
  const insets =
    useContext(SafeAreaInsetsContext) ?? initialWindowMetrics?.insets;
  const left = insets?.left ?? 0;
  const right = insets?.right ?? 0;

  return {
    bottom: insets?.bottom ?? 0,
    end: I18nManager.isRTL ? left : right,
    start: I18nManager.isRTL ? right : left,
    top: insets?.top ?? 0,
  };
}

/**
 * Whether a layer is on screen. It turns true with `open` and stays true until the layer calls
 * `hide` at the end of its exit, so the exit can play. Under Reduce Motion it turns false at once.
 */
export function useLayerPresence(open: boolean, reduceMotion: boolean) {
  const [present, setPresent] = useState(open);

  if (open && !present) setPresent(true);

  if (!open && present && reduceMotion) setPresent(false);

  const hide = useCallback(() => setPresent(false), []);

  return [present, hide] as const;
}

type ModalLayerState = {
  open: boolean;
  setOpen: (open: boolean) => void;
};

const ModalLayerContext = createContext<ModalLayerState | null>(null);

export type ModalLayerRootProps = {
  children?: ReactNode;
  onOpenChange: (open: boolean) => void;
  open: boolean;
};

export function ModalLayerRoot({
  children,
  onOpenChange,
  open,
}: ModalLayerRootProps) {
  const value = useMemo(
    () => ({ open, setOpen: onOpenChange }),
    [open, onOpenChange],
  );

  return (
    <ModalLayerContext.Provider value={value}>
      {children}
    </ModalLayerContext.Provider>
  );
}

/** The nearest modal layer's state. `component` and `root` name the parts in the error. */
export function useModalLayer(component: string, root: string) {
  const context = useContext(ModalLayerContext);

  if (!context) throw new Error(`${component} must be used within ${root}`);

  return context;
}

type ModalLayerHostProps = {
  children: ReactNode;
  /** Android's back button and the web's Escape key. */
  onRequestClose: () => void;
  present: boolean;
};

/** React Native's Modal, set up for a layer that draws its own scrim and animates itself. */
export function ModalLayerHost({
  children,
  onRequestClose,
  present,
}: ModalLayerHostProps) {
  return (
    <DialogModal
      animationType="none"
      navigationBarTranslucent
      onRequestClose={onRequestClose}
      statusBarTranslucent
      supportedOrientations={ORIENTATIONS}
      transparent
      visible={present}
    >
      {present ? children : null}
    </DialogModal>
  );
}

type ModalLayerScrimProps = {
  onPress: () => void;
  /** 0 hidden, 1 shown. */
  progress: Animated.Value;
};

/** The dimmed backdrop behind a modal layer. It fades with `progress`; a tap on it closes the layer. */
export function ModalLayerScrim({ onPress, progress }: ModalLayerScrimProps) {
  const { colors } = useGlassTheme();

  return (
    <>
      <Animated.View
        style={[
          { pointerEvents: "none" },
          StyleSheet.absoluteFill,
          { backgroundColor: colors.scrim, opacity: progress },
        ]}
      />
      <Pressable
        accessible={false}
        importantForAccessibility="no"
        onPress={onPress}
        style={StyleSheet.absoluteFill}
      />
    </>
  );
}

type ModalLayerCloseButtonProps = {
  label: string;
  onPress: () => void;
  /** Places the button; it is absolutely positioned. */
  style?: StyleProp<ViewStyle>;
};

/** The round close button in a layer's top corner, with a 44-point target. */
export function ModalLayerCloseButton({
  label,
  onPress,
  style,
}: ModalLayerCloseButtonProps) {
  const { colors } = useGlassTheme();

  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      hitSlop={4}
      onPress={onPress}
      style={({ pressed }) => [
        styles.close,
        {
          backgroundColor: pressed
            ? colors.pressedSurface
            : colors.controlSurface,
          borderColor: colors.border,
        },
        style,
      ]}
    >
      {({ pressed }) => (
        <Icon
          color={pressed ? colors.foreground : colors.mutedForeground}
          name="close"
          size={16}
        />
      )}
    </Pressable>
  );
}

/** A layer's heading, announced as a header and kept clear of the close button. */
export const ModalLayerTitle = forwardRef<ComponentRef<typeof Text>, TextProps>(
  ({ style, ...rest }, ref) => {
    const { colors } = useGlassTheme();

    return (
      <Text
        ref={ref}
        accessibilityRole="header"
        style={[styles.title, { color: colors.foreground }, style]}
        {...rest}
      />
    );
  },
);

ModalLayerTitle.displayName = "ModalLayerTitle";

/** A layer's supporting text, in the muted ink. */
export const ModalLayerDescription = forwardRef<
  ComponentRef<typeof Text>,
  TextProps
>(({ style, ...rest }, ref) => {
  const { colors } = useGlassTheme();

  return (
    <Text
      ref={ref}
      style={[styles.description, { color: colors.mutedForeground }, style]}
      {...rest}
    />
  );
});

ModalLayerDescription.displayName = "ModalLayerDescription";

const styles = StyleSheet.create({
  close: {
    alignItems: "center",
    borderCurve: "continuous",
    borderRadius: 18,
    borderWidth: 1,
    height: 36,
    justifyContent: "center",
    position: "absolute",
    width: 36,
  },
  description: { fontSize: 15, lineHeight: 21, marginTop: 6 },
  // The close button sits 16 points in from the corner; the title stops 8 points short of it.
  title: {
    fontSize: 20,
    fontWeight: "600",
    letterSpacing: -0.3,
    lineHeight: 25,
    paddingEnd: 36,
  },
});
