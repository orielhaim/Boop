import { Appearance } from "react-native";
import { StyleSheet, type UnistylesBreakpoints } from "react-native-unistyles";
import { themes } from "./tokens";

const breakpoints: UnistylesBreakpoints = {
  compact: 0,
  regular: 430,
  wide: 720,
};

declare module "react-native-unistyles" {
  export interface UnistylesThemes {
    light: (typeof themes)["light"];
    dark: (typeof themes)["dark"];
  }
  export interface UnistylesBreakpoints {
    compact: number;
    regular: number;
    wide: number;
  }
}

StyleSheet.configure({
  themes,
  breakpoints,
  settings: {
    initialTheme: Appearance.getColorScheme() === "dark" ? "dark" : "light",
  },
});
