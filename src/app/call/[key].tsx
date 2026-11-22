import {
  router,
  useFocusEffect,
  useLocalSearchParams,
  useRootNavigationState,
} from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator } from "react-native";
import { useStore } from "zustand";
import { CallScreen } from "@/components/calls/call-screen";
import { Empty, Screen } from "@/components/ui/kit";
import { parsePublicKey } from "@/core/identity/keys";
import { usePerson } from "@/components/people/use-person";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local-context";

export default function CallRoute() {
  const { t } = useTranslation(namespaces);
  const { key, callId, group, video } = useLocalSearchParams<{
    key: string;
    callId?: string;
    group?: string;
    video?: string;
  }>();
  const { calling, identity } = useLocal();
  const peerKey = typeof key === "string" ? parsePublicKey(key) : null;
  const { name } = usePerson(peerKey ?? "");
  const call = useStore(calling.store, (state) => state.call);
  const initiated = useRef(false);
  const requestedVideo = useRef(false);
  const started = useRef<string>(undefined);
  const navigation = useRootNavigationState();
  const [focused, setFocused] = useState(false);
  const [failed, setFailed] = useState(false);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );

  useEffect(() => {
    if (
      !peerKey ||
      peerKey === identity.publicKey ||
      callId ||
      initiated.current
    )
      return;
    initiated.current = true;
    void calling
      .dial(peerKey, typeof group === "string" ? group : undefined, (id) => {
        started.current = id;
      })
      .then((success) => {
        if (!success) setFailed(true);
      });
  }, [calling, callId, group, identity.publicKey, peerKey]);

  useEffect(() => {
    if (
      video !== "1" ||
      !initiated.current ||
      requestedVideo.current ||
      !focused ||
      call?.phase !== "connected" ||
      call.id !== started.current ||
      call.direction !== "outgoing" ||
      call.peerKey !== peerKey
    )
      return;
    const controls = calling.video();
    if (!controls) return;
    requestedVideo.current = true;
    void controls.enable();
  }, [call, calling, focused, peerKey, video]);

  const close = () => {
    if (call?.phase === "ended") calling.dismiss(call.id);
    if (router.canGoBack()) {
      let count = 1;
      const index = navigation?.index ?? 0;
      while (
        count < index &&
        navigation?.routes[index - count]?.name === "call/[key]"
      )
        count++;
      router.dismiss(count);
    } else router.replace("/");
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
  if (
    !call &&
    peerKey &&
    peerKey !== identity.publicKey &&
    !callId &&
    !failed
  ) {
    return (
      <Screen>
        <ActivityIndicator accessibilityLabel={t("calls:starting")} />
      </Screen>
    );
  }
  if (
    !call ||
    call.peerKey !== peerKey ||
    (call.phase === "ended" && callId && call.id !== callId)
  ) {
    return (
      <Screen>
        <Empty
          icon="phone"
          title={t("calls:unavailable")}
          detail={
            call && call.phase !== "ended"
              ? t("calls:anotherCall")
              : t("calls:tryFromCalls")
          }
        />
      </Screen>
    );
  }

  return <CallScreen call={call} name={name} close={close} focused={focused} />;
}
