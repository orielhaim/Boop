import { ScreenHeader } from "@/components/navigation/screen-header";
import { useTranslation } from "react-i18next";
import { Screen } from "@/components/ui/kit";
import { PermissionSettings } from "@/components/ui/permission-settings";

export default function Permissions() {
  const { t } = useTranslation("security");
  return (
    <Screen navigationHeader={<ScreenHeader title={t("permissions")} />}>
      <PermissionSettings />
    </Screen>
  );
}
