import { NDKEvent, type NDKSigner } from "@nostr-dev-kit/ndk";
import { z } from "zod";
import { blossomHash, publicMediaUrl } from "./url";

export const defaultBlossomServer = "https://blossom.nostr.build";

export function blossomServer(input: string) {
  const url = publicMediaUrl(input.trim());
  return url && url.pathname === "/" && !url.search && !input.includes("#")
    ? url.origin
    : null;
}

export type UploadMime = "image/jpeg" | "application/octet-stream";
export const uploadFailures = [
  "network",
  "timeout",
  "authorization",
  "forbidden",
  "payment",
  "rate-limit",
  "size",
  "format",
  "hash",
  "server",
  "descriptor",
  "cancelled",
  "configuration",
] as const;
export type UploadFailure = (typeof uploadFailures)[number];
export function isUploadFailure(
  value: string | undefined | null,
): value is UploadFailure {
  return uploadFailures.some((code) => code === value);
}
export type UploadProgress =
  "checking" | "uploading" | "validating" | "mirroring";

export class BlossomError extends Error {
  constructor(
    readonly code: UploadFailure,
    readonly status?: number,
  ) {
    super(code);
  }
}

function httpError(status: number) {
  const codes: Partial<Record<number, UploadFailure>> = {
    401: "authorization",
    402: "payment",
    403: "forbidden",
    409: "hash",
    413: "size",
    415: "format",
    429: "rate-limit",
    507: "size",
  };
  return new BlossomError(codes[status] ?? "server", status);
}

export async function uploadAuthorization(
  signer: NDKSigner,
  host: string,
  hash: string,
  purpose: "profile" | "attachment" = "profile",
) {
  const now = Math.floor(Date.now() / 1000);
  const event = new NDKEvent(undefined, {
    kind: 24242,
    content:
      purpose === "profile" ? "Upload profile photo" : "Upload encrypted file",
    created_at: now - 1,
    tags: [
      ["t", "upload"],
      ["expiration", String(now + 120)],
      ["server", host],
      ["x", hash],
    ],
  });
  await event.sign(signer);
  const token = btoa(JSON.stringify(event.rawEvent()))
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
  return `Nostr ${token}`;
}

const descriptor = z.object({
  url: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  size: z.number().int().positive(),
  type: z.string(),
  uploaded: z.number().int().nonnegative(),
});

async function boundedBody(response: BlossomResponse, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) throw new BlossomError("descriptor");
  const bytes = new Uint8Array(limit);
  let offset = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return bytes.slice(0, offset);
      if (offset + value.length > limit) throw new BlossomError("descriptor");
      bytes.set(value, offset);
      offset += value.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export type BlossomResponse = {
  status: number;
  body: ReadableStream<Uint8Array> | null;
};
export type BlossomHttp = {
  request(
    url: string,
    init: {
      method?: "HEAD" | "PUT";
      body?: Uint8Array<ArrayBuffer>;
      redirect: "error";
      credentials: "omit";
      signal: AbortSignal;
      headers?: Record<string, string>;
    },
  ): Promise<BlossomResponse>;
  sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string>;
  timeoutMs?: number;
};

type BlobInfo = { mime: UploadMime; hash: string; size: number };
export type BlobUpload = BlobInfo & { bytes: Uint8Array<ArrayBuffer> };

function jsonDescriptor(text: Uint8Array, origin: string, blob: BlobInfo) {
  try {
    const data = descriptor.parse(JSON.parse(new TextDecoder().decode(text)));
    const url = publicMediaUrl(data.url);
    if (
      url?.origin === origin &&
      blossomHash(url) === blob.hash &&
      data.sha256 === blob.hash &&
      data.size === blob.size &&
      data.type === blob.mime
    )
      return url.href;
  } catch {
    // A malformed descriptor is treated as a failed upload.
  }
  throw new BlossomError("descriptor");
}

