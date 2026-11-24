import { useEffect, useState, useSyncExternalStore } from "react";
import { useIsFocused } from "expo-router";
import { marmot, type MarmotAvatarAsset } from "@/core/marmot/native";
import { useLocal } from "@/services/local-context";

export function usePreparedGroupAvatar(
  asset: MarmotAvatarAsset | null | undefined,
  visible = true,
) {
  const { identity, isCurrent, lock, privacy } = useLocal();
  useSyncExternalStore(privacy.subscribe, privacy.revision);
  const account = identity.publicKey;
  const focused = useIsFocused();
  const state = useSyncExternalStore(lock.subscribe, lock.getState);
  const eligible =
    visible &&
    focused &&
    state.active &&
    !state.locked &&
    privacy.photoPolicy() !== "nobody";
  const target = eligible ? asset?.target : undefined;
  const reference =
    eligible &&
    (asset?.availability === "ready" || asset?.availability === "stale")
      ? asset.reference
      : undefined;
  const revision = asset?.revision;
  const [image, setImage] = useState<{
    account: string;
    key: string;
    uri: string;
  }>();
  const key = reference && `${reference}:${revision}`;

  useEffect(() => {
    if (!target || reference || !isCurrent()) return;
    void marmot.requestAvatarAssets([target]).catch(() => undefined);
  }, [isCurrent, reference, target]);
  useEffect(() => {
    if (!reference || !isCurrent()) return;
    let mounted = true;
    void marmot
      .readAvatarAssets([reference])
      .then(([result]) => {
        if (!mounted || !isCurrent() || !result) return;
        if (result.uri && result.revision === revision) {
          setImage({
            account,
            key: `${reference}:${revision}`,
            uri: result.uri,
          });
        } else if (
          target &&
          !result.deferred &&
          result.availability === "missing"
        ) {
          void marmot.requestAvatarAssets([target]).catch(() => undefined);
        }
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, [account, isCurrent, reference, revision, target]);
  return eligible && key && image?.account === account && image.key === key
    ? image.uri
    : undefined;
}
