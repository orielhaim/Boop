import { File, Paths } from "expo-file-system";
import { Image } from "expo-image";
import {
  ImageManipulator,
  type ImageResult,
  SaveFormat,
} from "expo-image-manipulator";
import {
  launchCameraAsync,
  launchImageLibraryAsync,
  requestCameraPermissionsAsync,
} from "expo-image-picker";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import { Action, Icon, Ink, Screen } from "@/components/ui/kit";
import { maxAvatarBytes, sanitizeAvatarJpeg } from "@/core/avatars/jpeg";
import { namespaces } from "@/i18n";
import { space, useTheme } from "@/theme";

function deleteTemporary(uri: string) {
  try {
    const file = new File(uri);
    if (file.uri.startsWith(Paths.cache.uri)) file.delete();
  } catch {
    // The picker and manipulator create these in the OS cache directory.
  }
}

export type AvatarPhotoSource = "gallery" | "camera";

export function useAvatarPicker() {
  const { t } = useTranslation(namespaces);
  const [image, setImage] = useState<ImageResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(false);
  const pending = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (image) return () => deleteTemporary(image.uri);
  }, [image]);

  async function pick(source: AvatarPhotoSource) {
    if (pending.current) return;
    const camera = source === "camera";
    pending.current = true;
    setError("");
    setBusy(true);
    try {
      if (camera && !(await requestCameraPermissionsAsync()).granted) {
        setError(t("settings:photoCameraDenied"));
        return;
      }
      const select = camera ? launchCameraAsync : launchImageLibraryAsync;
      const result = await select({
        mediaTypes: ["images"],
        exif: false,
        base64: false,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset?.uri.startsWith("file://"))
        throw new Error("Photo unavailable");
      try {
        const context = ImageManipulator.manipulate(asset.uri, {
          maxWidth: 2048,
          maxHeight: 2048,
        });
        try {
          const ref = await context.renderAsync();
          try {
            const normalized = await ref.saveAsync({
              format: SaveFormat.JPEG,
              compress: 0.95,
            });
            if (active.current) setImage(normalized);
            else deleteTemporary(normalized.uri);
          } finally {
            ref.release();
          }
        } finally {
          context.release();
        }
      } finally {
        deleteTemporary(asset.uri);
      }
    } catch {
      setError(t("settings:photoProcessFailed"));
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }

  return { image, busy, error, pick, clear: () => setImage(undefined) };
}

type CropProps = {
  source: ImageResult;
  wide?: boolean;
  onSave(file: File): void;
  onCancel(): void;
};

export function AvatarCropScreen({
  topInset,
  ...props
}: CropProps & { topInset?: boolean }) {
  return (
    <Screen scroll={false} topInset={topInset}>
      <View style={styles.editor}>
        <CropPhoto {...props} />
      </View>
    </Screen>
  );
}

export function AvatarPicker({ onSave, onCancel }: Omit<CropProps, "source">) {
  const { t } = useTranslation(namespaces);
  const { image, busy, error, pick } = useAvatarPicker();
  return image ? (
    <CropPhoto source={image} onSave={onSave} onCancel={onCancel} />
  ) : (
    <View style={styles.picker}>
      <Action disabled={busy} onPress={() => void pick("gallery")}>
        {t("settings:photoGallery")}
      </Action>
      <Action
        variant="soft"
        disabled={busy}
        onPress={() => void pick("camera")}
      >
        {t("settings:photoCamera")}
      </Action>
      <Action variant="soft" disabled={busy} onPress={onCancel}>
        {t("common:cancel")}
      </Action>
      {busy && (
        <Ink muted accessibilityLiveRegion="polite">
          {t("settings:photoProcessing")}
        </Ink>
      )}
      {error && <Ink accessibilityRole="alert">{error}</Ink>}
    </View>
  );
}

function clamp(value: number, limit: number) {
  "worklet";
  return Math.max(-limit, Math.min(limit, value));
}

function CropPhoto({ source, wide = false, onSave, onCancel }: CropProps) {
  const { t } = useTranslation(namespaces);
  const { colors } = useTheme();
  const { width, height } = useWindowDimensions();
  const size = Math.min(340, width - space.xl * 2, Math.max(128, height - 310));
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const [rotation, setRotation] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const swap = rotation % 180 !== 0;
  const imageWidth = swap ? source.height : source.width;
  const imageHeight = swap ? source.width : source.height;
  const cropHeight = wide ? size / 2.5 : size;
  const base = Math.max(size / imageWidth, cropHeight / imageHeight);
  const scale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  function move(nextX: number, nextY: number, zoom: number) {
    "worklet";
    x.set(clamp(nextX, (imageWidth * base * zoom - size) / 2));
    y.set(clamp(nextY, (imageHeight * base * zoom - cropHeight) / 2));
  }
  const pan = Gesture.Pan()
    .maxPointers(1)
    .onChange((event) => {
      move(x.get() + event.changeX, y.get() + event.changeY, scale.get());
    });
  const pinch = Gesture.Pinch().onChange((event) => {
    const zoom = Math.max(1, Math.min(5, scale.get() * event.scaleChange));
    const fx = event.focalX - size / 2;
    const fy = event.focalY - cropHeight / 2;
    move(
      fx + ((x.get() - fx) * zoom) / scale.get(),
      fy + ((y.get() - fy) * zoom) / scale.get(),
      zoom,
    );
    scale.set(zoom);
  });
  const transform = useAnimatedStyle(() => ({
    transform: [
      { translateX: x.get() },
      { translateY: y.get() },
      { scale: scale.get() },
      { rotate: `${rotation}deg` },
    ],
  }));
  function zoom(change: number) {
    const value = Math.max(1, Math.min(5, scale.get() + change));
    move(
      (x.get() * value) / scale.get(),
      (y.get() * value) / scale.get(),
      value,
    );
    scale.set(value);
  }
  async function save() {
    setBusy(true);
    setError(false);
    try {
      const pixelsPerPoint = 1 / (base * scale.get());
      const edge = Math.max(
        1,
        Math.min(
          imageWidth,
          wide ? imageWidth : imageHeight,
          Math.round(size * pixelsPerPoint),
        ),
      );
      const cropPixels = Math.max(
        1,
        Math.min(imageHeight, Math.round(cropHeight * pixelsPerPoint)),
      );
      if (wide && cropPixels >= edge) throw new Error("Banner is too small");
      const outputWidth = Math.min(wide ? 1024 : 512, edge);
      const outputHeight = wide
        ? Math.max(1, Math.round((cropPixels * outputWidth) / edge))
        : outputWidth;
      const origin = (bound: number, length: number, offset: number) =>
        Math.min(
          bound - length,
          Math.max(
            0,
            Math.round((bound - length) / 2 - offset * pixelsPerPoint),
          ),
        );
      const context = ImageManipulator.manipulate(source.uri);
      try {
        if (rotation) context.rotate(rotation);
        context.crop({
          originX: origin(imageWidth, edge, x.get()),
          originY: origin(imageHeight, wide ? cropPixels : edge, y.get()),
          width: edge,
          height: wide ? cropPixels : edge,
        });
        if (edge !== outputWidth)
          context.resize({ width: outputWidth, height: outputHeight });
        const ref = await context.renderAsync();
        try {
          for (const compress of [0.88, 0.78, 0.65]) {
            const output = await ref.saveAsync({
              format: SaveFormat.JPEG,
              compress,
            });
            const file = new File(output.uri);
            try {
              if (file.size > maxAvatarBytes) continue;
              const verified = sanitizeAvatarJpeg(await file.bytes(), wide);
              if (
                verified.dimension !== outputWidth ||
                verified.height !== outputHeight
              )
                throw new Error("Unexpected crop size");
              file.write(verified.bytes);
              if (active.current) onSave(file);
              return;
            } finally {
              deleteTemporary(file.uri);
            }
          }
          throw new Error("Photo exceeds size limit");
        } finally {
          ref.release();
        }
      } finally {
        context.release();
      }
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.crop}>
      <GestureDetector gesture={Gesture.Simultaneous(pan, pinch)}>
        <View
          accessible
          accessibilityLabel={t("settings:photoCrop")}
          accessibilityRole="adjustable"
          accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
          onAccessibilityAction={({ nativeEvent }) =>
            zoom(nativeEvent.actionName === "increment" ? 0.25 : -0.25)
          }
          style={[
            styles.stencil,
            {
              width: size,
              height: cropHeight,
              borderRadius: wide ? space.md : size / 2,
              backgroundColor: colors.surface,
            },
          ]}
        >
          <Animated.View
            style={[
              styles.image,
              { width: source.width * base, height: source.height * base },
              transform,
            ]}
          >
            <Image
              source={source.uri}
              cachePolicy="none"
              contentFit="fill"
              style={StyleSheet.absoluteFill}
            />
          </Animated.View>
        </View>
      </GestureDetector>
      <Ink kind="caption" muted>
        {t("settings:photoCropHint")}
      </Ink>
      <View style={styles.controls}>
        <Action
          variant="soft"
          disabled={busy}
          accessibilityLabel={t("settings:photoZoomOut")}
          onPress={() => zoom(-0.25)}
        >
          <Icon name="subtract" size={18} />
        </Action>
        <Action
          variant="soft"
          disabled={busy}
          accessibilityLabel={t("settings:photoZoomIn")}
          onPress={() => zoom(0.25)}
        >
          <Icon name="add" size={18} />
        </Action>
        <Action
          variant="soft"
          disabled={busy}
          onPress={() => {
            x.set(0);
            y.set(0);
            scale.set(1);
            setRotation((rotation + 90) % 360);
          }}
        >
          {t("settings:photoRotate")}
        </Action>
      </View>
      <View style={styles.controls}>
        <Action variant="soft" disabled={busy} onPress={onCancel}>
          {t("common:cancel")}
        </Action>
        <Action disabled={busy} onPress={() => void save()}>
          {t("settings:photoUseCrop")}
        </Action>
      </View>
      {busy && (
        <Ink muted accessibilityLiveRegion="polite">
          {t("settings:photoProcessing")}
        </Ink>
      )}
      {error && (
        <Ink accessibilityRole="alert">{t("settings:photoProcessFailed")}</Ink>
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  editor: { flex: 1, justifyContent: "center", paddingHorizontal: space.xl },
  picker: { gap: space.sm },
  crop: { alignItems: "center", gap: space.md, paddingVertical: space.md },
  stencil: {
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  image: { position: "absolute", direction: "ltr" },
  controls: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: space.sm,
  },
});
