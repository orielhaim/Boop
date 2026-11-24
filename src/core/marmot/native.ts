import { randomUUID } from "expo-crypto";
import { requireNativeModule } from "expo-modules-core";
import { z } from "zod";
import { mediaUploadArguments } from "./media-send";

export type MarmotRelays = {
  general: readonly string[];
  inbox: readonly string[];
  discovery: readonly string[];
};

const accountRelayLists = z.object({
  general: z.array(z.string()),
  write: z.array(z.string()),
  inbox: z.array(z.string()),
  bootstrap: z.array(z.string()),
  allowed: z.array(z.string()),
  retiredHosts: z.array(z.string()),
});
export type MarmotRelayLists = z.infer<typeof accountRelayLists>;

const relayLiveness = z.object({
  url: z.string(),
  status: z.enum(["unknown", "connecting", "connected", "offline"]),
  lastError: z.string().nullish(),
  lastAttempt: z.number().nullish(),
});
export type MarmotRelayLiveness = z.infer<typeof relayLiveness>;

const windowRevision = z.object({
  generation: z.string(),
  sequence: z.string().regex(/^\d{1,20}$/),
  hasMoreBefore: z.boolean(),
  hasMoreAfter: z.boolean(),
});
const identifiedRow = z.looseObject({ id: z.string() });
const windowDelta = z.object({
  base: windowRevision.shape.sequence,
  field: z.enum(["rows", "messages"]),
  metadata: windowRevision.loose(),
  order: z.array(z.string()).max(200),
  changed: z.array(identifiedRow).max(200),
});
const avatarAsset = z.object({
  target: z.string(),
  reference: z.string().nullish(),
  revision: windowRevision.shape.sequence,
  availability: z.enum(["missing", "ready", "stale", "invalidated"]),
});
export type MarmotAvatarAsset = z.infer<typeof avatarAsset>;

const chatRow = z.object({
  id: z.string(),
  title: z.string().nullish(),
  peer: z.string().nullish(),
  image: z.string().nullish(),
  avatarAsset: avatarAsset.nullish(),
  kind: z.enum(["unknown", "direct", "group"]),
  lifecycle: z.string(),
  membership: z.string(),
  invited: z.boolean(),
  pinned: z.boolean(),
  muted: z.boolean(),
  archived: z.boolean(),
  unread: z.number().nonnegative(),
  manualUnread: z.boolean(),
  updatedAt: z.number().nonnegative(),
  preview: z.string().nullish(),
  previewKind: z.number().nullish(),
  previewId: z.string().nullish(),
  previewSender: z.string().nullish(),
  draft: z.string().nullish(),
});

const message = z.object({
  id: z.string(),
  token: z.string().nullish(),
  sender: z.string(),
  text: z.string(),
  sentAt: z.number().nonnegative(),
  expiresAt: z.number().nonnegative().nullish(),
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
      plaintextHash: z
        .string()
        .regex(/^[0-9a-f]{64}$/i)
        .nullish(),
      dimensions: z.string().nullish(),
      size: z.number().nonnegative().nullish(),
      duration: z.number().positive().nullish(),
      waveform: z.array(z.number().int().min(0).max(31)).max(64).nullish(),
      round: z.boolean().optional(),
      voice: z.boolean().optional(),
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
const groupStateSnapshot = windowRevision.extend({
  kind: z.literal("groupState"),
});
const groupCallSnapshot = windowRevision.extend({
  kind: z.literal("groupCall"),
  announcements: z
    .array(
      z.object({
        text: z.string(),
        sender: z.string(),
        sentAt: z.number(),
        invalidated: z.boolean(),
      }),
    )
    .max(64),
});
const conversationSnapshot = windowRevision.extend({
  kind: z.literal("conversation"),
  title: z.string().nullish(),
  peer: z.string().nullish(),
  image: z.string().nullish(),
  avatarAsset: avatarAsset.nullish(),
  lifecycle: z.string(),
  memberCount: z.number().nullish(),
  invited: z.boolean(),
  authorityReady: z.boolean(),
  canSend: z.boolean(),
  firstUnread: z.string().nullish(),
  draft: z
    .object({
      text: z.string(),
      replyTo: z.string().nullish(),
      attachments: z
        .array(
          z.object({
            id: z.string(),
            size: z.number().int().positive(),
            duration: z.number().positive().nullish(),
            waveform: z
              .array(z.number().int().min(0).max(31))
              .max(64)
              .optional(),
          }),
        )
        .max(64),
    })
    .nullish(),
  identities: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      avatarAsset: avatarAsset.nullish(),
    }),
  ),
  messages: z.array(message).max(200),
});

