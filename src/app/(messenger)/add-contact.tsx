import { router, useNavigation } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Keyboard } from "react-native";
import { GlassInput } from "@/components/glassyui/glass-input";
import { ScreenHeader } from "@/components/navigation/screen-header";
import { Ink, Screen } from "@/components/ui/kit";
import { AuraLift } from "@/components/ui/organisms/aura-lift";
import { SaveButton } from "@/components/ui/save-button";
import { parsePublicKey } from "@/core/identity/keys";
import { contactByKey, saveContact } from "@/db/queries";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local-context";

export default function AddContact() {
  const { t } = useTranslation(namespaces);
  const { db, identity, privacy, lock } = useLocal();
  const navigation = useNavigation();
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  function back() {
    if (router.canGoBack()) router.back();
    else router.replace("/people");
  }

  function save() {
    const key = parsePublicKey(address);
    const displayName = name.trim();
    if (!displayName) {
      setError(t("contacts:nameRequired"));
      return false;
    }
    if (!key || key === identity.publicKey) {
      setError(t(key ? "contacts:ownAddress" : "contacts:invalidAddress"));
      return false;
    }
    if (
      lock.getState().locked ||
      !lock.getState().active ||
      privacy.isBlocked(key)
    ) {
      setError(t("contacts:unavailable"));
      return false;
    }
    try {
      const added = db.transaction((tx) => {
        if (contactByKey(tx, key).get()) return false;
        saveContact(tx, key, displayName);
        return true;
      });
      if (!added) {
        setError(t("contacts:duplicate"));
        return false;
      }
      setSaved(true);
      setError("");
      Keyboard.dismiss();
      return true;
    } catch {
      setError(t("contacts:saveError"));
      return false;
    }
  }

  return (
    <Screen
      navigationHeader={
        <ScreenHeader title={t("navigation:addContact")} onBack={back} />
      }
    >
      <GlassInput
        label={t("contacts:nickname")}
        value={name}
        editable={!saved}
        maxLength={128}
        onChangeText={(value) => {
          setName(value);
          setError("");
        }}
      />
      <GlassInput
        label={t("common:address")}
        placeholder={t("common:pasteAddress")}
        value={address}
        editable={!saved}
        onChangeText={(value) => {
          setAddress(value);
          setError("");
        }}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={1024}
        style={{ writingDirection: "ltr", textAlign: "left" }}
      />
      {error ? (
        <Ink accessibilityRole="alert" accessibilityLiveRegion="polite">
          {error}
        </Ink>
      ) : null}
      <SaveButton
        label={t("contacts:save")}
        savedDecoration={<AuraLift />}
        disabled={saved}
        onSave={save}
        onSaved={() => {
          if (navigation.isFocused()) back();
        }}
      />
    </Screen>
  );
}
