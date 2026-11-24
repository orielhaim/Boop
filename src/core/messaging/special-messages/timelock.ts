import {
  type ChainClient,
  type ChainInfo,
  defaultChainOptions,
  fetchBeacon,
  type RandomnessBeacon,
  roundAt,
  roundTime,
} from "drand-client";
import { decrypt, encrypt, inspect, quicknet as tlockQuicknet } from "tlock-js";
import { z } from "zod";
import { messagingMetric } from "../diagnostics";

export const quicknetHash =
  "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
const quicknet: ChainInfo = {
  hash: quicknetHash,
  public_key:
    "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a",
  period: 3,
  genesis_time: 1692803367,
  groupHash: "f477d5c89f21a17c863a7f937c6a6d15859414d2be09cd448d4279af331c5d3e",
  schemeID: "bls-unchained-g1-rfc9380",
  metadata: { beaconID: "quicknet" },
};

export const maxTimeLockDate = Date.UTC(9999, 11, 31, 23, 59, 56);
const maxRound = roundAt(maxTimeLockDate, quicknet) + 1;
const maxTextLength = 4_000;
const maxCiphertext = 17_000;
export const timeLockKind = 24881;
const timestamp = z
  .number()
  .int()
  .min(quicknet.genesis_time * 1_000);
const scheduleSchema = z.object({
  requestedAt: timestamp.max(maxTimeLockDate),
  roundTime: timestamp.max(maxTimeLockDate + 3_000),
  unlockRound: z.number().int().min(1).max(maxRound),
  chainHash: z.literal(quicknetHash),
});
export type UnlockSchedule = z.infer<typeof scheduleSchema>;

export function scheduleUnlock(requestedAt: number): UnlockSchedule {
  timestamp.max(maxTimeLockDate).parse(requestedAt);
  const previousOrExact = roundAt(requestedAt, quicknet);
  const unlockRound =
    roundTime(quicknet, previousOrExact) < requestedAt
      ? previousOrExact + 1
      : previousOrExact;
  return {
    requestedAt,
    unlockRound,
    roundTime: roundTime(quicknet, unlockRound),
    chainHash: quicknetHash,
  };
}

const contentSchema = scheduleSchema
  .extend({
    type: z.literal("timelock"),
    v: z.literal(1),
    ciphertext: z.string().min(1).max(maxCiphertext),
  })
  .strict();
export type TimeLockContent = z.infer<typeof contentSchema>;

const armorHeader = "-----BEGIN AGE ENCRYPTED FILE-----";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function parseTimeLock(value: unknown): TimeLockContent | null {
  const parsed = contentSchema.safeParse(value);
  if (!parsed.success) return null;
  const content = parsed.data;
  const schedule = scheduleUnlock(content.requestedAt);
  if (
    schedule.unlockRound !== content.unlockRound ||
    schedule.roundTime !== content.roundTime
  )
    return null;
  try {
    // inspect reports tlock recipients only. Require Boop's single Quicknet
    // stanza, including its 128-byte body, before the AGE MAC line.
    const [first, ...lines] = content.ciphertext.split("\n", 9);
    if (first !== armorHeader || lines.length !== 8) return null;
    const prefix = atob(lines.join(""));
    const mac = prefix.indexOf("\n--- ");
    if (mac < 0) return null;
    const header = prefix.slice(0, mac).split("\n");
    if (
      header.length !== 5 ||
      header[1] !== `-> tlock ${content.unlockRound} ${quicknetHash}` ||
      header[2]?.length !== 64 ||
      header[3]?.length !== 64 ||
      header[4]?.length !== 43
    )
      return null;
    const { format, recipients } = inspect(content.ciphertext);
    return format === "armor" &&
      recipients.length === 1 &&
      recipients[0]?.round === content.unlockRound &&
      recipients[0]?.chainHash === quicknetHash
      ? content
      : null;
  } catch {
    return null;
  }
}

const endpoints = [
  "https://api.drand.sh",
  "https://api2.drand.sh",
  "https://api3.drand.sh",
  "https://drand.cloudflare.com",
];
const beaconSchema = z.object({
  round: z.number().int().min(1).max(maxRound),
  signature: z.string().regex(/^[0-9a-f]{96}$/),
  randomness: z.string().regex(/^[0-9a-f]{64}$/),
});
export type UnlockFailure =
  | "not-ready"
  | "network"
  | "endpoint"
  | "verification"
  | "ciphertext"
  | "decryption"
  | "plaintext";
export class TimeLockError extends Error {
  constructor(readonly code: UnlockFailure) {
    super(code);
  }
}

function pinnedClient(get: ChainClient["get"]): ChainClient {
  return {
    options: {
      ...defaultChainOptions,
      chainVerificationParams: {
        chainHash: quicknetHash,
        publicKey: quicknet.public_key,
      },
    },
    get,
    latest: () => get(roundAt(Date.now(), quicknet)),
    chain: () => ({ baseUrl: "", info: async () => quicknet }),
  };
}

