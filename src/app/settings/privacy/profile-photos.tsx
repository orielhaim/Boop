import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  SettingsDescription,
  SettingsGroup,
} from "@/components/settings/group";
import { ProfilePhotoPolicyRow } from "@/components/settings/profile-photo-policy-row";
import { Action, Screen } from "@/components/ui/kit";
import { usePrivacy } from "@/components/ui/privacy-actions";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local";

export default function ProfilePhotoPrivacy() {
  const { t } = useTranslation(namespaces);
  const { avatars } = useLocal();
  const privacy = usePrivacy();
  const [status, setStatus] = useState("");
  return (
    <Screen>
      <SettingsGroup>
        <ProfilePhotoPolicyRow
          title={t("settings:photoPolicy")}
          value={privacy.photoPolicy()}
          onChange={(policy) => {
            try {
              privacy.set("profilePhotos", policy);
              setStatus("");
            } catch {
              setStatus(t("security:privacyWriteFailed"));
            }
          }}
        />
      </SettingsGroup>
      <SettingsDescription>{t("settings:photoPolicyHelp")}</SettingsDescription>
      <Action
        variant="soft"
        onPress={() => {
          try {
            avatars.clear();
            setStatus(t("settings:photoCleared"));
          } catch {
            setStatus(t("security:privacyWriteFailed"));
          }
        }}
      >
        {t("settings:photoClear")}
      </Action>
      {status && <SettingsDescription>{status}</SettingsDescription>}
    </Screen>
  );
}
