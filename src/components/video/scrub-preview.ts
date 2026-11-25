const CACHE_LIMIT = 48;
const NEARBY_FRAME_SECONDS = 0.25;
const MOVING_FRAME_SECONDS = 3;

export function createScrubPreview<Frame>(
  decode: (time: number) => Promise<Frame | undefined>,
  show: (frame: Frame) => void,
  release: () => void = () => {},
) {
  const cache = new Map<number, Frame>();
  let target: number | undefined;
  let decoding = false;
  let generation = 0;
  let displayed: number | undefined;
  function publish(time: number, frame: Frame) {
    if (displayed === time) return;
    // Keep recently displayed frames available when the drag reverses.
    cache.delete(time);
    cache.set(time, frame);
    displayed = time;
    show(frame);
  }

  function stop() {
    target = displayed = undefined;
    generation++;
  }

  async function loadLatest() {
    if (decoding || target === undefined || cache.has(target)) return;
    const time = target;
    const started = generation;
    decoding = true;
    try {
      const frame = await decode(time);
      if (frame === undefined || started !== generation) return;
      cache.set(time, frame);
      if (cache.size > CACHE_LIMIT) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
      if (target === time) publish(time, frame);
    } catch {
      // Some assets cannot generate a preview at every position.
    } finally {
      decoding = false;
      if (target !== time || started !== generation) void loadLatest();
    }
  }

  return {
    request(seconds: number) {
      const time = Math.round(seconds * 1000) / 1000;
      if (target === time) return;
      const moving = target !== undefined;
      target = time;
      const frame = cache.get(time);
      if (frame !== undefined) {
        publish(time, frame);
        return;
      }

      let distance = Math.min(
        moving ? MOVING_FRAME_SECONDS : NEARBY_FRAME_SECONDS,
        displayed === undefined ? Infinity : Math.abs(displayed - time),
      );
      let nearby: [number, Frame] | undefined;
      for (const [cachedTime, cachedFrame] of cache) {
        const offset = Math.abs(cachedTime - time);
        if (offset >= distance) continue;
        distance = offset;
        nearby = [cachedTime, cachedFrame];
      }
      if (nearby) publish(...nearby);
      void loadLatest();
    },
    stop,
    clear() {
      stop();
      if (decoding || cache.size) release();
      cache.clear();
    },
  };
}
