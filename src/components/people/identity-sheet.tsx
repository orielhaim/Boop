import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import {
  GlassSheet,
  GlassSheetContent,
} from "@/components/glassyui/glass-sheet";
import { PeerActions } from "@/components/ui/peer-actions";
import { useLocal } from "@/services/local-context";
import { AddressSheetContent } from "./address-sheet";

type SheetContent = "address" | "qr" | "newConversation";

const IdentitySheetContext = createContext<
  ((content: SheetContent) => void) | null
>(null);

export function useIdentitySheet() {
  const show = useContext(IdentitySheetContext);
  if (!show) throw new Error("IdentitySheetProvider is missing");
  return show;
}

export function IdentitySheetProvider({
  obscured,
  children,
}: {
  obscured: boolean;
  children: ReactNode;
}) {
  const { identity } = useLocal();
  const [sheet, setSheet] = useState<{
    open: boolean;
    content: SheetContent;
  }>({ open: false, content: "qr" });

  if (obscured && sheet.open) setSheet({ ...sheet, open: false });

  const show = useCallback((content: SheetContent) => {
    setSheet({ open: true, content });
  }, []);
  const close = useCallback(
    () => setSheet((previous) => ({ ...previous, open: false })),
    [],
  );

  return (
    <IdentitySheetContext.Provider value={show}>
      {children}
      {!obscured && (
        <GlassSheet open={sheet.open} onOpenChange={close}>
          <GlassSheetContent>
            {sheet.content === "newConversation" ? (
              <PeerActions onClose={close} onShowQr={() => show("qr")} />
            ) : (
              <AddressSheetContent
                address={identity.npub}
                showQr={sheet.content === "qr"}
                onShowQr={() => show("qr")}
              />
            )}
          </GlassSheetContent>
        </GlassSheet>
      )}
    </IdentitySheetContext.Provider>
  );
}
