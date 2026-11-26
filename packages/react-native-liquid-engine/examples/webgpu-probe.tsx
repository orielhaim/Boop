import { useEffect, useRef, useState, type ComponentRef } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import { importDevice } from "react-native-webgpu";
import { rect, Skia, type SkImage } from "react-native-skia";
import type { GlassScene } from "../src/geometry";
import { SkiaGlass } from "../src/skia";

const stageWidth = 240;
const stageHeight = 120;
const region = rect(20, 18, 200, 84);

interface ProbeResult {
  image: SkImage;
  submitMs: number;
  completeMs: number;
}

/**
 * Development-only measurement of a fixed, synthetic view. Supply the
 * app's window capture and route authorization through captureAllowed.
 */
export function WebGPUProbe({ captureAllowed }: { captureAllowed: boolean }) {
  const fixture = useRef<ComponentRef<typeof View>>(null);
  const sequence = useRef(0);
  const [result, setResult] = useState<ProbeResult>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const scene = useSharedValue<GlassScene>({
    shapes: [{ x: 35, y: 28, width: 170, height: 62, radius: 31 }],
  });

  useEffect(() => {
    if (!captureAllowed) {
      setResult(undefined);
      setPending(false);
    }
    return () => {
      sequence.current++;
    };
  }, [captureAllowed]);
  useEffect(() => () => result?.image.dispose(), [result]);

  const capture = async () => {
    if (!captureAllowed || !fixture.current || pending) return;
    const request = ++sequence.current;
    const source = fixture.current;
    setPending(true);
    setError("");
    let texture: GPUTexture | undefined;
    let retained = false;
    try {
      const device = importDevice(Skia.getNativeDevice());
      texture = device.createTexture({
        size: { width: region.width, height: region.height },
        format: "rgba8unorm",
        usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
      });
      const start = performance.now();
      await device.queue.drawElementImageToTexture(
        {
          source,
          sourceX: region.x,
          sourceY: region.y,
          sourceWidth: region.width,
          sourceHeight: region.height,
          afterScreenUpdates: false,
        },
        { texture, size: { width: region.width, height: region.height } },
      );
      const submitMs = performance.now() - start;
      await device.queue.onSubmittedWorkDone();
      if (request !== sequence.current) return;
      const image = Skia.Image.MakeFromGPUTexture(texture);
      retained = true;
      setResult({ image, submitMs, completeMs: performance.now() - start });
    } catch (failure) {
      if (request === sequence.current) {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    } finally {
      // Skia retains the successful texture. Destroying it here would
      // invalidate the displayed image despite native references.
      if (!retained) texture?.destroy();
      if (request === sequence.current) setPending(false);
    }
  };

  return (
    <View>
      <View style={styles.stage}>
        <View ref={fixture} collapsable={false} style={styles.fixture}>
          {[
            "#163f72",
            "#fe9850",
            "#fcdd68",
            "#3ea18a",
            "#79379f",
            "#235a7c",
          ].map((color) => (
            <View key={color} style={{ flex: 1, backgroundColor: color }} />
          ))}
        </View>
        {result && captureAllowed && (
          <SkiaGlass
            image={result.image}
            imageRect={region}
            scene={scene}
            material="lens"
            fallback={[0.11, 0.18, 0.27, 1]}
            style={StyleSheet.absoluteFill}
          />
        )}
      </View>
      <Pressable
        accessibilityRole="button"
        disabled={pending || !captureAllowed}
        onPress={() => void capture()}
        style={styles.button}
      >
        <Text>Capture synthetic region</Text>
      </Pressable>
      {error ? <Text accessibilityLiveRegion="polite">{error}</Text> : null}
      {result && captureAllowed && (
        <Text accessibilityLiveRegion="polite">
          Submit {result.submitMs.toFixed(1)} ms · Queue complete{" "}
          {result.completeMs.toFixed(1)} ms
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  stage: { width: stageWidth, height: stageHeight, overflow: "hidden" },
  fixture: { ...StyleSheet.absoluteFill, flexDirection: "row" },
  button: { minHeight: 44, alignSelf: "flex-start", justifyContent: "center" },
});
