import { router } from "expo-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Pressable } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { Icon, tapFeedback } from "@/components/ui/kit";
import { CountBadge } from "@/components/kinetik/count-badge";
import { useLocal } from "@/services/local-context";
import { useTheme } from "@/theme";

import { DownloadProgressRing } from "./progress-ring";

export function DownloadsIndicator() {
  const { downloads } = useLocal();
  const { t } = useTranslation("downloads");
  const { colors, reduceMotion } = useTheme();
  const { count, selected } = useSyncExternalStore(
    downloads.subscribe,
    downloads.indicator,
  );
  const selectedId = selected?.id;
  const [shown, setShown] = useState(selectedId);
  const last = useSyncExternalStore(downloads.subscribe, () =>
    shown ? downloads.get(shown) : undefined,
  );
  const finishing =
    !reduceMotion && last?.state === "completed" && shown !== selectedId;
  const displayed = finishing ? last : selected;

  useEffect(() => {
    if (shown === selectedId) return;
    const timer = setTimeout(() => setShown(selectedId), finishing ? 280 : 0);
    return () => clearTimeout(timer);
  }, [finishing, selectedId, shown]);

  const visible = Boolean(selected || finishing);
  const actionable = visible && count > 0;
  const unknown =
    displayed?.state === "active" &&
    !displayed.total &&
    displayed.nativeState === "downloading";
  const paused = displayed?.state === "paused";
  const waiting =
    displayed?.state === "waiting" ||
    displayed?.nativeState === "retry_scheduled";
  const status = paused ? t("paused") : waiting ? t("waiting") : null;
  const fraction = finishing
    ? 1
    : displayed?.total
      ? Math.min(0.99, displayed.received / displayed.total)
      : 0;
  const width = useSharedValue(visible ? 46 : 0);
  const shownWidth = useAnimatedStyle(() => ({
    width: width.value,
    opacity: width.value / 46,
  }));
  useEffect(() => {
    width.set(
      withTiming(visible ? 46 : 0, { duration: reduceMotion ? 0 : 180 }),
    );
  }, [reduceMotion, visible, width]);

  return (
    <Animated.View
      style={[styles.slot, shownWidth]}
      pointerEvents={actionable ? "auto" : "none"}
    >
      <Pressable
        accessible={actionable}
        accessibilityRole="button"
        accessibilityLabel={[t("indicator", { count }), status]
          .filter(Boolean)
          .join(". ")}
        accessibilityValue={
          !finishing && displayed?.total
            ? { min: 0, max: 100, now: Math.round(fraction * 100) }
            : undefined
        }
        onPress={() => {
          tapFeedback();
          router.push("/downloads");
        }}
        style={styles.button}
      >
        <CountBadge
          count={count > 1 ? count : 0}
          tone="accent"
          size="compact"
          ringColor={colors.background}
          badgeStyle={styles.badge}
        >
          <DownloadProgressRing
            key={displayed?.id}
            size={40}
            fraction={fraction}
            indeterminate={unknown}
          >
            <Icon
              name={
                finishing
                  ? "check"
                  : paused
                    ? "pause"
                    : waiting
                      ? "refresh"
                      : "download"
              }
              size={18}
            />
          </DownloadProgressRing>
        </CountBadge>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  slot: { width: 0, height: 46, overflow: "hidden" },
  button: {
    width: 46,
    height: 46,
    alignItems: "center",
    justifyContent: "center",
  },
  badge: {
    top: -2,
    end: -3,
  },
});
