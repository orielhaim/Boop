import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef } from "react";
import { ActivityIndicator } from "react-native";
import { useStore } from "zustand";
import { CallScreen } from "@/components/calls/call-screen";
import { Empty, Screen } from "@/components/ui/kit";
import { parsePublicKey } from "@/core/identity/keys";
import { nameOrAddress, useContact } from "@/db/contacts";
import { useLocal } from "@/services/local";

export default function CallRoute() {
  const { key, callId } = useLocalSearchParams<{
    key: string;
    callId?: string;
  }>();
  const { calling, identity } = useLocal();
  const peerKey = typeof key === "string" ? parsePublicKey(key) : null;
  const contact = useContact(peerKey ?? "");
  const call = useStore(calling.store, (state) => state.call);
  const initiated = useRef(false);

  useEffect(() => {
    if (
      !peerKey ||
      peerKey === identity.publicKey ||
      callId ||
      initiated.current
    )
      return;
    initiated.current = true;
    calling.dial(peerKey);
  }, [calling, callId, identity.publicKey, peerKey]);

  const close = () => {
    if (call?.phase === "ended") calling.dismiss(call.id);
    if (router.canGoBack()) router.back();
    else router.replace("/");
  };
  useFocusEffect(
    useCallback(() => {
      if (
        call?.id !== callId ||
        call?.direction !== "incoming" ||
        call.phase !== "ended"
      )
        return;
      if (call.outcome !== "cancelled" && call.outcome !== "missed") return;
      calling.dismiss(call.id);
      if (router.canGoBack()) router.back();
      else router.replace("/");
    }, [call, callId, calling]),
  );
  if (!call && peerKey && peerKey !== identity.publicKey && !callId) {
    return (
      <Screen>
        <ActivityIndicator accessibilityLabel="Starting call" />
      </Screen>
    );
  }
  if (!call || call.peerKey !== peerKey || (callId && call.id !== callId)) {
    return (
      <Screen>
        <Empty
          icon="phone"
          title="Call unavailable"
          detail={
            call && call.phase !== "ended"
              ? "Finish your current call before starting another."
              : "Open Calls to try again."
          }
        />
      </Screen>
    );
  }

  return (
    <CallScreen
      call={call}
      name={nameOrAddress(contact?.name, call.peerKey)}
      avatarUrl={contact?.avatarUrl}
      close={close}
    />
  );
}
