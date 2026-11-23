// Adapted from Reacticx Save Button (MIT).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { MorphLoader } from "@/components/ui/organisms/morph-loader";
import { useTranslation } from "react-i18next";
import { Icon, tapFeedback } from "@/components/ui/kit";
import { space, useTheme } from "@/theme";

type SavePhase = "idle" | "loading" | "saved" | "failed";

export function SaveButton({
  label,
  savedLabel,
  savedDecoration,
  onSave,
  onSaved,
  disabled = false,
  visible = true,
  size = "md",
}: {
  label: string;
  savedLabel?: string;
  savedDecoration?: ReactNode;
  onSave: () => boolean | Promise<boolean>;
  onSaved?: () => void;
  disabled?: boolean;
  visible?: boolean;
  size?: "sm" | "md";
}) {
  const { t } = useTranslation("common");
  const { colors, reduceMotion } = useTheme();
  const saved = savedLabel ?? t("saved");
  const failed = t("saveFailed");
  const height = size === "sm" ? 44 : 52;
  const [phase, setPhase] = useState<SavePhase>("idle");
  const mounted = useRef(false);
  const pending = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  function idle() {
    pending.current = false;
    setPhase("idle");
  }

  async function save() {
    if (disabled || pending.current) return;
    pending.current = true;
    tapFeedback();
    setPhase("loading");
    const started = Date.now();
    let success = false;
    try {
      success = await onSave();
    } catch {
      success = false;
    }
    if (!mounted.current) return;
    const finish = () => {
      setPhase(success ? "saved" : "failed");
      timer.current = setTimeout(() => {
        idle();
        if (success) onSaved?.();
      }, 1100);
    };
    timer.current = setTimeout(
      finish,
      Math.max(0, 330 - (Date.now() - started)),
    );
  }

  if (!visible && phase === "idle") return null;
  const busy = phase === "loading";
  const unavailable = disabled && phase === "idle";
  const text = phase === "saved" ? saved : phase === "failed" ? failed : label;
  const reservedText = [label, saved, failed].reduce((a, b) =>
    a.length >= b.length ? a : b,
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={busy ? t("saving") : text}
      accessibilityLiveRegion="polite"
      accessibilityState={{ busy, disabled: unavailable || phase !== "idle" }}
      disabled={unavailable || phase !== "idle"}
      onPress={() => void save()}
      style={[
        styles.button,
        {
          minHeight: height,
          minWidth: size === "sm" ? 80 : 96,
          backgroundColor: colors.accentSoft,
        },
        unavailable && styles.disabled,
      ]}
    >
      <Text
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[styles.label, styles.measure]}
      >
        {reservedText}
      </Text>
      {phase === "saved" && !reduceMotion && savedDecoration && (
        <View pointerEvents="none" style={styles.decoration}>
          {savedDecoration}
        </View>
      )}
      <View pointerEvents="none" style={styles.content}>
        <Animated.View
          key={phase}
          entering={reduceMotion ? undefined : FadeIn.duration(140)}
          style={styles.status}
        >
          {busy ? (
            <MorphLoader size={22} />
          ) : (
            <>
              {phase === "saved" && (
                <Icon name="check" size={16} color={colors.accent} />
              )}
              {phase === "failed" && (
                <Icon name="hangup" size={16} color={colors.danger} />
              )}
              <Text
                style={[
                  styles.label,
                  {
                    color: phase === "failed" ? colors.danger : colors.text,
                    flexShrink: 1,
                  },
                ]}
              >
                {text}
              </Text>
            </>
          )}
        </Animated.View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    position: "relative",
    justifyContent: "center",
    flexShrink: 1,
    borderRadius: 999,
  },
  disabled: { opacity: 0.45 },
  decoration: {
    ...StyleSheet.absoluteFill,
    borderRadius: 999,
    overflow: "hidden",
  },
  measure: {
    opacity: 0,
    paddingStart: space.md,
    paddingEnd: space.md + 19 + space.xs,
    paddingVertical: space.xs,
  },
  content: {
    ...StyleSheet.absoluteFill,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.xs,
    paddingHorizontal: space.md,
  },
  status: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.xs,
  },
  label: { fontSize: 14, fontWeight: "600", textAlign: "center" },
});
