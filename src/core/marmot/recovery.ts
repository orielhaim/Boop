export function createRecovery(retry: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay = 250;

  function cancel() {
    clearTimeout(timer);
    timer = undefined;
  }

  return {
    schedule() {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        retry();
      }, delay);
      delay = Math.min(delay * 2, 30_000);
    },
    cancel,
    reset() {
      cancel();
      delay = 250;
    },
  };
}
