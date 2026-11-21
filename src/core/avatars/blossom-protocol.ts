import { NDKEvent, type NDKSigner } from "@nostr-dev-kit/ndk";
import { z } from "zod";
import { sanitizeAvatarJpeg, maxAvatarBytes } from "./jpeg";
import { blossomHash, publicImageUrl } from "./protocol";

export const defaultBlossomServer = "https://blossom.nostr.build";

export function blossomServer(input: string) {
  const url = publicImageUrl(input.trim());
  return url && url.pathname === "/" && !url.search && !input.includes("#")
    ? url.origin
    : null;
}

export type UploadFailure =
  | "network"
  | "timeout"
  | "authorization"
  | "quota"
  | "format"
  | "server"
  | "descriptor"
  | "cancelled";
export class BlossomError extends Error {
  constructor(readonly code: UploadFailure) {
    super(code);
  }
}

function httpError(status: number): UploadFailure {
  if ([401, 403].includes(status)) return "authorization";
  if ([402, 429, 507].includes(status)) return "quota";
  if ([413, 415].includes(status)) return "format";
  return "server";
}

export async function uploadAuthorization(
  signer: NDKSigner,
  host: string,
  hash: string,
) {
  const now = Math.floor(Date.now() / 1000);
  const event = new NDKEvent(undefined, {
    kind: 24242,
    content: "Upload profile photo",
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
  type: z.literal("image/jpeg"),
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

type BlossomResponse = {
  status: number;
  body: ReadableStream<Uint8Array> | null;
};
type BlossomHttp = {
  request(
    url: string,
    init: {
      method?: "PUT";
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

export async function putAvatar(
  signer: NDKSigner,
  origin: string,
  bytes: Uint8Array<ArrayBuffer>,
  signal: AbortSignal,
  { request, sha256, timeoutMs = 18_000 }: BlossomHttp,
) {
  const approved = blossomServer(origin);
  if (!approved || !bytes.length || bytes.length > maxAvatarBytes)
    throw new BlossomError("format");
  let sanitized: ReturnType<typeof sanitizeAvatarJpeg>;
  try {
    sanitized = sanitizeAvatarJpeg(bytes);
  } catch {
    throw new BlossomError("format");
  }
  if (sanitized.bytes.length !== bytes.length) throw new BlossomError("format");
  const hash = await sha256(sanitized.bytes);
  const authorization = await uploadAuthorization(
    signer,
    new URL(approved).hostname,
    hash,
  );
  if (signal.aborted) throw new BlossomError("cancelled");
  const timeout = new AbortController();
  const abort = () => timeout.abort();
  signal.addEventListener("abort", abort, { once: true });
  const deadline = setTimeout(abort, timeoutMs);
  try {
    const response = await request(`${approved}/upload`, {
      method: "PUT",
      body: sanitized.bytes,
      redirect: "error",
      credentials: "omit",
      signal: timeout.signal,
      headers: {
        Authorization: authorization,
        "Content-Type": "image/jpeg",
        "X-SHA-256": hash,
      },
    });
    if (response.status !== 200 && response.status !== 201)
      throw new BlossomError(httpError(response.status));
    let result: z.infer<typeof descriptor>;
    try {
      result = descriptor.parse(
        JSON.parse(new TextDecoder().decode(await boundedBody(response, 8192))),
      );
    } catch {
      throw new BlossomError("descriptor");
    }
    const url = publicImageUrl(result.url);
    if (
      !url ||
      url.origin !== approved ||
      blossomHash(url) !== hash ||
      result.sha256 !== hash ||
      result.size !== bytes.length
    )
      throw new BlossomError("descriptor");
    const stored = await request(url.href, {
      redirect: "error",
      credentials: "omit",
      signal: timeout.signal,
    });
    if (
      stored.status !== 200 ||
      (await sha256(await boundedBody(stored, maxAvatarBytes))) !== hash
    ) {
      throw new BlossomError("descriptor");
    }
    return url.href;
  } catch (error) {
    if (signal.aborted) throw new BlossomError("cancelled");
    if (timeout.signal.aborted) throw new BlossomError("timeout");
    if (error instanceof BlossomError) throw error;
    throw new BlossomError("network");
  } finally {
    timeout.abort();
    signal.removeEventListener("abort", abort);
    clearTimeout(deadline);
  }
}
