import { useLocales } from "expo-localization";
import {
  DarkTheme,
  DefaultTheme,
  LocaleProvider,
  Stack,
  ThemeProvider,
} from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { addDatabaseChangeListener } from "expo-sqlite";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Modal,
  StyleSheet,
  View,
} from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { CallIndicator } from "@/components/calls/call-indicator";
import { GlassProvider } from "@/components/glassyui/glass-provider";
import { LockScreen } from "@/components/settings/lock-screen";
import { Action, Ink } from "@/components/ui/kit";
import {
  directionFor,
  namespaces,
  preferredLanguage,
  resolveLanguage,
} from "@/i18n";
import { applyLanguage, initializeLanguage } from "@/i18n/direction";
import { readLanguagePreference } from "@/i18n/preference";
import { initializeLocal, MessagingLifecycle } from "@/services/local";
import { LocalContext } from "@/services/local-context";
import { themes, useAppPreferences } from "@/stores/preferences";
import { space, useTheme } from "@/theme";

void SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  const [attempt, retry] = useState(0);
  const selected = useAppPreferences((state) => state.theme);
  return (
    <GestureHandlerRootView style={styles.root}>
      <KeyboardProvider>
        <GlassProvider theme={selected === "system" ? undefined : selected}>
          <Boot key={attempt} onRetry={() => retry((value) => value + 1)} />
        </GlassProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}

function Boot({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation(namespaces);
  const [data, setData] =
    useState<Awaited<ReturnType<typeof initializeLocal>>>();
  const [failed, setFailed] = useState(false);
  const { colors, theme } = useTheme();
  useEffect(() => {
    let live = true;
    void initializeLocal()
      .then(async (result) => {
        if (!live || (await initializeLanguage(result.db)) || !live) return;
        const choice = themes.find((item) => item === result.theme) ?? "system";
        useAppPreferences.setState({
          theme: choice,
          haptics: result.haptics,
        });
        setData(result);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (data || failed) void SplashScreen.hideAsync().catch(() => {});
  }, [data, failed]);

  const base = theme === "dark" ? DarkTheme : DefaultTheme;
  return (
    <ThemeProvider
      value={{
        ...base,
        colors: {
          ...base.colors,
          primary: colors.accent,
          background: colors.background,
          card: colors.surface,
          text: colors.text,
          border: colors.line,
        },
      }}
    >
      <StatusBar style={theme === "dark" ? "light" : "dark"} />
      {data ? (
        <ProtectedApplication data={data} />
      ) : (
        <View style={[styles.boot, { backgroundColor: colors.background }]}>
          <Ink kind="title">Boop</Ink>
          {failed ? (
            <>
              <Ink muted>{t("errors:startup")}</Ink>
              <Action onPress={onRetry}>{t("common:retry")}</Action>
            </>
          ) : (
            <ActivityIndicator
              accessibilityLabel={t("common:opening")}
              color={colors.accent}
            />
          )}
        </View>
      )}
    </ThemeProvider>
  );
}

function ProtectedApplication({
  data,
}: {
  data: Awaited<ReturnType<typeof initializeLocal>>;
}) {
  const { t, i18n } = useTranslation(namespaces);
  const deviceLanguage = useLocales()[0]?.languageCode;
  const direction = directionFor(resolveLanguage(i18n.resolvedLanguage));
  const { colors } = useTheme();
  const { db, calling, lock } = data;
  const state = useSyncExternalStore(lock.subscribe, lock.getState);
  const obscured = state.enabled && (state.locked || !state.active);

  useEffect(() => {
    const update = (next: typeof AppState.currentState) =>
      lock.setActive(next === "active");
    const subscription = AppState.addEventListener("change", update);
    update(AppState.currentState);
    return () => subscription.remove();
  }, [lock]);

  useEffect(() => {
    if (!state.hasOpened || obscured) return;
    let queued = false;
    let applying = false;
    let live = true;
    const schedule = () => {
      if (queued || applying) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (!live || AppState.currentState !== "active") return;
        const call = calling.store.getState().call;
        if (call && call.phase !== "ended") return;
        const current = resolveLanguage(i18n.resolvedLanguage);
        const next = preferredLanguage(
          readLanguagePreference(db, current),
          deviceLanguage,
        );
        if (next === current) return;
        applying = true;
        void applyLanguage(next).catch(() => {
          applying = false;
          if (live) Alert.alert(t("settings:languageRestartError"));
        });
      });
    };
    const unwatch = calling.store.subscribe((next, previous) => {
      if (next.call?.phase === "ended" && previous.call?.phase !== "ended")
        schedule();
    });
    const settings = addDatabaseChangeListener(({ tableName }) => {
      if (tableName === "settings") schedule();
    });
    const appState = AppState.addEventListener("change", schedule);
    schedule();
    return () => {
      live = false;
      unwatch();
      settings.remove();
      appState.remove();
    };
  }, [calling, db, deviceLanguage, i18n, obscured, state.hasOpened, t]);

  if (!state.hasOpened) return <LockScreen lock={lock} state={state} />;
  return (
    <LocalContext.Provider value={data}>
      <MessagingLifecycle />
      <LocaleProvider direction={direction}>
        <View
          style={[styles.root, { direction }, obscured && styles.obscured]}
          pointerEvents={obscured ? "none" : "auto"}
          accessibilityElementsHidden={obscured}
          importantForAccessibility={obscured ? "no-hide-descendants" : "auto"}
        >
          <Stack
            screenOptions={{
              headerBackButtonDisplayMode: "minimal",
              contentStyle: { backgroundColor: colors.background },
            }}
          >
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen
              name="call/[key]"
              options={{ headerShown: false, presentation: "card" }}
            />
            <Stack.Screen name="chat/[key]" options={{ headerShown: false }} />
            <Stack.Screen
              name="contact/[key]"
              options={{ title: t("navigation:contact") }}
            />
            <Stack.Screen
              name="contact/new"
              options={{
                title: t("navigation:addContact"),
                presentation: "modal",
              }}
            />
            <Stack.Screen
              name="scan"
              options={{ title: t("navigation:scan"), presentation: "modal" }}
            />
            <Stack.Screen
              name="connect"
              options={{
                title: t("navigation:connect"),
                presentation: "modal",
              }}
            />
            <Stack.Screen name="settings" options={{ headerShown: false }} />
          </Stack>
          {!obscured && <CallIndicator />}
        </View>
      </LocaleProvider>
      <Modal
        visible={obscured}
        onRequestClose={() => undefined}
        presentationStyle="fullScreen"
        statusBarTranslucent
        navigationBarTranslucent
      >
        <LockScreen lock={lock} state={state} />
      </Modal>
    </LocalContext.Provider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  obscured: { opacity: 0 },
  boot: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: space.lg,
    padding: space.xxl,
  },
});
