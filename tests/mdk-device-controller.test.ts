import { describe, expect, test } from "bun:test";
import { createDeviceController } from "../src/core/marmot/device-controller";
import {
  linkedDeviceSchema,
  unrecognizedSignInSchema,
} from "../src/core/marmot/device-contract";
import type { DeviceEventKind } from "../src/core/marmot/native";

type Source = Parameters<typeof createDeviceController>[0]["source"];

function pending<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function drain() {
  for (let turn = 0; turn < 32; turn++) await Promise.resolve();
}

const pairing = {
  newDevice: null,
  prompts: [],
  moves: [],
  deviceGroupStalled: false,
  chatProgress: [],
};
const owner = "a".repeat(64);

function row(hex: string, current = false) {
  return linkedDeviceSchema.parse({
    slotIdHex: hex.repeat(64),
    isThisDevice: current,
    label: hex,
    client: "Boop",
    platform: "android",
    linkedAt: 1,
    linkedBySlotIdHex: null,
    status: { kind: "active" },
    addToAllChats: true,
    bringHistory: true,
    keepWhileInactive: false,
    lastActiveAt: null,
    inactive: false,
    removalPending: false,
  });
}

function fixture() {
  const observers: {
    account: string;
    receive: (kind: DeviceEventKind) => void;
    closed: boolean;
    ready: ReturnType<typeof pending<void>>;
  }[] = [];
  const source: Source = {
    observe(account, receive) {
      const opened = {
        account,
        receive,
        closed: false,
        ready: pending<void>(),
      };
      observers.push(opened);
      return {
        ready: opened.ready.promise,
        close() {
          opened.closed = true;
        },
      };
    },
    linkedDevices: async () => [],
    accountIsUnlinked: async () => false,
    deviceLinkSnapshot: async () => pairing,
    startDeviceLink: async () => pairing,
    cancelDeviceLink: async () => pairing,
    confirmDeviceLinkMatch: async () => pairing,
    linkDevice: async () => pairing,
    declineDeviceLink: async () => pairing,
    renameLinkedDevice: async () => {},
    updateLinkedDeviceSettings: async () => {},
    removeLinkedDevice: async () => {},
    unrecognizedSignIns: async () => [],
    checkSignIns: async () => [],
    answerSignIn: async () => {},
    compromiseWarning: async () => [],
    dismissCompromiseWarning: async () => {},
    startFresh: async () => {},
    startedFresh: async () => false,
    chatHistoryImports: async () => [],
    accountRecoveryStatus: async () => ({
      catchingUpGroupIdsHex: [],
      inboxCatchingUp: false,
      notices: [],
    }),
    keyPackageRefreshOverdue: async () => false,
    removedDeviceLeftoverChats: async () => 0,
    chatsClosedToLinkedDevices: async () => 0,
    resetDeviceGroupForRepair: async () => pairing,
    rotateKeyPackage: async () => {},
    dismissDeviceGroupMoveSibling: async () => pairing,
    accountDevicesActivation: async () => ({ kind: "eligible" }),
    enableAccountDevices: async () => {},
  };
  let allowed = true;
  let networkAllowed = true;
  let unlinks = 0;
  const controller = createDeviceController({
    account: owner,
    source,
    canAct: () => allowed,
    canSynchronize: () => networkAllowed,
    onUnlinked: () => unlinks++,
  });
  return {
    controller,
    observers,
    source,
    allow: (next: boolean) => {
      allowed = next;
    },
    allowNetwork: (next: boolean) => {
      networkAllowed = next;
    },
    unlinks: () => unlinks,
  };
}

