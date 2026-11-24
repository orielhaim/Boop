import { Image } from "expo-image";
import { useLocalSearchParams } from "expo-router";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ink } from "@/components/ui/kit";
import { useAvatar } from "@/core/avatars/use-avatar";
import { parsePublicKey } from "@/core/identity/keys";
import { useLocal } from "@/services/local-context";
import { namespaces } from "@/i18n";

export default function ProfilePhoto() {
  const { key } = useLocalSearchParams<{ key: string }>();
  const publicKey = typeof key === "string" ? parsePublicKey(key) : null;
  const publishedPhoto = useAvatar(publicKey, false);
  const { identity, profileEditor } = useLocal();
  const { draft, photoPreview } = useSyncExternalStore(
    profileEditor.subscribe,
    profileEditor.getSnapshot,
  );
  const photo =
    publicKey === identity.publicKey
      ? draft?.photo.kind === "remove"
        ? undefined
        : (photoPreview ?? publishedPhoto)
      : publishedPhoto;
  const { t } = useTranslation(namespaces);
  return (
    <SafeAreaView style={styles.viewer}>
      {photo ? (
        <Image
          source={photo}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          accessibilityLabel={t("messenger:viewProfilePhoto")}
        />
      ) : (
        <View style={styles.empty}>
          <Ink style={styles.copy}>{t("contacts:unavailable")}</Ink>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  viewer: { flex: 1, backgroundColor: "#111217" },
  empty: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
  },
  copy: { color: "#fff" },
});
