import { useNavigation, useRoute } from "expo-router";
import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
} from "react";
import type { DerivedValue } from "react-native-reanimated";

export const PlayerPresentation = createContext<{
  setVisible(visible: boolean): void;
  miniHeight: number;
  fullOpacity: DerivedValue<number>;
} | null>(null);

export function usePlayerPresentation() {
  const player = useContext(PlayerPresentation);
  if (!player) throw new Error("Audio player layout unavailable");
  return player;
}

export function useActiveWithAudioOverlay() {
  const navigation = useNavigation();
  const { key } = useRoute();
  const subscribe = useCallback(
    (notify: () => void) => navigation.addListener("state", notify),
    [navigation],
  );
  return useSyncExternalStore(subscribe, () => {
    const state = navigation.getState();
    if (!state) return navigation.isFocused();
    const { index, routes } = state;
    const current = routes[index];
    return (
      current?.key === key ||
      (current?.name === "audio-player" && routes[index - 1]?.key === key)
    );
  });
}
