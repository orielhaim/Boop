import { create } from "zustand";

export type ThemeChoice = "system" | "light" | "dark";
export const themes: ThemeChoice[] = ["system", "light", "dark"];
export const callNavigationKeys = {
  separateTab: "calls.separate-tab",
  defaultScreen: "calls.default-screen",
};
export const launchScreens = ["chats", "calls"] as const;
export type LaunchScreen = (typeof launchScreens)[number];

export const useAppPreferences = create<{
  theme: ThemeChoice;
  haptics: boolean;
  separateCallsTab: boolean;
  defaultScreen: LaunchScreen;
}>(() => ({
  theme: "system",
  haptics: true,
  separateCallsTab: false,
  defaultScreen: "chats",
}));
