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
  makeMutable,
  type SharedValue,
  useDerivedValue,
  useFrameCallback,
} from "react-native-reanimated";
import {
  AlphaType,
  Canvas,
  ColorType,
  Group,
  Image,
  type SkImage,
  type SkRRect,
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
type Opening = {
  x: number;
  y: number;
  end: number;
  progress: SharedValue<number>;
};
type Wave = Size &
  Snapshot & {
    id: number;
    target: Presentation;
    opening: Opening;
    probe: { x: number; y: number };
    elapsed: SharedValue<number>;
  };

const captureTimeout = 300;
let hardwareCaptureAvailable = true;

const androidSnapshot = requireOptionalNativeModule<{
  copy: (
    tag: number,
    width: number,
    height: number,
  ) => Promise<Uint8Array | null>;
  awaitFrameCover?: (tag: number, x: number, y: number) => Promise<boolean>;
}>("BoopThemeSnapshot");

const androidOverlay = {
  backingView: "SurfaceView",
  zOrderOnTop: true,
  opaque: false,
} as const;

function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function disposeWave(wave: Wave) {
  wave.elapsed.set(-1);
  // Skia may still present a recording referencing this image after React unmounts it.
  setTimeout(wave.release, 50);
}

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
  const canvas = useRef<CaptureView>(null);
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
  const [waves, setWaves] = useState<Wave[]>([]);
  const sequence = useRef(0);
  const owned = useRef(new Map<number, Wave>());
  const cancelCapture = useRef<(() => void) | null>(null);
  const awaitingPresentation = useRef<Wave | null>(null);
  const readyToAnimate = useRef<Wave | null>(null);
  const animated = enabled && active && width > 0 && height > 0;
  const displayedTheme = animated ? rendered.theme : theme;
  const displayedChoice = animated ? rendered.choice : choice;
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

  const retire = useCallback((id: number) => {
    const wave = owned.current.get(id);
    if (!wave) return;
    owned.current.delete(id);
    disposeWave(wave);
    setWaves((current) => current.filter((item) => item.id !== id));
  }, []);

  useLayoutEffect(() => {
    const snapshots = owned.current;
    return () => {
      snapshots.forEach(disposeWave);
      snapshots.clear();
      awaitingPresentation.current = null;
      readyToAnimate.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    for (const wave of owned.current.values()) {
      if (animated && wave.width === width && wave.height === height) continue;
      if (awaitingPresentation.current === wave)
        awaitingPresentation.current = null;
      if (readyToAnimate.current === wave) readyToAnimate.current = null;
      retire(wave.id);
    }
  }, [animated, width, height, retire]);

  // The capture belongs to this surface even when another theme is requested.
  useLayoutEffect(
    () => () => cancelCapture.current?.(),
    [animated, width, height],
  );

  useLayoutEffect(() => {
    if (UnistylesRuntime.themeName !== displayedTheme) {
      UnistylesRuntime.setTheme(displayedTheme);
    }
    const wave = readyToAnimate.current;
    if (!wave || wave.target !== rendered) return;
    readyToAnimate.current = null;
    void nextFrame().then(() => {
      if (owned.current.has(wave.id)) wave.elapsed.set(0);
    });
  }, [displayedTheme, rendered]);

  useLayoutEffect(() => {
    const source = view.current;
    if (cancelCapture.current || awaitingPresentation.current) return;
    const target = { theme, choice };
    const commit = () =>
      setRendered((current) =>
        current.theme === theme && current.choice === choice ? current : target,
      );
    if (!animated || !source || !isForeground() || rendered.theme === theme) {
      commit();
      return;
    }
    let pending = true;
    const canCapture = () => pending && isForeground();
    const clear = () => {
      pending = false;
      clearTimeout(timeout);
      if (cancelCapture.current === clear) cancelCapture.current = null;
    };
    const timeout = setTimeout(() => {
      clear();
      if (owned.current.size === 0) commit();
    }, captureTimeout);
    cancelCapture.current = clear;

    const prepare = async () => {
      // Wait for the currently selected palette to reach the native window.
      await nextFrame();
      if (!canCapture()) return;
      const measuring = measureLiveArea(source, liveControl);
      const snapshot = await capture(source, { width, height }, canCapture);
      try {
        const liveArea = await Promise.race([
          measuring,
          nextFrame().then(() => null),
        ]);
        if (!canCapture()) {
          snapshot.release();
          return;
        }
        const x = liveArea ? liveArea.x + liveArea.width / 2 : width / 2;
        const y = liveArea ? liveArea.y + liveArea.height / 2 : height / 2;
        const previous = Array.from(owned.current.values()).at(-1)?.opening;
        const wave: Wave = {
          ...snapshot,
          width,
          height,
          id: ++sequence.current,
          target,
          probe: { x: previous?.x ?? x, y: previous?.y ?? y },
          elapsed: makeMutable(-1),
          opening: {
            x,
            y,
            end:
              Math.hypot(Math.max(x, width - x), Math.max(y, height - y)) + 1,
            progress: makeMutable(0),
          },
        };
        clear();
        awaitingPresentation.current = wave;
        owned.current.set(wave.id, wave);
        setWaves((current) => [...current, wave]);
      } catch (error) {
        snapshot.release();
        throw error;
      }
    };
    void prepare().catch(() => {
      if (canCapture() && owned.current.size === 0) commit();
      clear();
    });
  }, [
    animated,
    choice,
    height,
    liveControl,
    rendered.theme,
    theme,
    waves.length,
    width,
  ]);

  const newest = waves.at(-1);
  useLayoutEffect(() => {
    if (!newest || awaitingPresentation.current !== newest) return;
    let current = true;
    const present = async () => {
      // The previous opening stays transparent until the incoming cover is drawn.
      await nextFrame();
      let covered = true;
      const tag = canvas.current && findNodeHandle(canvas.current);
      if (tag != null && androidSnapshot?.awaitFrameCover) {
        const { x, y } = newest.probe;
        covered = await androidSnapshot.awaitFrameCover(
          tag,
          x / width,
          y / height,
        );
      } else {
        await nextFrame();
      }
      if (!current || awaitingPresentation.current !== newest) return;
      awaitingPresentation.current = null;
      if (covered) {
        readyToAnimate.current = newest;
        setRendered(newest.target);
      } else {
        retire(newest.id);
        if (owned.current.size === 0) setRendered(newest.target);
      }
    };
    void present().catch(() => {
      if (!current || awaitingPresentation.current !== newest) return;
      awaitingPresentation.current = null;
      retire(newest.id);
      if (owned.current.size === 0) setRendered(newest.target);
    });
    return () => {
      current = false;
    };
  }, [newest, width, height, retire]);

  function onLayout({ nativeEvent }: LayoutChangeEvent) {
    const { width, height } = nativeEvent.layout;
    setSize((current) =>
      current.width === width && current.height === height
        ? current
        : { width, height },
    );
  }

  const visible = animated
    ? waves.filter((wave) => wave.width === width && wave.height === height)
    : [];

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
      {visible.map((wave) => (
        <WaveMotion key={wave.id} wave={wave} retire={retire} />
      ))}
      {((animated && liveControl) || visible.length > 0) && (
        <View
          ref={canvas}
          collapsable={false}
          pointerEvents="none"
          style={StyleSheet.absoluteFill}
        >
          <Canvas
            android={androidOverlay}
            colorSpace="srgb"
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={StyleSheet.absoluteFill}
          >
            {visible.toReversed().map((wave, index, newestFirst) => (
              <ThemeReveal
                key={wave.id}
                wave={wave}
                openings={newestFirst
                  .slice(0, index + 1)
                  .map((item) => item.opening)}
              />
            ))}
          </Canvas>
        </View>
      )}
    </View>
  );
}

