import { z } from "zod";

const futureKind = (known: readonly string[]) =>
  z
    .object({ kind: z.string() })
    .passthrough()
    .refine(({ kind }) => !known.includes(kind))
    .transform(({ kind: nativeKind, ...details }) => ({
      ...details,
      kind: "unsupported" as const,
      nativeKind,
    }));
const slotIdHex = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .brand<"DeviceSlot">();
export type DeviceSlot = z.infer<typeof slotIdHex>;
const groupId = z.string().regex(/^(?:[a-f0-9]{2}){1,256}$/);

export function validDeviceLabel(label: string, allowEmpty: boolean) {
  const trimmed = label.trim();
  // A lone surrogate encodes to the three-byte replacement character.
  let bytes = 0;
  for (const character of trimmed) {
    const point = character.codePointAt(0) ?? 0;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return (allowEmpty || trimmed.length > 0) && bytes <= 64;
}
const deviceLinkEndReasonSchema = z.union([
  z.object({ kind: z.literal("cancelled") }),
  z.object({ kind: z.literal("cancelledElsewhere") }),
  z.object({ kind: z.literal("codesDiffer") }),
  z.object({ kind: z.literal("verificationFailed") }),
  z.object({ kind: z.literal("timedOut") }),
  z.object({ kind: z.literal("answeredElsewhere") }),
  z.object({ kind: z.literal("cannotLink") }),
  z.object({ kind: z.literal("rejected") }),
  z.object({ kind: z.literal("linkFailed") }),
  futureKind([
    "cancelled",
    "cancelledElsewhere",
    "codesDiffer",
    "verificationFailed",
    "timedOut",
    "answeredElsewhere",
    "cannotLink",
    "rejected",
    "linkFailed",
  ]),
]);

export const deviceLinkEmojiSchema = z.object({
  emoji: z.string(),
  description: z.string(),
});

export const newDeviceLinkStateSchema = z.union([
  z.object({ kind: z.literal("waitingForAnswer") }),
  z.object({
    kind: z.literal("comparing"),
    code: z.array(deviceLinkEmojiSchema).length(7),
  }),
  z.object({ kind: z.literal("waitingForOtherDevice") }),
  z.object({ kind: z.literal("joining") }),
  z.object({ kind: z.literal("linked") }),
  z.object({ kind: z.literal("ended"), reason: deviceLinkEndReasonSchema }),
  futureKind([
    "waitingForAnswer",
    "comparing",
    "waitingForOtherDevice",
    "joining",
    "linked",
    "ended",
  ]),
]);

export const deviceLinkPromptStateSchema = z.union([
  z.object({ kind: z.literal("preparing") }),
  z.object({
    kind: z.literal("comparing"),
    code: z.array(deviceLinkEmojiSchema).length(7),
  }),
  z.object({ kind: z.literal("competingRequests") }),
  z.object({
    kind: z.literal("rateLimited"),
    retryAt: z.number().int().nonnegative(),
  }),
  z.object({ kind: z.literal("cannotLink"), missing: z.array(z.string()) }),
  z.object({ kind: z.literal("tooManyDevices") }),
  z.object({ kind: z.literal("linking") }),
  z.object({ kind: z.literal("linked") }),
  z.object({
    kind: z.literal("addedElsewhere"),
    deviceLabel: z.string(),
    addedByLabel: z.string(),
  }),
  z.object({ kind: z.literal("ended"), reason: deviceLinkEndReasonSchema }),
  futureKind([
    "preparing",
    "comparing",
    "competingRequests",
    "rateLimited",
    "cannotLink",
    "tooManyDevices",
    "linking",
    "linked",
    "addedElsewhere",
    "ended",
  ]),
]);

export const deviceLinkPromptSchema = z.object({
  promptId: z.string(),
  slotIdHex: slotIdHex.nullable(),
  requestedAt: z.number().int().nonnegative(),
  state: deviceLinkPromptStateSchema,
});

export const linkedDeviceStatusSchema = z.union([
  z.object({ kind: z.literal("active") }),
  z.object({ kind: z.literal("inactive") }),
  z.object({ kind: z.literal("leaving") }),
  z.object({ kind: z.literal("moved") }),
  futureKind(["active", "inactive", "leaving", "moved"]),
]);

export const linkedDeviceSchema = z.object({
  slotIdHex,
  isThisDevice: z.boolean(),
  label: z.string(),
  client: z.string(),
  platform: z.string(),
  linkedAt: z.number().int().nonnegative(),
  linkedBySlotIdHex: slotIdHex.nullable(),
  status: linkedDeviceStatusSchema,
  addToAllChats: z.boolean(),
  bringHistory: z.boolean(),
  keepWhileInactive: z.boolean(),
  lastActiveAt: z.number().int().nonnegative().nullable(),
  inactive: z.boolean(),
  removalPending: z.boolean(),
});

export const deviceGroupMoveSchema = z.object({
  moveId: z.string(),
  state: z.union([
    z.object({ kind: z.literal("waitingForWelcome") }),
    z.object({ kind: z.literal("joining") }),
    z.object({ kind: z.literal("made") }),
    z.object({ kind: z.literal("failed") }),
    futureKind(["waitingForWelcome", "joining", "made", "failed"]),
  ]),
  oldSiblings: z.array(
    z.object({
      slotIdHex,
      label: z.string(),
      questionSuppressed: z.boolean(),
    }),
  ),
  overriddenRejectionSlots: z.array(slotIdHex),
});

export const linkChatProgressSchema = z.object({
  slotIdHex,
  onNewDevice: z.boolean(),
  total: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
});

export const deviceLinkSnapshotSchema = z.object({
  newDevice: newDeviceLinkStateSchema.nullable(),
  prompts: z.array(deviceLinkPromptSchema),
  moves: z.array(deviceGroupMoveSchema),
  deviceGroupStalled: z.boolean(),
  chatProgress: z.array(linkChatProgressSchema),
});

export const unrecognizedSignInStateSchema = z.union([
  z.object({ kind: z.literal("prompt") }),
  z.object({ kind: z.literal("notNow") }),
  z.object({ kind: z.literal("linkedElsewhere") }),
  z.object({ kind: z.literal("rejectedElsewhere") }),
  futureKind(["prompt", "notNow", "linkedElsewhere", "rejectedElsewhere"]),
]);

export const unrecognizedSignInSchema = z.object({
  slotIdHex,
  client: z.string(),
  appearedAt: z.number().int().nonnegative(),
  lastSeenAt: z.number().int().nonnegative(),
  beforeThisDevice: z.boolean(),
  signedIn: z.boolean(),
  state: unrecognizedSignInStateSchema,
  linkedBySlotIdHex: slotIdHex.nullable(),
  previouslyLinkedHere: z.boolean(),
});

export const compromiseWarningSchema = z.object({
  reason: z.union([
    z.object({ kind: z.literal("rejectedSignIn") }),
    z.object({ kind: z.literal("foreignOwnSlotKeyPackage") }),
    futureKind(["rejectedSignIn", "foreignOwnSlotKeyPackage"]),
  ]),
  slotIdHex,
  keyPackageRefHex: z
    .string()
    .regex(/^[a-f0-9]+$/)
    .nullable(),
  occurredAt: z.number().int().nonnegative(),
});

const historyImportSourceSchema = z.object({
  deviceSlotIdHex: slotIdHex,
  deviceLabel: z.string(),
});

export const chatHistoryImportSchema = z.object({
  groupIdHex: groupId,
  state: z.union([
    z.object({ kind: z.literal("receiving"), retrying: z.boolean() }),
    z.object({
      kind: z.literal("imported"),
      from: historyImportSourceSchema,
      at: z.number().int().nonnegative(),
    }),
    futureKind(["receiving", "imported"]),
  ]),
});

export const accountDevicesActivationSchema = z.union([
  z.object({ kind: z.literal("eligible") }),
  z.object({ kind: z.literal("notAdmin") }),
  z.object({ kind: z.literal("alreadyEnabled") }),
  z.object({ kind: z.literal("legacyGroup") }),
  z.object({ kind: z.literal("membersNeedUpdate") }),
  z.object({ kind: z.literal("devicesNeedReplacement") }),
  z.object({ kind: z.literal("deviceLimitExceeded") }),
  futureKind([
    "eligible",
    "notAdmin",
    "alreadyEnabled",
    "legacyGroup",
    "membersNeedUpdate",
    "devicesNeedReplacement",
    "deviceLimitExceeded",
  ]),
]);

export type DeviceLinkSnapshot = z.infer<typeof deviceLinkSnapshotSchema>;
export type LinkedDevice = z.infer<typeof linkedDeviceSchema>;
export type UnrecognizedSignIn = z.infer<typeof unrecognizedSignInSchema>;
export type CompromiseWarning = z.infer<typeof compromiseWarningSchema>;
export type ChatHistoryImport = z.infer<typeof chatHistoryImportSchema>;
export const accountRecoveryStatusSchema = z.object({
  catchingUpGroupIdsHex: groupId.array(),
  inboxCatchingUp: z.boolean(),
  notices: z.array(
    z.object({
      noticeId: z.string().regex(/^[a-f0-9]{48}$/),
      groupIdHex: groupId.nullable(),
      parkedAtMs: z.number().int().nonnegative().nullable(),
      cause: z.string(),
    }),
  ),
});
export type AccountDevicesActivation = z.infer<
  typeof accountDevicesActivationSchema
>;
