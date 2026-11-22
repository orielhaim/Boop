import { useMinimizeOnScroll } from "expo-glass-tabs";
import { Redirect } from "expo-router";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { CallHistory } from "@/components/calls/call-history";
import { Screen } from "@/components/ui/kit";
import { CompactHeader } from "@/components/ui/messenger-ui";
import { useAppPreferences } from "@/stores/preferences";
import { space } from "@/theme";

export default function Calls() {
  const { t } = useTranslation("navigation");
  const separateCallsTab = useAppPreferences((state) => state.separateCallsTab);
  const onScroll = useMinimizeOnScroll();

  if (!separateCallsTab) return <Redirect href="/people" />;

  return (
    <Screen tab scroll={false}>
      <View style={styles.header}>
        <CompactHeader title={t("calls")} />
      </View>
      <CallHistory onScroll={onScroll} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: space.lg, paddingBottom: space.sm },
});
