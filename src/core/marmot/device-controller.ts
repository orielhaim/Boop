import { createStore } from "zustand/vanilla";
import { validDeviceLabel, type DeviceSlot } from "./device-contract";
import type { DeviceEventKind, SignInResponse, marmotDevices } from "./native";
import { createRecovery } from "./recovery";
import { marmotErrorCode } from "./errors";

type Source = typeof marmotDevices;
type Observation = ReturnType<Source["observe"]>;
type Projections = {
  roster: Awaited<ReturnType<Source["linkedDevices"]>>;
  pairing: Awaited<ReturnType<Source["deviceLinkSnapshot"]>>;
  signIns: Awaited<ReturnType<Source["unrecognizedSignIns"]>>;
  warnings: Awaited<ReturnType<Source["compromiseWarning"]>>;
  history: Awaited<ReturnType<Source["chatHistoryImports"]>>;
  recovery: Awaited<ReturnType<Source["accountRecoveryStatus"]>>;
  keyHealth: boolean;
  startedFresh: boolean;
  leftoverChats: number;
  closedChats: number;
};
type Projection = keyof Projections;
type Removal = "requested" | "pending" | "removed" | "failed" | "unavailable";
type DeviceState = {
  connection:
    "starting" | "observing" | "reconnecting" | "stopped" | "unlinked";
  projections: Partial<Projections>;
  failed: readonly Projection[];
  operation: string | null;
  discovery: "unchecked" | "checked" | "failed";
  removals: ReadonlyMap<DeviceSlot, Removal>;
};

const projectionNames: Projection[] = [
  "roster",
  "pairing",
  "signIns",
  "warnings",
  "history",
  "keyHealth",
  "startedFresh",
  "leftoverChats",
  "closedChats",
  "recovery",
];

const invalidations: Record<
  Exclude<DeviceEventKind, "ended" | "deviceUnlinked">,
  Projection[]
> = {
  linkedDevicesChanged: [
    "roster",
    "leftoverChats",
    "closedChats",
    "startedFresh",
    "history",
  ],
  deviceLinkChanged: ["pairing", "closedChats", "startedFresh"],
  unrecognizedSignInsChanged: ["signIns"],
  compromiseWarningChanged: ["warnings"],
  chatHistoryImportsChanged: ["history"],
  keyPackageRefreshOverdueChanged: ["keyHealth"],
  recoveryStatusChanged: ["recovery"],
};

const initial: DeviceState = {
  connection: "stopped",
  projections: {},
  failed: [],
  operation: null,
  discovery: "unchecked",
  removals: new Map(),
};

