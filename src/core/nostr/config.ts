import { z } from "zod";
import { relayUrl, secureRelays } from "./relays";

export const initialAccountRelays = {
  general: ["wss://nos.lol/", "wss://relay.primal.net/"],
  inbox: ["wss://nos.lol/", "wss://relay.primal.net/"],
  discovery: ["wss://purplepag.es/"],
};

export const discoveryPreference = "relay.discovery";
export const callInboxDisabledPreference = "relay.calls.disabled";
export const callHandoffPreference = "relay.calls.handoff";

export type RelayConfiguration = {
  general: readonly string[];
  write: readonly string[];
  inbox: readonly string[];
  discovery: readonly string[];
};

export function readDiscovery(value: string | null): string[] {
  if (value === null) return initialAccountRelays.discovery;
  try {
    return relayUrl.array().parse(JSON.parse(value));
  } catch {
    return initialAccountRelays.discovery;
  }
}

const callHandoff = z
  .array(z.tuple([relayUrl, z.number().int().positive()]))
  .max(12);
export type CallHandoff = z.infer<typeof callHandoff>;

export function readCallHandoff(value: string | null): CallHandoff {
  if (value === null) return [];
  try {
    return callHandoff.parse(JSON.parse(value));
  } catch {
    return [];
  }
}

export function sameRelays(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((url) => b.includes(url));
}

export function relayRoutes(configuration: RelayConfiguration) {
  return secureRelays([...configuration.discovery, ...configuration.general]);
}
