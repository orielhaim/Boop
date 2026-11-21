import { randomUUID } from "expo-crypto";
import { requireNativeModule } from "expo-modules-core";
import { nip19 } from "nostr-tools";
import { getPublicKey } from "nostr-tools/pure";
import { hexToBytes } from "nostr-tools/utils";
import { z } from "zod";
import type { RelayConfiguration } from "../nostr/config";

const windowRevision = z.object({
  generation: z.string(),
  sequence: z.string().regex(/^\d{1,20}$/),
  hasMoreBefore: z.boolean(),
  hasMoreAfter: z.boolean(),
});
const chatRow = z.object({
  id: z.string(),
  title: z.string().nullish(),
  peer: z.string().nullish(),
  kind: z.enum(["unknown", "direct", "group"]),
  lifecycle: z.string(),
  membership: z.string(),
  invited: z.boolean(),
  pinned: z.boolean(),
  muted: z.boolean(),
  archived: z.boolean(),
  unread: z.number().nonnegative(),
  updatedAt: z.number().nonnegative(),
  preview: z.string().nullish(),
});

const message = z.object({
  id: z.string(),
  token: z.string().nullish(),
  sender: z.string(),
  text: z.string(),
  sentAt: z.number().nonnegative(),
  eventKind: z.number().int().nonnegative(),
  replyTo: z.string().nullish(),
  replyPreview: z
    .object({ id: z.string(), sender: z.string(), text: z.string() })
    .nullish(),
  reactions: z.array(
    z.object({
      emoji: z.string(),
      count: z.number(),
      users: z.array(z.string()),
      own: z.boolean(),
    }),
  ),
  attachments: z.array(
    z.object({
      index: z.number().int(),
      name: z.string(),
      type: z.string(),
      thumbhash: z.string().nullish(),
      dimensions: z.string().nullish(),
    }),
  ),
  sourceId: z.string().nullish(),
  poll: z
    .object({
      question: z.string(),
      multiple: z.boolean(),
      open: z.boolean(),
      selected: z.array(z.string()),
      expiresAt: z.number().nullish(),
      options: z.array(
        z.object({ id: z.string(), name: z.string(), votes: z.number() }),
      ),
    })
    .nullish(),
  deleted: z.boolean(),
  edited: z.boolean(),
  confirmed: z.boolean(),
  invalidated: z.boolean(),
  systemType: z.string().nullish(),
});

const chatListSnapshot = windowRevision.extend({
  kind: z.literal("chatList"),
  rows: z.array(chatRow).max(200),
});
const attentionSnapshot = windowRevision.extend({
  kind: z.literal("attention"),
  count: z.number().nullish(),
});
const conversationSnapshot = windowRevision.extend({
  kind: z.literal("conversation"),
  title: z.string().nullish(),
  peer: z.string().nullish(),
  lifecycle: z.string(),
  memberCount: z.number().nullish(),
  invited: z.boolean(),
  canSend: z.boolean(),
  firstUnread: z.string().nullish(),
  draft: z
    .object({ text: z.string(), replyTo: z.string().nullish() })
    .nullish(),
  identities: z.array(z.object({ id: z.string(), name: z.string() })),
  messages: z.array(message).max(200),
});

const readiness = z.enum([
  "initializing",
  "local_ready",
  "publishing",
  "network_ready",
  "recovery_required",
]);
const memberOutcome = z.object({
  account: z.string(),
  status: z.string(),
  devices: z.number(),
});
const groupCreation = z.object({
  groupId: z.string().nullish(),
  members: z.array(memberOutcome),
});
const groupDetails = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  inviter: z.string().nullish(),
  relays: z.array(z.string()),
  retention: z.number().int().nonnegative(),
  membership: z.string(),
  lifecycle: z.string(),
  commit: z.string().nullish(),
  isAdmin: z.boolean(),
  canInvite: z.boolean(),
  canLeave: z.boolean(),
  canCancelLeave: z.boolean(),
  canDisband: z.boolean(),
  canEnableDisbanding: z.boolean(),
  members: z.array(
    z.object({
      id: z.string(),
      npub: z.string(),
      name: z.string().nullish(),
      self: z.boolean(),
      admin: z.boolean(),
      devices: z.number(),
      canPromote: z.boolean(),
      canRemove: z.boolean(),
      canDemote: z.boolean(),
    }),
  ),
});

