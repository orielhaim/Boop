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
  type GlassyUiPreferences,
  type GlassyUiTheme,
  readSystemAccessibility,
  subscribeToSystemAccessibility,
} from "./lib/preferences";
import { GLASS_COLORS } from "./lib/tokens";

type Preferences = Required<GlassyUiPreferences>;
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
  const preferences = useMemo<Record<GlassyUiTheme, Preferences>>(
    () => ({
      light: { theme: "light", mode: "clear", ...accessibility },
      dark: { theme: "dark", mode: "clear", ...accessibility },
    }),
    [accessibility],
  );
  return (
    <ThemeSwitcher
      theme={choice === "system" ? (scheme === "dark" ? "dark" : "light") : choice}
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
  return { colors: GLASS_COLORS[preferences.theme], preferences };
}
