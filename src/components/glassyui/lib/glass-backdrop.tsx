import { BlurTargetView } from "expo-blur";
import { GlassBackdrop, GlassProvider } from "react-native-liquid-engine";
import {
  createContext,
  useContext,
  useRef,
  type ComponentRef,
  type ReactNode,
  type RefObject,
} from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

export { GlassBackdrop as GlassBackdropLayer };

type BlurTargetRef = RefObject<ComponentRef<typeof View> | null>;

const GlassBackdropContext = createContext<BlurTargetRef | null>(null);

export function GlassBackdropProvider({
  children,
  active = true,
}: {
  children: ReactNode;
  active?: boolean;
}) {
  const target = useRef<ComponentRef<typeof View>>(null);
  return (
    <GlassProvider active={active}>
      <GlassBackdropContext.Provider value={target}>
        {children}
      </GlassBackdropContext.Provider>
    </GlassProvider>
  );
}

export function useGlassBackdropTarget() {
  return useContext(GlassBackdropContext);
}

export function GlassBackdropTarget({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const target = useGlassBackdropTarget();
  if (!target) {
    throw new Error("GlassBackdropTarget must be inside GlassBackdropProvider");
  }

  return (
    <GlassBackdrop style={[styles.target, style]}>
      <BlurTargetView ref={target} style={styles.target}>
        {children}
      </BlurTargetView>
    </GlassBackdrop>
  );
}

const styles = StyleSheet.create({ target: { flex: 1 } });
