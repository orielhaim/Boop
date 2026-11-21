import { useEffect, useState, useSyncExternalStore } from "react";
import { useLocal } from "@/services/local-context";

export function useTranslationLanguages() {
  const { translation } = useLocal();
  const revision = useSyncExternalStore(
    translation.subscribe,
    translation.revision,
  );
  const [catalog, setCatalog] =
    useState<Awaited<ReturnType<typeof translation.languages>>>();
  const [downloaded, setDownloaded] = useState<string[]>();
  const [error, setError] = useState<"unsupported" | "modelsError">();
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const options = await translation.languages();
        if (!live || revision !== translation.revision()) return;
        setCatalog(options);
        try {
          const installed = await translation.downloaded();
          if (live && revision === translation.revision()) {
            setDownloaded(installed);
            setError(undefined);
          }
        } catch {
          if (live) setError("modelsError");
        }
      } catch {
        if (live) setError("unsupported");
      }
    })();
    return () => {
      live = false;
    };
  }, [translation, revision]);
  return {
    catalog,
    downloaded,
    error,
    retry: translation.refreshModelStatus,
  };
}
