import { requireOptionalNativeModule } from "expo";
import {
  type ComponentRef,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  AppState,
  findNodeHandle,
  type LayoutChangeEvent,
  type LayoutRectangle,
  PixelRatio,
  Platform,
  View,
} from "react-native";
import { StyleSheet, UnistylesRuntime } from "react-native-unistyles";
import {
  cancelAnimation,
  Easing,
  useDerivedValue,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import {
  AlphaType,
  Canvas,
  Circle,
  ColorType,
  Group,
  Image,
  Mask,
  Rect,
  RoundedRect,
  type SkImage,
  Skia,
} from "react-native-skia";
import { scheduleOnRN } from "react-native-worklets";
import { motion, type ThemeName } from "@/theme/tokens";
import type { ThemeChoice } from "@/stores/preferences";

type Size = { width: number; height: number };
type CaptureView = ComponentRef<typeof View>;
type Presentation = { theme: ThemeName; choice: ThemeChoice };
type Snapshot = {
  image: SkImage;
  release: () => void;
};
type Transition = Size &
  Pick<Snapshot, "image"> & {
    target: ThemeName;
    liveArea: LayoutRectangle | null;
    reveal: () => void;
    finish: () => void;
  };

const captureTimeout = 300;
let hardwareCaptureAvailable = true;

const androidSnapshot = requireOptionalNativeModule<{
  copy: (
    tag: number,
    width: number,
    height: number,
  ) => Promise<Uint8Array | null>;
}>("BoopThemeSnapshot");

const ThemeControlContext = createContext<{
  keepControlLive: (view: CaptureView) => () => void;
  displayedChoice: ThemeChoice;
} | null>(null);

export function useThemeRevealControl() {
  const control = useContext(ThemeControlContext);
  if (!control) throw new Error("The theme switcher is missing");
  return control;
}

function measureInWindow(view: CaptureView): Promise<LayoutRectangle> {
  return new Promise((resolve) => {
    view.measureInWindow((x, y, width, height) =>
      resolve({ x, y, width, height }),
    );
  });
}

async function measureLiveArea(
  source: CaptureView,
  control: CaptureView | null,
): Promise<LayoutRectangle | null> {
  if (!control) return null;
  const [root, bounds] = await Promise.all([
    measureInWindow(source),
    measureInWindow(control),
  ]);
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  return { ...bounds, x: bounds.x - root.x, y: bounds.y - root.y };
}

async function capture(
  view: CaptureView,
  { width, height }: Size,
  canCapture: () => boolean,
): Promise<Snapshot> {
  if (Platform.OS === "android") {
    const tag = findNodeHandle(view);
    if (!canCapture() || tag == null || !androidSnapshot) {
      throw new Error("Theme capture unavailable");
    }
    const scale = Math.min(
      PixelRatio.get(),
      1.5,
      Math.sqrt(1_500_000 / (width * height)),
    );
    const pixelWidth = Math.floor(width * scale);
    const pixelHeight = Math.floor(height * scale);
    const pixels = await androidSnapshot.copy(tag, pixelWidth, pixelHeight);
    if (!pixels || !canCapture()) throw new Error("Theme capture unavailable");
    const data = Skia.Data.fromBytes(pixels);
    try {
      const image = Skia.Image.MakeRaster(
        {
          width: pixelWidth,
          height: pixelHeight,
          alphaType: AlphaType.Premul,
          colorType: ColorType.RGBA_8888,
        },
        data,
        pixelWidth * 4,
      );
      if (!image) throw new Error("Theme capture unavailable");
      return { image, release: () => image.dispose() };
    } finally {
      data.dispose();
    }
  }

  const { GPUTextureUsage, importDevice } = await import("react-native-webgpu");
  const device = importDevice(Skia.getNativeDevice());
  const usage = GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING;

  async function snapshot(
    device: GPUDevice,
    hardware: boolean,
  ): Promise<Snapshot> {
    if (!canCapture()) throw new Error("Theme capture cancelled");
    // Bound bitmap readback on high-density displays.
    const scale = hardware
      ? PixelRatio.get()
      : Math.min(PixelRatio.get(), 1.25);
    const size = {
      width: Math.round(width * scale),
      height: Math.round(height * scale),
    };
    const texture = device.createTexture({
      size,
      format: "rgba8unorm",
      usage: usage | (hardware ? GPUTextureUsage.RENDER_ATTACHMENT : 0),
    });

    try {
      await device.queue.drawElementImageToTexture(
        { source: view, afterScreenUpdates: false },
        { texture, size, premultipliedAlpha: true },
      );
      if (!canCapture()) throw new Error("Theme capture cancelled");
      const image = Skia.Image.MakeFromGPUTexture(texture);
      return {
        image,
        release() {
          image.dispose();
          texture.destroy();
        },
      };
    } catch (error) {
      texture.destroy();
      throw error;
    }
  }

  if (
    Platform.OS === "ios" &&
    hardwareCaptureAvailable &&
    device.features.has("shared-texture-memory-iosurface")
  ) {
    try {
      return await snapshot(device, true);
    } catch (error) {
      if (!canCapture()) throw error;
      // Some drivers advertise the feature but reject the native buffer.
      // Without RENDER_ATTACHMENT, WebGPU uploads a native bitmap instead.
      hardwareCaptureAvailable = false;
      return snapshot(importDevice(Skia.getNativeDevice()), false);
    }
  }
  return snapshot(device, false);
}

function subscribeToForeground(listener: () => void) {
  const subscription = AppState.addEventListener("change", listener);
  return () => subscription.remove();
}

function isForeground() {
  return AppState.currentState === "active";
}

// Adapted from Reacticx Theme Switch. Capture the outgoing view, then reveal
// the new palette through its circular mask without remounting the app.
export function ThemeSwitcher({
  theme,
  choice,
  enabled,
  children,
}: {
  theme: ThemeName;
  choice: ThemeChoice;
  enabled: boolean;
  children: (theme: ThemeName) => ReactNode;
}) {
  const view = useRef<CaptureView>(null);
  const [liveControl, setLiveControl] = useState<CaptureView | null>(null);
  const keepControlLive = useCallback((control: CaptureView) => {
    setLiveControl(control);
    return () => {
      setLiveControl((current) => (current === control ? null : current));
    };
  }, []);
  const active = useSyncExternalStore(
    subscribeToForeground,
    isForeground,
    isForeground,
  );
  const [{ width, height }, setSize] = useState<Size>({ width: 0, height: 0 });
  const [rendered, setRendered] = useState<Presentation>({ theme, choice });
  const [transition, setTransition] = useState<Transition | null>(null);
  const animated = enabled && active && width > 0 && height > 0;
  const displayedTheme = animated ? rendered.theme : theme;
  const displayedChoice = displayedTheme === theme ? choice : rendered.choice;
  const committed = useRef(displayedTheme);
  const control = useMemo(
    () => ({ keepControlLive, displayedChoice }),
    [displayedChoice, keepControlLive],
  );

  useEffect(() => {
    if (animated && Platform.OS === "ios") {
      void import("react-native-webgpu")
        .then(({ importDevice }) => importDevice(Skia.getNativeDevice()))
        .catch(() => {});
    }
  }, [animated]);

  useLayoutEffect(() => {
    if (UnistylesRuntime.themeName !== displayedTheme) {
      UnistylesRuntime.setTheme(displayedTheme);
    }
    committed.current = displayedTheme;
  }, [displayedTheme]);

  useLayoutEffect(() => {
    const source = view.current;
    const commit = () => {
      setRendered((current) =>
        current.theme === theme && current.choice === choice
          ? current
          : { theme, choice },
      );
    };
    if (
      !animated ||
      !source ||
      !isForeground() ||
      committed.current === theme
    ) {
      commit();
      return;
    }

    let pending = true;
    let snapshot: Snapshot | undefined;

    function retire() {
      const outgoing = snapshot;
      if (!outgoing) return;
      snapshot = undefined;
      setTransition((current) =>
        current?.image === outgoing.image ? null : current,
      );
      // Let Skia retire the overlay's recording before destroying its texture.
      setTimeout(outgoing.release, 50);
    }

    const timeout = setTimeout(() => {
      pending = false;
      commit();
      retire();
    }, captureTimeout);

    const canCapture = () => pending && isForeground();
    const acquiring = capture(source, { width, height }, canCapture).then(
      (outgoing) => {
        if (canCapture()) snapshot = outgoing;
        else outgoing.release();
      },
    );
    void Promise.all([measureLiveArea(source, liveControl), acquiring]).then(
      ([liveArea]) => {
        if (!snapshot || !canCapture()) return;
        clearTimeout(timeout);
        setTransition({
          image: snapshot.image,
          target: theme,
          liveArea,
          width,
          height,
          reveal: () => {
            if (canCapture()) commit();
          },
          finish: retire,
        });
      },
      () => {
        if (pending) commit();
        pending = false;
        clearTimeout(timeout);
        retire();
      },
    );

    return () => {
      pending = false;
      clearTimeout(timeout);
      retire();
    };
  }, [animated, choice, height, liveControl, theme, width]);

  function onLayout({ nativeEvent }: LayoutChangeEvent) {
    const { width, height } = nativeEvent.layout;
    setSize((current) =>
      current.width === width && current.height === height
        ? current
        : { width, height },
    );
  }

  const overlay =
    animated &&
    transition?.target === theme &&
    transition.width === width &&
    transition.height === height
      ? transition
      : null;

  return (
    <View style={styles.fill}>
      <View
        ref={view}
        onLayout={onLayout}
        collapsable={false}
        style={styles.fill}
      >
        <ThemeControlContext.Provider value={control}>
          {children(displayedTheme)}
        </ThemeControlContext.Provider>
      </View>
      {((animated && liveControl) || overlay) && (
        <Canvas
          colorSpace="srgb"
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={StyleSheet.absoluteFill}
        >
          {overlay && (
            <ThemeReveal
              transition={overlay}
              revealing={displayedTheme === theme}
            />
          )}
        </Canvas>
      )}
    </View>
  );
}

function ThemeReveal({
  transition,
  revealing,
}: {
  transition: Transition;
  revealing: boolean;
}) {
  const { image, width, height, liveArea, reveal, finish } = transition;
  const progress = useSharedValue(0);
  const originX = liveArea ? liveArea.x + liveArea.width / 2 : width / 2;
  const originY = liveArea ? liveArea.y + liveArea.height / 2 : height / 2;
  const maxRadius =
    Math.hypot(
      Math.max(originX, width - originX),
      Math.max(originY, height - originY),
    ) + 1;
  // Start beyond the live capsule so the first palette change is visible
  // around the selector even before the radius advances.
  const initialRadius = liveArea ? liveArea.height * 0.85 : 0;
  const radius = useDerivedValue(
    () => initialRadius + (maxRadius - initialRadius) * progress.get(),
  );

  useLayoutEffect(() => {
    progress.set(0);
    // Submit the outgoing frame before revealing the new palette and selection.
    let frame = requestAnimationFrame(() => {
      if (liveArea) reveal();
      else frame = requestAnimationFrame(reveal);
    });
    return () => cancelAnimationFrame(frame);
  }, [liveArea, progress, reveal]);

  useLayoutEffect(() => {
    if (!revealing) return;
    progress.set(
      withTiming(
        1,
        { duration: motion.themeReveal, easing: Easing.out(Easing.cubic) },
        (finished) => {
          if (finished) scheduleOnRN(finish);
        },
      ),
    );
    return () => cancelAnimation(progress);
  }, [finish, progress, revealing]);

  return (
    <Mask
      mode="luminance"
      mask={
        <Group>
          <Rect x={0} y={0} width={width} height={height} color="white" />
          {liveArea && (
            <RoundedRect {...liveArea} r={liveArea.height / 2} color="black" />
          )}
          <Circle cx={originX} cy={originY} r={radius} color="black" />
        </Group>
      }
    >
      <Image
        image={image}
        x={0}
        y={0}
        width={width}
        height={height}
        fit="fill"
      />
    </Mask>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
