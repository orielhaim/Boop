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
import {
  type ReactNode,
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { Alert, AppState, Modal, StyleSheet, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { CallIndicator } from "@/components/calls/call-indicator";
import { GlassProvider } from "@/components/glassyui/glass-provider";
import { MarmotChatLists } from "@/components/messages/marmot-chat-lists";
import { IdentitySheetProvider } from "@/components/people/identity-sheet";
import { LockScreen } from "@/components/settings/lock-screen";
import { OpeningMark, openingPalette } from "@/components/opening/brand";
import { OpeningButton } from "@/components/opening/controls";
import { OpeningCurtain } from "@/components/opening/curtain";
import { glassStackBack } from "@/components/ui/back-button";
import { Ink } from "@/components/ui/kit";
import { ScreenInsets } from "@/components/ui/screen-insets";
import { IncompatibleDatabaseError } from "@/db";
import { preference } from "@/db/queries";
import {
  directionFor,
  namespaces,
  preferredLanguage,
  resolveLanguage,
} from "@/i18n";
import { applyLanguage, initializeLanguage } from "@/i18n/direction";
import { readLanguagePreference } from "@/i18n/preference";
import { initializeLocal, LocalSessionLifecycle } from "@/services/local";
import { Onboarding } from "@/components/onboarding";
import { IdentityMismatchError } from "@/core/identity/storage";
import { LocalContext, type LocalServices } from "@/services/local-context";
import {
  callNavigationKeys,
  defaultFavoritesDisplay,
  favoritesDisplayKey,
  favoritesDisplays,
  themes,
  useAppPreferences,
} from "@/stores/preferences";
import { space, useTheme } from "@/theme";

export const unstable_settings = { initialRouteName: "(messenger)" };

void SplashScreen.preventAutoHideAsync().catch(() => {});
SplashScreen.setOptions({ duration: 0, fade: false });

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={styles.root}>
      <KeyboardProvider>
        <Boot />
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}

type LocalResult = Awaited<ReturnType<typeof initializeLocal>>;
type Startup =
  | { phase: "boot" }
  | {
      phase: "installing";
      welcome: Extract<LocalResult, { status: "welcome" }>;
    }
  | { phase: "loaded"; data: LocalResult }
  | { phase: "failed"; failure: "database" | "startup" | "identity" };

const subscribeWithoutLock = () => () => {};

function Boot() {
  const { t } = useTranslation(namespaces);
  const selected = useAppPreferences((state) => state.theme);
  const [attempt, setAttempt] = useState(0);
  const [startup, setStartup] = useState<Startup>({ phase: "boot" });
  const [handedOff, setHandedOff] = useState(false);
  const [destinationDrawn, setDestinationDrawn] = useState(false);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    let live = true;
    void initializeLocal()
      .then(async (result) => {
        if (!live || (await initializeLanguage(result.db)) || !live) return;
        const choice = themes.find((item) => item === result.theme) ?? "system";
        const favoritesDisplay = preference(result.db, favoritesDisplayKey);
        useAppPreferences.setState({
          theme: choice,
          haptics: result.haptics,
          favoritesDisplay:
            favoritesDisplays.find((item) => item === favoritesDisplay) ??
            defaultFavoritesDisplay,
          separateCallsTab:
            preference(result.db, callNavigationKeys.separateTab) === "on",
          defaultScreen:
            preference(result.db, callNavigationKeys.defaultScreen) === "calls"
              ? "calls"
              : "chats",
        });
        setStartup({ phase: "loaded", data: result });
      })
      .catch((error) => {
        if (!live) return;
        setStartup({
          phase: "failed",
          failure:
            error instanceof IncompatibleDatabaseError
              ? "database"
              : error instanceof IdentityMismatchError
                ? "identity"
                : "startup",
        });
      });
    return () => {
      live = false;
    };
  }, [attempt]);

  const handOff = useCallback(() => {
    if (handedOff) return;
    // Expo Image has attached the decoded drawable. Keep the same frame in
    // place when Expo releases the native splash's draw gate.
    requestAnimationFrame(() => {
      void SplashScreen.hideAsync()
        .finally(() => setHandedOff(true))
        .catch(() => {});
    });
  }, [handedOff]);
  const reveal = useCallback(() => setRevealed(true), []);
  const welcome =
    startup.phase === "installing"
      ? startup.welcome
      : startup.phase === "loaded" && startup.data.status === "welcome"
        ? startup.data
        : undefined;
  const ready =
    startup.phase === "loaded" && startup.data.status === "ready"
      ? startup.data
      : undefined;
  const failed = startup.phase === "failed" ? startup.failure : undefined;
  const covered = !handedOff || (!welcome && !revealed);
  const lock = ready?.lock;
  const canCapture = useSyncExternalStore(
    lock?.subscribe ?? subscribeWithoutLock,
    useCallback(() => {
      const state = lock?.getState();
      return !state || !state.enabled || (!state.locked && state.active);
    }, [lock]),
  );

  function restart(welcome?: Extract<LocalResult, { status: "welcome" }>) {
    setDestinationDrawn(false);
    setRevealed(false);
    setStartup(welcome ? { phase: "installing", welcome } : { phase: "boot" });
    setAttempt((value) => value + 1);
  }

  return (
    <GlassProvider
      choice={selected}
      animateThemeChanges={!covered && canCapture}
    >
      <BootSurface>
        {handedOff && welcome ? (
          <Onboarding
            key={startup.phase === "installing" ? attempt - 1 : attempt}
            data={welcome}
            initializing={startup.phase === "installing"}
            onComplete={() => restart(welcome)}
          />
        ) : ready || failed ? (
          <View
            key={ready ? "session" : "error"}
            style={styles.root}
            onLayout={() => setDestinationDrawn(true)}
            pointerEvents={covered ? "none" : "auto"}
            accessibilityElementsHidden={covered}
            importantForAccessibility={covered ? "no-hide-descendants" : "auto"}
          >
            {ready ? (
              <ProtectedApplication data={ready} />
            ) : (
              <ScreenInsets padding={space.xxl} style={styles.boot}>
                <OpeningMark />
                <Ink
                  kind="heading"
                  accessibilityRole="header"
                  style={styles.center}
                >
                  {t(
                    failed === "database"
                      ? "errors:databaseBaseline"
                      : failed === "identity"
                        ? "messenger:identityMismatch"
                        : "errors:startup",
                  )}
                </Ink>
                <OpeningButton
                  primary
                  label={t("common:retry")}
                  onPress={() => restart()}
                />
              </ScreenInsets>
            )}
          </View>
        ) : null}
        {covered && (
          <OpeningCurtain
            revealing={destinationDrawn && Boolean(ready || failed)}
            handedOff={handedOff}
            label={t("common:opening")}
            onDrawn={handOff}
            onRevealed={reveal}
          />
        )}
      </BootSurface>
    </GlassProvider>
  );
}

