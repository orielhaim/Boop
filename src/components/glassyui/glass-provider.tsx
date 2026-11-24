import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useSyncExternalStore,
} from "react";
import { useColorScheme } from "react-native";
import { ThemeSwitcher } from "@/components/ui/theme-switch";
import type { ThemeChoice } from "@/stores/preferences";
import {
  type SystemAccessibility,
  readSystemAccessibility,
  subscribeToSystemAccessibility,
} from "./lib/preferences";
import { themes, type ThemeName } from "@/theme/tokens";

type Preferences = SystemAccessibility & { theme: ThemeName };
const PreferencesContext = createContext<Preferences | null>(null);

export function GlassProvider({
  children,
  choice,
  animateThemeChanges,
}: {
  children: ReactNode;
  choice: ThemeChoice;
  animateThemeChanges: boolean;
}) {
  const scheme = useColorScheme();
  const accessibility = useSyncExternalStore(
    subscribeToSystemAccessibility,
    readSystemAccessibility,
    readSystemAccessibility,
  );
  const preferences = useMemo<Record<ThemeName, Preferences>>(
    () => ({
      light: { theme: "light", ...accessibility },
      dark: { theme: "dark", ...accessibility },
    }),
    [accessibility],
  );
  return (
    <ThemeSwitcher
      theme={
        choice === "system" ? (scheme === "dark" ? "dark" : "light") : choice
      }
      choice={choice}
      enabled={animateThemeChanges && !accessibility.reduceMotion}
    >
      {(displayed) => (
        <PreferencesContext.Provider value={preferences[displayed]}>
          {children}
        </PreferencesContext.Provider>
      )}
    </ThemeSwitcher>
  );
}

export function usePreferences() {
  const preferences = useContext(PreferencesContext);
  if (!preferences) throw new Error("GlassProvider is missing");
  return preferences;
}

export function useGlassTheme() {
  const preferences = usePreferences();
  return { colors: themes[preferences.theme].glass, preferences };
}
