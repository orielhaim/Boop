import { describe, expect, it } from "bun:test";
import {
  accountDevicesActivationSchema,
  chatHistoryImportSchema,
  compromiseWarningSchema,
  deviceLinkPromptStateSchema,
  deviceLinkSnapshotSchema,
  linkedDeviceSchema,
  newDeviceLinkStateSchema,
  unrecognizedSignInSchema,
  validDeviceLabel,
} from "../src/core/marmot/device-contract";

const slot = "a1".repeat(32);
const code = ["🐶", "🐱", "🦁", "🐎", "🦄", "🐷", "🐘"].map((emoji) => ({
  emoji,
  description: "animal",
}));

function expectEqual(actual: unknown, expected: unknown) {
  expect(actual).toEqual(expected);
}

describe("MDK device boundary schemas", () => {
  it("checks the UTF-8 label limit and lets rename clear an existing label", () => {
    expect(validDeviceLabel("א".repeat(32), false)).toBe(true);
    expect(validDeviceLabel("א".repeat(33), false)).toBe(false);
    expect(validDeviceLabel("🦁".repeat(16), false)).toBe(true);
    expect(validDeviceLabel("🦁".repeat(17), false)).toBe(false);
    expect(validDeviceLabel("  ", false)).toBe(false);
    expect(validDeviceLabel("  ", true)).toBe(true);
  });

  it("parses every current new-device pairing state", () => {
    const states = [
      { kind: "waitingForAnswer" },
      { kind: "comparing", code },
      { kind: "waitingForOtherDevice" },
      { kind: "joining" },
      { kind: "linked" },
      { kind: "ended", reason: { kind: "linkFailed" } },
    ];
    for (const state of states)
      expectEqual(newDeviceLinkStateSchema.parse(state), state);
    for (const kind of [
      "cancelled",
      "cancelledElsewhere",
      "codesDiffer",
      "verificationFailed",
      "timedOut",
      "answeredElsewhere",
      "cannotLink",
      "rejected",
      "linkFailed",
    ]) {
      const state = { kind: "ended", reason: { kind } };
      expectEqual(newDeviceLinkStateSchema.parse(state), state);
    }
  });

  it("parses every current signed-in-device prompt state", () => {
    const states = [
      { kind: "preparing" },
      { kind: "comparing", code },
      { kind: "competingRequests" },
      { kind: "rateLimited", retryAt: 1_800_000_000 },
      { kind: "cannotLink", missing: ["app_component:0x8004"] },
      { kind: "tooManyDevices" },
      { kind: "linking" },
      { kind: "linked" },
      { kind: "addedElsewhere", deviceLabel: "Phone", addedByLabel: "Laptop" },
      { kind: "ended", reason: { kind: "cancelledElsewhere" } },
    ];
    for (const state of states)
      expectEqual(deviceLinkPromptStateSchema.parse(state), state);
  });

  it("keeps the snapshot shape separate from the linked-device roster", () => {
    const snapshot = {
      newDevice: { kind: "comparing", code },
      prompts: [
        {
          promptId: "opaque-local-id",
          slotIdHex: slot,
          requestedAt: 1_700_000_000,
          state: { kind: "comparing", code },
        },
      ],
      moves: [
        {
          moveId: "opaque-move",
          state: { kind: "made" },
          oldSiblings: [],
          overriddenRejectionSlots: [],
        },
      ],
      deviceGroupStalled: true,
      chatProgress: [
        { slotIdHex: slot, onNewDevice: true, total: 3, remaining: 2 },
      ],
    };
    expectEqual(deviceLinkSnapshotSchema.parse(snapshot), snapshot);
  });

  it("parses every current linked-device, sign-in, and activation status", () => {
    const device = {
      slotIdHex: slot,
      isThisDevice: false,
      label: "📱 現在の端末",
      client: "Boop",
      platform: "Android",
      linkedAt: 1_700_000_000,
      linkedBySlotIdHex: null,
      status: { kind: "active" },
      addToAllChats: true,
      bringHistory: true,
      keepWhileInactive: false,
      lastActiveAt: null,
      inactive: false,
      removalPending: false,
    };
    for (const kind of ["active", "inactive", "leaving", "moved"])
      expectEqual(
        linkedDeviceSchema.parse({ ...device, status: { kind } }).status,
        { kind },
      );

    for (const kind of [
      "prompt",
      "notNow",
      "linkedElsewhere",
      "rejectedElsewhere",
    ])
      expectEqual(
        unrecognizedSignInSchema.parse({
          slotIdHex: slot,
          client: "Boop",
          appearedAt: 1,
          lastSeenAt: 2,
          beforeThisDevice: false,
          signedIn: true,
          state: { kind },
          linkedBySlotIdHex: null,
          previouslyLinkedHere: false,
        }).state,
        { kind },
      );

    for (const kind of [
      "eligible",
      "notAdmin",
      "alreadyEnabled",
      "legacyGroup",
      "membersNeedUpdate",
      "devicesNeedReplacement",
      "deviceLimitExceeded",
    ])
      expectEqual(accountDevicesActivationSchema.parse({ kind }), { kind });
  });

  it("normalizes new native reasons without misreading malformed known states", () => {
    expectEqual(
      newDeviceLinkStateSchema.parse({
        kind: "ended",
        reason: { kind: "newNativeFailure", code: 42 },
      }),
      {
        kind: "ended",
        reason: {
          kind: "unsupported",
          nativeKind: "newNativeFailure",
          code: 42,
        },
      },
    );
    expectEqual(
      compromiseWarningSchema.parse({
        reason: { kind: "newWarningReason" },
        slotIdHex: slot,
        keyPackageRefHex: null,
        occurredAt: 3,
      }).reason,
      { kind: "unsupported", nativeKind: "newWarningReason" },
    );

    expect(
      newDeviceLinkStateSchema.safeParse({ kind: "comparing" }).success,
    ).toBe(false);
    expect(
      newDeviceLinkStateSchema.safeParse({
        kind: "comparing",
        code: code.slice(0, 6),
      }).success,
    ).toBe(false);
    expect(
      deviceLinkPromptStateSchema.safeParse({ kind: "rateLimited" }).success,
    ).toBe(false);
    expect(
      deviceLinkPromptStateSchema.safeParse({
        kind: "ended",
        reason: { kind: "cancelled" },
      }).success,
    ).toBe(true);
  });

  it("validates opaque slot IDs and imported-history provenance", () => {
    const valid = {
      groupIdHex: "b2".repeat(32),
      state: {
        kind: "imported",
        from: { deviceSlotIdHex: slot, deviceLabel: "Tablet" },
        at: 1_700_000_000,
      },
    };
    expectEqual(chatHistoryImportSchema.parse(valid), valid);
    expect(
      chatHistoryImportSchema.safeParse({
        ...valid,
        state: {
          kind: "imported",
          from: { deviceSlotIdHex: "A1".repeat(32), deviceLabel: "Tablet" },
          at: 0,
        },
      }).success,
    ).toBe(false);
    expect(
      unrecognizedSignInSchema.safeParse({
        slotIdHex: "abc",
        client: "Boop",
        appearedAt: 1,
        lastSeenAt: 2,
        beforeThisDevice: false,
        signedIn: true,
        state: { kind: "prompt" },
        linkedBySlotIdHex: null,
        previouslyLinkedHere: false,
      }).success,
    ).toBe(false);
  });
});
