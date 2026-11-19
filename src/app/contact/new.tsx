import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { GlassInput } from "@/components/glassyui/glass-input";
import { Action, Icon, Ink, Screen } from "@/components/ui/kit";
import { parsePublicKey } from "@/core/identity/keys";
import { saveContact } from "@/db/queries";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local";

export default function NewContact() {
  const { t } = useTranslation(namespaces);
  const { address } = useLocalSearchParams<{ address?: string }>();
  const [name, setName] = useState("");
  const [edit, setEdit] = useState<{ address?: string; value: string }>();
  const keyInput =
    edit && edit.address === address ? edit.value : (address ?? "");
  const [error, setError] = useState("");
  const { db, identity } = useLocal();

  function save() {
    const publicKey = parsePublicKey(keyInput);
    if (!name.trim()) {
      setError(t("contacts:nameRequired"));
      return;
    }
    if (!publicKey) {
      setError(t("contacts:invalidAddress"));
      return;
    }
    if (publicKey === identity.publicKey) {
      setError(t("contacts:ownAddress"));
      return;
    }
    try {
      if (saveContact(db, publicKey, name.trim()).changes === 0) {
        setError(t("contacts:duplicate"));
        return;
      }
      router.replace({
        pathname: "/contact/[key]",
        params: { key: publicKey },
      });
    } catch {
      setError(t("contacts:saveError"));
    }
  }

  return (
    <Screen>
      <GlassInput
        label={t("contacts:displayName")}
        placeholder={t("contacts:name")}
        value={name}
        onChangeText={setName}
        maxLength={100}
      />
      <GlassInput
        label={t("common:address")}
        placeholder={t("common:pasteAddress")}
        autoCapitalize="none"
        style={{ writingDirection: "ltr", textAlign: "left" }}
        autoCorrect={false}
        value={keyInput}
        onChangeText={(value) => setEdit({ address, value })}
        maxLength={128}
      />
      <Action onPress={() => router.push("/scan")}>
        <Icon name="qr" />
        {t("contacts:scanQr")}
      </Action>
      {error ? <Ink accessibilityLiveRegion="polite">{error}</Ink> : null}
      <Action variant="prominent" onPress={save}>
        {t("contacts:save")}
      </Action>
    </Screen>
  );
}
