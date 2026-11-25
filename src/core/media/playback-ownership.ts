type Owner = "audio" | "video";

export function createPlaybackOwnership() {
  let owner: Owner | undefined;
  let blocked = false;
  const suspend = new Map<Owner, () => void>();

  return {
    register(next: Owner, onSuspend: () => void) {
      suspend.set(next, onSuspend);
    },
    claim(next: Owner) {
      if (blocked) return false;
      const previous = owner;
      owner = next;
      if (previous && previous !== next) suspend.get(previous)?.();
      return true;
    },
    release(previous: Owner) {
      if (owner === previous) owner = undefined;
    },
    interrupt(active: boolean) {
      blocked = active;
      if (!active || !owner) return;
      const previous = owner;
      owner = undefined;
      suspend.get(previous)?.();
    },
  };
}
