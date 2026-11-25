import { useLocalSearchParams } from "expo-router";
import { useTranslation } from "react-i18next";
import { ScreenHeader } from "@/components/navigation/screen-header";
import { SharedMediaLibrary } from "@/components/shared-media/library";
import { Empty, Screen } from "@/components/ui/kit";

export default function SharedMediaRoute() {
  const { group, scope } = useLocalSearchParams<{
    group?: string;
    scope?: string;
  }>();
  const { t } = useTranslation("messages");
  const valid =
    group === undefined ||
    (typeof group === "string" &&
      /^[a-f0-9]{2,512}$/u.test(group) &&
      group.length % 2 === 0);
  return (
    <Screen
      scroll={false}
      navigationHeader={<ScreenHeader title={t("sharedMedia.title")} />}
    >
      {valid ? (
        <SharedMediaLibrary
          key={group ?? "account"}
          scope={
            group === undefined
              ? { kind: "account" }
              : { kind: scope === "direct" ? "direct" : "group", group }
          }
        />
      ) : (
        <Empty icon="warning" detail="" title={t("sharedMedia.unavailable")} />
      )}
    </Screen>
  );
}
