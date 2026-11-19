import { Image } from "expo-image";
import { radius } from "@/theme";

export function BoopLogo({ size = 64 }: { size?: number }) {
  return (
    <Image
      source={require("../../../assets/images/icon.png")}
      style={{ width: size, height: size, borderRadius: radius.input }}
      contentFit="contain"
      accessible={false}
    />
  );
}
