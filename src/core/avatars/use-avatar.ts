import { useIsFocused } from "expo-router";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useLocal } from "@/services/local-context";

export function useAvatar(
  key: string | null | undefined,
  enabled = true,
  banner = false,
  profile = false,
) {
  const { avatars } = useLocal();
  const focused = useIsFocused();
  useEffect(() => {
    if (key && focused && enabled) return avatars.watch(key, banner, profile);
  }, [avatars, key, focused, enabled, banner, profile]);
  return useSyncExternalStore(
    useCallback(
      (listener) => (key ? avatars.subscribe(key, listener) : () => {}),
      [avatars, key],
    ),
    () => (key ? avatars.resolve(key, banner, profile) : undefined),
  );
}

const viewabilityConfig = {
  itemVisiblePercentThreshold: 50,
  minimumViewTime: 100,
};

export function useAvatarVisibility<T>(
  publicKey: (item: T) => string,
  active = true,
) {
  const { avatars } = useLocal();
  const focused = useIsFocused();
  const key = useRef(publicKey);
  const watching = useRef(new Map<string, () => void>());
  const [visible, setVisible] = useState<string[]>([]);
  const onViewableItemsChanged = useCallback(
    ({
      viewableItems,
    }: {
      viewableItems: { item: T; isViewable: boolean }[];
    }) => {
      const next = viewableItems.flatMap(({ item, isViewable }) => {
        const peer = isViewable ? key.current(item) : "";
        return peer ? [peer] : [];
      });
      setVisible((current) =>
        current.length === next.length &&
        current.every((peer, index) => peer === next[index])
          ? current
          : next,
      );
    },
    [],
  );
  useEffect(() => {
    const wanted = new Set(focused && active ? visible.slice(0, 32) : []);
    for (const [key, stop] of watching.current) {
      if (wanted.has(key)) continue;
      stop();
      watching.current.delete(key);
    }
    for (const key of wanted) {
      if (!watching.current.has(key))
        watching.current.set(key, avatars.watch(key));
    }
  }, [active, avatars, focused, visible]);
  useEffect(() => {
    const current = watching.current;
    return () => {
      for (const stop of current.values()) stop();
      current.clear();
    };
  }, []);
  return { onViewableItemsChanged, viewabilityConfig };
}
