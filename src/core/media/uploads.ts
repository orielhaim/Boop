import type { NDKSigner } from "@nostr-dev-kit/ndk";
import {
  BlossomError,
  type BlossomHttp,
  createBlossomClient,
  type UploadFailure,
  type UploadMime,
  type UploadProgress,
  type UploadContext,
} from "./blossom";
import type { createMediaSettings, MediaRole } from "./servers";
import { maxAttachmentBytes } from "./protocol";

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
        if (error instanceof BlossomError) failure(origin, role, error, size);
        throw error;
      }
    },
    async upload(
      role: MediaRole,
      input:
        | Uint8Array<ArrayBuffer>
        | { uri: string; size: number; hash: string; context?: UploadContext },
      options: {
        signal: AbortSignal;
        expectedHash?: string;
        progress?: (progress: UploadProgress) => void;
        canStart?: () => boolean;
      },
    ): Promise<MediaUploadResult> {
      const { signal, expectedHash, progress, canStart } = options;
      const checkLive = () => {
        if (signal.aborted || canStart?.() === false)
          throw new BlossomError("cancelled");
      };
      const size = input instanceof Uint8Array ? input.length : input.size;
      if (!size || size > maxAttachmentBytes) throw new BlossomError("size");
      if (role === "attachment" && !expectedHash)
        throw new BlossomError("hash");
      const hash =
        input instanceof Uint8Array ? await http.sha256(input) : input.hash;
      if (expectedHash && hash !== expectedHash) throw new BlossomError("hash");
      const blob = {
        ...(input instanceof Uint8Array ? { bytes: input } : input),
        size,
        hash,
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
              progress,
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
        if (!target || signal.aborted || canStart?.() === false) return { url };
        const mirror = async () => {
          progress?.("mirroring");
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
              const fallback =
                "uri" in blob ? { ...blob, context: undefined } : blob;
              await client.put(target.origin, fallback, signal);
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
