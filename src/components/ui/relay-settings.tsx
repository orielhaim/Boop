import { asc, eq } from "drizzle-orm";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { useState, useSyncExternalStore } from "react";
import { StyleSheet, View } from "react-native";
import { GlassInput } from "@/components/glassyui/glass-input";
import {
  GlassMenu,
  GlassMenuContent,
  GlassMenuItem,
  GlassMenuTrigger,
} from "@/components/glassyui/glass-menu";
import { Action, Ink, layout, Row } from "@/components/ui/kit";
import { relayUrl } from "@/core/nostr/relays";
import { relaySettings } from "@/db/schema";
import { useLocal } from "@/services/local";
import { space } from "@/theme";

export function RelaySettings() {
  const { db, messaging } = useLocal();
  const connection = useSyncExternalStore(
    messaging.subscribeStatus,
    messaging.getStatus,
  );
  const { data: items } = useLiveQuery(
    db.select().from(relaySettings).orderBy(asc(relaySettings.url)),
    [db],
  );
  const [input, setInput] = useState("");
  const [error, setError] = useState("");

  function write(change: () => void) {
    try {
      change();
      setError("");
    } catch {
      setError("Could not update the relay list.");
    }
  }

  function add() {
    const result = relayUrl.safeParse(input.trim());
    if (!result.success) {
      setError(
        "Enter a wss:// relay address without credentials or query parameters.",
      );
      return;
    }
    write(() => {
      db.insert(relaySettings)
        .values({ url: result.data })
        .onConflictDoUpdate({
          target: relaySettings.url,
          set: { enabled: true },
        })
        .run();
      setInput("");
    });
  }

  return (
    <>
      <View style={styles.controls}>
        <Ink kind="label">Relays</Ink>
        <Ink kind="label" accessibilityLiveRegion="polite">
          {
            {
              disabled: "No inbox relays enabled",
              connecting: "Connecting to inbox relays…",
              online: "Connected to an inbox relay",
              offline: "Inbox relays are offline",
            }[connection]
          }
        </Ink>
        <Ink kind="caption" muted>
          Use a relay in common with someone to exchange encrypted messages.
        </Ink>
        <GlassInput
          label="Relay address"
          placeholder="wss://relay.example"
          autoCapitalize="none"
          autoCorrect={false}
          value={input}
          onChangeText={setInput}
          keyboardType="url"
          onSubmitEditing={add}
          maxLength={2048}
        />
        <View style={layout.row}>
          <Action onPress={add}>Add relay</Action>
        </View>
        {error ? <Ink accessibilityLiveRegion="polite">{error}</Ink> : null}
      </View>
      {items.map((item) => (
        <Row
          key={item.url}
          title={item.url}
          detail={item.enabled ? "Enabled" : "Disabled"}
          trailing={
            <GlassMenu>
              <GlassMenuTrigger>
                <Action size="sm" accessibilityLabel={`Manage ${item.url}`}>
                  Manage
                </Action>
              </GlassMenuTrigger>
              <GlassMenuContent>
                <GlassMenuItem
                  onSelect={() =>
                    write(() => {
                      db.update(relaySettings)
                        .set({ enabled: !item.enabled })
                        .where(eq(relaySettings.url, item.url))
                        .run();
                    })
                  }
                >
                  {item.enabled ? "Disable relay" : "Enable relay"}
                </GlassMenuItem>
                <GlassMenuItem
                  onSelect={() =>
                    write(() => {
                      db.delete(relaySettings)
                        .where(eq(relaySettings.url, item.url))
                        .run();
                    })
                  }
                >
                  Remove relay
                </GlassMenuItem>
              </GlassMenuContent>
            </GlassMenu>
          }
        />
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  controls: { padding: space.lg, gap: space.sm },
});
