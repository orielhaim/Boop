import { ScreenHeader } from "@/components/navigation/screen-header";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { GlassInput } from "@/components/glassyui/glass-input";
import { SettingsGroup, SettingsRow } from "@/components/settings/group";
import { Action, Empty, Screen } from "@/components/ui/kit";
import { useBlockAction, usePrivacy } from "@/components/ui/privacy-actions";
import { parsePublicKey, toNpub } from "@/core/identity/keys";
import { contactByKey } from "@/db/queries";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local-context";

function BlockedRow({
  publicKey,
  title,
}: {
  publicKey: string;
  title: string;
}) {
  const action = useBlockAction(publicKey);
  return (
    <SettingsRow
      title={title}
      detail={`${toNpub(publicKey).slice(0, 19)}…`}
      value={action.label}
      onPress={action.onPress}
    />
  );
}

export default function BlockedUsers() {
  const { t } = useTranslation(namespaces);
  const { db, identity } = useLocal();
  const privacy = usePrivacy();
  const [filter, setFilter] = useState("");
  const target = parsePublicKey(filter);
  const action = useBlockAction(target ?? "");
  const query = filter.trim().toLowerCase();
  const matches = privacy
    .blockedKeys()
    .map((key) => {
      const name = contactByKey(db, key).get()?.name;
      return { key, name, address: toNpub(key) };
    })
    .filter(
      ({ key, name, address }) =>
        key.includes(query) ||
        address.includes(query) ||
        name?.toLowerCase().includes(query),
    );
  return (
    <Screen
      navigationHeader={<ScreenHeader title={t("security:blockedUsers")} />}
    >
      <GlassInput
        value={filter}
        onChangeText={setFilter}
        placeholder={t("security:searchBlocked")}
        accessibilityLabel={t("security:searchBlocked")}
      />
      {target && target !== identity.publicKey && !action.blocked && (
        <Action onPress={action.onPress}>{t("security:block")}</Action>
      )}
      {matches.length ? (
        <SettingsGroup>
          {matches.map(({ key, name, address }) => (
            <BlockedRow
              key={key}
              publicKey={key}
              title={name ?? `${address.slice(0, 23)}…`}
            />
          ))}
        </SettingsGroup>
      ) : (
        <Empty icon="lock" title={t("security:noBlocked")} detail="" />
      )}
    </Screen>
  );
}
