import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { GlassSheetTitle } from "@/components/glassyui/glass-sheet";
import { Icon, Row } from "@/components/ui/kit";
import { namespaces } from "@/i18n";

export function PeerActions({
  onClose,
  onShowQr,
}: {
  onClose: () => void;
  onShowQr: () => void;
}) {
  const { t } = useTranslation(namespaces);
  const title = t("messages:newChat");

  return (
    <>
      <GlassSheetTitle>{title}</GlassSheetTitle>
      <Row
        leading={<Icon name="addPerson" />}
        title={t("messages:marmot.newGroup")}
        onPress={() => {
          onClose();
          router.push({
            pathname: "/chat/[key]",
            params: { key: "new-group" },
          });
        }}
      />
      <Row
        leading={<Icon name="chat" />}
        title={t("contacts:enterAddress")}
        onPress={() => {
          onClose();
          router.push("/connect");
        }}
      />
      <Row
        leading={<Icon name="qr" />}
        title={t("contacts:scanQr")}
        onPress={() => {
          onClose();
          router.push("/scan");
        }}
      />
      <Row
        leading={<Icon name="person" />}
        title={t("contacts:ownQr")}
        onPress={onShowQr}
      />
    </>
  );
}
