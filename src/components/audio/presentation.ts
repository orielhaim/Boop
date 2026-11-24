import { createContext, useContext } from "react";
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
