import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { GlassProvider } from "@/components/glassyui/glass-provider";
import { Action, Ink } from "@/components/ui/kit";
import {
  initializeLocal,
  LocalContext,
  MessagingLifecycle,
} from "@/services/local";
import { themes, useAppPreferences } from "@/stores/preferences";
import { space, useTheme } from "@/theme";

void SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  const [attempt, retry] = useState(0);
  const selected = useAppPreferences((state) => state.theme);
  return (
    <GestureHandlerRootView style={styles.root}>
      <KeyboardProvider>
        <GlassProvider
          defaultTheme={selected === "system" ? undefined : selected}
        >
          <Boot key={attempt} onRetry={() => retry((value) => value + 1)} />
        </GlassProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}

function Boot({ onRetry }: { onRetry: () => void }) {
  const [data, setData] =
    useState<Awaited<ReturnType<typeof initializeLocal>>>();
  const [state, setState] = useState<"loading" | "error" | "ready">("loading");
  const { colors, theme } = useTheme();
  useEffect(() => {
    let live = true;
    initializeLocal().then(
      (result) => {
        if (!live) return;
        const choice = themes.find((item) => item === result.theme) ?? "system";
        useAppPreferences.setState({
          theme: choice,
          haptics: result.haptics,
        });
        setData(result);
        setState("ready");
      },
      () => {
        if (live) setState("error");
      },
    );
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (state !== "loading") void SplashScreen.hideAsync().catch(() => {});
  }, [state]);

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
        <LocalContext.Provider value={data}>
          <MessagingLifecycle />
          <Stack
            screenOptions={{
              headerBackButtonDisplayMode: "minimal",
              contentStyle: { backgroundColor: colors.background },
            }}
          >
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen
              name="call/[key]"
              options={{ title: "Call", presentation: "modal" }}
            />
            <Stack.Screen name="chat/[key]" options={{ headerShown: false }} />
            <Stack.Screen name="contact/[key]" options={{ title: "Contact" }} />
            <Stack.Screen
              name="contact/new"
              options={{ title: "Add contact", presentation: "modal" }}
            />
            <Stack.Screen
              name="scan"
              options={{ title: "Scan address", presentation: "modal" }}
            />
            <Stack.Screen
              name="connect"
              options={{ title: "Connect", presentation: "modal" }}
            />
            <Stack.Screen
              name="settings/index"
              options={{ title: "Settings" }}
            />
          </Stack>
        </LocalContext.Provider>
      ) : (
        <View style={[styles.boot, { backgroundColor: colors.background }]}>
          <Ink kind="title">Boop</Ink>
          {state === "error" ? (
            <>
              <Ink muted>
                Boop could not open your identity or local data. Unlock your
                device and try again.
              </Ink>
              <Action
                onPress={() => {
                  onRetry();
                }}
              >
                Try again
              </Action>
            </>
          ) : (
            <ActivityIndicator
              accessibilityLabel="Opening Boop"
              color={colors.accent}
            />
          )}
        </View>
      )}
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  boot: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: space.lg,
    padding: space.xxl,
  },
});
