import { selectionAsync } from "expo-haptics";
import { useAppPreferences } from "@/stores/preferences";

export function tapFeedback() {
  if (useAppPreferences.getState().haptics)
    void selectionAsync().catch(() => {});
}
