import { z } from "zod";

export const relayUrl = z.string().transform((value, context) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    context.addIssue({ code: "custom", message: "Invalid relay address." });
    return z.NEVER;
  }
  if (
    !/^wss:\/\//i.test(value) ||
    url.protocol !== "wss:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  ) {
    context.addIssue({ code: "custom", message: "Invalid relay address." });
    return z.NEVER;
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
});

export function secureRelays(values: readonly string[]) {
  const relays = new Set<string>();
  for (const value of values) {
    const parsed = relayUrl.safeParse(value);
    if (parsed.success) relays.add(parsed.data);
  }
  return [...relays];
}

export function isPublicRelayAddress(value: string) {
  const { hostname, port } = new URL(value);
  // Peer-supplied relay addresses must not address this device's local network
  // or request arbitrary ports. Explicitly configured relays are trusted separately.
  return (
    (!port || port === "443") &&
    hostname.includes(".") &&
    !/^[0-9.]+$/.test(hostname) &&
    !/\.(?:localhost|local|internal|lan|test|invalid|example)\.?$/i.test(
      hostname,
    )
  );
}
