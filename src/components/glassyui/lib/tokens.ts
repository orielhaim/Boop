import { Platform } from "react-native";
import { motion } from "@/theme/tokens";

export const GLASS_MOTION = {
  nativeDriver: Platform.OS !== "web",
  spring: motion.settle,
};
