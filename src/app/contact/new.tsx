import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { GlassInput } from "@/components/glassyui/glass-input";
import { Action, Card, Icon, Ink, Screen } from "@/components/ui/kit";
import { parsePublicKey } from "@/core/identity/keys";
import { saveContact } from "@/db/queries";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local";
import { radius, space, useTheme } from "@/theme";

type ContactError =
  | { field: "name"; message: "nameRequired" }
  | {
      field: "address";
      message: "invalidAddress" | "ownAddress" | "duplicate";
      value: string;
    }
  | { field: "form"; message: "saveError" };

export default function NewContact() {
  const { t } = useTranslation(namespaces);
  const { address } = useLocalSearchParams<{ address?: string }>();
  const [name, setName] = useState("");
  const [edit, setEdit] = useState<{ address?: string; value: string }>();
  const keyInput =
    edit && edit.address === address ? edit.value : (address ?? "");
  const [error, setError] = useState<ContactError>();
  const { db, identity } = useLocal();
  const { colors } = useTheme();
  const addressError =
    error?.field === "address" && error.value === keyInput ? error : undefined;
  const nameError = error?.field === "name" ? error : undefined;

  function save() {
    if (!name.trim()) {
      setError({ field: "name", message: "nameRequired" });
      return;
    }
    const publicKey = parsePublicKey(keyInput);
    if (!publicKey) {
      setError({
        field: "address",
        message: "invalidAddress",
        value: keyInput,
      });
      return;
    }
    if (publicKey === identity.publicKey) {
      setError({ field: "address", message: "ownAddress", value: keyInput });
      return;
    }
    try {
      if (saveContact(db, publicKey, name.trim()).changes === 0) {
        setError({ field: "address", message: "duplicate", value: keyInput });
        return;
      }
      router.replace({
        pathname: "/contact/[key]",
        params: { key: publicKey },
      });
    } catch {
      setError({ field: "form", message: "saveError" });
    }
  }

  return (
    <Screen>
      <View style={styles.form}>
        <View style={styles.intro}>
          <View style={[styles.emblem, { backgroundColor: colors.accentSoft }]}>
            <Icon name="addPerson" size={30} />
          </View>
        </View>
        <Card style={styles.fields}>
          <GlassInput
            label={t("contacts:displayName")}
            placeholder={t("contacts:name")}
            value={name}
            onChangeText={(value) => {
              setName(value);
              if (error?.field !== "address") setError(undefined);
            }}
            maxLength={100}
            invalid={Boolean(nameError)}
            hint={nameError && t(`contacts:${nameError.message}`)}
            accessibilityLiveRegion="polite"
          />
          <View style={[styles.divider, { backgroundColor: colors.line }]} />
          <View style={styles.addressGroup}>
            <GlassInput
              label={t("common:address")}
              placeholder={t("common:pasteAddress")}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.address}
              value={keyInput}
              onChangeText={(value) => {
                setEdit({ address, value });
                setError(undefined);
              }}
              maxLength={128}
              invalid={Boolean(addressError)}
              hint={addressError && t(`contacts:${addressError.message}`)}
              accessibilityLiveRegion="polite"
            />
            <Action
              variant="soft"
              style={styles.centerAction}
              onPress={() => router.push("/scan")}
            >
              <Icon name="qr" size={19} />
              {t("contacts:scanQr")}
            </Action>
          </View>
        </Card>
        {error?.field === "form" ? (
          <Ink
            accessibilityLiveRegion="polite"
            style={[styles.centered, { color: colors.danger }]}
          >
            {t(`contacts:${error.message}`)}
          </Ink>
        ) : null}
        <Action
          variant="prominent"
          size="lg"
          style={styles.save}
          onPress={save}
        >
          {t("contacts:save")}
        </Action>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  form: { width: "100%", maxWidth: 480, alignSelf: "center", gap: space.lg },
  intro: { alignItems: "center", paddingVertical: space.lg },
  emblem: {
    width: 64,
    height: 64,
    borderRadius: radius.round,
    alignItems: "center",
    justifyContent: "center",
  },
  centered: { textAlign: "center" },
  fields: { padding: space.lg, gap: space.lg },
  addressGroup: { gap: space.md },
  address: { writingDirection: "ltr", textAlign: "left" },
  centerAction: { alignSelf: "center" },
  divider: { height: StyleSheet.hairlineWidth },
  save: { alignSelf: "stretch" },
});
