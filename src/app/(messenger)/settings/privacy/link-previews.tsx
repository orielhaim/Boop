import { ScreenHeader } from "@/components/navigation/screen-header";
import { useTranslation } from "react-i18next";
import { Alert } from "react-native";
import { SettingsDescription, ListGroup } from "@/components/ui/list-group";
import { SettingsMenuRow } from "@/components/settings/menu-row";
import { Screen } from "@/components/ui/kit";
import { usePrivacy } from "@/components/ui/privacy-actions";
import { linkPreviewPolicies } from "@/core/messaging/link-previews";
import { namespaces } from "@/i18n";

export default function LinkPreviewPrivacy() {
  const { t } = useTranslation(namespaces);
  const privacy = usePrivacy();
  const policy = privacy.linkPreviewPolicy();
  return (
    <Screen
      navigationHeader={<ScreenHeader title={t("settings:linkPreviews")} />}
    >
      <ListGroup>
        <SettingsMenuRow
          title={t("settings:linkPreviews")}
          value={policy}
          options={linkPreviewPolicies.map((value) => ({
            value,
            label: t(`settings:linkPreview_${value}`),
          }))}
          onChange={(value) => {
            try {
              privacy.set("linkPreviews", value);
            } catch {
              Alert.alert(t("security:privacyWriteFailed"));
            }
          }}
        />
      </ListGroup>
      <SettingsDescription>
        {t(`settings:linkPreviewHelp_${policy}`)}
      </SettingsDescription>
      <SettingsDescription>
        {t("settings:linkPreviewPrivacy")}
      </SettingsDescription>
    </Screen>
  );
}
