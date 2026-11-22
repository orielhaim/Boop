import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import {
  GlassSheet,
  GlassSheetContent,
  GlassSheetTitle,
} from "@/components/glassyui/glass-sheet";
import { Icon, Row } from "@/components/ui/kit";
import { namespaces } from "@/i18n";

export function PeerActions({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(namespaces);
  const title = t("messages:newChat");

  return (
    <GlassSheet open={open} onOpenChange={onOpenChange}>
      <GlassSheetContent side="bottom">
        <GlassSheetTitle>{title}</GlassSheetTitle>
        <Row
          leading={<Icon name="addPerson" />}
          title={t("messages:marmot.newGroup")}
          onPress={() => {
            onOpenChange(false);
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
            onOpenChange(false);
            router.push("/connect");
          }}
        />
        <Row
          leading={<Icon name="qr" />}
          title={t("contacts:scanQr")}
          onPress={() => {
            onOpenChange(false);
            router.push("/scan");
          }}
        />
        <Row
          leading={<Icon name="person" />}
          title={t("contacts:ownQr")}
          onPress={() => {
            onOpenChange(false);
            router.push({
              pathname: "/settings/identity",
              params: { qr: "1" },
            });
          }}
        />
      </GlassSheetContent>
    </GlassSheet>
  );
}
