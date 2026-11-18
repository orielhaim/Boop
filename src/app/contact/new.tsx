import { eq } from "drizzle-orm";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { GlassInput } from "@/components/glassyui/glass-input";
import { Action, Icon, Ink, Screen } from "@/components/ui/kit";
import { parsePublicKey } from "@/core/identity/keys";
import { contacts } from "@/db/schema";
import { useLocal } from "@/services/local";

export default function NewContact() {
  const { address } = useLocalSearchParams<{ address?: string }>();
  const [name, setName] = useState("");
  const [edit, setEdit] = useState<{ address?: string; value: string }>();
  const keyInput =
    edit && edit.address === address ? edit.value : (address ?? "");
  const [error, setError] = useState("");
  const { db, identity } = useLocal();

  function save() {
    const publicKey = parsePublicKey(keyInput);
    if (!name.trim()) {
      setError("Enter a contact name.");
      return;
    }
    if (!publicKey) {
      setError("Enter a valid Boop address.");
      return;
    }
    if (publicKey === identity.publicKey) {
      setError("Enter someone else’s address.");
      return;
    }
    try {
      if (
        db
          .select()
          .from(contacts)
          .where(eq(contacts.publicKey, publicKey))
          .get()
      ) {
        setError("That address is already in your contacts.");
        return;
      }
      db.insert(contacts).values({ publicKey, name: name.trim() }).run();
      router.replace({
        pathname: "/contact/[key]",
        params: { key: publicKey },
      });
    } catch {
      setError("Could not save the contact. Try again.");
    }
  }

  return (
    <Screen>
      <GlassInput
        label="Display name"
        placeholder="Contact name"
        value={name}
        onChangeText={setName}
        maxLength={100}
      />
      <GlassInput
        label="Boop address"
        placeholder="Paste an address"
        autoCapitalize="none"
        autoCorrect={false}
        value={keyInput}
        onChangeText={(value) => setEdit({ address, value })}
        maxLength={128}
      />
      <Action onPress={() => router.push("/scan")}>
        <Icon name="qr" />
        Scan QR code
      </Action>
      {error ? <Ink accessibilityLiveRegion="polite">{error}</Ink> : null}
      <Action variant="prominent" onPress={save}>
        Save contact
      </Action>
    </Screen>
  );
}
