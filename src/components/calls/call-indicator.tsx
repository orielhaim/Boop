import { router, usePathname, useRootNavigationState } from "expo-router";
import { useEffect, useRef } from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useStore } from "zustand";
import { Action, Icon } from "@/components/ui/kit";
import { nameOrAddress, useContact } from "@/db/contacts";
import { useLocal } from "@/services/local";

export function CallIndicator() {
  const { calling } = useLocal();
  const call = useStore(calling.store, (state) => state.call);
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
    router.push({
      pathname: "/call/[key]",
      params: { key: call.peerKey, callId: call.id },
    });
  }, [call, navigation?.key]);

  if (!call || call.phase === "ended" || pathname === `/call/${call.peerKey}`)
    return null;
  return (
    <View
      pointerEvents="box-none"
      style={[styles.container, { top: insets.top + 48 }]}
    >
      <Action
        variant="prominent"
        onPress={() =>
          router.navigate({
            pathname: "/call/[key]",
            params: { key: call.peerKey, callId: call.id },
          })
        }
      >
        <Icon name="phone" size={16} color="#FFFFFF" />
        {call.phase === "incoming" ? "Incoming call" : "Return to call"} ·{" "}
        {nameOrAddress(contact?.name, call.peerKey)}
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
