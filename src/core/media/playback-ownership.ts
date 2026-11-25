type Owner = "audio" | "video" | "roundNote";

export function createPlaybackOwnership() {
  let owner: Owner | undefined;
  let blocked = false;
  const suspend = new Map<Owner, () => void>();
  let stopRoundNote: (() => void) | undefined;

  const coordinator = {
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
  coordinator.register("roundNote", () => {
    const stop = stopRoundNote;
    stopRoundNote = undefined;
    stop?.();
  });
  return {
    ...coordinator,
    claimRoundNote(stop: () => void) {
      if (!coordinator.claim("roundNote")) return false;
      // The previous row may release its claim while Chat Kit replaces it.
      // Only the latest claim can release round-note ownership.
      const claim = () => stop();
      stopRoundNote = claim;
      return () => {
        if (stopRoundNote !== claim) return;
        stopRoundNote = undefined;
        coordinator.release("roundNote");
      };
    },
    stopRoundNote() {
      coordinator.release("roundNote");
      suspend.get("roundNote")?.();
    },
  };
}