export function createBlossomClient(signer: NDKSigner, http: BlossomHttp) {
  async function operation<T>(
    origin: string,
    blob: BlobInfo,
    signal: AbortSignal,
    run: (args: {
      origin: string;
      authorization: string;
      signal: AbortSignal;
    }) => Promise<T>,
  ) {
    const server = blossomServer(origin);
    if (!server) throw new BlossomError("configuration");
    if (signal.aborted) throw new BlossomError("cancelled");
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal.addEventListener("abort", cancel, { once: true });
    const timeout = setTimeout(cancel, http.timeoutMs ?? 35_000);
    try {
      const authorization = await uploadAuthorization(
        signer,
        new URL(server).hostname,
        blob.hash,
        blob.mime === "image/jpeg" ? "profile" : "attachment",
      );
      if (abort.signal.aborted) throw new BlossomError("cancelled");
      return await run({ origin: server, authorization, signal: abort.signal });
    } catch (error) {
      if (signal.aborted) throw new BlossomError("cancelled");
      if (abort.signal.aborted) throw new BlossomError("timeout");
      if (error instanceof BlossomError) throw error;
      throw new BlossomError("network");
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", cancel);
      cancel();
    }
  }

  async function preflight(
    origin: string,
    authorization: string,
    blob: BlobInfo,
    signal: AbortSignal,
  ) {
    const response = await http.request(`${origin}/upload`, {
      method: "HEAD",
      redirect: "error",
      credentials: "omit",
      signal,
      headers: {
        Authorization: authorization,
        "X-SHA-256": blob.hash,
        "X-Content-Type": blob.mime,
        "X-Content-Length": String(blob.size),
      },
    });
    if (response.status >= 200 && response.status < 300)
      return "compatible" as const;
    if ([404, 405, 501].includes(response.status))
      return "unsupported" as const;
    throw httpError(response.status);
  }

  return {
    check(origin: string, blob: BlobInfo, signal: AbortSignal) {
      return operation(origin, blob, signal, (args) =>
        preflight(args.origin, args.authorization, blob, args.signal),
      );
    },
    put(
      origin: string,
      blob: BlobUpload,
      signal: AbortSignal,
      options: {
        preflight?: boolean;
        progress?: (progress: UploadProgress) => void;
      } = {},
    ) {
      return operation(origin, blob, signal, async (args) => {
        const common = {
          redirect: "error" as const,
          credentials: "omit" as const,
          signal: args.signal,
        };
        if (options.preflight !== false) {
          options.progress?.("checking");
          await preflight(args.origin, args.authorization, blob, args.signal);
        }
        options.progress?.("uploading");
        const response = await http.request(`${args.origin}/upload`, {
          ...common,
          method: "PUT",
          body: blob.bytes,
          headers: {
            Authorization: args.authorization,
            "Content-Type": blob.mime,
            "Content-Length": String(blob.size),
            "X-SHA-256": blob.hash,
          },
        });
        if (response.status !== 200 && response.status !== 201)
          throw httpError(response.status);
        options.progress?.("validating");
        const url = jsonDescriptor(
          await boundedBody(response, 8192),
          args.origin,
          blob,
        );
        if (blob.mime === "image/jpeg") {
          const stored = await http.request(url, common);
          if (
            stored.status !== 200 ||
            (await http.sha256(await boundedBody(stored, blob.size))) !==
              blob.hash
          )
            throw new BlossomError("descriptor");
        }
        return url;
      });
    },
    mirror(
      origin: string,
      source: string,
      blob: BlobInfo,
      signal: AbortSignal,
    ) {
      const url = publicMediaUrl(source);
      if (!url || blossomHash(url) !== blob.hash)
        return Promise.reject(new BlossomError("descriptor"));
      return operation(origin, blob, signal, async (args) => {
        const body = new TextEncoder().encode(
          JSON.stringify({ url: url.href }),
        );
        const response = await http.request(`${args.origin}/mirror`, {
          method: "PUT",
          redirect: "error",
          credentials: "omit",
          signal: args.signal,
          body,
          headers: {
            Authorization: args.authorization,
            "X-SHA-256": blob.hash,
            "Content-Type": "application/json",
            "Content-Length": String(body.length),
          },
        });
        if (response.status !== 200 && response.status !== 201)
          throw httpError(response.status);
        return jsonDescriptor(
          await boundedBody(response, 8192),
          args.origin,
          blob,
        );
      });
    },
  };
}
