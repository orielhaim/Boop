import type { ViewProps } from "react-native";
import Animated from "react-native-reanimated";
import { type Edge, useSafeAreaInsets } from "react-native-safe-area-context";
import { useTabBarClearance } from "./tab-bar-insets";

const allEdges: readonly Edge[] = ["top", "bottom", "left", "right"];

// Resolve insets from the router's provider before the screen's first layout.
export function ScreenInsets({
  edges = allEdges,
  padding = 0,
  style,
  ...props
}: ViewProps & { edges?: readonly Edge[]; padding?: number }) {
  const insets = useSafeAreaInsets();
  const bottomPadding = useTabBarClearance(
    edges.includes("bottom") ? insets.bottom : 0,
    padding,
  );
  return (
    <Animated.View
      {...props}
      style={[
        style,
        {
          paddingTop: padding + (edges.includes("top") ? insets.top : 0),
          paddingLeft: padding + (edges.includes("left") ? insets.left : 0),
          paddingRight: padding + (edges.includes("right") ? insets.right : 0),
        },
        bottomPadding,
      ]}
    />
  );
}