function WaveMotion({
  wave,
  retire,
}: {
  wave: Wave;
  retire: (id: number) => void;
}) {
  const {
    id,
    elapsed,
    opening: { progress },
  } = wave;
  const duration = motion.themeReveal;
  useFrameCallback(({ timeSincePreviousFrame }) => {
    const previous = elapsed.get();
    if (previous < 0) return;
    // A delayed frame must not skip a visible portion of the reveal.
    const step = Math.min(timeSincePreviousFrame ?? 1000 / 60, 1000 / 30);
    const next = Math.min(previous + step, duration);
    const fraction = next / duration;
    progress.set(fraction + fraction * fraction * (1 - fraction));
    elapsed.set(next === duration ? -1 : next);
    if (next === duration) scheduleOnRN(retire, id);
  });
  return null;
}

function ThemeReveal({ wave, openings }: { wave: Wave; openings: Opening[] }) {
  const { image, width, height } = wave;
  // A newer opening reveals the live palette through every older snapshot.
  return openings.reduce<ReactNode>(
    (snapshot, opening) => (
      <RevealMask opening={opening}>{snapshot}</RevealMask>
    ),
    <Image
      image={image}
      x={0}
      y={0}
      width={width}
      height={height}
      fit="fill"
    />,
  );
}

function RevealMask({
  opening,
  children,
}: {
  opening: Opening;
  children: ReactNode;
}) {
  const { x, y, end, progress } = opening;
  const circle = useDerivedValue<SkRRect>(() => {
    const radius = end * progress.get();
    return {
      rect: {
        x: x - radius,
        y: y - radius,
        width: 2 * radius,
        height: 2 * radius,
      },
      rx: radius,
      ry: radius,
    };
  });
  return (
    <Group clip={circle} invertClip>
      {children}
    </Group>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
