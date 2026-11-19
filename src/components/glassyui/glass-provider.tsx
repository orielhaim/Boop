import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useSyncExternalStore,
} from "react";
import { useColorScheme } from "react-native";
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
  theme,
}: {
  children: ReactNode;
  theme?: GlassyUiTheme;
}) {
  const scheme = useColorScheme();
  const accessibility = useSyncExternalStore(
    subscribeToSystemAccessibility,
    readSystemAccessibility,
    readSystemAccessibility,
  );
  const preferences = useMemo<Preferences>(
    () => ({
      theme: theme ?? (scheme === "dark" ? "dark" : "light"),
      mode: "clear",
      reduceMotion: accessibility.reduceMotion,
      reduceTransparency: accessibility.reduceTransparency,
    }),
    [accessibility, scheme, theme],
  );
  return (
    <PreferencesContext.Provider value={preferences}>
      {children}
    </PreferencesContext.Provider>
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