export type MarmotChatRow = z.infer<typeof chatRow>;
export type MarmotMessage = z.infer<typeof message>;
export type MarmotChatList = z.infer<typeof chatListSnapshot>;
export type MarmotConversation = z.infer<typeof conversationSnapshot>;
export type MarmotReadiness = z.infer<typeof readiness>;
export type MarmotChatView = "chats" | "unread" | "archived" | "left";
export type MarmotGroupDetails = z.infer<typeof groupDetails>;
export type MarmotMemberOutcome = z.infer<typeof memberOutcome>;
type MemberAction = "promote" | "demote" | "remove";
type MembershipAction =
  "leave" | "cancelLeave" | "forget" | "disband" | "enableDisbanding";
export type MarmotUpload = {
  path: string;
  name: string;
  type: string;
  dimensions?: string;
  thumbhash?: string;
};
const handoff = z.object({
  lease: z.string(),
  path: z.string(),
  type: z.string(),
  name: z.string(),
});
const deviceState = z.object({
  state: z.string().nullish(),
  code: z.array(z.string()),
  stalled: z.boolean(),
  prompts: z.array(
    z.object({ id: z.string(), state: z.string(), code: z.array(z.string()) }),
  ),
  progress: z.array(
    z.object({ slot: z.string(), remaining: z.number(), total: z.number() }),
  ),
  devices: z.array(
    z.object({
      slot: z.string(),
      current: z.boolean(),
      label: z.string(),
      platform: z.string(),
      client: z.string(),
    }),
  ),
});
export type MarmotDeviceState = z.infer<typeof deviceState>;
export type MarmotDeviceAction =
  "start" | "match" | "cancel" | "link" | "decline" | "remove";

type Events = {
  windowChanged: (event: { id: string; snapshot: unknown }) => void;
  windowClosed: (event: { id: string; code: string }) => void;
};

type Bridge = {
  addListener<Event extends keyof Events>(
    name: Event,
    listener: Events[Event],
  ): { remove(): void };
  openAccount(
    key: string,
    secret: string,
    nsec: string,
    general: readonly string[],
    inbox: readonly string[],
    discovery: readonly string[],
  ): Promise<unknown>;
  closeAccount(): Promise<void>;
  accountReadiness(): Promise<unknown>;
  openChatList(id: string, view: MarmotChatView): Promise<unknown>;
  openAttention(id: string): Promise<unknown>;
  openConversation(
    id: string,
    group: string,
    target: string | null,
  ): Promise<unknown>;
  observeWindow(id: string): Promise<void>;
  closeWindow(id: string): Promise<void>;
  pageWindow(
    id: string,
    generation: string,
    sequence: string,
    direction: string,
  ): Promise<unknown>;
  anchorWindow(
    id: string,
    generation: string,
    sequence: string,
    target: string,
  ): Promise<unknown>;
  jumpToMessage(
    id: string,
    generation: string,
    sequence: string,
    target: string,
  ): Promise<unknown>;
  startDirect(peer: string): Promise<string>;
  createGroup(
    name: string,
    description: string | null,
    members: string[],
  ): Promise<unknown>;
  respondToInvitation(group: string, accept: boolean): Promise<void>;
  groupDetails(group: string): Promise<unknown>;
  updateGroup(
    group: string,
    name: string | null,
    description: string | null,
  ): Promise<void>;
  updateRetention(group: string, seconds: number): Promise<void>;
  inviteMembers(group: string, members: string[]): Promise<unknown>;
  changeMember(
    group: string,
    member: string,
    action: MemberAction,
  ): Promise<void>;
  changeMembership(group: string, action: MembershipAction): Promise<void>;
  sendText(
    group: string,
    text: string,
    token: string,
    reply: string | null,
  ): Promise<string>;
  saveDraft(group: string, text: string, reply: string | null): Promise<void>;
  sendSpecial(
    group: string,
    kind: 24881 | 24883,
    body: string,
    reply: string | null,
  ): Promise<void>;
  sendMedia(
    group: string,
    files: MarmotUpload[],
    caption: string | null,
    token: string,
    server: string | null,
    reply: string | null,
  ): Promise<string>;
  downloadAttachment(
    group: string,
    id: string,
    source: string,
    index: number,
  ): Promise<void>;
  openAttachment(
    group: string,
    id: string,
    source: string,
    index: number,
  ): Promise<unknown>;
  releaseAttachment(lease: string): Promise<void>;
  storageUsage(): Promise<number>;
  clearDownloads(): Promise<void>;
  editMessage(group: string, id: string, content: string): Promise<void>;
  deleteMessage(group: string, id: string): Promise<void>;
  reactToMessage(
    group: string,
    id: string,
    emoji: string,
    remove: boolean,
  ): Promise<void>;
  markRead(group: string, id: string): Promise<void>;
  setArchived(group: string, archived: boolean): Promise<void>;
  setPinned(group: string, pinned: boolean): Promise<void>;
  setMuted(group: string, muted: boolean): Promise<void>;
  setBlocked(key: string, blocked: boolean): Promise<void>;
  retryConversation(group: string): Promise<void>;
  createPoll(
    group: string,
    question: string,
    options: string[],
    multiple: boolean,
    expiresAt: number | null,
  ): Promise<void>;
  vote(group: string, id: string, choice: string[]): Promise<void>;
  deviceState(): Promise<unknown>;
  deviceAction(
    action: MarmotDeviceAction,
    target: string | null,
    label: string | null,
    allChats: boolean,
    history: boolean,
  ): Promise<void>;
};

