import { NDKEvent, type NDKSigner } from "@nostr-dev-kit/ndk";
import { z } from "zod";
import { blossomHash, publicMediaUrl } from "./url";

export function blossomServer(input: string) {
  const url = publicMediaUrl(input.trim());
  return url && url.pathname === "/" && !url.search && !input.includes("#")
    ? url.origin
    : null;
}

export type UploadMime = "image/jpeg" | "application/octet-stream";
export type UploadFailure =
  | "network"
  | "timeout"
  | "authorization"
  | "forbidden"
  | "payment"
  | "rate-limit"
  | "size"
  | "format"
  | "hash"
  | "server"
  | "descriptor"
  | "cancelled"
  | "configuration";

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

async function uploadAuthorization(
  signer: NDKSigner,
  host: string,
  hash: string,
  purpose: "profile" | "attachment" = "profile",
  preflight = false,
) {
  const now = Math.floor(Date.now() / 1000);
  const expires = now + 120;
  const event = new NDKEvent(undefined, {
    kind: 24242,
    content: preflight
      ? "Check upload permissions"
      : purpose === "profile"
        ? "Upload profile photo"
        : "Upload encrypted file",
    created_at: now - 1,
    tags: [
      ["t", "upload"],
      ["expiration", String(expires)],
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
  verifyProfileBlob?: (
    url: string,
    hash: string,
    signal: AbortSignal,
  ) => Promise<void>;
  headUpload?: (
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal,
  ) => Promise<number>;
  mirrorCommand?: (
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal,
    body: string,
  ) => Promise<{ status: number; body: string }>;
  timeoutMs?: number;
};

type BlobInfo = { mime: UploadMime; hash: string; size: number };
function jsonDescriptor(text: string, blob: BlobInfo) {
  try {
    const data = descriptor.parse(JSON.parse(text));
    const url = publicMediaUrl(data.url);
    if (
      url &&
      blossomHash(url) === blob.hash &&
      data.sha256 === blob.hash &&
      data.size === blob.size &&
      data.type === blob.mime
    )
      return url;
  } catch {
    // A malformed descriptor is treated as a failed upload.
  }
  throw new BlossomError("descriptor");
}

export function createBlossomClient(signer: NDKSigner, http: BlossomHttp) {
  async function verifiedUrl(
    body: string,
    origin: string,
    blob: BlobInfo,
    signal: AbortSignal,
  ) {
    const url = jsonDescriptor(body, blob);
    if (blob.mime === "image/jpeg" && http.verifyProfileBlob) {
      await http.verifyProfileBlob(url.href, blob.hash, signal);
    } else {
      if (url.origin !== origin) throw new BlossomError("descriptor");
      if (blob.mime === "image/jpeg") {
        const stored = await http.request(url.href, {
          redirect: "error",
          credentials: "omit",
          signal,
        });
        if (
          stored.status !== 200 ||
          (await http.sha256(await boundedBody(stored, blob.size))) !==
            blob.hash
        )
          throw new BlossomError("descriptor");
      }
    }
    if (signal.aborted) throw new BlossomError("cancelled");
    return url.href;
  }

  async function operation<T>(
    origin: string,
    blob: BlobInfo,
    signal: AbortSignal,
    run: (args: {
      origin: string;
      authorization: string;
      signal: AbortSignal;
    }) => Promise<T>,
    timeoutMs = http.timeoutMs ?? 35_000,
    checking = false,
  ) {
    const server = blossomServer(origin);
    if (!server) throw new BlossomError("configuration");
    if (signal.aborted) throw new BlossomError("cancelled");
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal.addEventListener("abort", cancel, { once: true });
    const timeout = setTimeout(cancel, timeoutMs);
    try {
      const authorization = await uploadAuthorization(
        signer,
        new URL(server).hostname,
        blob.hash,
        blob.mime === "image/jpeg" ? "profile" : "attachment",
        checking,
      );
      if (abort.signal.aborted) throw new BlossomError("cancelled");
      return await run({
        origin: server,
        authorization,
        signal: abort.signal,
      });
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
    const endpoint = `${origin}/upload`;
    const headers = {
      Authorization: authorization,
      "X-SHA-256": blob.hash,
      "X-Content-Type": blob.mime,
      "X-Content-Length": String(blob.size),
    };
    const status = http.headUpload
      ? await http.headUpload(endpoint, headers, signal)
      : (
          await http.request(endpoint, {
            method: "HEAD",
            redirect: "error",
            credentials: "omit",
            signal,
            headers,
          })
        ).status;

    if (status >= 200 && status < 300) return "compatible" as const;
    if ([404, 405, 501].includes(status)) return "unsupported" as const;
    throw httpError(status);
  }

  return {
    check(origin: string, blob: BlobInfo, signal: AbortSignal) {
      return operation(
        origin,
        blob,
        signal,
        (args) => preflight(args.origin, args.authorization, blob, args.signal),
        undefined,
        true,
      );
    },
    async put(
      origin: string,
      blob: BlobInfo & { bytes: Uint8Array<ArrayBuffer> },
      signal: AbortSignal,
      options: {
        preflight?: boolean;
        beforeRequest?: () => void;
      } = {},
    ) {
      if (options.preflight !== false) {
        options.beforeRequest?.();
        await operation(
          origin,
          blob,
          signal,
          (args) =>
            preflight(args.origin, args.authorization, blob, args.signal),
          undefined,
          true,
        );
      }
      return operation(origin, blob, signal, async (args) => {
        options.beforeRequest?.();
        const endpoint = `${args.origin}/upload`;
        const headers = {
          Authorization: args.authorization,
          "Content-Type": blob.mime,
          "Content-Length": String(blob.size),
          "X-SHA-256": blob.hash,
        };
        const response = await http.request(endpoint, {
          method: "PUT",
          redirect: "error",
          credentials: "omit",
          signal: args.signal,
          body: blob.bytes,
          headers,
        });
        if (response.status !== 200 && response.status !== 201)
          throw httpError(response.status);
        return verifiedUrl(
          new TextDecoder().decode(await boundedBody(response, 8192)),
          args.origin,
          blob,
          args.signal,
        );
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
        const endpoint = `${args.origin}/mirror`;
        const content = JSON.stringify({ url: url.href });
        const body = new TextEncoder().encode(content);
        const headers = {
          Authorization: args.authorization,
          "X-SHA-256": blob.hash,
          "Content-Type": "application/json",
          "Content-Length": String(body.length),
        };
        if (http.mirrorCommand) {
          const response = await http.mirrorCommand(
            endpoint,
            headers,
            args.signal,
            content,
          );
          if (response.status !== 200 && response.status !== 201)
            throw httpError(response.status);
          return verifiedUrl(response.body, args.origin, blob, args.signal);
        }
        const response = await http.request(endpoint, {
          method: "PUT",
          redirect: "error",
          credentials: "omit",
          signal: args.signal,
          body,
          headers,
        });
        if (response.status !== 200 && response.status !== 201)
          throw httpError(response.status);
        return verifiedUrl(
          new TextDecoder().decode(await boundedBody(response, 8192)),
          args.origin,
          blob,
          args.signal,
        );
      });
    },
  };
}
