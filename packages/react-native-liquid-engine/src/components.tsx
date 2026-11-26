import { requireNativeView, requireOptionalNativeModule } from "expo";
import {
  GlassContainer as SystemContainer,
  GlassView,
  isGlassEffectAPIAvailable,
  isLiquidGlassAvailable,
} from "expo-glass-effect";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useState,
  type ReactNode,
  type Ref,
  type ComponentRef,
} from "react";
import {
  AppState,
  Platform,
  processColor,
  StyleSheet,
  View,
  type ViewProps,
} from "react-native";
import Animated, {
  useAnimatedProps,
  useAnimatedStyle,
  useDerivedValue,
  type SharedValue,
} from "react-native-reanimated";
import {
  MAX_GLASS_SHAPES,
  packScene,
  packSceneOptics,
  shapeCorners,
  type GlassScene,
} from "./geometry";
import { resolveGlassMaterial, type GlassMaterialInput } from "./material";

const moduleName = "LiquidGlassEngine";
const nativeAndroid =
  Platform.OS === "android"
    ? requireOptionalNativeModule<{ supportsRecordedBackdrop: boolean }>(
        moduleName,
      )
    : null;
const BackdropView = nativeAndroid?.supportsRecordedBackdrop
  ? requireNativeView<ViewProps & { sourceId?: string }>(
      moduleName,
      "GlassBackdropView",
    )
  : null;
interface OpticsProps extends ViewProps {
  sourceId?: string;
  captureEnabled?: boolean;
  sampleWindow?: boolean;
  refractContent?: boolean;
  opaqueColor?: number;
  geometry?: number[];
  optics?: number[];
}
const OpticsView = nativeAndroid?.supportsRecordedBackdrop
  ? Animated.createAnimatedComponent(
      requireNativeView<OpticsProps>(moduleName, "GlassOpticsView"),
    )
  : null;

function hasSystemGlass() {
  if (Platform.OS !== "ios") return false;
  try {
    return isGlassEffectAPIAvailable() && isLiquidGlassAvailable();
  } catch {
    return false;
  }
}

const systemGlass = hasSystemGlass();
const AnimatedSystemGlass = systemGlass
  ? Animated.createAnimatedComponent(GlassView)
  : null;

export function getGlassCapabilities() {
  if (OpticsView)
    return {
      backend: "android-render-node",
      maxShapes: MAX_GLASS_SHAPES,
      customOptics: true,
    } as const;
  if (systemGlass)
    return {
      backend: "ios-system",
      maxShapes: MAX_GLASS_SHAPES,
      customOptics: false,
    } as const;
  return {
    backend: "opaque",
    maxShapes: MAX_GLASS_SHAPES,
    customOptics: false,
  } as const;
}

interface BackdropScope {
  id: string;
  active: boolean;
}

const BackdropContext = createContext<BackdropScope | null>(null);

export function useGlassSceneEnabled(enabled: boolean) {
  const scope = useContext(BackdropContext);
  return enabled && (scope?.active ?? true);
}

export function GlassProvider({
  children,
  active = true,
}: {
  children: ReactNode;
  active?: boolean;
}) {
  const parent = useContext(BackdropContext);
  const id = useId();
  const [foreground, setForeground] = useState(
    () => AppState.currentState === "active" || AppState.currentState === null,
  );
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setForeground(state === "active"),
    );
    return () => subscription.remove();
  }, []);
  return (
    <BackdropContext.Provider
      value={{ id, active: active && foreground && (parent?.active ?? true) }}
    >
      {children}
    </BackdropContext.Provider>
  );
}

/** Render one source per provider. Use a sibling renderer to sample it. */
export function GlassBackdrop(props: ViewProps) {
  const backdrop = useContext(BackdropContext);
  if (!BackdropView || !backdrop) return <View {...props} />;
  return (
    <BackdropView
      {...props}
      sourceId={backdrop.active ? backdrop.id : undefined}
    />
  );
}

export interface GlassRendererProps extends Pick<
  ViewProps,
  "style" | "testID"
> {
  /** Local layout points. Give the renderer a box that contains its entire scene. */
  scene: Readonly<Pick<SharedValue<GlassScene>, "value" | "get">>;
  /** The number of animated shape slots used by the system-glass and opaque backends. */
  shapeCount: number;
  material?: GlassMaterialInput;
  opaqueColor?: string;
  enabled?: boolean;
  /** Window sampling is explicit. Android falls back to the named source where unavailable. */
  backdrop?: "source" | "window";
  colorScheme?: "auto" | "light" | "dark";
  systemStyle?: "clear" | "regular";
  systemTint?: string;
  systemSpacing?: number;
}

export interface GlassContentLensProps extends ViewProps {
  scene: GlassRendererProps["scene"];
  material?: GlassMaterialInput;
  /** Color behind the content, used to composite the separated color channels. */
  matteColor?: string;
  enabled?: boolean;
}