const offlineQuicknet = { chain: tlockQuicknet.chain };

function validBody(body: string) {
  return Boolean(body.trim() && body.length <= maxTextLength);
}

export async function encryptTimeLock(body: string, requestedAt: number) {
  if (!validBody(body)) throw new Error("invalid-message");
  const schedule = scheduleUnlock(requestedAt);
  if (requestedAt <= Date.now()) throw new Error("unlock-time");
  const bytes = textEncoder.encode(body);
  if (textDecoder.decode(bytes) !== body) throw new Error("invalid-message");
  const ciphertext = encrypt(bytes, {
    round: schedule.unlockRound,
    format: "armor",
    network: offlineQuicknet,
  });
  const content = parseTimeLock({
    type: "timelock",
    v: 1,
    ...schedule,
    ciphertext,
  });
  if (!content) throw new Error("invalid-message");
  return content;
}

async function retrieve(endpoint: string, round: number, signal?: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) throw new TimeLockError("network");
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), 4_000);
  try {
    const start = performance.now();
    const response = await fetch(
      `${endpoint}/${quicknetHash}/public/${round}`,
      {
        signal: controller.signal,
      },
    );
    if (response.status === 404 || response.status === 425)
      throw new TimeLockError("not-ready");
    if (!response.ok) throw new TimeLockError("endpoint");
    if (Number(response.headers.get("content-length")) > 1_024)
      throw new TimeLockError("verification");
    const payload = await response.text();
    messagingMetric("Quicknet beacon HTTP", { ms: performance.now() - start });
    if (payload.length > 1_024) throw new TimeLockError("verification");
    try {
      return beaconSchema.parse(JSON.parse(payload));
    } catch {
      throw new TimeLockError("verification");
    }
  } catch (error) {
    if (error instanceof TimeLockError) throw error;
    throw new TimeLockError(controller.signal.aborted ? "endpoint" : "network");
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

async function verify(round: number, get: ChainClient["get"]) {
  try {
    return await fetchBeacon(pinnedClient(get), round);
  } catch (error) {
    if (error instanceof TimeLockError) throw error;
    throw new TimeLockError("verification");
  }
}

type BeaconCache = {
  read(round: number): unknown;
  store(beacon: RandomnessBeacon): void;
};

export function createTimeLockOpener(
  durable?: BeaconCache,
  fetchRound = retrieve,
) {
  const cached = new Map<number, RandomnessBeacon>();
  const inFlight = new Map<number, Promise<RandomnessBeacon>>();

  async function load(round: number, signal?: AbortSignal) {
    const stored = beaconSchema.safeParse(durable?.read(round));
    if (stored.success) {
      const result = await verify(round, async () => stored.data).catch(
        () => null,
      );
      if (result) return result;
    }
    const failures = new Set<UnlockFailure>();
    for (const endpoint of endpoints) {
      if (signal?.aborted) break;
      try {
        const beacon = await verify(round, () =>
          fetchRound(endpoint, round, signal),
        );
        if (!signal?.aborted) durable?.store(beacon);
        return beacon;
      } catch (error) {
        if (!(error instanceof TimeLockError)) throw error;
        failures.add(error.code);
      }
    }
    for (const code of [
      "verification",
      "not-ready",
      "endpoint",
      "network",
    ] as const)
      if (failures.has(code)) throw new TimeLockError(code);
    throw new TimeLockError("network");
  }

  function beacon(round: number, signal?: AbortSignal) {
    const existing = cached.get(round);
    if (existing) return Promise.resolve(existing);
    const fetching = inFlight.get(round);
    if (fetching) return fetching;
    const next = load(round, signal)
      .then((result) => {
        cached.set(round, result);
        const oldest = cached.keys().next().value;
        if (cached.size > 32 && oldest !== undefined) cached.delete(oldest);
        return result;
      })
      .finally(() => inFlight.delete(round));
    inFlight.set(round, next);
    return next;
  }

  return async (content: TimeLockContent, signal?: AbortSignal) => {
    if (signal?.aborted) return null;
    if (!parseTimeLock(content)) throw new TimeLockError("ciphertext");
    if (content.roundTime > Date.now()) throw new TimeLockError("not-ready");
    const verified = await beacon(content.unlockRound, signal);
    if (signal?.aborted) return null;
    let plaintext: Uint8Array;
    try {
      const start = performance.now();
      plaintext = await decrypt(content.ciphertext, {
        network: offlineQuicknet,
        beacon: verified,
      });
      messagingMetric("timelock decrypt", { ms: performance.now() - start });
    } catch {
      throw new TimeLockError("decryption");
    }
    try {
      const body = textDecoder.decode(plaintext);
      if (validBody(body)) return body;
    } catch {
      throw new TimeLockError("plaintext");
    }
    throw new TimeLockError("plaintext");
  };
}
