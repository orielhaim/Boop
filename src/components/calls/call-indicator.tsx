import { router, usePathname, useRootNavigationState } from "expo-router";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useStore } from "zustand";
import { Action, Icon } from "@/components/ui/kit";
import { nameOrAddress, useContact } from "@/db/contacts";
import { namespaces } from "@/i18n";
import { isolateText } from "@/i18n/format";
import { useLocal } from "@/services/local-context";

export function CallIndicator() {
  const { t } = useTranslation(namespaces);
  const { calling, nativeOpen } = useLocal();
  const call = useStore(calling.store, (state) => state.call);
  const video = useStore(calling.store, (state) => state.video);
  const reopen = useStore(nativeOpen, (state) => state.id);
  const pathname = usePathname();
  const navigation = useRootNavigationState();
  const insets = useSafeAreaInsets();
  const shown = useRef<string | null>(null);
  const contact = useContact(call?.peerKey ?? "");
  useEffect(() => {
    if (
      !navigation?.key ||
      call?.phase !== "incoming" ||
      shown.current === call.id
    )
      return;
    shown.current = call.id;
    router.navigate({
      pathname: "/call/[key]",
      params: { key: call.peerKey, callId: call.id },
    });
  }, [call, navigation?.key]);
  useEffect(() => {
    if (!navigation?.key || !call || call.id !== reopen) return;
    nativeOpen.setState({ id: null });
    if (pathname === `/call/${call.peerKey}`) return;
    router.navigate({
      pathname: "/call/[key]",
      params: { key: call.peerKey, callId: call.id },
    });
  }, [call, nativeOpen, navigation?.key, pathname, reopen]);

  if (!call || call.phase === "ended" || pathname === `/call/${call.peerKey}`)
    return null;
  const name = video?.conference
    ? t("calls:groupCall")
    : nameOrAddress(contact?.name, call.peerKey);
  const hasVideo =
    video?.local.phase === "sharing" || video?.remote.phase === "receiving";
  const label =
    call.phase === "incoming"
      ? t("calls:incoming")
      : video?.remote.phase === "requesting"
        ? t("video:consent")
        : hasVideo
          ? t("video:active")
          : t("calls:return");
  return (
    <View
      pointerEvents="box-none"
      style={[styles.container, { top: insets.top + 48 }]}
    >
      <Action
        variant="prominent"
        accessibilityLabel={`${label} · ${isolateText(name)}`}
        onPress={() =>
          router.navigate({
            pathname: "/call/[key]",
            params: { key: call.peerKey, callId: call.id },
          })
        }
      >
        <Icon name={hasVideo ? "camera" : "phone"} size={16} color="#FFFFFF" />
        {`${label} · ${isolateText(name)}`}
      </Action>
    </View>
  );
}
const styles = StyleSheet.create({
  container: {
    position: "absolute",
    left: 16,
    right: 16,
    alignItems: "center",
    zIndex: 8,
    elevation: 8,
  },
});
