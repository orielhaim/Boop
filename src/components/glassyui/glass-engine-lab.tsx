import { useTranslation } from "react-i18next";
import { GlassPlayground } from "react-native-liquid-engine/playground";
import { usePreferences } from "./glass-provider";

export function GlassEngineLab() {
  const { t } = useTranslation("settings");
  const { theme, reduceMotion, reduceTransparency } = usePreferences();
  return (
    <GlassPlayground
      dark={theme === "dark"}
      reduceMotion={reduceMotion}
      reduceTransparency={reduceTransparency}
      labels={t("glassEngineLab", { returnObjects: true })}
    />
  );
}
