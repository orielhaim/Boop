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
  mode,
  open,
  onOpenChange,
}: {
  mode: "chat" | "call";
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(namespaces);
  const title = mode === "chat" ? t("messages:newChat") : t("calls:newCall");

  return (
    <GlassSheet open={open} onOpenChange={onOpenChange}>
      <GlassSheetContent side="bottom">
        <GlassSheetTitle>{title}</GlassSheetTitle>
        <Row
          leading={<Icon name={mode === "chat" ? "chat" : "phone"} />}
          title={t("contacts:enterAddress")}
          onPress={() => {
            onOpenChange(false);
            router.push({ pathname: "/connect", params: { mode } });
          }}
        />
        <Row
          leading={<Icon name="qr" />}
          title={t("contacts:scanQr")}
          onPress={() => {
            onOpenChange(false);
            router.push({ pathname: "/scan", params: { mode } });
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