const readiness = z.enum([
  "initializing",
  "local_ready",
  "publishing",
  "network_ready",
  "recovery_required",
]);
const accountKey = z.string().regex(/^[0-9a-f]{64}$/);
const account = z.object({
  key: accountKey,
  readiness,
  signedOut: z.boolean(),
  unlinked: z.boolean(),
});
const onboardingStep = z.enum([
  "profile",
  "follows",
  "relays",
  "inbox_relays",
  "single_device",
  "key_package",
]);
const onboardingSnapshot = z.object({
  ready: z.boolean(),
  revision: z.string().regex(/^\d+$/),
  epoch: z.string().nullish(),
  proposal: z
    .object({
      read: z.array(z.string()),
      write: z.array(z.string()),
      inconclusive: z.boolean(),
    })
    .nullish(),
  deviceNotice: z
    .object({ discovery: z.string(), complete: z.boolean() })
    .nullish(),
  steps: z.array(
    z.object({
      step: onboardingStep,
      actions: z.array(z.string()),
      status: z.enum([
        "pending",
        "checking",
        "passed",
        "needs_input",
        "retryable_failure",
        "waiting_for_signer",
        "skipped",
      ]),
    }),
  ),
});
export type MarmotAccount = z.infer<typeof account>;
export type MarmotOnboarding = z.infer<typeof onboardingSnapshot>;
export type OnboardingAction =
  | { action: "read" | "run" | "recover" | "cancel" | "cancelRepair" }
  | {
      action: "retry" | "skip" | "propose";
      step: z.infer<typeof onboardingStep>;
    }
  | { action: "approve" | "acknowledge"; displayed: MarmotOnboarding };
export type IdentityInput =
  { name: string; about: string } | { importToken: string };

const backupState = z.object({
  enabled: z.boolean(),
  thisDeviceWrites: z.boolean(),
  phase: z.enum([
    "idle",
    "discovering",
    "restoring",
    "complete",
    "partial",
    "unavailable",
    "cancelled",
  ]),
  operation: z.string().nullish(),
  imported: z.number(),
  failed: z.number(),
});
const recoveryWords = z.object({
  words: z.array(z.string()),
  positions: z.tuple([
    z.number().positive().int(),
    z.number().positive().int(),
  ]),
});
export type MarmotBackupState = z.infer<typeof backupState>;
export type MarmotRecoveryWords = z.infer<typeof recoveryWords>;
type BackupAction =
  "confirm" | "cancel" | "disable" | "restore" | "cancelRestore";
const memberOutcome = z.object({
  account: z.string(),
  status: z.string(),
  devices: z.number(),
});
const groupCreation = z.object({
  groupId: z.string().nullish(),
  members: z.array(memberOutcome),
});
const searchResult = z.object({
  id: z.string(),
  sender: z.string(),
  text: z.string(),
  sentAt: z.number(),
});
const editHistory = z.object({
  more: z.boolean(),
  versions: z
    .array(z.object({ id: z.string(), text: z.string(), at: z.number() }))
    .max(25),
});
export type MarmotSearchResult = z.infer<typeof searchResult>;
export type MarmotEditHistory = z.infer<typeof editHistory>;
const groupDetails = z.object({
  avatarAsset: avatarAsset.nullish(),
  id: z.string(),
  name: z.string(),
  description: z.string(),
  inviter: z.string().nullish(),
  image: z.string().nullish(),
  epoch: z.string(),
  mediaV2: z.boolean(),
  mediaEndpoints: z.array(z.string()),
  unrecoverable: z.boolean(),
  convergenceParked: z.boolean(),
  historyIncomplete: z.boolean(),
  relayChangesOutstanding: z.number().nonnegative(),
  relays: z.array(z.string()),
  membership: z.string(),
  pendingInvitation: z.boolean(),
  kind: z.string().nullish(),
  pendingLeave: z.boolean(),
  leaveBlocked: z.boolean(),
  createdAt: z.number().nullish(),
  muted: z.boolean(),
  archived: z.boolean(),
  canEdit: z.boolean(),
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
  duration?: string;
  waveform?: string;
  presentation?: "voice" | "round";
};
const handoff = z.object({
  lease: z.string(),
  path: z.string(),
  type: z.string(),
  name: z.string(),
});
const uploadReceipt = z.object({
  id: z.string(),
  blobs: z
    .array(
      z.object({
        url: z.string(),
        hash: z.string().regex(/^[a-f0-9]{64}$/),
        size: z.number().int().positive(),
      }),
    )
    .max(16),
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
      removalPending: z.boolean(),
    }),
  ),
});
export type MarmotDeviceState = z.infer<typeof deviceState>;
export type MarmotDeviceAction =
  "start" | "match" | "cancel" | "link" | "decline" | "remove";

