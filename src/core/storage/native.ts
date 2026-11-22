import { requireOptionalNativeModule } from "expo";
import { Paths } from "expo-file-system";
import { nativeUsage } from "./usage";

const storage = requireOptionalNativeModule<{ usage(): Promise<unknown> }>(
  "BoopStorage",
);

export async function appStorageUsage() {
  if (!storage) throw new Error("Storage usage unavailable");
  const summary = nativeUsage.parse(await storage.usage());
  if (summary.freeBytes === undefined) {
    try {
      const freeBytes = Paths.availableDiskSpace;
      if (Number.isSafeInteger(freeBytes) && freeBytes >= 0)
        return { ...summary, freeBytes };
    } catch {}
  }
  return summary;
}
