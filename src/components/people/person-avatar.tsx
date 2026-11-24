import { StyleSheet, View } from "react-native";
import {
  GlassAvatar,
  type GlassAvatarSize,
} from "@/components/glassyui/glass-avatar";

export function PersonAvatar({
  publicKey,
  name,
  photo,
  hasName,
  animateArrival,
  size = "md",
}: {
  publicKey: string;
  name: string;
  photo?: string;
  hasName: boolean;
  animateArrival?: boolean;
  size?: GlassAvatarSize;
}) {
  const cell = size === "xl" || size === "xxl" ? 6 : 3;
  const pattern = hasName ? undefined : (
    <View style={[styles.pattern, { width: cell * 5 }]}>
      {Array.from({ length: 25 }, (_, index) => {
        const column = index % 5;
        const bit = Math.floor(index / 5) * 3 + Math.min(column, 4 - column);
        const lit = Number.parseInt(publicKey[bit], 16) % 2 === 1;
        return (
          <View
            key={index}
            style={{
              width: cell,
              height: cell,
              backgroundColor: lit ? "#fff" : undefined,
            }}
          />
        );
      })}
    </View>
  );
  return (
    <GlassAvatar
      name={name}
      src={photo}
      size={size}
      fallback={pattern}
      animateArrival={animateArrival}
    />
  );
}

const styles = StyleSheet.create({
  pattern: { flexDirection: "row", flexWrap: "wrap", direction: "ltr" },
});