const optionalText = z
  .string()
  .nullish()
  .transform((value) => value ?? undefined);
const publicProfile = z.object({
  key: accountKey,
  name: optionalText,
  displayName: optionalText,
  about: optionalText,
  picture: optionalText,
  banner: optionalText,
  nip05: optionalText,
  lud16: optionalText,
  website: optionalText,
  bot: z.boolean(),
});
export type MarmotPublicProfile = z.output<typeof publicProfile>;
export type MarmotProfileEdits = Partial<
  Record<
    | "display_name"
    | "name"
    | "about"
    | "picture"
    | "banner"
    | "nip05"
    | "lud16"
    | "website",
    string
  >
>;

const directoryResult = z.object({
  key: accountKey,
  profile: publicProfile.nullish(),
});
type Events = {
  relayLiveness: (event: { id: string; rows: unknown }) => void;
  directorySearchResults: (event: { id: string; rows: unknown }) => void;
  attachmentProgress: (event: {
    transfer: string;
    received: number;
    total?: number | null;
    state: string;
  }) => void;
  windowChanged: (event: {
    id: string;
    snapshot?: unknown;
    delta?: unknown;
  }) => void;
  windowClosed: (event: { id: string; code: string }) => void;
};

type Bridge = {
  addListener<Event extends keyof Events>(
    name: Event,
    listener: Events[Event],
  ): { remove(): void };
  listAccounts(
    general: readonly string[],
    discovery: readonly string[],
    mediaOrigin: string | null,
  ): Promise<unknown>;
  prepareIdentityImport(
    token: string,
    input: string,
    password: string,
  ): Promise<string>;
  discardIdentityImport(token: string): Promise<void>;
  installAccount(
    token: string | null,
    name: string | null,
    about: string | null,
    general: readonly string[],
    inbox: readonly string[],
    discovery: readonly string[],
  ): Promise<unknown>;
  accountOnboarding(
    key: string,
    action: string,
    step: string | null,
    revision: string | null,
    epoch: string | null,
  ): Promise<unknown>;
  selectSigner(key: string): Promise<unknown>;
  accountNetworkReady(key: string): Promise<boolean>;
  requestAvatarAssets(targets: string[]): Promise<unknown>;
  readAvatarAssets(references: string[]): Promise<unknown>;
  clearMarmotAvatarCache(owner: string): Promise<void>;
  readProfiles(owner: string, keys: string[]): Promise<unknown>;
  refreshPublicProfile(
    owner: string,
    key: string,
    relays: readonly string[],
  ): Promise<void>;
  updatePublicProfile(owner: string, fields: MarmotProfileEdits): Promise<void>;
  cachedDirectorySearch(owner: string, query: string): Promise<unknown>;
  normalizeDirectoryIdentity(
    owner: string,
    reference: string,
  ): Promise<unknown>;
  prepareObservation(id: string): boolean;
  searchDirectory(owner: string, id: string, query: string): Promise<void>;
  cancelObservation(id: string): void;
  removeAccount(key: string): Promise<void>;
  signInAccount(key: string): Promise<void>;
  signOutAccount(key: string): Promise<void>;
  resumeAccountSetup(): Promise<void>;
  openAccount(
    key: string,
    general: readonly string[],
    discovery: readonly string[],
    mediaOrigin: string | null,
  ): Promise<unknown>;
  signNostrEvent(key: string, event: string): Promise<string>;
  nostrCipher(
    key: string,
    peer: string,
    value: string,
    nip44: boolean,
    encrypt: boolean,
  ): Promise<string>;
  exportIdentity(key: string, password: string | null): Promise<string>;
  shutdownRuntime(): Promise<void>;
  closeAccount(pauseMessaging: boolean): Promise<void>;
  catchUp(): Promise<void>;
  notifyConnectivityRestored(): Promise<void>;
  accountRelayLists(key: string): Promise<unknown>;
  refreshAccountRelayLists(key: string, urls: readonly string[]): Promise<void>;
  classifyRelays(key: string, urls: readonly string[]): Promise<unknown>;
  setAccountRelays(
    key: string,
    inbox: boolean,
    urls: readonly string[],
    bootstrap: readonly string[],
  ): Promise<void>;
  reconnectMarmotRelay(url: string): Promise<void>;
  watchRelayLiveness(key: string, id: string): Promise<void>;
  backupState(): Promise<unknown>;
  beginBackup(): Promise<unknown>;
  backupAction(action: BackupAction, words: string[]): Promise<void>;
  backupConditions(wifi: boolean, charging: boolean): Promise<void>;
  backupNow(): Promise<string>;
  openChatList(
    id: string,
    view: MarmotChatView,
    invitations: boolean,
    search: string | null,
  ): Promise<unknown>;
  openAttention(id: string): Promise<unknown>;
  openGroupState(id: string, group: string): Promise<unknown>;
  openGroupCall(id: string, group: string): Promise<unknown>;
  openConversation(
    id: string,
    group: string,
    target: string | null,
  ): Promise<unknown>;
  observeWindow(id: string): Promise<void>;
  closeWindow(id: string): Promise<void>;
  windowSnapshot(id: string): Promise<unknown>;
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
  checkInvitee(peer: string): Promise<void>;
  createGroup(
    name: string,
    description: string | null,
    members: string[],
    image: string | null,
  ): Promise<unknown>;
  respondToInvitation(group: string, accept: boolean): Promise<void>;
  groupDetails(group: string): Promise<unknown>;
  viewGroupImage(group: string, hash: string): Promise<string>;
  updateGroupImage(group: string, path: string | null): Promise<void>;
  updateGroupMedia(group: string, origins: string[]): Promise<void>;
  searchConversation(
    group: string,
    text: string | null,
    media: boolean,
  ): Promise<unknown>;
  editHistory(
    group: string,
    message: string,
    before: number | null,
    id: string | null,
  ): Promise<unknown>;
  updateGroup(
    group: string,
    name: string | null,
    description: string | null,
  ): Promise<void>;
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
  stageMediaDraft(
    group: string,
    files: ReturnType<typeof mediaUploadArguments>,
    caption: string,
    token: string,
    reply: string | null,
  ): Promise<void>;
  discardMediaDraft(group: string): Promise<void>;
  sendSpecial(
    group: string,
    kind: 24881 | 24883 | 24884,
    body: string,
    reply: string | null,
  ): Promise<void>;
  sendMedia(
    group: string,
    files: ReturnType<typeof mediaUploadArguments>,
    caption: string | null,
    token: string,
    server: string | null,
    reply: string | null,
  ): Promise<unknown>;
  cancelUpload(token: string): Promise<boolean>;
  attachmentStatus(
    group: string,
    id: string,
    source: string,
    index: number,
  ): Promise<boolean>;
  audioMetadata(path: string): Promise<unknown>;
  inspectMediaFile(
    path: string,
    image: boolean,
    poster: boolean,
  ): Promise<unknown>;
  registerAttachmentTransfer(transfer: string): void;
  interruptAttachmentTransfer(
    group: string,
    id: string,
    source: string,
    index: number,
    transfer: string,
  ): Promise<void>;
  downloadAttachment(
    group: string,
    id: string,
    source: string,
    index: number,
    transfer: string,
  ): Promise<string>;
  attachmentTransferState(
    group: string,
    id: string,
    source: string,
    index: number,
  ): Promise<string | null>;
  controlAttachment(
    group: string,
    id: string,
    source: string,
    index: number,
    action: "cancel" | "remove",
  ): Promise<boolean>;
  openAttachment(
    group: string,
    id: string,
    source: string,
    index: number,
  ): Promise<unknown>;
  releaseAttachment(lease: string): Promise<void>;
  storageUsage(): Promise<number>;
  clearDownloads(): Promise<void>;
  retainedAttachmentBytes(
    group: string,
    id: string,
    source: string,
    index: number,
  ): Promise<number | null>;
  recentVoiceNotes(
    sender: string,
    since: number,
    onlyOutgoing: boolean,
  ): Promise<unknown>;
  editMessage(group: string, id: string, content: string): Promise<void>;
  deleteMessage(group: string, id: string): Promise<void>;
  reportMessage(group: string, id: string, spam: boolean): Promise<void>;
  reactToMessage(
    group: string,
    id: string,
    emoji: string,
    remove: boolean,
  ): Promise<void>;
  markRead(group: string, id: string): Promise<void>;
  markUnread(group: string): Promise<void>;
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

export const marmotDirectory = {
  async read(owner: string, keys: string[]) {
    return publicProfile
      .array()
      .parse(await native().readProfiles(owner, keys));
  },
  refresh(owner: string, key: string, relays: readonly string[]) {
    return native().refreshPublicProfile(owner, key, relays);
  },
  update(owner: string, edits: MarmotProfileEdits) {
    return native().updatePublicProfile(owner, edits);
  },
  async normalize(owner: string, reference: string) {
    return accountKey
      .nullish()
      .parse(await native().normalizeDirectoryIdentity(owner, reference));
  },
  async searchCached(owner: string, query: string) {
    return directoryResult
      .array()
      .parse(await native().cachedDirectorySearch(owner, query));
  },
  async search(
    owner: string,
    id: string,
    query: string,
    signal: AbortSignal,
    receive: (rows: z.infer<typeof directoryResult>[]) => void,
  ) {
    if (signal.aborted) return;
    const bridge = native();
    if (!bridge.prepareObservation(id))
      throw new Error("Directory search unavailable");
    const listener = bridge.addListener("directorySearchResults", (event) => {
      if (event.id !== id || signal.aborted) return;
      const rows = directoryResult.array().safeParse(event.rows);
      if (rows.success) receive(rows.data);
    });
    const cancel = () => bridge.cancelObservation(id);
    signal.addEventListener("abort", cancel, { once: true });
    try {
      await bridge.searchDirectory(owner, id, query);
    } finally {
      listener.remove();
      signal.removeEventListener("abort", cancel);
      cancel();
    }
  },
};

export const marmotRelays = {
  refresh: (key: string, urls: readonly string[]) =>
    native().refreshAccountRelayLists(key, urls),
  async read(key: string) {
    return accountRelayLists.parse(await native().accountRelayLists(key));
  },
  async classify(key: string, urls: readonly string[]) {
    return z
      .array(z.enum(["allowed", "retired", "unsafe", "invalid"]))
      .parse(await native().classifyRelays(key, urls));
  },
  set(
    key: string,
    list: "general" | "inbox",
    urls: readonly string[],
    bootstrap: readonly string[],
  ) {
    return native().setAccountRelays(key, list === "inbox", urls, bootstrap);
  },
  reconnect: (url: string) => native().reconnectMarmotRelay(url),
  observe(
    key: string,
    receive: (rows: MarmotRelayLiveness[]) => void,
    ended: () => void,
  ) {
    const bridge = native();
    const id = randomUUID();
    const listener = bridge.addListener("relayLiveness", (event) => {
      if (event.id === id) receive(relayLiveness.array().parse(event.rows));
    });
    let closed = false;
    const close = () => {
      closed = true;
      listener.remove();
      bridge.cancelObservation(id);
    };
    try {
      if (!bridge.prepareObservation(id)) throw new Error("AccountBusy");
      void bridge
        .watchRelayLiveness(key, id)
        .catch(() => undefined)
        .finally(() => {
          listener.remove();
          if (!closed) ended();
        });
      return close;
    } catch (error) {
      close();
      throw error;
    }
  },
};

export const marmotAccounts = {
  async prepareImport(token: string, input: string, password: string) {
    return accountKey.parse(
      await native().prepareIdentityImport(token, input, password),
    );
  },
  discardImport: (token: string) => native().discardIdentityImport(token),
  async list({ general, discovery }: MarmotRelays, mediaOrigin: string | null) {
    return account
      .array()
      .parse(await native().listAccounts(general, discovery, mediaOrigin));
  },
  async install(
    input: IdentityInput,
    { general, inbox, discovery }: MarmotRelays,
  ) {
    const key =
      "importToken" in input
        ? await native().installAccount(
            input.importToken,
            null,
            null,
            general,
            inbox,
            discovery,
          )
        : await native().installAccount(
            null,
            input.name,
            input.about,
            general,
            inbox,
            discovery,
          );
    return accountKey.parse(key);
  },
  async open(
    key: string,
    { general, discovery }: Omit<MarmotRelays, "inbox">,
    mediaOrigin: string | null,
  ) {
    return readiness.parse(
      await native().openAccount(key, general, discovery, mediaOrigin),
    );
  },
  async onboarding(key: string, command: OnboardingAction) {
    const displayed = "displayed" in command ? command.displayed : undefined;
    return (
      onboardingSnapshot
        .nullish()
        .parse(
          await native().accountOnboarding(
            key,
            command.action,
            "step" in command ? command.step : null,
            displayed?.revision ?? null,
            displayed?.epoch ?? null,
          ),
        ) ?? null
    );
  },
  async selectSigner(key: string) {
    return z
      .object({ name: z.string().nullish(), about: z.string().nullish() })
      .parse(await native().selectSigner(key));
  },
  networkReady: (key: string) => native().accountNetworkReady(key),
  remove: (key: string) => native().removeAccount(key),
  signIn: (key: string) => native().signInAccount(key),
  signOut: (key: string) => native().signOutAccount(key),
  resumeSetup: () => native().resumeAccountSetup(),
  shutdown: () => native().shutdownRuntime(),
  export: (key: string, password: string | null) =>
    native().exportIdentity(key, password),
  sign: (key: string, event: string) => native().signNostrEvent(key, event),
  cipher: (
    key: string,
    peer: string,
    value: string,
    nip44: boolean,
    encrypt: boolean,
  ) => native().nostrCipher(key, peer, value, nip44, encrypt),
};

async function openWindow<S extends Revision, Direction extends string>(
  open: (bridge: Bridge, id: string) => Promise<unknown>,
  schema: z.ZodType<S>,
): Promise<MarmotWindow<S, Direction>> {
  const bridge = native();
  const id = randomUUID();
  const listeners = new Set<() => void>();
  let state: WindowState<S> = { status: "closed", code: "WindowClosed" };
  let closing: Promise<void> | undefined;
  let wantedSequence = 0n;
  let resyncing = false;
  const changed = bridge.addListener("windowChanged", (event) => {
    if (event.id !== id) return;
    try {
      if (event.delta !== undefined) applyDelta(event.delta);
      else install(event.snapshot);
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
  function applyDelta(value: unknown) {
    if (state.status !== "ready") return;
    const delta = windowDelta.parse(value);
    const current = state.snapshot;
    if (delta.metadata.generation !== current.generation) {
      terminate("WindowGenerationChanged");
      return;
    }
    if (BigInt(delta.metadata.sequence) <= BigInt(current.sequence)) return;
    if (delta.base !== current.sequence) {
      wantedSequence = BigInt(delta.metadata.sequence);
      refresh();
      return;
    }
    const prior =
      delta.field === "rows" && "rows" in current
        ? current.rows
        : delta.field === "messages" && "messages" in current
          ? current.messages
          : undefined;
    const rows = z.array(identifiedRow).max(200).parse(prior);
    const indexed = new Map(
      [...rows, ...delta.changed].map((row) => [row.id, row]),
    );
    install({
      ...delta.metadata,
      [delta.field]: delta.order.map((id) => indexed.get(id)),
    });
  }
  function refresh() {
    if (resyncing || state.status !== "ready") return;
    resyncing = true;
    void bridge
      .windowSnapshot(id)
      .then((next) => {
        install(next);
        if (
          state.status === "ready" &&
          BigInt(state.snapshot.sequence) < wantedSequence
        )
          terminate("WindowGenerationChanged");
      })
      .catch(() => terminate("WindowClosed"))
      .finally(() => {
        resyncing = false;
      });
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

const avatarRead = z.object({
  reference: z.string(),
  revision: windowRevision.shape.sequence,
  availability: avatarAsset.shape.availability,
  deferred: z.boolean(),
  uri: z.string().startsWith("data:image/").nullish(),
});
export const marmot = {
  async requestAvatarAssets(targets: string[]) {
    return avatarAsset
      .array()
      .parse(await native().requestAvatarAssets(targets));
  },
  async readAvatarAssets(references: string[]) {
    return avatarRead
      .array()
      .parse(await native().readAvatarAssets(references));
  },
  clearAvatarCache: (owner: string) => native().clearMarmotAvatarCache(owner),
  async backupState() {
    return backupState.parse(await native().backupState());
  },
  async beginBackup() {
    return recoveryWords.parse(await native().beginBackup());
  },
  backupAction: (action: BackupAction, words: string[] = []) =>
    native().backupAction(action, words),
  backupConditions: (wifi: boolean, charging: boolean) =>
    native().backupConditions(wifi, charging),
  backupNow: () => native().backupNow(),
  closeAccount: (pauseMessaging = false) =>
    native().closeAccount(pauseMessaging),
  catchUp: () => native().catchUp(),
  notifyConnectivityRestored: () => native().notifyConnectivityRestored(),
  openChatList: (
    view: MarmotChatView,
    options?: { invitations?: boolean; search?: string },
  ) =>
    openWindow<MarmotChatList, "forward" | "backward">(
      (bridge, id) =>
        bridge.openChatList(
          id,
          view,
          options?.invitations ?? false,
          options?.search?.trim().slice(0, 128) || null,
        ),
      chatListSnapshot,
    ),
  openAttention: () =>
    openWindow<z.infer<typeof attentionSnapshot>, never>(
      (bridge, id) => bridge.openAttention(id),
      attentionSnapshot,
    ),
  openGroupState: (group: string) =>
    openWindow<z.infer<typeof groupStateSnapshot>, never>(
      (bridge, id) => bridge.openGroupState(id, group),
      groupStateSnapshot,
    ),
  openGroupCall: (group: string) =>
    openWindow<z.infer<typeof groupCallSnapshot>, never>(
      (bridge, id) => bridge.openGroupCall(id, group),
      groupCallSnapshot,
    ),
  openConversation: (group: string, target?: string) =>
    openWindow<MarmotConversation, "older" | "newer">(
      (bridge, id) => bridge.openConversation(id, group, target ?? null),
      conversationSnapshot,
    ),
  startDirect: (peer: string) => native().startDirect(peer),
  checkInvitee: (peer: string) => native().checkInvitee(peer),
  async createGroup(
    name: string,
    description: string | null,
    members: string[],
    image: string | null = null,
  ) {
    return groupCreation.parse(
      await native().createGroup(name, description, members, image),
    );
  },
  respondToInvitation: (group: string, accept: boolean) =>
    native().respondToInvitation(group, accept),
  async groupDetails(group: string) {
    return groupDetails.parse(await native().groupDetails(group));
  },
  viewGroupImage: (group: string, hash: string) =>
    native().viewGroupImage(group, hash),
  async searchConversation(group: string, text: string | null, media: boolean) {
    return z
      .array(searchResult)
      .max(40)
      .parse(await native().searchConversation(group, text, media));
  },
  async editHistory(
    group: string,
    message: string,
    before?: { at: number; id: string },
  ) {
    return editHistory.parse(
      await native().editHistory(
        group,
        message,
        before?.at ?? null,
        before?.id ?? null,
      ),
    );
  },
  updateGroupImage: (group: string, path: string | null) =>
    native().updateGroupImage(group, path),
  updateGroupMedia: (group: string, origins: string[]) =>
    native().updateGroupMedia(group, origins),
  updateGroup: (
    group: string,
    name: string | null,
    description: string | null,
  ) => native().updateGroup(group, name, description),
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
    kind: 24881 | 24883 | 24884,
    body: string,
    reply: string | null,
  ) => native().sendSpecial(group, kind, body, reply),
  async sendMedia(
    group: string,
    files: MarmotUpload[],
    caption: string | null,
    token: string,
    server: string | null,
    reply: string | null,
    progress: (fraction: number) => void,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const bridge = native();
    const cancel = () => void bridge.cancelUpload(token).catch(() => undefined);
    const listener = bridge.addListener("attachmentProgress", (event) => {
      if (event.transfer !== token) return;
      if (signal.aborted) cancel();
      else if (event.total)
        progress(Math.min(0.99, event.received / event.total));
    });
    signal.addEventListener("abort", cancel, { once: true });
    try {
      return uploadReceipt.parse(
        await bridge.sendMedia(
          group,
          mediaUploadArguments(files),
          caption,
          token,
          server,
          reply,
        ),
      );
    } finally {
      signal.removeEventListener("abort", cancel);
      listener.remove();
    }
  },
  async stageMediaDraft(
    group: string,
    files: MarmotUpload[],
    caption: string,
    token: string,
    reply: string | null,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const bridge = native();
    const cancel = () => void bridge.cancelUpload(token).catch(() => undefined);
    const listener = bridge.addListener("attachmentProgress", (event) => {
      if (event.transfer === token && signal.aborted) cancel();
    });
    signal.addEventListener("abort", cancel, { once: true });
    try {
      await bridge.stageMediaDraft(
        group,
        mediaUploadArguments(files),
        caption,
        token,
        reply,
      );
    } finally {
      signal.removeEventListener("abort", cancel);
      listener.remove();
    }
  },
  discardMediaDraft: (group: string) => native().discardMediaDraft(group),
  attachmentStatus: (
    group: string,
    id: string,
    source: string,
    index: number,
  ) => native().attachmentStatus(group, id, source, index),
  audioMetadata: async (path: string) =>
    z
      .object({
        title: z.string().optional(),
        artist: z.string().optional(),
        album: z.string().optional(),
        duration: z.number().positive().optional(),
        artworkUrl: z.string().optional(),
      })
      .parse(await native().audioMetadata(path)),
  inspectMediaFile: async (path: string, image: boolean, poster: boolean) =>
    z
      .object({
        path: z.string().nullish(),
        duration: z.number().positive().nullish(),
        dimensions: z.string().nullish(),
      })
      .parse(await native().inspectMediaFile(path, image, poster)),
  async downloadAttachment(
    group: string,
    id: string,
    source: string,
    index: number,
    onProgress: (
      received: number,
      total: number | undefined,
      state: string,
    ) => void,
    signal: AbortSignal,
  ) {
    if (signal.aborted) return "cancelled";
    const bridge = native();
    const transfer = randomUUID();
    bridge.registerAttachmentTransfer(transfer);
    let cancellation: Promise<void> | undefined;
    const cancel = () => {
      cancellation = bridge.interruptAttachmentTransfer(
        group,
        id,
        source,
        index,
        transfer,
      );
      void cancellation.catch(() => undefined);
    };
    const listener = bridge.addListener("attachmentProgress", (event) => {
      if (event.transfer === transfer && !signal.aborted)
        onProgress(event.received, event.total ?? undefined, event.state);
    });
    signal.addEventListener("abort", cancel, { once: true });
    try {
      return await bridge.downloadAttachment(
        group,
        id,
        source,
        index,
        transfer,
      );
    } finally {
      signal.removeEventListener("abort", cancel);
      listener.remove();
      await cancellation;
    }
  },
  attachmentTransferState: async (
    group: string,
    id: string,
    source: string,
    index: number,
  ) =>
    (await native().attachmentTransferState(group, id, source, index)) ??
    "unavailable",
  controlAttachment: (
    group: string,
    id: string,
    source: string,
    index: number,
    action: "cancel" | "remove",
  ) => native().controlAttachment(group, id, source, index, action),
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
  retainedAttachmentBytes: (
    group: string,
    id: string,
    source: string,
    index: number,
  ) => native().retainedAttachmentBytes(group, id, source, index),
  recentVoiceNotes: (sender: string, since: number, onlyOutgoing: boolean) =>
    native().recentVoiceNotes(sender, since, onlyOutgoing),
  editMessage: (group: string, id: string, content: string) =>
    native().editMessage(group, id, content),
  deleteMessage: (group: string, id: string) =>
    native().deleteMessage(group, id),
  reportMessage: (group: string, id: string, reason: "spam" | "other") =>
    native().reportMessage(group, id, reason === "spam"),
  reactToMessage: (group: string, id: string, emoji: string, remove: boolean) =>
    native().reactToMessage(group, id, emoji, remove),
  markRead: (group: string, id: string) => native().markRead(group, id),
  markUnread: (group: string) => native().markUnread(group),
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
