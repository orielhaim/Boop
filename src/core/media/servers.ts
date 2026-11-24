import { z } from "zod";
import { blossomServer } from "./blossom";

export const mediaRoles = ["profile", "attachment"] as const;
export type MediaRole = (typeof mediaRoles)[number];
export const serverListKind = 10063;
export const maxMediaServers = 8;
const privateDefault = "https://nostr.download";
const configuration = z.object({
  servers: z
    .array(
      z.object({
        origin: z.string().refine((url) => blossomServer(url) === url),
        enabled: z.boolean(),
        roles: z.array(z.enum(mediaRoles)).max(2),
      }),
    )
    .max(maxMediaServers)
    .refine(
      (servers) =>
        new Set(servers.map((server) => server.origin)).size === servers.length,
    ),
  mirror: z.boolean(),
});
export type MediaConfiguration = z.infer<typeof configuration>;
export type MediaServer = MediaConfiguration["servers"][number];
type Store = {
  read(key: string): string | null;
  write(key: string, value: string): void;
};

function defaultEntry(origin: string, role: MediaRole): MediaServer {
  return { origin, enabled: true, roles: [role] };
}

export function recommendedMediaServers(): MediaConfiguration {
  return {
    servers: [
      defaultEntry("https://blossom.jumble.social", "profile"),
      defaultEntry(privateDefault, "attachment"),
    ],
    mirror: false,
  };
}

export function parseServerOrigins(tags: readonly string[][]) {
  return [
    ...new Set(
      tags.flatMap(([type, value]) => {
        const origin = type === "server" && value ? blossomServer(value) : null;
        return origin ? [origin] : [];
      }),
    ),
  ].slice(0, maxMediaServers);
}

export function createMediaSettings(store: Store) {
  const key = "media.servers.v1";
  const saved = store.read(key);
  let current: MediaConfiguration;
  if (saved === null) {
    current = recommendedMediaServers();
    store.write(key, JSON.stringify(current));
  } else {
    try {
      current = configuration.parse(JSON.parse(saved));
    } catch {
      current = { servers: [], mirror: false };
    }
  }

  return {
    snapshot: () => current,
    configured(role: MediaRole) {
      return current.servers.filter(
        (server) => server.enabled && server.roles.includes(role),
      );
    },
    save(next: MediaConfiguration) {
      const parsed = configuration.parse(next);
      store.write(key, JSON.stringify(parsed));
      current = parsed;
    },
  };
}
