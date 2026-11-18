import { create } from "zustand";

export type ThemeChoice = "system" | "light" | "dark";
export const themes: ThemeChoice[] = ["system", "light", "dark"];

export const useAppPreferences = create<{
  theme: ThemeChoice;
  haptics: boolean;
}>(() => ({
  theme: "system",
  haptics: true,
}));
