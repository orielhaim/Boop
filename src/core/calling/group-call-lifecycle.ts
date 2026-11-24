import type { marmot } from "../marmot/native";
import type { createCallController } from "./controller";
import {
  groupCallAnnouncement,
  groupCallRenewAfter,
  groupCallKind,
} from "./group-presence";

export function attachGroupCallLifecycle({
  calling,
  localKey,
  ready,
  client,
}: {
  calling: ReturnType<typeof createCallController>;
  localKey: string;
  ready: () => Promise<unknown>;
  client: Pick<typeof marmot, "openGroupRoster" | "sendSpecial">;
}) {
  let watching: string | undefined;
  let disposeWatch: (() => void) | undefined;
  let watchRevision = 0;
  let stopped = false;
  let last:
    | { group: string; call: string; members: string[]; sent: number }
    | undefined;
  let publicationTime = 0;
  let renewal: ReturnType<typeof setTimeout> | undefined;
  let chain = Promise.resolve();

  async function update() {
    if (stopped) return;
    const { call, participants, groupLobby } = calling.store.getState();
    const connected = call?.phase === "connected" ? call : undefined;
    if (connected?.reconnecting && !groupLobby) return;
    const group = connected?.groupId ?? groupLobby?.groupId;
    const callId = connected?.id ?? groupLobby?.callId;
    // An authenticated connected roster elects a deterministic coordinator.
    // The lobby can advertise before the first peer negotiates any media.
    const members =
      group && callId && (participants.length || groupLobby)
        ? [localKey, ...participants.map(({ key }) => key)].sort()
        : [];
    const coordinator = members[0] === localKey;
    if (
      last &&
      (group !== last.group || callId !== last.call || !coordinator)
    ) {
      const previous = last;
      last = undefined;
      clearTimeout(renewal);
      // Other members can take over without seeing this withdrawal. Under
      // disconnection the old route can just expire.
      const ended = !participants.length && previous.members.length === 1;
      await announce(previous.group, previous.call, [], ended);
    }
    if (!group || !callId || !coordinator) return;
    if (
      last &&
      last.members.join() === members.join() &&
      Date.now() < last.sent + groupCallRenewAfter
    )
      return;
    clearTimeout(renewal);
    if ((await announce(group, callId, members)) && !stopped) {
      last = { group, call: callId, members, sent: Date.now() };
      renewal = setTimeout(schedule, groupCallRenewAfter);
    } else {
      // Leave the last successful lease intact. Retry once on the next
      // membership, connection, or routing change.
      renewal = undefined;
    }
  }

  async function announce(
    group: string,
    call: string,
    members: string[],
    ended = false,
  ) {
    try {
      if (stopped || !(await calling.groupAllowed(group, members)))
        return false;
      const state = calling.store.getState();
      const connected =
        state.call?.id === call &&
        state.call.phase === "connected" &&
        !state.call.reconnecting;
      const lobby = state.groupLobby?.callId === call;
      if (stopped || (members.length > 0 && !connected && !lobby)) return false;
      publicationTime = Math.max(Date.now(), publicationTime + 1);
      await client.sendSpecial(
        group,
        groupCallKind,
        groupCallAnnouncement(call, members, publicationTime, ended),
        null,
      );
      return true;
    } catch {
      return false;
    }
  }

  function watch(group?: string) {
    if (watching === group) return;
    watching = group;
    const revision = ++watchRevision;
    disposeWatch?.();
    disposeWatch = undefined;
    if (!group) return;
    void ready()
      .then(() => client.openGroupRoster(group))
      .then((window) => {
        const close = () => void window.close().catch(() => undefined);
        if (revision !== watchRevision || stopped) {
          close();
          return;
        }
        const onChange = () => {
          if (revision !== watchRevision || stopped) return;
          const state = window.getState();
          if (state.status === "ready") {
            const { lifecycle, membership, members } = state.snapshot.details;
            if (
              lifecycle === "disbanded" ||
              ["removed", "device_removed", "left"].includes(membership)
            ) {
              calling.reconcileGroup(group, new Set());
            } else if (membership === "member" && lifecycle === "stable") {
              calling.reconcileGroup(
                group,
                new Set(members.map(({ id }) => id)),
              );
            }
            schedule();
          } else if (revision === watchRevision) watch(undefined);
        };
        const unsubscribe = window.subscribe(onChange);
        disposeWatch = () => {
          unsubscribe();
          close();
        };
        onChange();
      })
      .catch(() => {
        if (revision === watchRevision) watching = undefined;
      });
  }

  let queued = false;
  function schedule() {
    if (stopped) return;
    const { call, joining, groupLobby } = calling.store.getState();
    watch(
      groupLobby?.groupId ??
        (call && call.phase !== "ended" ? call.groupId : joining?.groupId),
    );
    if (queued) return;
    queued = true;
    chain = chain.then(async () => {
      queued = false;
      await update();
    });
  }
  const unsubscribe = calling.store.subscribe((state, before) => {
    const call = state.call;
    const previous = before.call;
    if (
      call?.id !== previous?.id ||
      call?.phase !== previous?.phase ||
      state.joining !== before.joining ||
      state.groupLobby !== before.groupLobby ||
      state.participants.map(({ key }) => key).join() !==
        before.participants.map(({ key }) => key).join() ||
      (call?.phase === "connected" &&
        previous?.phase === "connected" &&
        call.reconnecting !== previous.reconnecting)
    )
      schedule();
  });
  schedule();
  return () => {
    stopped = true;
    clearTimeout(renewal);
    unsubscribe();
    disposeWatch?.();
  };
}
