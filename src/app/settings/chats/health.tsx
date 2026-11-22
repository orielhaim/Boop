import { Stack, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  SettingsDescription,
  SettingsGroup,
  SettingsRow,
} from "@/components/settings/group";
import { Action, Ink, Screen } from "@/components/ui/kit";
import { marmot, type MarmotDiagnostics } from "@/core/marmot/native";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local-context";

export default function MessagingHealth() {
  const { t } = useTranslation(namespaces);
  const { marmotSession } = useLocal();
  const [status, setStatus] = useState<MarmotDiagnostics>();
  const [failure, setFailure] = useState(false);
  const [working, setWorking] = useState(false);
  const read = useCallback(
    () => marmotSession.ready().then(marmot.diagnostics),
    [marmotSession],
  );
  useFocusEffect(
    useCallback(() => {
      let active = true;
      void read()
        .then((next) => {
          if (active) setStatus(next);
        })
        .catch(() => {
          if (active) setFailure(true);
        });
      return () => {
        active = false;
      };
    }, [read]),
  );
  async function refresh(rotate: boolean) {
    setWorking(true);
    setFailure(false);
    try {
      if (rotate) await marmot.rotateKeys();
      setStatus(await read());
    } catch {
      setFailure(true);
    } finally {
      setWorking(false);
    }
  }
  return (
    <Screen>
      <Stack.Screen options={{ title: t("messages:marmot.health") }} />
      <SettingsDescription>
        {t("messages:marmot.keyHealthHint")}
      </SettingsDescription>
      {status && (
        <SettingsGroup>
          <SettingsRow
            title={t("messages:marmot.connectionStatus")}
            value={t(`messages:marmot.readiness_${status.readiness}`)}
          />
          <SettingsRow
            title={t("messages:marmot.connectedRelays")}
            value={`${status.connected} / ${status.relays}`}
          />
          <SettingsRow
            title={t("messages:marmot.keyPackages")}
            value={String(status.keyPackages)}
          />
          <SettingsRow
            title={t("messages:marmot.keysPublished")}
            value={String(status.published ?? 0)}
          />
          {__DEV__ && (
            <SettingsRow
              title={t("settings:publicAddress")}
              detail={status.account}
            />
          )}
        </SettingsGroup>
      )}
      {status?.refreshOverdue && <Ink>{t("messages:marmot.keysOverdue")}</Ink>}
      {failure && <Ink>{t("messages:marmot.accountError")}</Ink>}
      <Action disabled={working} onPress={() => void refresh(false)}>
        {t("common:retry")}
      </Action>
      <Action disabled={working || !status} onPress={() => void refresh(true)}>
        {t("messages:marmot.rotateKeys")}
      </Action>
    </Screen>
  );
}
