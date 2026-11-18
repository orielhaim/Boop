import { z } from "zod";
import { relayUrl, secureRelays } from "./relays";

export const defaultRelays = [
  {
    url: "wss://nos.lol/",
    general: true,
    inbox: true,
    discovery: false,
    enabled: true,
  },
  {
    url: "wss://relay.primal.net/",
    general: true,
    inbox: true,
    discovery: false,
    enabled: true,
  },
  {
    url: "wss://purplepag.es/",
    general: false,
    inbox: false,
    discovery: true,
    enabled: true,
  },
];

export const inboxIntentKey = "relay.inbox.intent";
export const inboxPublicationKey = "relay.inbox.publication";
export const inboxHandoffMs = 3 * 24 * 60 * 60 * 1000;

export type RelayChoice = (typeof defaultRelays)[number];
export type RelayConfiguration = {
  general: readonly string[];
  inbox: readonly string[];
  discovery: readonly string[];
  intent: string | null;
};

const publicationSchema = z.object({
  urls: z.array(relayUrl).max(3),
  eventTime: z.number().int().nonnegative(),
  intent: z.string().nullable(),
  previous: z.array(z.object({ url: relayUrl, until: z.number() })).max(12),
});
export type InboxPublication = z.infer<typeof publicationSchema>;

export function readPublication(value: string | null) {
  if (value === null) return null;
  try {
    return publicationSchema.parse(JSON.parse(value));
  } catch {
    return null;
  }
}

export function configuredRelays(
  rows: readonly RelayChoice[],
  intent: string | null,
): RelayConfiguration {
  const enabled = rows.filter((row) => row.enabled);
  return {
    general: secureRelays(
      enabled.filter((row) => row.general).map((row) => row.url),
    ).sort(),
    inbox: secureRelays(
      enabled.filter((row) => row.inbox).map((row) => row.url),
    ).sort(),
    discovery: secureRelays(
      enabled.filter((row) => row.discovery).map((row) => row.url),
    ).sort(),
    intent,
  };
}

export function sameRelays(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((url) => b.includes(url));
}
