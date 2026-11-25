import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppState } from "react-native";
import { useDialog } from "@/components/ui/dialog";
import { Action, Ink, Screen } from "@/components/ui/kit";
import {
  clearSelectedAccount,
  removeLocalAccount,
  selectAccount,
} from "@/core/identity";
import {
  marmotAccounts,
  type MarmotAccount,
  type MarmotOnboarding,
  type OnboardingAction,
} from "@/core/marmot/native";
import type { Database } from "@/db";
import { namespaces } from "@/i18n";

export function AccountSetup({
  account,
  initial,
  previousAccount,
  db,
  complete,
  reenter,
}: {
  account: MarmotAccount;
  initial: MarmotOnboarding | null;
  previousAccount?: string;
  db: Database;
  complete: () => void;
  reenter: () => void;
}) {
  const dialog = useDialog();
  const { t } = useTranslation(namespaces);
  const [snapshot, setSnapshot] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const live = useRef(true);
  const running = useRef(false);

  async function perform(operation: () => Promise<void>) {
    if (running.current || AppState.currentState !== "active") return;
    running.current = true;
    setBusy(true);
    setFailed(false);
    try {
      await operation();
    } catch {
      if (live.current) setFailed(true);
    } finally {
      running.current = false;
      if (live.current) setBusy(false);
    }
  }

  function run(command: OnboardingAction) {
    return perform(async () => {
      const next = await marmotAccounts.onboarding(account.key, command);
      if (!live.current) return;
      setSnapshot(next);
      if (next?.ready) complete();
      if (command.action === "recover") reenter();
    });
  }

  useEffect(() => {
    live.current = true;
    if (
      initial?.steps.some(
        ({ status }) => status === "pending" || status === "checking",
      )
    )
      void run({ action: "run" });
    return () => {
      live.current = false;
    };
    // MDK owns progress for this mounted account. Explicit actions update the snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.key]);

  const current = snapshot?.steps.find(
    ({ status }) => status !== "passed" && status !== "skipped",
  );
  const has = (action: string) => current?.actions.includes(action);
  const proposal = snapshot?.proposal;
  const recovery = account.readiness === "recovery_required";
  const canSignIn =
    account.signedOut &&
    !account.unlinked &&
    !recovery &&
    (!snapshot || snapshot.ready);

  function discard() {
    void dialog.show({
      title: t("messenger:discardSetup"),
      message: t("messenger:discardSetupDetail"),
      dismissible: false,
      actions: [
        { label: t("common:cancel"), tone: "cancel" },
        {
          label: t("messenger:discardSetup"),
          tone: "danger",
          onSelect: () =>
            void perform(async () => {
              if (snapshot && !snapshot.ready) {
                await marmotAccounts.onboarding(account.key, {
                  action: "cancel",
                });
              }
              if (previousAccount) selectAccount(db, previousAccount);
              else clearSelectedAccount(db);
              await removeLocalAccount(account.key);
              if (live.current) complete();
            }),
        },
      ],
    });
  }

  function recover() {
    void dialog.show({
      title: t("messenger:recoverSetup"),
      message: t("messenger:recoverSetupDetail"),
      dismissible: false,
      actions: [
        { label: t("common:cancel"), tone: "cancel" },
        {
          label: t("messenger:recoverSetup"),
          onSelect: () => void run({ action: "recover" }),
        },
      ],
    });
  }

  const steps = {
    profile: t("messenger:setupProfile"),
    follows: t("messenger:setupFollows"),
    relays: t("messenger:setupRelays"),
    inbox_relays: t("messenger:setupInbox"),
    single_device: t("messenger:setupDevices"),
    key_package: t("messenger:setupKeyPackage"),
  };

  return (
    <Screen topInset>
      <Ink kind="heading" accessibilityRole="header">
        {t("messenger:resumeSetup")}
      </Ink>
      {account.unlinked ? <Ink>{t("messenger:setupUnlinked")}</Ink> : null}
      {current ? <Ink>{steps[current.step]}</Ink> : null}
      {busy ? (
        <Ink accessibilityLiveRegion="polite">
          {t("messenger:checkingSetup")}
        </Ink>
      ) : null}
      {failed ? (
        <Ink accessibilityLiveRegion="polite">
          {t("messenger:setupRequestFailed")}
        </Ink>
      ) : null}
      {proposal && snapshot ? (
        <>
          <Ink>
            {t(
              proposal.inconclusive
                ? "messenger:setupApproveUncertain"
                : "messenger:setupApproveRelays",
            )}
          </Ink>
          <Ink>
            {t("messenger:setupReadRelays")} {proposal.read.join(", ")}
          </Ink>
          <Ink>
            {t("messenger:setupWriteRelays")} {proposal.write.join(", ")}
          </Ink>
          <Action
            disabled={busy}
            onPress={() => void run({ action: "approve", displayed: snapshot })}
          >
            {t("messenger:setupPublishRelays")}
          </Action>
          <Action
            variant="soft"
            disabled={busy}
            onPress={() => void run({ action: "cancelRepair" })}
          >
            {t("common:cancel")}
          </Action>
        </>
      ) : null}
      {current && !proposal ? (
        <>
          {has("retry") ? (
            <Action
              disabled={busy}
              onPress={() => void run({ action: "retry", step: current.step })}
            >
              {t("common:retry")}
            </Action>
          ) : null}
          {has("continue_without") ? (
            <Action
              variant="soft"
              disabled={busy}
              onPress={() => void run({ action: "skip", step: current.step })}
            >
              {t("messenger:setupSkip")}
            </Action>
          ) : null}
          {has("use_recommended_relays") ? (
            <Action
              disabled={busy}
              onPress={() =>
                void run({ action: "propose", step: current.step })
              }
            >
              {t("messenger:setupRecommendedRelays")}
            </Action>
          ) : null}
          {has("continue_anyway") && snapshot && snapshot.deviceNotice ? (
            <>
              <Ink>
                {t(
                  snapshot.deviceNotice.complete
                    ? "messenger:setupOtherDevice"
                    : "messenger:setupUnknownDevices",
                )}
              </Ink>
              <Action
                disabled={busy}
                onPress={() =>
                  void run({ action: "acknowledge", displayed: snapshot })
                }
              >
                {t("messenger:setupContinueAnyway")}
              </Action>
            </>
          ) : null}
          {current.status === "pending" || current.status === "checking" ? (
            <Action disabled={busy} onPress={() => void run({ action: "run" })}>
              {t("common:retry")}
            </Action>
          ) : null}
        </>
      ) : null}
      {recovery ? (
        <Action disabled={busy} onPress={recover}>
          {t("messenger:recoverSetup")}
        </Action>
      ) : null}
      {!snapshot && !recovery && !account.signedOut && !account.unlinked ? (
        <Action
          disabled={busy}
          onPress={() =>
            void perform(async () => {
              await marmotAccounts.resumeSetup();
              if (live.current) complete();
            })
          }
        >
          {t("common:retry")}
        </Action>
      ) : null}
      {canSignIn ? (
        <Action
          disabled={busy}
          onPress={() =>
            void perform(async () => {
              await marmotAccounts.signIn(account.key);
              if (live.current) complete();
            })
          }
        >
          {t("messenger:signIn")}
        </Action>
      ) : null}
      {!snapshot && !recovery && !account.unlinked ? (
        <Action variant="soft" disabled={busy} onPress={reenter}>
          {t("messenger:setupReenter")}
        </Action>
      ) : null}
      <Action variant="soft" disabled={busy} onPress={discard}>
        {t("messenger:discardSetup")}
      </Action>
    </Screen>
  );
}