type Revision = z.infer<typeof windowRevision>;
type WindowState<S> =
  { status: "ready"; snapshot: S } | { status: "closed"; code: string };

export type MarmotWindow<S, Direction> = {
  getState(): WindowState<S>;
  subscribe(listener: () => void): () => void;
  page(direction: Direction): Promise<void>;
  anchor(target: string): Promise<void>;
  jump(target: string): Promise<void>;
  close(): Promise<void>;
};

const native = () => requireNativeModule<Bridge>("BoopMarmot");

export async function openMarmotAccount(
  key: string,
  secret: string,
  relays: RelayConfiguration,
) {
  const bytes = hexToBytes(secret);
  try {
    if (getPublicKey(bytes) !== key) throw new Error("IdentityMismatch");
    return readiness.parse(
      await native().openAccount(
        key,
        secret,
        nip19.nsecEncode(bytes),
        relays.general,
        relays.inbox,
        relays.discovery,
      ),
    );
  } finally {
    bytes.fill(0);
  }
}

async function openWindow<S extends Revision, Direction extends string>(
  open: (bridge: Bridge, id: string) => Promise<unknown>,
  schema: z.ZodType<S>,
): Promise<MarmotWindow<S, Direction>> {
  const bridge = native();
  const id = randomUUID();
  const listeners = new Set<() => void>();
  let state: WindowState<S> = { status: "closed", code: "WindowClosed" };
  let closing: Promise<void> | undefined;
  const changed = bridge.addListener("windowChanged", (event) => {
    if (event.id !== id) return;
    try {
      install(event.snapshot);
    } catch {
      terminate("InvalidWindowProjection");
    }
  });
  const closed = bridge.addListener("windowClosed", (event) => {
    if (event.id === id) terminate(event.code);
  });

  function emit() {
    for (const listener of listeners) listener();
  }
  function install(value: unknown) {
    if (state.status !== "ready") return;
    const next = schema.parse(value);
    const current = state.snapshot;
    if (next.generation !== current.generation) {
      terminate("WindowGenerationChanged");
      return;
    }
    if (BigInt(next.sequence) <= BigInt(current.sequence)) return;
    state = { status: "ready", snapshot: next };
    emit();
  }
  function close() {
    changed.remove();
    closed.remove();
    closing ??= bridge.closeWindow(id);
    return closing;
  }
  function terminate(code: string) {
    if (state.status === "closed") return;
    state = { status: "closed", code };
    void close().catch(() => undefined);
    emit();
  }
  async function command(
    run: (id: string, generation: string, sequence: string) => Promise<unknown>,
  ) {
    if (state.status !== "ready") return;
    const { generation, sequence } = state.snapshot;
    install(await run(id, generation, sequence));
  }
  try {
    state = { status: "ready", snapshot: schema.parse(await open(bridge, id)) };
    await bridge.observeWindow(id);
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    page: (direction) =>
      command((...revision) => bridge.pageWindow(...revision, direction)),
    anchor: (target) =>
      command((...revision) => bridge.anchorWindow(...revision, target)),
    jump: (target) =>
      command((...revision) => bridge.jumpToMessage(...revision, target)),
    close() {
      terminate("WindowClosed");
      return close();
    },
  };
}

