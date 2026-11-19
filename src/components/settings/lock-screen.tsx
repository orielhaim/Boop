import { LinearGradient } from "expo-linear-gradient";
import * as Authentication from "expo-local-authentication";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { BackHandler, Platform, StyleSheet, View } from "react-native";
import { Action, Icon, Ink } from "@/components/ui/kit";
import { ScreenInsets } from "@/components/ui/screen-insets";
import type { AppLock } from "@/core/security/app-lock";
import { namespaces } from "@/i18n";
import { space, useTheme } from "@/theme";

export function LockScreen({
  lock,
  state,
}: {
  lock: AppLock;
  state: ReturnType<AppLock["getState"]>;
}) {
  const { t } = useTranslation(namespaces);
  const { colors, reduceTransparency } = useTheme();
  const [face, setFace] = useState(false);
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    void Authentication.supportedAuthenticationTypesAsync().then(
      (types) =>
        setFace(
          types.includes(Authentication.AuthenticationType.FACIAL_RECOGNITION),
        ),
      () => undefined,
    );
  }, []);

  useEffect(() => {
    if (state.active && state.locked) lock.autoUnlock();
  }, [lock, state.active, state.locked]);

  useEffect(() => {
    if (Platform.OS !== "android" || !state.locked) return;
    const back = BackHandler.addEventListener("hardwareBackPress", () => true);
    return () => back.remove();
  }, [state.locked]);

  return (
    <ScreenInsets
      padding={space.xxl}
      style={[styles.screen, { backgroundColor: colors.background }]}
      accessibilityViewIsModal
    >
      {!reduceTransparency && (
        <LinearGradient
          colors={[colors.heroStart, colors.background, colors.heroEnd]}
          style={StyleSheet.absoluteFill}
        />
      )}
      <View style={styles.content}>
        <View
          style={[
            styles.mark,
            { backgroundColor: colors.surface, borderColor: colors.line },
          ]}
        >
          <Icon name={face ? "faceId" : "fingerprint"} size={48} />
        </View>
        <Ink kind="title" accessibilityRole="header">
          {t("security:locked")}
        </Ink>
        <Ink muted style={styles.center}>
          {t("security:unlockHint")}
        </Ink>
        <Action
          variant="prominent"
          style={styles.unlock}
          disabled={!state.active || state.authenticating}
          onPress={() => void lock.change("unlock")}
        >
          {state.authenticating
            ? t("security:authenticating")
            : t("security:unlock")}
        </Action>
        {state.error ? (
          <Ink
            kind="caption"
            muted
            accessibilityLiveRegion="polite"
            style={styles.center}
          >
            {t(`security:${state.error}`)}
          </Ink>
        ) : null}
      </View>
    </ScreenInsets>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: "center" },
  content: { alignItems: "center", gap: space.lg },
  mark: {
    width: 94,
    height: 94,
    borderRadius: 34,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: space.sm,
  },
  unlock: { alignSelf: "center", minWidth: 144 },
  center: { textAlign: "center" },
});