/** Refract the live pixels of a view subtree in place. Coordinates are local to this view. */
export function GlassContentLens({
  scene,
  material = "lens",
  matteColor = "#ffffff",
  enabled = true,
  ...props
}: GlassContentLensProps) {
  const active = useGlassSceneEnabled(enabled);
  const resolved = resolveGlassMaterial(material);
  const color = processColor(matteColor);
  const animatedProps = useAnimatedProps(() => {
    const frame = scene.get();
    return {
      geometry: packScene(frame),
      optics: packSceneOptics(frame, resolved),
    };
  });
  if (!OpticsView) return <View {...props} />;
  return (
    <OpticsView
      {...props}
      captureEnabled={active}
      refractContent
      opaqueColor={typeof color === "number" ? color : undefined}
      animatedProps={animatedProps}
    />
  );
}

export function GlassRenderer({
  scene,
  shapeCount,
  material: input = "regular",
  opaqueColor = "#202228",
  enabled = true,
  backdrop = "source",
  colorScheme = "auto",
  systemStyle = "regular",
  systemTint,
  systemSpacing,
  ...viewProps
}: GlassRendererProps) {
  const source = useContext(BackdropContext);
  const active = enabled && (source?.active ?? true);
  const material = resolveGlassMaterial(input);
  const animatedProps = useAnimatedProps(() => {
    const frame = scene.get();
    return {
      geometry: packScene(frame),
      optics: packSceneOptics(frame, material),
    };
  });
  const fallback = {
    ...viewProps,
    pointerEvents: "none",
    accessible: false,
    importantForAccessibility: "no-hide-descendants",
  } as const;
  if (OpticsView && (source || backdrop === "window")) {
    const color = processColor(opaqueColor);
    return (
      <OpticsView
        {...fallback}
        sourceId={source?.id}
        captureEnabled={active}
        sampleWindow={backdrop === "window"}
        opaqueColor={typeof color === "number" ? color : undefined}
        animatedProps={animatedProps}
      />
    );
  }

  const native = systemGlass && active;
  const shapes = Array.from(
    { length: Math.min(MAX_GLASS_SHAPES, shapeCount) },
    (_, index) => (
      <ShapeLayer
        key={index}
        index={index}
        scene={scene}
        native={native}
        color={opaqueColor}
        colorScheme={colorScheme}
        effect={systemStyle}
        tint={systemTint}
      />
    ),
  );
  return native && shapeCount > 1 ? (
    <SystemContainer {...fallback} spacing={systemSpacing}>
      {shapes}
    </SystemContainer>
  ) : (
    <View {...fallback}>{shapes}</View>
  );
}

function ShapeLayer({
  index,
  scene,
  native,
  color,
  colorScheme,
  effect,
  tint,
}: {
  index: number;
  scene: GlassRendererProps["scene"];
  native: boolean;
  color: string;
  colorScheme: GlassRendererProps["colorScheme"];
  effect: GlassRendererProps["systemStyle"];
  tint: string | undefined;
}) {
  const style = useAnimatedStyle(() => {
    const shape = scene.get().shapes[index];
    if (!shape) return { width: 0, height: 0, opacity: 0 };
    const [topLeft, topRight, bottomRight, bottomLeft] = shapeCorners(shape);
    return {
      left: shape.x,
      top: shape.y,
      width: shape.width,
      height: shape.height,
      opacity: 1,
      borderTopLeftRadius: topLeft,
      borderTopRightRadius: topRight,
      borderBottomRightRadius: bottomRight,
      borderBottomLeftRadius: bottomLeft,
      borderRadius: Math.min(topLeft, topRight, bottomRight, bottomLeft),
      borderCurve: shape.kind === "continuous" ? "continuous" : "circular",
      transform: [{ rotate: `${shape.rotation ?? 0}rad` }],
    };
  });
  if (native && AnimatedSystemGlass) {
    return (
      <AnimatedSystemGlass
        glassEffectStyle={effect}
        colorScheme={colorScheme}
        tintColor={tint}
        pointerEvents="none"
        style={[styles.shape, style]}
      />
    );
  }
  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.shape, style, { backgroundColor: color }]}
    />
  );
}

export interface GlassSurfaceProps extends ViewProps {
  ref?: Ref<ComponentRef<typeof View>>;
  shape?: Pick<GlassScene["shapes"][number], "radius" | "kind">;
  material?: GlassMaterialInput;
  opaqueColor?: string;
  enabled?: boolean;
  backdrop?: GlassRendererProps["backdrop"];
  colorScheme?: GlassRendererProps["colorScheme"];
  systemStyle?: GlassRendererProps["systemStyle"];
  systemTint?: string;
}

export function GlassSurface({
  shape = { radius: 22, kind: "roundedRect" },
  material,
  opaqueColor,
  enabled,
  backdrop,
  colorScheme,
  systemStyle,
  systemTint,
  children,
  onLayout,
  ...props
}: GlassSurfaceProps) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const scene = useDerivedValue<GlassScene>(() => ({
    shapes: [{ ...shape, ...size, x: 0, y: 0 }],
  }));
  return (
    <View
      {...props}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        setSize((current) =>
          current.width === width && current.height === height
            ? current
            : { width, height },
        );
        onLayout?.(event);
      }}
    >
      <GlassRenderer
        style={StyleSheet.absoluteFill}
        scene={scene}
        shapeCount={1}
        material={material}
        opaqueColor={opaqueColor}
        enabled={enabled}
        backdrop={backdrop}
        colorScheme={colorScheme}
        systemStyle={systemStyle}
        systemTint={systemTint}
      />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  shape: { position: "absolute", overflow: "hidden" },
});
