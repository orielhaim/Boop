import { router } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { SafeAreaView } from "react-native-safe-area-context";
import type { OverlayProps } from "react-native-screen-transitions";
import { GlassBackButton } from "@/components/ui/back-button";
import { space } from "@/theme";

export function ProfilePhotoControls({ route, focusedRoute }: OverlayProps) {
  if (route.key !== focusedRoute.key) return null;
  return (
    <SafeAreaView
      pointerEvents="box-none"
      edges={["top", "left", "right"]}
      style={styles.controls}
    >
      <GlassBackButton
        onPress={() => {
          if (router.canGoBack()) router.back();
          else router.replace("/people");
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  controls: { alignItems: "flex-start", padding: space.md },
});
