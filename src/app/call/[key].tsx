import { randomUUID } from "expo-crypto";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useRef } from "react";
import { CallScreen } from "@/components/calls/call-screen";
import { Empty, Screen } from "@/components/ui/kit";
import { parsePublicKey } from "@/core/identity/keys";
import { nameOrAddress, useContact } from "@/db/contacts";
import { callHistory } from "@/db/schema";
import { useLocal } from "@/services/local";

export default function CallRoute() {
  const { key } = useLocalSearchParams<{ key: string }>();
  const publicKey = typeof key === "string" ? parsePublicKey(key) : null;
  const { identity } = useLocal();
  if (!publicKey || publicKey === identity.publicKey) {
    return (
      <Screen>
        <Empty
          icon="phone"
          title="Call unavailable"
          detail="Open the call with someone else’s Boop address."
        />
      </Screen>
    );
  }
  return <CallAttempt key={publicKey} peerKey={publicKey} />;
}

function CallAttempt({ peerKey }: { peerKey: string }) {
  const contact = useContact(peerKey);
  const { db } = useLocal();
  const recorded = useRef(false);
  useEffect(() => {
    if (recorded.current) return;
    recorded.current = true;
    try {
      db.insert(callHistory)
        .values({
          id: randomUUID(),
          peerKey,
          direction: "outgoing",
          outcome: "failed",
          startedAt: Date.now(),
        })
        .run();
    } catch {
      // Local history is optional when the call transport is unavailable.
    }
  }, [db, peerKey]);
  return (
    <CallScreen
      name={nameOrAddress(contact?.name, peerKey)}
      avatarUrl={contact?.avatarUrl}
      state={{ phase: "failed" }}
    />
  );
}
