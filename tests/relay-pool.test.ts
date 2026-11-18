import { expect, spyOn, test } from "bun:test";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { createMessagingRelays } from "../src/core/nostr/messaging-relays";

test("late relay connections remain registered across configuration changes", () => {
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    const transport = createMessagingRelays(
      new NDKPrivateKeySigner("01".repeat(32)),
    );
    const address = "wss://relay.example/";
    const relay = transport.addConfigured(address, true);
    transport.unconfigure(relay);
    relay.emit("connect");
    expect(error).not.toHaveBeenCalled();
    expect(transport.addConfigured(address, true)).toBe(relay);
    transport.unconfigure(relay);
  } finally {
    error.mockRestore();
  }
});