export function createDeviceController({
  account,
  source,
  canAct,
  canSynchronize = () => true,
  onUnlinked,
}: {
  account: string;
  source: Source;
  canAct: () => boolean;
  canSynchronize?: () => boolean;
  onUnlinked: () => void;
}) {
  const activePolicy = () => canAct() && canSynchronize();
  const { subscribe, getState, setState } = createStore<DeviceState>(
    () => initial,
  );
  const read: { [K in Projection]: () => Promise<Projections[K]> } = {
    roster: () => source.linkedDevices(account),
    pairing: () => source.deviceLinkSnapshot(account),
    signIns: () => source.unrecognizedSignIns(account),
    warnings: () => source.compromiseWarning(account),
    history: () => source.chatHistoryImports(account),
    recovery: () => source.accountRecoveryStatus(account),
    keyHealth: () => source.keyPackageRefreshOverdue(account),
    startedFresh: () => source.startedFresh(account),
    leftoverChats: () => source.removedDeviceLeftoverChats(account),
    closedChats: () => source.chatsClosedToLinkedDevices(account),
  };
  let generation = 0;
  let streamEpoch = 0;
  let authorization = 0;
  let signInReadEpoch = 0;
  let active = false;
  let observation: Observation | undefined;
  let refreshToken: object | undefined;
  let unlinkProbe: object | undefined;
  const dirty = new Set<Projection>();
  const observeRecovery = createRecovery(connect);
  const readRecovery = createRecovery(() => invalidate(getState().failed));

  function isCurrent(revision: number) {
    return active && revision === generation;
  }

  function invalidate(projections: readonly Projection[]) {
    for (const key of projections) dirty.add(key);
    if (projections.length) queueMicrotask(refresh);
  }

  function updateRoster(roster: Projections["roster"]) {
    const state = getState();
    const removals = new Map(state.removals);
    for (const [slot, outcome] of removals) {
      if (
        outcome !== "requested" &&
        outcome !== "pending" &&
        outcome !== "unavailable"
      )
        continue;
      const row = roster.find((device) => device.slotIdHex === slot);
      if (!row && !roster.some((device) => device.isThisDevice)) {
        removals.set(slot, "unavailable");
      } else if (!row) {
        removals.set(slot, "removed");
      } else if (row.removalPending) {
        removals.set(slot, "pending");
      }
    }
    setState({ removals });
  }

  async function readProjection<K extends Projection>(key: K, token: object) {
    const readEpoch = key === "signIns" ? signInReadEpoch : undefined;
    try {
      const result = await read[key]();
      if (refreshToken !== token || !activePolicy()) return;
      if (key === "signIns" && readEpoch !== signInReadEpoch) return;
      // Any event raised across this read must get a subsequent native snapshot.
      setState(({ projections, failed }) => ({
        projections: { ...projections, [key]: result },
        failed: failed.filter((item) => item !== key),
      }));
      if (key === "roster") {
        const roster = getState().projections.roster;
        if (roster) updateRoster(roster);
      }
    } catch (error) {
      if (refreshToken === token) {
        const code = marmotErrorCode(error);
        if (code === "AccountUnlinked") {
          revoke();
          return;
        }
        if (code === "AccountSignedOut") probeUnlink();
      }
      if (
        refreshToken === token &&
        activePolicy() &&
        (key !== "signIns" || readEpoch === signInReadEpoch)
      )
        setState(({ failed }) => ({
          failed: Array.from(new Set([...failed, key])),
        }));
    }
  }

  function refresh() {
    if (
      refreshToken ||
      getState().connection !== "observing" ||
      !activePolicy() ||
      !dirty.size
    )
      return;
    const token = {};
    refreshToken = token;
    void (async () => {
      // Limit concurrent native reads and yield between bounded batches.
      const pending = Array.from(dirty);
      dirty.clear();
      for (let offset = 0; offset < pending.length; offset += 3) {
        if (refreshToken !== token || !activePolicy()) return;
        await Promise.all(
          pending
            .slice(offset, offset + 3)
            .map((key) => readProjection(key, token)),
        );
      }
      if (refreshToken !== token || !activePolicy()) return;
      if (getState().failed.length) readRecovery.schedule();
      else readRecovery.reset();
    })().finally(() => {
      if (refreshToken !== token) return;
      refreshToken = undefined;
      if (dirty.size && activePolicy()) queueMicrotask(refresh);
    });
  }

  function stop() {
    if (!active) return;
    active = false;
    generation++;
    streamEpoch++;
    authorization++;
    refreshToken = undefined;
    unlinkProbe = undefined;
    dirty.clear();
    observeRecovery.reset();
    readRecovery.reset();
    const stream = observation;
    observation = undefined;
    stream?.close();
    setState(initial, true);
  }

  function revoke() {
    if (!active) return;
    stop();
    setState({ connection: "unlinked" });
    onUnlinked();
  }

  function probeUnlink() {
    if (!active || unlinkProbe) return;
    const epoch = streamEpoch;
    const probe = {};
    unlinkProbe = probe;
    void Promise.resolve()
      .then(() => source.accountIsUnlinked(account))
      .then(
        (unlinked) => {
          if (
            unlinked &&
            active &&
            streamEpoch === epoch &&
            unlinkProbe === probe
          )
            revoke();
        },
        () => undefined,
      )
      .finally(() => {
        if (unlinkProbe === probe) unlinkProbe = undefined;
      });
  }

  function connect() {
    if (!active || observation) return;
    const epoch = ++streamEpoch;
    const live = () => active && epoch === streamEpoch;
    const ended = () => {
      if (!live()) return;
      streamEpoch++;
      authorization++;
      refreshToken = undefined;
      unlinkProbe = undefined;
      const stream = observation;
      observation = undefined;
      stream?.close();
      readRecovery.reset();
      setState({ connection: "reconnecting" });
      observeRecovery.schedule();
    };
    try {
      const current = source.observe(account, (kind) => {
        if (!live()) return;
        if (kind === "deviceUnlinked") {
          revoke();
        } else if (kind === "ended") {
          ended();
        } else {
          invalidate(invalidations[kind]);
        }
      });
      if (!live()) {
        current.close();
        void current.ready.catch(() => undefined);
        return;
      }
      observation = current;
      void current.ready.then(() => {
        if (!live()) return;
        setState({ connection: "observing" });
        invalidate(projectionNames);
      }, ended);
    } catch {
      ended();
    }
  }

  function assertCurrent(revision: number, authority = authorization) {
    if (!isCurrent(revision) || authority !== authorization || !activePolicy())
      throw new Error("AccountClosed");
  }

  async function command<T>(
    operation: string,
    projections: readonly Projection[],
    run: (assertActive: () => void) => Promise<T>,
  ): Promise<T> {
    const revision = generation;
    const authority = authorization;
    const assertActive = () => assertCurrent(revision, authority);
    assertActive();
    if (getState().operation) throw new Error("AccountBusy");
    setState({ operation });
    try {
      const result = await run(assertActive);
      assertActive();
      return result;
    } catch (error) {
      if (isCurrent(revision) && marmotErrorCode(error) === "AccountUnlinked")
        revoke();
      throw error;
    } finally {
      if (isCurrent(revision)) {
        setState({ operation: null });
        invalidate(projections);
      }
    }
  }

  function setRemoval(slot: DeviceSlot, status: Removal) {
    setState(({ removals }) => ({
      removals: new Map(removals).set(slot, status),
    }));
  }

  function removeDevices(slots: readonly DeviceSlot[]) {
    const confirmed = Array.from(new Set(slots));
    return command(
      "remove",
      ["roster", "leftoverChats"],
      async (assertActive) => {
        for (const slot of confirmed) {
          assertActive();
          try {
            const roster = await read.roster();
            assertActive();
            const target = roster.find((device) => device.slotIdHex === slot);
            if (!target || target.isThisDevice) {
              setRemoval(slot, "unavailable");
              continue;
            }
            if (target.removalPending) {
              setRemoval(slot, "pending");
              continue;
            }
            await source.removeLinkedDevice(account, slot);
            assertActive();
            setRemoval(slot, "requested");
          } catch {
            assertActive();
            setRemoval(slot, "failed");
          }
        }
      },
    );
  }

  return {
    subscribe,
    getState,
    start() {
      if (active || getState().connection === "unlinked") return;
      active = true;
      setState({ connection: "starting" });
      connect();
    },
    stop,
    suspend() {
      authorization++;
      refreshToken = undefined;
      readRecovery.reset();
    },
    reconnect() {
      if (!active) return;
      observeRecovery.reset();
      if (observation) {
        probeUnlink();
        invalidate(projectionNames);
      } else connect();
    },
    refreshChatAvailability() {
      invalidate(["closedChats", "leftoverChats"]);
    },
    startLink: () =>
      command("startLink", ["pairing"], () => source.startDeviceLink(account)),
    confirmMatch: (code: string[]) =>
      command("compare", ["pairing"], () =>
        source.confirmDeviceLinkMatch(account, code),
      ),
    cancelLink: () =>
      command("cancelLink", ["pairing"], () =>
        source.cancelDeviceLink(account),
      ),
    linkDevice: (
      prompt: string,
      code: string[],
      label: string,
      allChats: boolean,
      history: boolean,
    ) =>
      command("link", ["pairing", "roster"], async () => {
        if (!validDeviceLabel(label, false))
          throw new Error("InvalidDeviceLabel");
        return source.linkDevice(
          account,
          prompt,
          code,
          label,
          allChats,
          allChats && history,
        );
      }),
    declineLink: (prompt: string) =>
      command("decline", ["pairing"], () =>
        source.declineDeviceLink(account, prompt),
      ),
    removeDevices,
    renameDevice: (slot: DeviceSlot, label: string) =>
      command("rename", ["roster"], async () => {
        if (!validDeviceLabel(label, true))
          throw new Error("InvalidDeviceLabel");
        await source.renameLinkedDevice(account, slot, label);
      }),
    updateDevice: (
      slot: DeviceSlot,
      patch: {
        addToAllChats?: boolean;
        bringHistory?: boolean;
        keepWhileInactive?: boolean;
      },
    ) =>
      command("settings", ["roster"], () =>
        source.updateLinkedDeviceSettings(
          account,
          slot,
          patch.addToAllChats ?? null,
          patch.bringHistory ?? null,
          patch.keepWhileInactive ?? null,
        ),
      ),
    checkSignIns: () => {
      signInReadEpoch += 1;
      setState({ discovery: "unchecked" });
      return command("discovery", ["signIns"], async (assertActive) => {
        try {
          const result = await source.checkSignIns(account);
          assertActive();
          signInReadEpoch += 1;
          setState(({ projections, failed }) => ({
            discovery: "checked",
            projections: { ...projections, signIns: result },
            failed: failed.filter((item) => item !== "signIns"),
          }));
          return result;
        } catch (error) {
          assertActive();
          setState({ discovery: "failed" });
          throw error;
        }
      });
    },
    answerSignIn: (slot: DeviceSlot, response: SignInResponse) =>
      command("answer", ["signIns", "warnings"], async (assertActive) => {
        const rows = await read.signIns();
        assertActive();
        const state = rows.find((row) => row.slotIdHex === slot)?.state.kind;
        const allowed =
          response === "dismiss"
            ? state === "linkedElsewhere" || state === "rejectedElsewhere"
            : response === "reject"
              ? state === "prompt" || state === "notNow"
              : state === "prompt";
        if (!allowed) throw new Error("SignInChanged");
        await source.answerSignIn(account, slot, response);
      }),
    startFresh: () =>
      command("startFresh", ["startedFresh", "signIns"], () =>
        source.startFresh(account),
      ),
    acknowledgeWarning: () =>
      command("acknowledge", ["warnings"], () =>
        source.dismissCompromiseWarning(account),
      ),
    repair: () =>
      command("repair", projectionNames, async (assertActive) => {
        await source.resetDeviceGroupForRepair(account);
        assertActive();
        await source.rotateKeyPackage(account);
        assertActive();
        return source.startDeviceLink(account);
      }),
    rotateKeyPackage: () =>
      command("rotateKeyPackage", ["keyHealth"], () =>
        source.rotateKeyPackage(account),
      ),
    dismissMoveSibling: (move: string, slot: DeviceSlot) =>
      command("dismissMoveSibling", ["pairing"], () =>
        source.dismissDeviceGroupMoveSibling(account, move, slot),
      ),
    async accountDevicesActivation(group: string) {
      const revision = generation;
      const authority = authorization;
      assertCurrent(revision, authority);
      const result = await source.accountDevicesActivation(account, group);
      assertCurrent(revision, authority);
      return result;
    },
    enableAccountDevices: (group: string) =>
      command("enableAccountDevices", ["closedChats"], () =>
        source.enableAccountDevices(account, group),
      ),
  };
}