describe("MDK device controller", () => {
  test("a reconnect checks durable unlink even when the event was missed", async () => {
    const { controller, observers, source, unlinks, allow } = fixture();
    allow(false);
    source.accountIsUnlinked = async () => true;
    controller.start();
    observers[0]?.ready.resolve();
    await drain();
    controller.reconnect();
    await drain();
    expect(unlinks()).toBe(1);
    expect(controller.getState().connection).toBe("unlinked");
  });

  test("disconnecting Chats blocks worker reads and commands while leaving unlink observation active", async () => {
    const { controller, observers, source, allowNetwork, unlinks } = fixture();
    let reads = 0;
    source.linkedDevices = async () => {
      reads++;
      return [];
    };
    allowNetwork(false);
    controller.start();
    observers[0]?.ready.resolve();
    await drain();
    expect(reads).toBe(0);
    await expect(controller.checkSignIns()).rejects.toThrow("AccountClosed");
    observers[0]?.receive("deviceUnlinked");
    expect(unlinks()).toBe(1);
  });

  test("a stale sign-in decision cannot reject an existing linked-elsewhere result", async () => {
    const { controller, observers, source } = fixture();
    const signIn = unrecognizedSignInSchema.parse({
      slotIdHex: "c".repeat(64),
      appearedAt: 1,
      lastSeenAt: 1,
      client: "Boop",
      beforeThisDevice: true,
      signedIn: true,
      state: { kind: "linkedElsewhere" },
      previouslyLinkedHere: false,
      linkedBySlotIdHex: null,
    });
    source.unrecognizedSignIns = async () => [signIn];
    const responses: string[] = [];
    source.answerSignIn = async (_account, _slot, response) => {
      responses.push(response);
    };
    controller.start();
    try {
      observers[0]?.ready.resolve();
      await expect(
        controller.answerSignIn(signIn.slotIdHex, "reject"),
      ).rejects.toThrow("SignInChanged");
      await controller.answerSignIn(signIn.slotIdHex, "dismiss");
      expect(responses).toEqual(["dismiss"]);
    } finally {
      controller.stop();
    }
  });

  test("setting patches leave omitted roster fields untouched", async () => {
    const { controller, observers, source } = fixture();
    const slot = row("b", true).slotIdHex;
    const settings: Parameters<Source["updateLinkedDeviceSettings"]>[] = [];
    source.updateLinkedDeviceSettings = async (...args) => {
      settings.push(args);
    };
    controller.start();
    try {
      observers[0]?.ready.resolve();
      await controller.updateDevice(slot, { bringHistory: false });
      expect(settings).toEqual([[owner, slot, null, false, null]]);
    } finally {
      controller.stop();
    }
  });

  test("subscribes before initial reads and drains duplicate invalidations through one following read", async () => {
    const { controller, observers, source } = fixture();
    const first = pending<Awaited<ReturnType<Source["linkedDevices"]>>>();
    const roster = [row("b", true), row("c")];
    let reads = 0;
    source.linkedDevices = async () => (++reads === 1 ? first.promise : roster);
    controller.start();
    try {
      expect(observers[0]?.account).toBe(owner);
      expect(reads).toBe(0);
      observers[0]?.ready.resolve();
      await drain();
      expect(reads).toBe(1);
      observers[0]?.receive("linkedDevicesChanged");
      observers[0]?.receive("linkedDevicesChanged");
      first.resolve([]);
      await drain();
      expect(reads).toBe(2);
      expect(controller.getState().projections.roster).toEqual(roster);
    } finally {
      controller.stop();
    }
  });

  test("an empty native roster is distinct from unreadable state", async () => {
    const { controller, observers } = fixture();
    controller.start();
    try {
      expect(controller.getState().projections.roster).toBeUndefined();
      observers[0]?.ready.resolve();
      await drain();
      expect(controller.getState().projections.roster).toEqual([]);
    } finally {
      controller.stop();
    }
  });

  test("reconnects after termination and ignores old stream callbacks and reads", async () => {
    const { controller, observers, source, unlinks } = fixture();
    const old = pending<Awaited<ReturnType<Source["linkedDevices"]>>>();
    let reads = 0;
    source.linkedDevices = async () =>
      ++reads === 1 ? old.promise : [row("b", true)];
    controller.start();
    try {
      observers[0]?.ready.resolve();
      await drain();
      observers[0]?.receive("ended");
      expect(observers[0]?.closed).toBe(true);
      expect(controller.getState().connection).toBe("reconnecting");
      controller.reconnect();
      observers[1]?.ready.resolve();
      await drain();
      old.resolve([row("c")]);
      observers[0]?.receive("deviceUnlinked");
      await drain();
      expect(controller.getState().projections.roster?.[0]?.label).toBe("b");
      expect(unlinks()).toBe(0);
    } finally {
      controller.stop();
    }
  });

  test("unlink revokes synchronously while locked and rejects late commands", async () => {
    const { controller, observers, source, allow, unlinks } = fixture();
    const link = pending<typeof pairing>();
    source.startDeviceLink = () => link.promise;
    controller.start();
    observers[0]?.ready.resolve();
    await drain();
    const action = controller.startLink();
    const result = action.catch((error: unknown) => error);
    allow(false);
    controller.suspend();
    observers[0]?.receive("deviceUnlinked");
    observers[0]?.receive("deviceUnlinked");
    expect(controller.getState().connection).toBe("unlinked");
    expect(controller.getState().projections).toEqual({});
    expect(unlinks()).toBe(1);
    link.resolve(pairing);
    expect(await result).toEqual(new Error("AccountClosed"));
  });

  test("App Lock invalidates admitted command presentation even after unlock", async () => {
    const { controller, observers, source, allow } = fixture();
    const discovery = pending<[]>();
    source.checkSignIns = () => discovery.promise;
    controller.start();
    try {
      observers[0]?.ready.resolve();
      await drain();
      const result = controller.checkSignIns().catch((error: unknown) => error);
      allow(false);
      controller.suspend();
      allow(true);
      controller.reconnect();
      discovery.resolve([]);
      expect(await result).toEqual(new Error("AccountClosed"));
      expect(controller.getState().discovery).toBe("unchecked");
    } finally {
      controller.stop();
    }
  });

  test("failed discovery stays distinct from a successful empty relay check", async () => {
    const { controller, observers, source } = fixture();
    source.checkSignIns = async () => {
      throw new Error("relay unavailable");
    };
    controller.start();
    try {
      observers[0]?.ready.resolve();
      await expect(controller.checkSignIns()).rejects.toThrow(
        "relay unavailable",
      );
      expect(controller.getState().discovery).toBe("failed");
      source.checkSignIns = async () => [];
      await expect(controller.checkSignIns()).resolves.toEqual([]);
      expect(controller.getState().discovery).toBe("checked");
    } finally {
      controller.stop();
    }
  });

  test("bulk removal tracks failure and native pending, and never includes self or newly found rows", async () => {
    const { controller, observers, source } = fixture();
    const [current, first, second, added] = [
      row("b", true),
      row("c"),
      row("d"),
      row("e"),
    ];
    let roster = [current, first, second, added];
    const calls: string[] = [];
    source.linkedDevices = async () => roster;
    source.removeLinkedDevice = async (_, slot) => {
      calls.push(slot);
      if (slot === first.slotIdHex) throw new Error("device_group_busy");
      roster = roster.map((device) =>
        device.slotIdHex === slot
          ? { ...device, removalPending: true }
          : device,
      );
    };
    controller.start();
    try {
      observers[0]?.ready.resolve();
      await drain();
      await controller.removeDevices([
        current.slotIdHex,
        first.slotIdHex,
        second.slotIdHex,
      ]);
      await drain();
      expect(calls).toEqual([first.slotIdHex, second.slotIdHex]);
      expect(controller.getState().removals.get(first.slotIdHex)).toBe(
        "failed",
      );
      expect(controller.getState().removals.get(second.slotIdHex)).toBe(
        "pending",
      );
      roster = roster.filter(({ slotIdHex }) => slotIdHex !== second.slotIdHex);
      observers[0]?.receive("linkedDevicesChanged");
      await drain();
      expect(controller.getState().removals.get(second.slotIdHex)).toBe(
        "removed",
      );
    } finally {
      controller.stop();
    }
  });
});
