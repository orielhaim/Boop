import { useCallback, useEffect, useRef, useState } from "react";
import * as ScreenOrientation from "expo-screen-orientation";

export function useVideoOrientation() {
  const previous = useRef<
    ScreenOrientation.PlatformOrientationInfo | undefined
  >(undefined);
  const work = useRef(Promise.resolve());
  const [landscape, setLandscape] = useState(false);

  const restore = useCallback(() => {
    work.current = work.current
      .then(async () => {
        const policy = previous.current;
        previous.current = undefined;
        if (policy) await ScreenOrientation.lockPlatformAsync(policy);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => restore, [restore]);
  return {
    landscape,
    reset() {
      setLandscape(false);
      restore();
    },
    enter() {
      work.current = work.current
        .then(async () => {
          previous.current ??=
            await ScreenOrientation.getPlatformOrientationLockAsync();
          await ScreenOrientation.lockAsync(
            ScreenOrientation.OrientationLock.LANDSCAPE,
          );
          setLandscape(true);
        })
        .catch(() => restore());
    },
  };
}
