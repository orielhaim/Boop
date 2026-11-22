import type { marmot } from "../marmot/native";
import type { createCallController } from "./controller";
import {
  groupCallAnnouncement,
  groupCallHeartbeat,
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
  client: Pick<
    typeof marmot,
    "groupDetails" | "openGroupState" | "sendSpecial"
  >;
}) {
  let watching: string | undefined;
  let disposeWatch: (() => void) | undefined;
  let watchRevision = 0;
  let refreshRevision = 0;
  let stopped = false;
  let last:
    | { group: string; call: string; members: string[]; sent: number }
    | undefined;
  let chain = Promise.resolve();

  async function update() {
    if (stopped) return;
    const { call, participants } = calling.store.getState();
    const group = call?.groupId;
    if (
      last &&
      (call?.id !== last.call || group !== last.group || call.phase === "ended")
    ) {
      const previous = last;
      last = undefined;
      await announce(previous.group, previous.call, []);
    }
    if (!group || call?.phase !== "connected" || call.reconnecting) return;
    const members = [localKey, ...participants.map(({ key }) => key)].sort();
    if (
      members.length < 2 ||
      (last &&
        last.members.join() === members.join() &&
        Date.now() - last.sent < groupCallHeartbeat - 1_000)
    )
      return;
    if (await announce(group, call.id, members))
      last = { group, call: call.id, members, sent: Date.now() };
  }

  async function announce(group: string, call: string, members: string[]) {
    try {
      await ready();
      const details = await client.groupDetails(group);
      const roster = new Set(details.members.map(({ id }) => id));
      const state = calling.store.getState().call;
      if (
        stopped ||
        details.kind !== "group" ||
        details.membership !== "member" ||
        details.lifecycle !== "stable" ||
        details.pendingInvitation ||
        !roster.has(localKey) ||
        !members.every((key) => roster.has(key)) ||
        (members.length > 0 &&
          (state?.id !== call ||
            state.phase !== "connected" ||
            state.reconnecting))
      )
        return false;
      await client.sendSpecial(
        group,
        groupCallKind,
        groupCallAnnouncement(call, members),
        null,
      );
      return true;
    } catch {
      return false;
    }
  }

  function refresh(group: string, revision: number) {
    const request = ++refreshRevision;
    void client
      .groupDetails(group)
      .then((details) => {
        if (
          revision !== watchRevision ||
          request !== refreshRevision ||
          stopped
        )
          return;
        if (
          details.lifecycle === "disbanded" ||
          ["removed", "device_removed", "left"].includes(details.membership)
        ) {
          calling.reconcileGroup(group, new Set());
        } else if (
          details.membership === "member" &&
          details.lifecycle === "stable"
        ) {
          calling.reconcileGroup(
            group,
            new Set(details.members.map(({ id }) => id)),
          );
        }
      })
      .catch(() => undefined);
  }

  function watch(group?: string) {
    if (watching === group) return;
    watching = group;
    const revision = ++watchRevision;
    disposeWatch?.();
    disposeWatch = undefined;
    if (!group) return;
    void ready()
      .then(() => client.openGroupState(group))
      .then((window) => {
        const close = () => void window.close().catch(() => undefined);
        if (revision !== watchRevision || stopped) {
          close();
          return;
        }
        const onChange = () => {
          if (window.getState().status === "ready") refresh(group, revision);
          else if (revision === watchRevision) watch(undefined);
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
    const { call, joining } = calling.store.getState();
    watch(call && call.phase !== "ended" ? call.groupId : joining?.groupId);
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
      state.participants.map(({ key }) => key).join() !==
        before.participants.map(({ key }) => key).join() ||
      (call?.phase === "connected" &&
        previous?.phase === "connected" &&
        call.reconnecting !== previous.reconnecting)
    )
      schedule();
  });
  const heartbeat = setInterval(() => {
    if (calling.store.getState().call?.groupId) schedule();
  }, groupCallHeartbeat);
  schedule();
  return () => {
    stopped = true;
    clearInterval(heartbeat);
    unsubscribe();
    disposeWatch?.();
  };
}
