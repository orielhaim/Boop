import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  SettingsDescription,
  SettingsGroup,
  SettingsRow,
  SettingsToggle,
} from "@/components/settings/group";
import { Action, Ink, Screen, Search } from "@/components/ui/kit";
import { blossomServer, probeBlossom } from "@/core/avatars/blossom";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local";

export default function MediaStorage() {
  const { t } = useTranslation(namespaces);
  const { profileEditor, messaging } = useLocal();
  const settings = profileEditor.configuration();
  const [first, setFirst] = useState(settings.primary);
  const [second, setSecond] = useState(settings.backup ?? "");
  const [mirror, setMirror] = useState(settings.mirror);
  const [notice, setNotice] = useState("");
  const [checking, setChecking] = useState(false);
  const [published, setPublished] = useState<string[]>([]);
  const status = {
    reachable: t("settings:mediaReachable"),
    requiresAuth: t("settings:mediaRequiresAuth"),
    unavailable: t("settings:mediaUnavailable"),
  };
  async function check() {
    setChecking(true);
    try {
      const results = await Promise.all(
        [first, ...(second.trim() ? [second] : [])].map(probeBlossom),
      );
      setNotice(results.map((result) => status[result]).join("\n"));
    } finally {
      setChecking(false);
    }
  }
  return (
    <Screen>
      <SettingsDescription>{t("settings:mediaHelp")}</SettingsDescription>
      <Ink kind="label">{t("settings:mediaFirst")}</Ink>
      <Search
        accessibilityLabel={t("settings:mediaFirst")}
        value={first}
        onChangeText={setFirst}
        keyboardType="url"
        autoCapitalize="none"
      />
      <Ink kind="label">{t("settings:mediaSecond")}</Ink>
      <Search
        accessibilityLabel={t("settings:mediaSecond")}
        value={second}
        onChangeText={setSecond}
        keyboardType="url"
        autoCapitalize="none"
      />
      <SettingsGroup>
        <SettingsToggle
          title={t("settings:mediaMirror")}
          value={mirror}
          onChange={setMirror}
        />
      </SettingsGroup>
      <Action
        onPress={() => {
          try {
            setNotice(
              t(
                profileEditor.configure(first, second, mirror)
                  ? "settings:mediaSaved"
                  : "settings:mediaInvalid",
              ),
            );
          } catch {
            setNotice(t("security:privacyWriteFailed"));
          }
        }}
      >
        {t("common:done")}
      </Action>
      <Action variant="soft" disabled={checking} onPress={() => void check()}>
        {t("settings:mediaCheck")}
      </Action>
      <Action
        variant="soft"
        onPress={() => {
          void messaging
            .discoverBlossomServers()
            .then((items) => {
              const servers = [
                ...new Set(items.flatMap((item) => blossomServer(item) ?? [])),
              ];
              setPublished(servers);
              if (!servers.length) setNotice(t("settings:mediaNoPublished"));
            })
            .catch(() => setNotice(t("settings:mediaNoPublished")));
        }}
      >
        {t("settings:mediaFindPublished")}
      </Action>
      {published.length > 0 && (
        <SettingsGroup title={t("settings:mediaPublished")}>
          {published.map((origin) => (
            <SettingsRow
              key={origin}
              title={origin}
              onPress={() => setFirst(origin)}
            />
          ))}
        </SettingsGroup>
      )}
      {notice && <SettingsDescription>{notice}</SettingsDescription>}
    </Screen>
  );
}
