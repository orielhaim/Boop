import type {
  AnnounceResult,
  OfferRecord,
  StrategyAdapter,
  StrategyOnMessage,
} from "@trystero-p2p/core";
import { callCapacity } from "./conference";
import { callMetric } from "./diagnostics";
import {
  type InviteDraft,
  inviteLifetime,
  type RtcOffer,
  type RtcPayload,
  type RtcSignal,
  rtcPayload,
} from "./signals";

type Scope = { invitationId?: string; recovery?: true; expiresAt: number };
type Link = {
  scope: Scope;
  offer?: RtcOffer;
  remoteId?: string;
  lease?: OfferRecord;
  answered: boolean;
  started: boolean;
  connected: boolean;
  received: Set<string>;
  sent: Set<string>;
  out: string[];
  early: { peerId: string; values: string[] }[];
  answer?: Extract<RtcPayload, { answer: string }>;
  flush?: ReturnType<typeof setTimeout>;
  apply: Promise<unknown>;
};

const candidateLimit = 32;

export function directSignaling({
  invite,
  localKey,
  signal,
  randomId,
  publish,
}: {
  invite: InviteDraft;
  localKey: string;
  signal: AbortSignal;
  randomId: () => string;
  publish: (message: RtcSignal, live: () => boolean) => Promise<boolean>;
}) {
  const links = new Map<string, Link>();
  type Subscribe = Parameters<StrategyAdapter<null>["subscribe"]>;
  type Endpoint = {
    id: string;
    topic: string;
    receive: StrategyOnMessage;
    getOffers: Subscribe[4];
  };
  let resolveEndpoint: (value: Endpoint) => void = () => undefined;
  let rejectEndpoint: (reason: Error) => void = () => undefined;
  const endpoint = new Promise<Endpoint>((resolve, reject) => {
    resolveEndpoint = resolve;
    rejectEndpoint = reject;
  });
  void endpoint.catch(() => undefined);
  let closed = false;
  const pending: RtcSignal[] = [];
  const incomingOffers = new Map<string, number>();
  let scopeFor: (key: string, message: RtcSignal) => Scope | undefined = () =>
    undefined;
  const sameScope = (
    a: Scope,
    b: Pick<RtcSignal, "invitationId" | "recovery">,
  ) => a.invitationId === b.invitationId && a.recovery === b.recovery;

  const live = (key: string, link: Link) =>
    !closed &&
    !signal.aborted &&
    !link.connected &&
    links.get(key) === link &&
    Date.now() < link.scope.expiresAt;

  function remove(key: string) {
    const link = links.get(key);
    links.delete(key);
    clearTimeout(link?.flush);
    link?.lease?.reclaim?.();
  }

  function close() {
    if (closed) return;
    closed = true;
    rejectEndpoint(new Error("RTC signaling closed"));
    pending.length = 0;
    incomingOffers.clear();
    for (const key of links.keys()) remove(key);
  }

  const adapter = {
    init: () => null,
    subscribe(_relay, _roomTopic, topic, receive, getOffers, { peerId }) {
      if (!closed) {
        callMetric("signaling_ready");
        resolveEndpoint({ id: peerId, topic, receive, getOffers });
      }
      return close;
    },
    announce: (): AnnounceResult => ({ stopAnnouncing: true }),
  } satisfies StrategyAdapter<null>;

  function allocate(key: string, scope: Scope) {
    if (closed || links.size >= callCapacity - 1 || links.has(key))
      throw new Error("RTC link unavailable");
    const link: Link = {
      scope,
      answered: false,
      started: false,
      connected: false,
      received: new Set(),
      sent: new Set(),
      early: [],
      out: [],
      apply: Promise.resolve(),
    };
    links.set(key, link);
    return link;
  }

  async function send(key: string, link: Link, payload: RtcPayload) {
    if (!live(key, link)) return false;
    const createdAt = Math.floor(Date.now() / 1_000) * 1_000;
    const message: RtcSignal = {
      type: "call.rtc",
      version: 1,
      callId: invite.callId,
      nonce: randomId(),
      senderKey: localKey,
      recipientKey: key,
      createdAt,
      expiresAt: Math.min(link.scope.expiresAt, createdAt + inviteLifetime),
      ...(link.scope.recovery ? { recovery: true } : {}),
      ...(link.scope.invitationId
        ? { invitationId: link.scope.invitationId }
        : {}),
      payload,
    };
    for (const delay of [0, 350, 1_000]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (!live(key, link)) return false;
      if (await publish(message, () => live(key, link)).catch(() => false))
        return true;
    }
    return false;
  }

  function schedule(key: string, link: Link) {
    if (!link.started || link.flush || !link.offer || !link.out.length) return;
    link.flush = setTimeout(() => {
      link.flush = undefined;
      if (!live(key, link) || !link.offer) return;
      void endpoint.then(({ id }) => {
        if (!link.offer || !live(key, link)) return;
        const candidates = link.out.splice(0, 8);
        if (candidates.length)
          void send(key, link, {
            peerId: id,
            offerId: link.offer.offerId,
            candidates,
          });
        schedule(key, link);
      });
    }, 35);
  }

  function queue(key: string, link: Link, candidate: string) {
    if (
      !live(key, link) ||
      candidate.length > 1_536 ||
      link.sent.size >= candidateLimit ||
      link.sent.has(candidate)
    )
      return;
    link.sent.add(candidate);
    link.out.push(candidate);
    schedule(key, link);
  }

  function bind(link: Link, peerId: string) {
    if (link.remoteId) return link.remoteId === peerId;
    if ([...links.values()].some((other) => other.remoteId === peerId))
      return false;
    link.remoteId = peerId;
    return true;
  }

  async function prepare(key: string, scope: Scope) {
    const local = await endpoint;
    signal.throwIfAborted();
    const link = allocate(key, scope);
    try {
      callMetric("offer_preparation_started");
      const gathering: { id: string; candidate: string }[] = [];
      const [lease] = await local.getOffers(1, (id, candidate) => {
        if (link.offer) {
          if (link.offer.offerId === id) queue(key, link, candidate);
        } else if (gathering.length < 2 * candidateLimit) {
          gathering.push({ id, candidate });
        }
      });
      if (!lease || !live(key, link)) {
        lease?.reclaim?.();
        throw new Error("RTC offer expired");
      }
      link.lease = lease;
      const offer: RtcOffer = {
        peerId: local.id,
        offerId: lease.offerId,
        offer: lease.offer,
      };
      if (!rtcPayload.safeParse(offer).success)
        throw new Error("RTC offer exceeds transport bounds");
      link.offer = offer;
      for (const { id, candidate } of gathering.splice(0))
        if (id === offer.offerId) queue(key, link, candidate);
      callMetric("offer_ready");
      return offer;
    } catch (error) {
      remove(key);
      throw error;
    }
  }

  async function applyOffer(key: string, scope: Scope, offer: RtcOffer) {
    const local = await endpoint;
    if (closed || signal.aborted || scope.expiresAt <= Date.now()) return;
    const existing = links.get(key);
    if (existing) {
      if (
        scope.recovery &&
        existing.answer &&
        existing.offer?.offerId === offer.offerId &&
        existing.remoteId === offer.peerId &&
        existing.offer.offer === offer.offer
      ) {
        void send(key, existing, existing.answer);
        repeatCandidates(key, existing);
      }
      return;
    }
    const replayKey = `${key}:${offer.offerId}`;
    for (const [id, expiry] of incomingOffers)
      if (expiry <= Date.now()) incomingOffers.delete(id);
    if (incomingOffers.has(replayKey) || incomingOffers.size >= 64) return;
    const link = allocate(key, scope);
    if (offer.peerId === local.id || !bind(link, offer.peerId)) {
      remove(key);
      return;
    }
    incomingOffers.set(replayKey, scope.expiresAt);
    link.offer = offer;
    link.started = true;
    callMetric("remote_offer_received");
    link.apply = Promise.resolve(
      local.receive(local.topic, offer, (_topic, raw) => {
        if (!live(key, link)) return;
        const data: unknown = JSON.parse(raw);
        if (typeof data !== "object" || !data) return;
        if ("candidate" in data && typeof data.candidate === "string") {
          queue(key, link, data.candidate);
          return;
        }
        const result = rtcPayload.safeParse(data);
        if (!result.success || !("answer" in result.data)) return;
        link.answer = result.data;
        callMetric("rtc_answer_publish_started");
        return send(key, link, result.data);
      }),
    );
    await link.apply;
  }

  async function receive(message: RtcSignal) {
    if (
      closed ||
      message.recipientKey !== localKey ||
      message.senderKey === localKey ||
      message.expiresAt <= Date.now() ||
      message.callId !== invite.callId
    )
      return;
    const local = await endpoint;
    const key = message.senderKey;
    const data = message.payload;
    if (data.peerId === local.id) return;
    if ("offer" in data && incomingOffers.has(`${key}:${data.offerId}`)) {
      const existing = links.get(key);
      if (existing?.connected || existing?.offer?.offerId !== data.offerId)
        return;
    }
    const scope = scopeFor(key, message);
    if (!scope || !sameScope(scope, message)) {
      const known = links.get(key);
      if (
        known?.lease &&
        !known.started &&
        sameScope(known.scope, message) &&
        known.offer?.offerId === data.offerId &&
        pending.length < 16
      )
        pending.push(message);
      return;
    }
    if ("offer" in data) {
      await applyOffer(key, scope, data);
      return;
    }
    const link = links.get(key);
    if (
      !link?.offer ||
      !live(key, link) ||
      !sameScope(link.scope, message) ||
      link.offer.offerId !== data.offerId
    )
      return;
    if ("answer" in data) {
      if (!link.lease || link.answered || !bind(link, data.peerId)) return;
      link.answered = true;
      callMetric("remote_answer_received");
      link.apply = Promise.resolve(
        local.receive(
          local.topic,
          { ...data, peer: link.lease.peer },
          () => undefined,
        ),
      );
      await link.apply;
      for (const entry of link.early.splice(0))
        if (entry.peerId === data.peerId)
          await candidates(link, local, data.peerId, entry.values);
      return;
    }
    if (link.remoteId && link.remoteId !== data.peerId) return;
    if (!link.remoteId) {
      if (link.early.length < 4)
        link.early.push({ peerId: data.peerId, values: data.candidates });
      return;
    }
    await candidates(link, local, data.peerId, data.candidates);
  }

  async function candidates(
    link: Link,
    local: Endpoint,
    peerId: string,
    list: string[],
  ) {
    await link.apply;
    if (closed || link.connected || !link.offer) return;
    for (const candidate of list) {
      if (link.received.size >= candidateLimit || link.received.has(candidate))
        continue;
      link.received.add(candidate);
      await local.receive(
        local.topic,
        {
          peerId,
          offerId: link.offer.offerId,
          candidate,
          ...(link.lease ? { peer: link.lease.peer } : {}),
        },
        () => undefined,
      );
    }
  }

  function repeatCandidates(key: string, link: Link) {
    if (!live(key, link)) return;
    link.out = [...link.sent];
    schedule(key, link);
  }

  return {
    adapter,
    prepare,
    applyOffer,
    receive,
    remove,
    close,
    connected(key: string) {
      const link = links.get(key);
      if (!link) return;
      link.connected = true;
      clearTimeout(link.flush);
      link.out.length = 0;
      link.early.length = 0;
      link.received.clear();
      link.sent.clear();
      link.lease = undefined;
    },
    scopeFor(resolve: typeof scopeFor) {
      scopeFor = resolve;
    },
    matches(key: string, peerId: string) {
      return links.get(key)?.remoteId === peerId;
    },
    startCandidates(key: string) {
      const link = links.get(key);
      if (!link) return;
      link.started = true;
      schedule(key, link);
      for (let i = pending.length - 1; i >= 0; i--) {
        const message = pending[i];
        if (!message || message.senderKey !== key) continue;
        pending.splice(i, 1);
        void receive(message).catch(() => undefined);
      }
    },
    async offer(key: string, scope: Scope) {
      const offer = await prepare(key, scope);
      const link = links.get(key);
      if (!link) return false;
      const accepted = await send(key, link, offer);
      link.started = true;
      schedule(key, link);
      return accepted;
    },
    async repeatOffer(key: string) {
      const link = links.get(key);
      if (!link?.offer || !link.lease || !live(key, link)) return false;
      const accepted = await send(key, link, link.offer);
      repeatCandidates(key, link);
      return accepted;
    },
  };
}
