import { memo, useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import {
  Canvas,
  Fill,
  ImageShader,
  rect,
  Shader,
  Skia,
  useImage,
} from "react-native-skia";
import { RIPPLE_SHADER_SOURCE } from "./conf";
import { useRipple } from "./hook";

const shader = Skia.RuntimeEffect.Make(RIPPLE_SHADER_SOURCE);

export default memo(function RippleImage({
  uri,
  width,
  height,
}: {
  uri: string;
  width: number;
  height: number;
}) {
  const data = useMemo(() => {
    const encoded = /^data:image\/[a-z0-9+.-]+;base64,(.*)$/iu.exec(uri)?.[1];
    return encoded ? base64ToBytes(encoded) : uri;
  }, [uri]);
  const image = useImage(data);
  const { uniforms, tap } = useRipple(Boolean(image && shader));
  if (!image || !shader) return null;

  return (
    <GestureDetector gesture={tap}>
      <View style={StyleSheet.absoluteFill}>
        <Canvas style={StyleSheet.absoluteFill}>
          <Fill>
            <Shader source={shader} uniforms={uniforms}>
              <ImageShader
                image={image}
                fit="cover"
                rect={rect(0, 0, width, height)}
                tx="clamp"
                ty="clamp"
              />
            </Shader>
          </Fill>
        </Canvas>
      </View>
    </GestureDetector>
  );
});

function base64ToBytes(encoded: string) {
  return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
}
