import { reloadAppAsync } from "expo";
import { I18nManager } from "react-native";
import { preference, setPreference } from "@/db/queries";
import { type AppLanguage, directionFor, i18n, resolveLanguage } from "./index";

function configureDirection(language: AppLanguage) {
  const rtl = directionFor(language) === "rtl";
  if (rtl) {
    I18nManager.allowRTL(true);
    I18nManager.forceRTL(true);
  } else {
    I18nManager.forceRTL(false);
    I18nManager.allowRTL(false);
  }
  return I18nManager.isRTL !== rtl;
}

const repairKey = "language.directionRepair";

export async function initializeLanguage<Result>(
  db: Parameters<typeof preference<Result>>[0],
) {
  const language = resolveLanguage(i18n.resolvedLanguage);
  const mismatch = configureDirection(language);
  try {
    const previous = preference(db, repairKey);
    if (!mismatch) {
      if (previous) setPreference(db, repairKey, "");
      return false;
    }
    if (previous === language) return false;
    setPreference(db, repairKey, language);
    await reloadAppAsync("Apply Boop layout direction");
    return true;
  } catch {
    return false;
  }
}

export async function applyLanguage(language: AppLanguage) {
  if (configureDirection(language)) {
    await reloadAppAsync("Apply Boop language");
  } else {
    await i18n.changeLanguage(language);
  }
}
