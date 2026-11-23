import { create } from "zustand";

export type ThemeChoice = "system" | "light" | "dark";
export const themes: ThemeChoice[] = ["system", "light", "dark"];
export const callNavigationKeys = {
  separateTab: "calls.separate-tab",
  defaultScreen: "calls.default-screen",
};
export const launchScreens = ["chats", "calls"] as const;
export type LaunchScreen = (typeof launchScreens)[number];
export const favoritesDisplayKey = "contacts.favorites-display";
export const favoritesDisplays = ["normal", "cool"] as const;
export type FavoritesDisplay = (typeof favoritesDisplays)[number];

export const useAppPreferences = create<{
  theme: ThemeChoice;
  haptics: boolean;
  separateCallsTab: boolean;
  defaultScreen: LaunchScreen;
  favoritesDisplay: FavoritesDisplay;
}>(() => ({
  theme: "system",
  haptics: true,
  separateCallsTab: false,
  defaultScreen: "chats",
  favoritesDisplay: "normal",
}));
