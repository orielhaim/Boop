import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { AppState } from "react-native";
import { DevicePairing } from "@/components/devices/pairing";
import {
  DeviceCard,
  DeviceHeading,
  type DeviceController,
} from "@/components/devices/presentation";
import { useDialog } from "@/components/ui/dialog";
import { Action, Ink, Screen } from "@/components/ui/kit";
import {
  ListGroup,
  ListRow,
  SettingsDescription,
} from "@/components/ui/list-group";
import {
  clearSelectedAccount,
  removeBoopAccountData,
  removeLocalAccount,
  selectAccount,
} from "@/core/identity";
import {
  marmotAccounts,
  marmotDevices,
  type MarmotAccount,
  type MarmotOnboarding,
  type OnboardingAction,
  type WipeOutcome,
} from "@/core/marmot/native";
import { createDeviceController } from "@/core/marmot/device-controller";
import type { AppLock } from "@/core/security/app-lock";
import { openDatabase, type Database } from "@/db";
import { finishOnboarding } from "@/services/local";
import { namespaces } from "@/i18n";

type DeviceState = ReturnType<DeviceController["getState"]>;
const emptyDeviceState: DeviceState = {
  connection: "stopped",
  projections: {},
  failed: [],
  operation: null,
  discovery: "unchecked",
  removals: new Map(),
};

