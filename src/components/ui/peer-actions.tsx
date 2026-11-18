import { router } from "expo-router";
import {
  GlassSheet,
  GlassSheetContent,
  GlassSheetTitle,
} from "@/components/glassyui/glass-sheet";
import { Icon, Row } from "@/components/ui/kit";

export function PeerActions({
  mode,
  open,
  onOpenChange,
  hebrew = false,
}: {
  mode: "chat" | "call";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hebrew?: boolean;
}) {
  const title =
    mode === "chat" ? (hebrew ? "שיחה חדשה" : "New chat") : "New call";

  return (
    <GlassSheet open={open} onOpenChange={onOpenChange}>
      <GlassSheetContent side="bottom">
        <GlassSheetTitle>{title}</GlassSheetTitle>
        <Row
          leading={<Icon name={mode === "chat" ? "chat" : "phone"} />}
          title={hebrew ? "הזנת כתובת" : "Enter an address"}
          onPress={() => {
            onOpenChange(false);
            router.push({ pathname: "/connect", params: { mode } });
          }}
        />
        <Row
          leading={<Icon name="qr" />}
          title={hebrew ? "סריקת קוד QR" : "Scan QR code"}
          onPress={() => {
            onOpenChange(false);
            router.push({ pathname: "/scan", params: { mode } });
          }}
        />
        <Row
          leading={<Icon name="person" />}
          title={hebrew ? "קוד ה־QR שלי" : "Show my QR code"}
          onPress={() => {
            onOpenChange(false);
            router.push({ pathname: "/settings", params: { qr: "1" } });
          }}
        />
      </GlassSheetContent>
    </GlassSheet>
  );
}