export const marmot = {
  async getReadiness() {
    return readiness.parse(await native().accountReadiness());
  },
  closeAccount: () => native().closeAccount(),
  openChatList: (view: MarmotChatView) =>
    openWindow<MarmotChatList, "forward" | "backward">(
      (bridge, id) => bridge.openChatList(id, view),
      chatListSnapshot,
    ),
  openAttention: () =>
    openWindow<z.infer<typeof attentionSnapshot>, never>(
      (bridge, id) => bridge.openAttention(id),
      attentionSnapshot,
    ),
  openConversation: (group: string, target?: string) =>
    openWindow<MarmotConversation, "older" | "newer">(
      (bridge, id) => bridge.openConversation(id, group, target ?? null),
      conversationSnapshot,
    ),
  startDirect: (peer: string) => native().startDirect(peer),
  async createGroup(
    name: string,
    description: string | null,
    members: string[],
  ) {
    return groupCreation.parse(
      await native().createGroup(name, description, members),
    );
  },
  respondToInvitation: (group: string, accept: boolean) =>
    native().respondToInvitation(group, accept),
  async groupDetails(group: string) {
    return groupDetails.parse(await native().groupDetails(group));
  },
  updateGroup: (
    group: string,
    name: string | null,
    description: string | null,
  ) => native().updateGroup(group, name, description),
  updateRetention: (group: string, seconds: number) =>
    native().updateRetention(
      group,
      z.number().int().min(0).max(2_147_483_647).parse(seconds),
    ),
  async inviteMembers(group: string, members: string[]) {
    return z
      .array(memberOutcome)
      .parse(await native().inviteMembers(group, members));
  },
  changeMember: (group: string, member: string, action: MemberAction) =>
    native().changeMember(group, member, action),
  changeMembership: (group: string, action: MembershipAction) =>
    native().changeMembership(group, action),
  sendText: (
    group: string,
    text: string,
    token: string,
    reply: string | null,
  ) => native().sendText(group, text, token, reply),
  saveDraft: (group: string, text: string, reply: string | null) =>
    native().saveDraft(group, text, reply),
  sendSpecial: (
    group: string,
    kind: 24881 | 24883,
    body: string,
    reply: string | null,
  ) => native().sendSpecial(group, kind, body, reply),
  sendMedia: (
    group: string,
    files: MarmotUpload[],
    caption: string | null,
    token: string,
    server: string | null,
    reply: string | null,
  ) => native().sendMedia(group, files, caption, token, server, reply),
  downloadAttachment: (
    group: string,
    id: string,
    source: string,
    index: number,
  ) => native().downloadAttachment(group, id, source, index),
  async openAttachment(
    group: string,
    id: string,
    source: string,
    index: number,
  ) {
    return handoff
      .nullish()
      .parse(await native().openAttachment(group, id, source, index));
  },
  releaseAttachment: (lease: string) => native().releaseAttachment(lease),
  storageUsage: () => native().storageUsage(),
  clearDownloads: () => native().clearDownloads(),
  editMessage: (group: string, id: string, content: string) =>
    native().editMessage(group, id, content),
  deleteMessage: (group: string, id: string) =>
    native().deleteMessage(group, id),
  reactToMessage: (group: string, id: string, emoji: string, remove: boolean) =>
    native().reactToMessage(group, id, emoji, remove),
  markRead: (group: string, id: string) => native().markRead(group, id),
  setArchived: (group: string, archived: boolean) =>
    native().setArchived(group, archived),
  setPinned: (group: string, pinned: boolean) =>
    native().setPinned(group, pinned),
  setMuted: (group: string, muted: boolean) => native().setMuted(group, muted),
  setBlocked: (key: string, blocked: boolean) =>
    native().setBlocked(key, blocked),
  retryConversation: (group: string) => native().retryConversation(group),
  createPoll: (
    group: string,
    question: string,
    options: string[],
    multiple: boolean,
    expiresAt: number | null,
  ) => native().createPoll(group, question, options, multiple, expiresAt),
  vote: (group: string, id: string, choice: string[]) =>
    native().vote(group, id, choice),
  async deviceState() {
    return deviceState.parse(await native().deviceState());
  },
  deviceAction: (
    action: MarmotDeviceAction,
    target: string | null = null,
    label: string | null = null,
    allChats = false,
    history = false,
  ) => native().deviceAction(action, target, label, allChats, history),
};
