import { useTranslation } from "react-i18next";
import { Image } from "react-native";
import { useTheme } from "@/theme";

export function TranslationAttribution() {
  const { theme } = useTheme();
  const { t } = useTranslation("translation");
  const dark = theme === "dark";
  return (
    <Image
      accessible
      accessibilityLabel={t("attribution")}
      source={
        dark
          ? require("../../../assets/images/google-translation-dark.png")
          : require("../../../assets/images/google-translation-light.png")
      }
      resizeMode="contain"
      style={{
        width: 176,
        height: 16,
        maxWidth: "100%",
      }}
    />
  );
}
