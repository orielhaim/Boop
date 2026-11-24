import { expect, test } from "bun:test";
import { connectivityRestored } from "../src/core/nostr/connectivity";

test("only connectivity restoration and a concrete route change wake transports", () => {
  const wifi = { connected: true, type: "WIFI" };
  const cell = { connected: true, type: "CELLULAR" };
  const down = { connected: false, type: "NONE" };
  expect(connectivityRestored(undefined, wifi)).toBe(false);
  expect(connectivityRestored(wifi, wifi)).toBe(false);
  expect(connectivityRestored(wifi, { connected: true })).toBe(false);
  expect(connectivityRestored({ connected: true, type: "UNKNOWN" }, cell)).toBe(
    false,
  );
  expect(connectivityRestored(wifi, down)).toBe(false);
  expect(connectivityRestored(down, wifi)).toBe(true);
  expect(connectivityRestored(wifi, cell)).toBe(true);
  expect(connectivityRestored(cell, cell)).toBe(false);
});