export function AccountSetup({
  account,
  initial,
  previousAccount,
  db,
  lock,
  complete,
  reenter,
}: {
  account: MarmotAccount;
  initial: MarmotOnboarding | null;
  previousAccount?: string;
  db: Database;
  lock: AppLock;
  complete: () => Promise<void>;
  reenter: () => void;
}) {
  const dialog = useDialog();
  const { t } = useTranslation(namespaces);
  const [snapshot, setSnapshot] = useState(initial);
  const [unlinked, setUnlinked] = useState(account.unlinked);
  const [unlinkedOutcome, setUnlinkedOutcome] = useState<WipeOutcome>();
  const [unlinkedDataPurged, setUnlinkedDataPurged] = useState(false);
  const [unlinkedCleanupFailed, setUnlinkedCleanupFailed] = useState(false);
  const [deviceController, setDeviceController] = useState<DeviceController>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const live = useRef(true);
  const running = useRef(false);
  const selectedSigner = useRef(false);
  const pairingController = useRef<DeviceController | undefined>(undefined);
  const pairingSetup = useRef<Promise<void> | undefined>(undefined);
  const [deviceActionFailed, setDeviceActionFailed] = useState(false);
  const subscribeDeviceState = useCallback(
    (listener: () => void) =>
      deviceController?.subscribe(listener) ?? (() => {}),
    [deviceController],
  );
  const readDeviceState = useCallback(
    () => deviceController?.getState() ?? emptyDeviceState,
    [deviceController],
  );
  const deviceState = useSyncExternalStore(
    subscribeDeviceState,
    readDeviceState,
  );

  async function releaseDevicePairing() {
    await pairingSetup.current?.catch(() => undefined);
    pairingController.current?.stop();
    pairingController.current = undefined;
    if (live.current) setDeviceController(undefined);
    if (!selectedSigner.current) return;
    selectedSigner.current = false;
    await marmotAccounts.releaseSigner(account.key);
  }

  async function purgeUnlinkedBoopData() {
    finishOnboarding(db);
    const installation = await openDatabase();
    try {
      clearSelectedAccount(installation);
    } finally {
      installation.$client.closeSync();
    }
    await removeBoopAccountData(account.key);
    setUnlinkedDataPurged(true);
    setUnlinkedCleanupFailed(false);
  }

  function removeUnlinkedAccount() {
    void perform(async () => {
      await releaseDevicePairing();
      const outcome =
        unlinkedOutcome?.localAccountRemoved === true
          ? unlinkedOutcome
          : await marmotAccounts.signOutAndWipe(account.key);
      setUnlinkedOutcome(outcome);
      if (!outcome.localAccountRemoved) {
        setUnlinkedCleanupFailed(true);
        return;
      }
      try {
        await purgeUnlinkedBoopData();
      } catch {
        setUnlinkedCleanupFailed(true);
      }
    });
  }

  async function prepareDevicePairing(ready = snapshot?.ready) {
    if (pairingController.current || pairingSetup.current || !ready) return;
    const setup = (async () => {
      try {
        await marmotAccounts.selectSigner(account.key);
        selectedSigner.current = true;
        if (!live.current) {
          await marmotAccounts.releaseSigner(account.key);
          selectedSigner.current = false;
          return;
        }
        const controller = createDeviceController({
          account: account.key,
          source: marmotDevices,
          canAct: () =>
            live.current &&
            AppState.currentState === "active" &&
            !lock.getState().locked,
          onUnlinked: () => {
            setUnlinked(true);
            void releaseDevicePairing().catch(() => undefined);
          },
        });
        pairingController.current = controller;
        setDeviceController(controller);
        controller.start();
      } catch {
        // Pairing is optional and must not block account setup.
      }
    })();
    pairingSetup.current = setup;
    try {
      await setup;
    } finally {
      if (pairingSetup.current === setup) pairingSetup.current = undefined;
    }
  }

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
      if (next?.ready) await prepareDevicePairing(next.ready);
      if (command.action === "recover") {
        await releaseDevicePairing();
        reenter();
      }
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
      pairingController.current?.stop();
      pairingController.current = undefined;
      if (selectedSigner.current) {
        selectedSigner.current = false;
        void marmotAccounts.releaseSigner(account.key).catch(() => undefined);
      }
    };
    // MDK owns progress for this mounted account. Explicit actions update the snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.key]);

  useEffect(() => {
    if (snapshot?.ready) void prepareDevicePairing(snapshot.ready);
    // Setup progress is owned by MDK and changes only through explicit actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.key, snapshot?.ready]);

  useEffect(() => {
    if (!deviceController) return;
    const reconnectIfEligible = () => {
      if (AppState.currentState === "active" && !lock.getState().locked)
        deviceController.reconnect();
      else deviceController.suspend();
    };
    const appState = AppState.addEventListener("change", reconnectIfEligible);
    const unlock = lock.subscribe(reconnectIfEligible);
    reconnectIfEligible();
    return () => {
      appState.remove();
      unlock();
    };
  }, [deviceController, lock]);

  const current = snapshot?.steps.find(
    ({ status }) => status !== "passed" && status !== "skipped",
  );
  const has = (action: string) => current?.actions.includes(action);
  const proposal = snapshot?.proposal;
  const recovery = account.readiness === "recovery_required";
  const signIns = deviceState.projections.signIns;
  const signInsLoaded =
    deviceState.discovery === "checked" &&
    signIns !== undefined &&
    !deviceState.failed.includes("signIns");
  const checkingSignIns =
    deviceState.operation === "discovery" ||
    (deviceState.discovery === "checked" &&
      !signIns &&
      !deviceState.failed.includes("signIns"));
  const showingPriorSignIns =
    signIns !== undefined && deviceState.discovery !== "checked";
  const noTrustedRoster = deviceState.projections.roster?.length === 0;
  const hasPriorDeviceEvidence =
    signIns?.some((record) => record.beforeThisDevice) ||
    (snapshot?.deviceNotice?.complete === true &&
      snapshot.deviceNotice.discovery === "other_installation_possible");
  const canStartFresh =
    signInsLoaded &&
    noTrustedRoster &&
    hasPriorDeviceEvidence &&
    !deviceState.projections.startedFresh;
  const canSignIn =
    account.signedOut &&
    !unlinked &&
    !recovery &&
    (!snapshot || snapshot.ready);

  useEffect(() => {
    if (
      !deviceController ||
      !snapshot?.ready ||
      unlinked ||
      account.signedOut ||
      deviceState.connection !== "observing" ||
      deviceState.discovery !== "unchecked" ||
      deviceState.operation !== null ||
      !deviceState.projections.roster ||
      lock.getState().locked ||
      AppState.currentState !== "active"
    )
      return;
    void deviceController.checkSignIns().catch(() => undefined);
  }, [
    account.signedOut,
    deviceController,
    deviceState.connection,
    deviceState.discovery,
    deviceState.operation,
    deviceState.projections.roster,
    lock,
    snapshot?.ready,
    unlinked,
  ]);

  function checkSignIns() {
    if (!deviceController) return;
    setDeviceActionFailed(false);
    void deviceController
      .checkSignIns()
      .catch(() => setDeviceActionFailed(true));
  }

  function startFresh() {
    if (!deviceController || !canStartFresh) return;
    void dialog.show({
      title: t("devices:startFresh"),
      message: t("devices:startFreshHelp"),
      tone: "danger",
      dismissible: false,
      actions: [
        { label: t("common:cancel"), tone: "cancel" },
        {
          label: t("devices:startFresh"),
          tone: "danger",
          onSelect: () => {
            setDeviceActionFailed(false);
            void deviceController
              .startFresh()
              .catch(() => setDeviceActionFailed(true));
          },
        },
      ],
    });
  }

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
              await releaseDevicePairing();
              if (previousAccount) selectAccount(db, previousAccount);
              else clearSelectedAccount(db);
              await removeLocalAccount(account.key);
              if (live.current) await complete();
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
        {t(unlinked ? "messenger:setupUnlinked" : "messenger:resumeSetup")}
      </Ink>
      {unlinked ? (
        <DeviceCard center>
          <DeviceHeading
            title={t("messenger:setupUnlinked")}
            detail={t("devices:wipeHelp")}
          />
          {busy ? (
            <Ink accessibilityLiveRegion="polite">
              {t("devices:lifecycleRemoving")}
            </Ink>
          ) : null}
          {failed || unlinkedCleanupFailed ? (
            <Ink accessibilityLiveRegion="polite">
              {t("devices:operationFailed")}
            </Ink>
          ) : null}
          {unlinkedOutcome ? (
            <>
              <Ink>
                {t("devices:lifecycleGroupsLeft", {
                  count: unlinkedOutcome.groupsLeft,
                })}
              </Ink>
              {unlinkedOutcome.groupLeaveFailures.length ? (
                <Ink>
                  {t("devices:lifecycleGroupFailures", {
                    count: unlinkedOutcome.groupLeaveFailures.length,
                  })}
                </Ink>
              ) : null}
              <Ink>
                {t("devices:lifecycleKeyPackagesDeleted", {
                  count: unlinkedOutcome.keyPackagesDeleted,
                })}
              </Ink>
              {unlinkedOutcome.keyPackageFailures.length ? (
                <Ink>
                  {t("devices:lifecycleKeyPackageFailures", {
                    count: unlinkedOutcome.keyPackageFailures.length,
                  })}
                </Ink>
              ) : null}
              {unlinkedOutcome.siblingsNotReached ? (
                <Ink>{t("devices:lifecycleSiblingsNotReached")}</Ink>
              ) : null}
              {unlinkedOutcome.groupsLeftToSiblings > 0 ? (
                <Ink>
                  {t("devices:lifecycleGroupsLeftToSiblings", {
                    count: unlinkedOutcome.groupsLeftToSiblings,
                  })}
                </Ink>
              ) : null}
              {unlinkedDataPurged ? (
                <Ink>{t("devices:lifecycleAccountRemoved")}</Ink>
              ) : (
                <Ink>{t("devices:lifecycleLocalCleanupFailed")}</Ink>
              )}
            </>
          ) : null}
          {unlinkedDataPurged ? (
            <Action
              disabled={busy}
              onPress={() =>
                void perform(async () => {
                  await releaseDevicePairing();
                  if (live.current) await complete();
                })
              }
            >
              {t("devices:done")}
            </Action>
          ) : (
            <Action disabled={busy} onPress={removeUnlinkedAccount}>
              {t(unlinkedOutcome ? "devices:retry" : "devices:wipe")}
            </Action>
          )}
        </DeviceCard>
      ) : (
        <>
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
                onPress={() =>
                  void run({ action: "approve", displayed: snapshot })
                }
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
                  onPress={() =>
                    void run({ action: "retry", step: current.step })
                  }
                >
                  {t("common:retry")}
                </Action>
              ) : null}
              {has("continue_without") ? (
                <Action
                  variant="soft"
                  disabled={busy}
                  onPress={() =>
                    void run({ action: "skip", step: current.step })
                  }
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
                      !snapshot.deviceNotice.complete
                        ? "messenger:setupUnknownDevices"
                        : snapshot.deviceNotice.discovery === "none_found"
                          ? "messenger:setupNoOtherDevice"
                          : snapshot.deviceNotice.discovery ===
                              "other_installation_possible"
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
                <Action
                  disabled={busy}
                  onPress={() => void run({ action: "run" })}
                >
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
          {!snapshot && !recovery && !account.signedOut && !unlinked ? (
            <Action
              disabled={busy}
              onPress={() =>
                void perform(async () => {
                  await marmotAccounts.resumeSetup();
                  await releaseDevicePairing();
                  if (live.current) await complete();
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
                  await releaseDevicePairing();
                  if (live.current) await complete();
                })
              }
            >
              {t("messenger:signIn")}
            </Action>
          ) : null}
          {!snapshot && !recovery && !unlinked ? (
            <Action variant="soft" disabled={busy} onPress={reenter}>
              {t("messenger:setupReenter")}
            </Action>
          ) : null}
          {snapshot?.ready && !account.signedOut && !unlinked ? (
            <>
              {deviceController ? (
                <>
                  <DevicePairing controller={deviceController} />
                  <ListGroup title={t("devices:discovery")}>
                    <SettingsDescription>
                      {t("devices:discoveryHelp")}
                    </SettingsDescription>
                    {showingPriorSignIns ? (
                      <SettingsDescription>
                        {t("devices:staleSignIns")}
                      </SettingsDescription>
                    ) : null}
                    {deviceState.connection !== "observing" ? (
                      <SettingsDescription>
                        {t(
                          deviceState.connection === "reconnecting"
                            ? "devices:reconnecting"
                            : "devices:loading",
                        )}
                      </SettingsDescription>
                    ) : null}
                    {checkingSignIns ? (
                      <SettingsDescription>
                        {t("devices:checkingSignIns")}
                      </SettingsDescription>
                    ) : null}
                    {deviceState.discovery === "failed" ||
                    deviceState.failed.includes("signIns") ? (
                      <SettingsDescription>
                        {t("devices:checkFailed")}
                      </SettingsDescription>
                    ) : null}
                    {deviceActionFailed ? (
                      <SettingsDescription>
                        {t("devices:operationFailed")}
                      </SettingsDescription>
                    ) : null}
                    {signInsLoaded && signIns.length === 0 ? (
                      <SettingsDescription>
                        {t("devices:discoveryEmpty")}
                      </SettingsDescription>
                    ) : null}
                    {signIns?.slice(0, 8).map((record) => (
                      <ListRow
                        key={record.slotIdHex}
                        icon="devices"
                        title={record.client || t("devices:unknownClient")}
                        detail={t(
                          record.beforeThisDevice
                            ? "devices:signInOlder"
                            : "devices:signInNew",
                        )}
                      />
                    ))}
                    <ListRow
                      icon="search"
                      title={t("devices:check")}
                      disabled={
                        !deviceController ||
                        deviceState.connection !== "observing" ||
                        deviceState.operation !== null ||
                        busy
                      }
                      onPress={checkSignIns}
                    />
                  </ListGroup>
                  {canStartFresh ? (
                    <Action
                      variant="soft"
                      disabled={deviceState.operation !== null || busy}
                      onPress={startFresh}
                    >
                      {t("devices:startFresh")}
                    </Action>
                  ) : null}
                  {deviceState.projections.startedFresh ? (
                    <Ink>{t("devices:startedFresh")}</Ink>
                  ) : null}
                </>
              ) : null}
              {deviceState.projections.pairing?.newDevice?.kind !==
                "linked" && (
                <SettingsDescription>
                  {t("devices:continueAloneHelp")}
                </SettingsDescription>
              )}
              <Action
                disabled={busy}
                onPress={() =>
                  void perform(async () => {
                    await releaseDevicePairing();
                    if (live.current) await complete();
                  })
                }
              >
                {t(
                  deviceState.projections.pairing?.newDevice?.kind === "linked"
                    ? "messenger:setupFinish"
                    : "devices:continueAlone",
                )}
              </Action>
            </>
          ) : null}
          {!snapshot?.ready && (
            <Action variant="soft" disabled={busy} onPress={discard}>
              {t("messenger:discardSetup")}
            </Action>
          )}
        </>
      )}
    </Screen>
  );
}
