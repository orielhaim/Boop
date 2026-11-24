import { BlurTargetView } from "expo-blur";
import {
  createContext,
  useContext,
  useRef,
  type ComponentRef,
  type ReactNode,
  type RefObject,
} from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

type BlurTargetRef = RefObject<ComponentRef<typeof View> | null>;

const GlassBackdropContext = createContext<BlurTargetRef | null>(null);

export function GlassBackdropProvider({ children }: { children: ReactNode }) {
  const target = useRef<ComponentRef<typeof View>>(null);

  return (
    <GlassBackdropContext.Provider value={target}>
      {children}
    </GlassBackdropContext.Provider>
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
    <BlurTargetView ref={target} style={[styles.target, style]}>
      {children}
    </BlurTargetView>
  );
}

const styles = StyleSheet.create({ target: { flex: 1 } });
