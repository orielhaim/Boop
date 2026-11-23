import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Share, StyleSheet, View } from "react-native";
import { AnimatedQRCode } from "react-native-animated-codes";
import { GlassSheetTitle } from "@/components/glassyui/glass-sheet";
import { Ink } from "@/components/ui/kit";
import { CompactAction } from "@/components/ui/messenger-ui";
import { namespaces } from "@/i18n";
import { space } from "@/theme";

export function AddressSheetContent({
  address,
  showQr,
  onShowQr,
}: {
  address: string;
  showQr: boolean;
  onShowQr: () => void;
}) {
  const { t } = useTranslation(namespaces);
  const [copied, setCopied] = useState<boolean>();
  const uri = `nostr:${address}`;

  async function copy() {
    try {
      setCopied(await Clipboard.setStringAsync(address));
    } catch {
      setCopied(false);
    }
  }

  return (
    <>
      <GlassSheetTitle>{t("common:address")}</GlassSheetTitle>
      <View style={styles.body}>
        <Ink selectable kind="caption" style={styles.address}>
          {address}
        </Ink>
        {showQr && (
          <AnimatedQRCode
            value={uri}
            size={208}
            quietZone={4}
            borderRadius={12}
            animation="ripple"
            dotTransition="grow"
            delay={0}
            duration={750}
            style={styles.qr}
            accessibilityLabel={t("settings:addressQr")}
          />
        )}
        <View style={styles.actions}>
          <CompactAction
            icon="copy"
            iconOnly
            label={t("settings:copyAddress")}
            onPress={() => void copy()}
          />
          <CompactAction
            icon="forward"
            iconOnly
            label={t("messenger:share")}
            onPress={() => {
              void Share.share({ message: uri }).catch(() => undefined);
            }}
          />
          {!showQr && (
            <CompactAction
              icon="qr"
              iconOnly
              label={t("security:showIdentityQr")}
              onPress={onShowQr}
            />
          )}
        </View>
        {copied !== undefined && (
          <Ink kind="caption" accessibilityLiveRegion="polite">
            {t(copied ? "settings:addressCopied" : "settings:copyAddressError")}
          </Ink>
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  body: { gap: space.md, padding: space.md },
  address: { writingDirection: "ltr", textAlign: "left" },
  qr: { alignSelf: "center" },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    flexWrap: "wrap",
    gap: space.sm,
  },
});
