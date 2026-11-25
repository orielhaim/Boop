type ActionTone = "primary" | "neutral" | "cancel" | "danger";

export type DialogAction = {
  label: string;
  tone?: ActionTone;
  disabled?: boolean;
} & (
  | { onSelect?: () => void; run?: never }
  | { run: (signal: AbortSignal) => Promise<unknown>; onSelect?: never }
);

export type DialogRequest = {
  title: string;
  message?: string;
  tone?: "info" | "error" | "danger";
  dismissible?: boolean;
  actions?: readonly [DialogAction, ...DialogAction[]];
};

type Selection = number | undefined;
type Owner = { signal: AbortSignal; canPresent: () => boolean };

type Entry = {
  id: number;
  request: DialogRequest;
  owner: Owner;
  pending?: AbortController;
  failed: boolean;
  settle: (selection: Selection) => void;
};

type Presentation = {
  id: number;
  request: Omit<DialogRequest, "actions">;
  actions?: readonly Pick<DialogAction, "label" | "tone" | "disabled">[];
  pendingIndex?: number;
  failed: boolean;
};

type Snapshot = { phase: "active" | "closing"; dialog: Presentation } | null;

export function createDialogQueue(allowed: () => boolean) {
  let id = 0;
  let snapshot: Snapshot = null;
  let leavingOwner: Owner | undefined;
  let waiting: Entry[] = [];
  const listeners = new Set<() => void>();

  function update(next: Snapshot) {
    if (snapshot === next) return;
    snapshot = next;
    for (const listener of listeners) listener();
  }

  function present(entry: Entry, pendingIndex?: number) {
    const { actions, ...request } = entry.request;
    update({
      phase: "active",
      dialog: {
        id: entry.id,
        request,
        actions: actions?.map(({ label, tone, disabled }) => ({
          label,
          tone,
          disabled,
        })),
        pendingIndex,
        failed: entry.failed,
      },
    });
  }

  function canPresent(owner: Owner) {
    return allowed() && !owner.signal.aborted && owner.canPresent();
  }

  function advance() {
    if (snapshot) return;
    while (waiting.length && !canPresent(waiting[0].owner)) {
      waiting.shift()?.settle(undefined);
    }
    const next = waiting[0];
    if (next) present(next);
  }

  function show(request: DialogRequest, owner: Owner): Promise<Selection> {
    if (!canPresent(owner)) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const discard = () => revoke(owner);
      owner.signal.addEventListener("abort", discard, { once: true });
      waiting.push({
        id: ++id,
        request,
        owner,
        failed: false,
        settle(selection) {
          owner.signal.removeEventListener("abort", discard);
          resolve(selection);
        },
      });
      advance();
    });
  }

  function revoke(owner?: Owner) {
    const discarded = waiting.filter(
      (entry) => !owner || entry.owner === owner,
    );
    waiting = waiting.filter((entry) => !discarded.includes(entry));
    for (const entry of discarded) {
      entry.pending?.abort();
      entry.settle(undefined);
    }
    if (
      !owner ||
      (snapshot?.phase === "active" &&
        discarded.some((entry) => entry.id === snapshot?.dialog.id)) ||
      leavingOwner === owner
    ) {
      leavingOwner = undefined;
      update(null);
    }
    advance();
  }

  function current(id: number) {
    const entry = waiting[0];
    return snapshot?.phase === "active" &&
      entry?.id === id &&
      canPresent(entry.owner)
      ? entry
      : undefined;
  }

  function close(entry: Entry, selection: Selection) {
    if (snapshot?.phase !== "active") return;
    waiting.shift();
    leavingOwner = entry.owner;
    update({ phase: "closing", dialog: snapshot.dialog });
    entry.settle(selection);
  }

  function finishExit(id: number) {
    if (snapshot?.phase !== "closing" || snapshot.dialog.id !== id) return;
    leavingOwner = undefined;
    update(null);
    advance();
  }

  function dismiss() {
    if (!snapshot) return false;
    const entry = current(snapshot.dialog.id);
    if (entry && !entry.pending && entry.request.dismissible !== false)
      close(entry, undefined);
    return true;
  }

  async function select(id: number, index: number, failureTitle?: string) {
    const entry = current(id);
    if (!entry || entry.pending) return;
    const action = entry.request.actions?.[index];
    if (action?.disabled || (!action && (entry.request.actions || index !== 0)))
      return;

    if (!action?.run) {
      close(entry, index);
      try {
        await action?.onSelect?.();
      } catch {
        if (failureTitle)
          void show({ title: failureTitle, tone: "error" }, entry.owner);
      }
      return;
    }

    const pending = new AbortController();
    entry.pending = pending;
    entry.failed = false;
    present(entry, index);
    try {
      await action.run(pending.signal);
      if (current(id)) close(entry, index);
    } catch {
      if (!current(id)) return;
      entry.pending = undefined;
      entry.failed = true;
      present(entry);
    }
  }

  return {
    read: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    show,
    select,
    dismiss,
    finishExit,
    revoke,
  };
}

export type DialogQueue = ReturnType<typeof createDialogQueue>;
