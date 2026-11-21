import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import {
  profilePhotoPolicies,
  type ProfilePhotoPolicy,
} from "@/core/avatars/protocol";
import { namespaces } from "@/i18n";
import { SettingsMenuRow } from "./menu-row";

export function ProfilePhotoPolicyRow(
  props: Omit<
    ComponentProps<typeof SettingsMenuRow<ProfilePhotoPolicy>>,
    "options" | "menuLabel"
  >,
) {
  const { t } = useTranslation(namespaces);
  const labels = {
    everyone: t("security:everyone"),
    contacts: t("settings:photoContacts"),
    nobody: t("security:nobody"),
  };
  return (
    <SettingsMenuRow
      {...props}
      menuLabel={t("settings:photoPolicy")}
      options={profilePhotoPolicies.map((value) => ({
        value,
        label: labels[value],
      }))}
    />
  );
}
