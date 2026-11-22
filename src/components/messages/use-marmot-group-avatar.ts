import { useEffect, useState, useSyncExternalStore } from "react";
import { marmot } from "@/core/marmot/native";
import { useLocal } from "@/services/local-context";

export function useMarmotGroupAvatar(group: string, hash?: string | null) {
  const { privacy } = useLocal();
  useSyncExternalStore(privacy.subscribe, privacy.revision);
  const eligible = privacy.photoPolicy() !== "nobody" && Boolean(hash);
  const [asset, setAsset] = useState<{
    group: string;
    hash: string;
    uri: string;
  }>();
  useEffect(() => {
    if (!eligible || !hash) return;
    let live = true;
    void marmot
      .groupImage(group, hash)
      .then((path) => {
        if (live && path) setAsset({ group, hash, uri: "file://" + path });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [eligible, group, hash]);
  return eligible && asset?.group === group && asset.hash === hash
    ? asset.uri
    : undefined;
}
