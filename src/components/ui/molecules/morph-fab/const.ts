import type { WithSpringConfig } from "react-native-reanimated";

export const MORPH_OPEN_SPRING: WithSpringConfig = {
  stiffness: 140,
  damping: 17,
  mass: 0.45,
};
export const MORPH_CLOSE_SPRING: WithSpringConfig = {
  stiffness: 170,
  damping: 20,
  mass: 0.45,
};
export const DEFAULT_SIDE_OFFSET = 16;
export const DEFAULT_SPACING = 12;
export const DEFAULT_STAGGER = 0.1;
