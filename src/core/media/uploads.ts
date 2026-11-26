import type { NDKSigner } from "@nostr-dev-kit/ndk";
import {
  BlossomError,
  type BlossomHttp,
  createBlossomClient,
  type UploadFailure,
  type UploadMime,
} from "./blossom";
import type { createMediaSettings, MediaRole } from "./servers";
import { maxAvatarBytes } from "../avatars/jpeg";

const backoffMs = 30_000;
const capabilityMs = 10 * 60_000;
type Health = {
  checkedAt: number;
  preflight?: "compatible" | "unsupported";
  lastFailure?: UploadFailure;
  rejectedSize?: number;
  retryAt?: number;
};
export type MediaUploadResult = { url: string; mirror?: Promise<boolean> };

export function createMediaUploads(
  signer: NDKSigner,
  http: BlossomHttp,
  settings: ReturnType<typeof createMediaSettings>,
  changed: () => void,
  now = Date.now,
) {
  const client = createBlossomClient(signer, http);
  const health = new Map<string, Health>();
  const key = (origin: string, role: MediaRole) => `${origin}:${role}`;
  const getHealth = (origin: string, role: MediaRole) =>
    health.get(key(origin, role));
  const mimeFor = (role: MediaRole): UploadMime =>
    role === "profile" ? "image/jpeg" : "application/octet-stream";
  function record(origin: string, role: MediaRole, value: Health) {
    if (health.size >= 64) {
      const oldest = health.keys().next().value;
      if (oldest) health.delete(oldest);
    }
    health.set(key(origin, role), value);
    changed();
  }
  function failure(
    origin: string,
    role: MediaRole,
    error: BlossomError,
    size: number,
  ) {
    if (error.code === "cancelled") return;
    const retry = ["network", "timeout", "rate-limit", "server"].includes(
      error.code,
    );
    record(origin, role, {
      checkedAt: now(),
      preflight: getHealth(origin, role)?.preflight,
      lastFailure: error.code,
      rejectedSize: error.code === "size" ? size : undefined,
      retryAt: retry ? now() + backoffMs : undefined,
    });
  }

  function priorRejection(origin: string, role: MediaRole, size: number) {
    const recent = getHealth(origin, role);
    if (!recent || now() - recent.checkedAt >= capabilityMs) return;
    if (recent.lastFailure === "format") return "format";
    if (recent.rejectedSize && size >= recent.rejectedSize) return "size";
    if (recent.retryAt && now() < recent.retryAt) return recent.lastFailure;
  }

  return {
    health: getHealth,
    async mirrorAttachments(
      blobs: readonly { url: string; hash: string; size: number }[],
      signal: AbortSignal,
      allowed: () => boolean,
    ) {
      if (!settings.snapshot().mirror) return true;
      let succeeded = true;
      for (const blob of blobs) {
        const source = new URL(blob.url).origin;
        const configured = settings.configured("attachment");
        const mirror = configured.find(
          ({ origin }) =>
            origin !== source &&
            !priorRejection(origin, "attachment", blob.size),
        );
        if (
          !mirror ||
          !configured.some(({ origin }) => origin === source) ||
          signal.aborted ||
          !allowed() ||
          !settings.snapshot().mirror
        )
          continue;
        try {
          await client.mirror(
            mirror.origin,
            blob.url,
            { ...blob, mime: "application/octet-stream" },
            signal,
          );
        } catch (error) {
          if (error instanceof BlossomError)
            failure(mirror.origin, "attachment", error, blob.size);
          succeeded = false;
        }
      }
      return succeeded;
    },
    async check(
      origin: string,
      role: MediaRole,
      signal: AbortSignal,
      size = 65_536,
    ) {
      // A capability probe declares metadata only. It sends no sample bytes.
      const nonce = new Uint8Array(32);
      crypto.getRandomValues(nonce);
      const blob = {
        size,
        mime: mimeFor(role),
        hash: await http.sha256(nonce),
      };
      try {
        const status = await client.check(origin, blob, signal);
        record(origin, role, { checkedAt: now(), preflight: status });
        return status;
      } catch (error) {
        if (
          role === "attachment" &&
          error instanceof BlossomError &&
          (error.status === 400 || error.status === 409)
        ) {
          // This probe has a synthetic hash. MarmotKit signs the real ciphertext
          // hash for the upload, which still has to pass the server's checks.
          record(origin, role, { checkedAt: now(), preflight: "unsupported" });
          return "unsupported" as const;
        }
        if (error instanceof BlossomError) failure(origin, role, error, size);
        throw error;
      }
    },
    async upload(
      role: "profile",
      input: Uint8Array<ArrayBuffer>,
      options: { signal: AbortSignal },
    ): Promise<MediaUploadResult> {
      const { signal } = options;
      const checkLive = () => {
        if (signal.aborted) throw new BlossomError("cancelled");
      };
      const size = input.length;
      if (!size || size > maxAvatarBytes) throw new BlossomError("size");
      const blob = {
        bytes: input,
        size,
        hash: await http.sha256(input),
        mime: mimeFor(role),
      };
      const servers = settings.configured(role);
      let last = new BlossomError("configuration");
      for (const server of servers) {
        checkLive();
        const allowed = (origin: string) =>
          settings
            .configured(role)
            .some((candidate) => candidate.origin === origin);
        const checkPreference = (origin: string) => {
          if (!allowed(origin)) throw new BlossomError("cancelled");
        };
        if (!allowed(server.origin)) continue;
        const rejected = priorRejection(server.origin, role, size);
        if (rejected) {
          last = new BlossomError(rejected);
          continue;
        }
        let url: string;
        try {
          const put = () =>
            client.put(server.origin, blob, signal, {
              beforeRequest() {
                checkLive();
                checkPreference(server.origin);
              },
            });
          try {
            url = await put();
          } catch (error) {
            if (
              !(error instanceof BlossomError) ||
              error.code !== "authorization"
            )
              throw error;
            url = await put();
          }
          record(server.origin, role, {
            checkedAt: now(),
            preflight: getHealth(server.origin, role)?.preflight,
          });
        } catch (error) {
          if (!(error instanceof BlossomError)) throw error;
          failure(server.origin, role, error, size);
          if (error.code === "cancelled" || error.code === "hash") throw error;
          last = error;
          continue;
        }
        const target =
          settings.snapshot().mirror &&
          settings
            .configured(role)
            .find(
              (candidate) =>
                candidate.origin !== server.origin &&
                !priorRejection(candidate.origin, role, size),
            );
        if (!target || signal.aborted) return { url };
        const mirror = async () => {
          try {
            if (!settings.snapshot().mirror || !allowed(target.origin))
              return false;
            try {
              await client.mirror(target.origin, url, blob, signal);
            } catch (error) {
              if (
                !(error instanceof BlossomError) ||
                ![404, 405, 501].includes(error.status ?? 0)
              )
                throw error;
              // BUD-04 is optional. Reuse the exact bytes for an opted-in destination.
              checkPreference(target.origin);
              await client.put(target.origin, blob, signal);
            }
            return true;
          } catch (error) {
            if (error instanceof BlossomError)
              failure(target.origin, role, error, size);
            return false;
          }
        };
        return { url, mirror: mirror() };
      }
      throw last;
    },
  };
}