function BootSurface({ children }: { children: ReactNode }) {
  const { colors, theme } = useTheme();
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
      <View
        style={[styles.root, { backgroundColor: openingPalette[theme].base }]}
      >
        {children}
      </View>
    </ThemeProvider>
  );
}

function ProtectedApplication({ data }: { data: LocalServices }) {
  const { t, i18n } = useTranslation(namespaces);
  const deviceLanguage = useLocales()[0]?.languageCode;
  const direction = directionFor(resolveLanguage(i18n.resolvedLanguage));
  const { colors, reduceMotion } = useTheme();
  const { db, calling, lock } = data;
  const chatsEnabled = useSyncExternalStore(
    data.chatPreferences.subscribe,
    data.chatPreferences.enabled,
  );
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
      <LocalSessionLifecycle />
      <MarmotChatLists enabled={chatsEnabled}>
        <LocaleProvider direction={direction}>
          <IdentitySheetProvider
            key={data.identity.publicKey}
            obscured={obscured}
          >
            <View
              style={[styles.root, { direction }, obscured && styles.obscured]}
              pointerEvents={obscured ? "none" : "auto"}
              accessibilityElementsHidden={obscured}
              importantForAccessibility={
                obscured ? "no-hide-descendants" : "auto"
              }
            >
              <Stack
                screenOptions={({ navigation }) => ({
                  ...glassStackBack(navigation.goBack),
                  animation: reduceMotion ? "none" : undefined,
                  contentStyle: { backgroundColor: colors.background },
                })}
              >
                <Stack.Screen
                  name="(messenger)"
                  options={{ headerShown: false }}
                />
                <Stack.Screen
                  name="call/[key]"
                  options={{ headerShown: false, presentation: "card" }}
                />
                <Stack.Screen
                  name="scan"
                  options={{
                    headerShown: false,
                    presentation: "modal",
                  }}
                />
              </Stack>
              {!obscured && <CallIndicator />}
            </View>
          </IdentitySheetProvider>
        </LocaleProvider>
      </MarmotChatLists>
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
  center: { textAlign: "center" },
  boot: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: space.lg,
  },
});
