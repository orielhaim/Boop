import { randomUUID } from "expo-crypto";
import { getDocumentAsync } from "expo-document-picker";
import { File } from "expo-file-system";
import * as ScreenCapture from "expo-screen-capture";
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import {
  AppState,
  BackHandler,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import Animated, {
  cancelAnimation,
  FadeIn,
  interpolate,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { openingMotion, openingPalette } from "@/components/opening/brand";
import { OpeningButton, OpeningField } from "@/components/opening/controls";
import { useOpeningForeground } from "@/components/opening/curtain";
import { OpeningScene } from "@/components/opening/scene";
import { AccountSetup } from "@/components/account-setup";
import { LockScreen } from "@/components/settings/lock-screen";
import { Icon } from "@/components/ui/kit";
import { backupKind, createOrImportIdentity } from "@/core/identity";
import { toNpub } from "@/core/identity/keys";
import { marmotAccounts } from "@/core/marmot/native";
import { preference, setPreference } from "@/db/queries";
import { directionFor, namespaces, resolveLanguage } from "@/i18n";
import { finishOnboarding, type initializeLocal } from "@/services/local";
import { useTheme } from "@/theme";

type Welcome = Extract<
  Awaited<ReturnType<typeof initializeLocal>>,
  { status: "welcome" }
>;
type Mode = "welcome" | "create" | "signIn";
const introKey = "opening.introSeen";
const secureInput = {
  secureTextEntry: true,
  autoCapitalize: "none",
  autoCorrect: false,
  spellCheck: false,
  autoComplete: "off",
  importantForAutofill: "no",
} as const;

// Serialize release and reacquisition of iOS's window-scoped privacy blur.
let protectionTurn = Promise.resolve();

export function Onboarding(props: {
  data: Welcome;
  initializing: boolean;
  onComplete: () => void;
}) {
  const { lock } = props.data;
  const [reenter, setReenter] = useState(false);
  const state = useSyncExternalStore(lock.subscribe, lock.getState);
  useEffect(() => {
    const update = (next: typeof AppState.currentState) =>
      lock.setActive(next === "active");
    update(AppState.currentState);
    const listener = AppState.addEventListener("change", update);
    return () => listener.remove();
  }, [lock]);
  if (!state.hasOpened || (state.enabled && (!state.active || state.locked)))
    return <LockScreen lock={lock} state={state} />;
  if (props.data.account && !reenter && !props.initializing) {
    return (
      <AccountSetup
        account={props.data.account}
        initial={props.data.setup}
        previousAccount={props.data.previousAccount}
        db={props.data.db}
        complete={() => {
          finishOnboarding(props.data.db);
          props.onComplete();
        }}
        reenter={() => setReenter(true)}
      />
    );
  }
  return <WelcomeForm {...props} />;
}

function WelcomeForm({
  data,
  initializing,
  onComplete,
}: {
  data: Welcome;
  initializing: boolean;
  onComplete: () => void;
}) {
  const { t, i18n } = useTranslation(namespaces);
  const direction = directionFor(resolveLanguage(i18n.resolvedLanguage));
  const { theme, colors, reduceMotion } = useTheme();
  const palette = openingPalette[theme];
  const insets = useSafeAreaInsets();
  const sidePadding = 24 + Math.max(insets.left, insets.right);
  const active = useOpeningForeground();
  const [mode, setMode] = useState<Mode>(data.account ? "signIn" : "welcome");
  const [skip, setSkip] = useState(false);
  const [introduced, setIntroduced] = useState(false);
  const [first] = useState(
    () => !initializing && preference(data.db, introKey) !== "yes",
  );
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [input, setInput] = useState("");
  const [password, setPassword] = useState("");
  const [candidate, setCandidate] = useState<{
    token: string;
    publicKey: string;
  }>();
  const importToken = useRef<string>(undefined);
  const [notice, setNotice] = useState<
    "saveFailed" | "invalidKey" | "invalidFile" | "protection"
  >();
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [protectedWindow, setProtectedWindow] = useState(false);
  const [height, setHeight] = useState(0);
  const [hero, setHero] = useState({ center: 0, size: 0.86 });
  const [formTop, setFormTop] = useState(0);
  const working = useRef(false);
  const pickerGeneration = useRef(0);
  const protection = useId();
  const intro = useSharedValue(0);
  const form = useSharedValue(0);
  const formScroll = useSharedValue(0);
  const scrollForm = useAnimatedScrollHandler(({ contentOffset }) => {
    formScroll.set(contentOffset.y);
  });
  const restore = useSharedValue(0);
  const establishing = useSharedValue(initializing ? 1 : 0);
  const hold = busy || initializing;
  const isForm = mode !== "welcome";
  const measured = height > 0 && hero.center > 0;

  useEffect(() => {
    if (!active || !measured || introduced || initializing) return;
    const duration = reduceMotion
      ? openingMotion.reduced
      : skip
        ? 240
        : first
          ? openingMotion.intro
          : 720;
    intro.set(
      withTiming(
        1,
        {
          duration: skip
            ? duration
            : Math.max(90, duration * (1 - intro.get())),
          easing: first && !skip ? openingMotion.cinema : openingMotion.glide,
        },
        (finished) => {
          if (finished) scheduleOnRN(setIntroduced, true);
        },
      ),
    );
    return () => cancelAnimation(intro);
  }, [
    active,
    first,
    introduced,
    initializing,
    intro,
    measured,
    reduceMotion,
    skip,
  ]);

  useEffect(() => {
    if (!introduced || !first || initializing) return;
    try {
      setPreference(data.db, introKey, "yes");
    } catch {
      // Intro completion must never block identity setup.
    }
  }, [data.db, first, initializing, introduced]);

  const reviewing = candidate !== undefined;
  useEffect(() => {
    const settings = {
      duration: reduceMotion ? 0 : openingMotion.settle,
      easing: openingMotion.glide,
    };
    form.set(withTiming(isForm ? 1 : 0, settings));
    restore.set(
      withTiming(mode !== "signIn" ? 0 : reviewing ? 0.56 : 1, settings),
    );
    establishing.set(withTiming(hold ? 1 : 0, settings));
  }, [
    establishing,
    form,
    hold,
    isForm,
    mode,
    reduceMotion,
    restore,
    reviewing,
  ]);

  useEffect(() => {
    if (mode !== "signIn") return;
    let live = true;
    let switcher = false;
    const applied = protectionTurn
      .then(async () => {
        if (!live) return;
        await ScreenCapture.preventScreenCaptureAsync(protection);
        if (Platform.OS === "ios" && !data.lock.getState().enabled) {
          await ScreenCapture.enableAppSwitcherProtectionAsync(1);
          switcher = true;
        }
        if (live) setProtectedWindow(true);
      })
      .catch(() => {
        if (live) setNotice("protection");
      });
    const state = AppState.addEventListener("change", (next) => {
      if (next !== "active") {
        setInput("");
        setPassword("");
        setCandidate(undefined);
        if (importToken.current)
          void marmotAccounts
            .discardImport(importToken.current)
            .catch(() => undefined);
        importToken.current = undefined;
      }
    });
    return () => {
      live = false;
      pickerGeneration.current += 1;
      if (importToken.current)
        void marmotAccounts
          .discardImport(importToken.current)
          .catch(() => undefined);
      importToken.current = undefined;
      state.remove();
      protectionTurn = applied
        .then(async () => {
          await ScreenCapture.allowScreenCaptureAsync(protection);
          if (switcher && !data.lock.getState().enabled)
            await ScreenCapture.disableAppSwitcherProtectionAsync();
        })
        .catch(() => undefined);
    };
  }, [data.lock, mode, protection]);

  function back() {
    if (hold || working.current) return;
    Keyboard.dismiss();
    setNotice(undefined);
    if (candidate) {
      void marmotAccounts.discardImport(candidate.token).catch(() => undefined);
      importToken.current = undefined;
      setCandidate(undefined);
      return;
    }
    pickerGeneration.current += 1;
    setInput("");
    setPassword("");
    setPicking(false);
    setProtectedWindow(false);
    formScroll.set(0);
    setMode("welcome");
  }

  useEffect(() => {
    if (!isForm) return;
    const handler = BackHandler.addEventListener("hardwareBackPress", () => {
      back();
      return true;
    });
    return () => handler.remove();
  });

  function canUseIdentity() {
    return AppState.currentState === "active" && !data.lock.getState().locked;
  }

  function advance() {
    finishOnboarding(data.db);
    setInput("");
    setPassword("");
    setCandidate(undefined);
    onComplete();
  }

  async function install(
    details: Parameters<typeof createOrImportIdentity>[1],
  ) {
    if (working.current || !canUseIdentity()) return;
    working.current = true;
    Keyboard.dismiss();
    setBusy(true);
    setNotice(undefined);
    try {
      await createOrImportIdentity(data.db, details, data.relays);
      advance();
    } catch {
      setNotice("saveFailed");
      setBusy(false);
    } finally {
      working.current = false;
    }
  }

  async function review() {
    if (!protectedWindow || !canUseIdentity() || working.current) return;
    working.current = true;
    Keyboard.dismiss();
    const token = randomUUID();
    importToken.current = token;
    setInput("");
    setPassword("");
    setNotice(undefined);
    try {
      const publicKey = await marmotAccounts.prepareImport(
        token,
        input,
        password,
      );
      if (importToken.current === token && canUseIdentity())
        setCandidate({ token, publicKey });
    } catch {
      if (importToken.current === token) setNotice("invalidKey");
    } finally {
      working.current = false;
    }
  }

  async function chooseFile() {
    if (picking || !protectedWindow || !canUseIdentity()) return;
    const generation = ++pickerGeneration.current;
    setPicking(true);
    setNotice(undefined);
    setPassword("");
    try {
      const selected = await getDocumentAsync({
        type: "*/*",
        copyToCacheDirectory: false,
      });
      if (selected.canceled || generation !== pickerGeneration.current) return;
      const asset = selected.assets[0];
      if (!asset || (asset.size ?? 0) > 512) throw new Error("Invalid backup");
      const handle = new File(asset.uri).open();
      try {
        const bytes = await handle.readBytes(513);
        try {
          if (!bytes.length || bytes.length > 512)
            throw new Error("Invalid backup");
          const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          if (backupKind(value) !== "encrypted")
            throw new Error("Invalid backup");
          if (generation === pickerGeneration.current && canUseIdentity())
            setInput(value);
        } finally {
          bytes.fill(0);
        }
      } finally {
        handle.close();
      }
    } catch {
      if (generation === pickerGeneration.current) setNotice("invalidFile");
    } finally {
      if (generation === pickerGeneration.current) setPicking(false);
    }
  }

  const welcomeCopy = useAnimatedStyle(() => ({
    opacity:
      interpolate(intro.get(), [0.67, 0.91], [0, 1], "clamp") *
      (1 - form.get()),
    transform: [
      {
        translateY: reduceMotion ? 0 : 20 * (1 - intro.get()) + 12 * form.get(),
      },
    ],
  }));
  const welcomeActions = useAnimatedStyle(() => ({
    opacity:
      interpolate(intro.get(), [0.74, 0.98], [0, 1], "clamp") *
      (1 - form.get()),
    transform: [
      {
        translateY: reduceMotion ? 0 : 40 * (1 - intro.get()) + 20 * form.get(),
      },
    ],
  }));
  const formEntry = useAnimatedStyle(() => ({
    opacity: form.get() * (1 - establishing.get()),
    transform: [{ translateY: reduceMotion ? 0 : 14 * (1 - form.get()) }],
  }));
  const waiting = useAnimatedStyle(() => ({
    opacity: interpolate(establishing.get(), [0.38, 1], [0, 1], "clamp"),
  }));

  const formTitle = t(
    candidate
      ? "messenger:reviewIdentity"
      : mode === "signIn"
        ? "messenger:signIn"
        : "messenger:create",
  );
  const progressLabel = t(
    initializing
      ? "common:opening"
      : mode === "create"
        ? "messenger:creating"
        : "messenger:importing",
  );
  const enter = reduceMotion
    ? undefined
    : FadeIn.duration(230).easing(openingMotion.glide);
  const showSecrets = protectedWindow && active && !hold;

  return (
    <View
      style={[styles.screen, { direction, backgroundColor: palette.base }]}
      onLayout={({ nativeEvent }) => setHeight(nativeEvent.layout.height)}
    >
      <OpeningScene
        intro={intro}
        form={form}
        restore={restore}
        busy={establishing}
        holding={hold && active}
        scroll={formScroll}
        height={height}
        heroCenter={hero.center}
        heroSize={hero.size}
        formCenter={formTop || insets.top + 96}
      />
      {!hold && (
        <View
          style={styles.welcomeLayer}
          pointerEvents={isForm ? "none" : "auto"}
          accessibilityElementsHidden={isForm}
          importantForAccessibility={isForm ? "no-hide-descendants" : "auto"}
        >
          <ScrollView
            bounces={false}
            scrollEnabled={!isForm}
            contentContainerStyle={[
              styles.welcome,
              {
                paddingHorizontal: sidePadding,
                paddingTop: insets.top + 12,
                paddingBottom: insets.bottom + 18,
              },
            ]}
          >
            <View
              style={styles.heroSpace}
              onLayout={({ nativeEvent: { layout } }) =>
                setHero({
                  center: layout.y + layout.height / 2,
                  size: Math.min(
                    1.1,
                    (layout.width + 22) / 360,
                    (layout.height + 37) / 320,
                  ),
                })
              }
            />
            <Animated.View
              accessible
              accessibilityRole="header"
              accessibilityLabel={`Boop. ${t("messenger:openingTagline")}`}
              accessibilityElementsHidden={!introduced}
              importantForAccessibility={
                introduced ? "yes" : "no-hide-descendants"
              }
              style={[styles.wordmark, welcomeCopy]}
            >
              <Text style={[styles.brandName, { color: palette.ink }]}>
                Boop
              </Text>
              <Text style={[styles.tagline, { color: colors.muted }]}>
                {t("messenger:openingTagline")}
              </Text>
            </Animated.View>
            <Animated.View
              pointerEvents={!isForm && introduced ? "auto" : "none"}
              accessibilityElementsHidden={!introduced}
              importantForAccessibility={
                introduced ? "auto" : "no-hide-descendants"
              }
              style={[styles.actions, styles.welcomeActions, welcomeActions]}
            >
              <OpeningButton
                primary
                disabled={isForm}
                label={t("messenger:create")}
                onPress={() => setMode("create")}
              />
              <OpeningButton
                disabled={isForm}
                label={t("messenger:signIn")}
                onPress={() => setMode("signIn")}
              />
            </Animated.View>
          </ScrollView>
        </View>
      )}
      {isForm ? (
        <KeyboardAvoidingView
          style={styles.fill}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <Animated.ScrollView
            onScroll={scrollForm}
            scrollEventThrottle={16}
            contentContainerStyle={[
              styles.formScroll,
              {
                paddingHorizontal: sidePadding,
                paddingTop: insets.top + 7,
                paddingBottom: insets.bottom + 18,
              },
            ]}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "none"}
            pointerEvents={hold ? "none" : "auto"}
            accessibilityElementsHidden={hold}
            importantForAccessibility={hold ? "no-hide-descendants" : "auto"}
          >
            <Animated.View style={[styles.formFrame, formEntry]}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("common:back")}
                onPress={back}
                style={({ pressed }) => [
                  styles.back,
                  {
                    backgroundColor: pressed ? colors.selected : colors.raised,
                    borderColor: colors.line,
                  },
                ]}
              >
                <Icon name="back" size={21} color={palette.ink} />
              </Pressable>
              <View style={styles.formLead} />
              <View
                style={styles.formArt}
                onLayout={({ nativeEvent: { layout } }) =>
                  setFormTop(insets.top + 7 + layout.y + layout.height / 2)
                }
              />
              {!hold && (
                <Animated.View
                  key={candidate ? "review" : mode}
                  entering={enter}
                  style={styles.formBody}
                >
                  <Text
                    accessibilityRole="header"
                    style={[styles.heading, { color: palette.ink }]}
                  >
                    {formTitle}
                  </Text>
                  <Text style={[styles.description, { color: colors.muted }]}>
                    {t(
                      candidate
                        ? "messenger:reviewAddressHint"
                        : mode === "create"
                          ? "messenger:publicIntro"
                          : "messenger:privateKeyHelp",
                    )}
                  </Text>
                  {mode === "create" ? (
                    <>
                      <OpeningField
                        label={t("messenger:publicName")}
                        autoCapitalize="words"
                        value={name}
                        maxLength={128}
                        onChangeText={setName}
                      />
                      <OpeningField
                        label={t("messenger:optionalAbout")}
                        value={about}
                        maxLength={1000}
                        multiline
                        onChangeText={setAbout}
                      />
                    </>
                  ) : candidate && active ? (
                    <View
                      style={[
                        styles.addressPanel,
                        {
                          borderColor: colors.line,
                          backgroundColor: colors.raised,
                        },
                      ]}
                    >
                      <Icon name="key" size={22} color={colors.accent} />
                      <Text
                        selectable
                        style={[styles.address, { color: palette.ink }]}
                      >
                        {toNpub(candidate.publicKey)}
                      </Text>
                    </View>
                  ) : showSecrets ? (
                    <>
                      <OpeningField
                        label={t("messenger:privateKey")}
                        {...secureInput}
                        maxLength={168}
                        value={input}
                        onChangeText={(value) => {
                          setInput(value);
                          setPassword("");
                          setNotice(undefined);
                        }}
                      />
                      {backupKind(input) === "encrypted" && (
                        <Animated.View entering={enter}>
                          <OpeningField
                            label={t("security:backupPassword")}
                            {...secureInput}
                            maxLength={512}
                            value={password}
                            onChangeText={setPassword}
                          />
                        </Animated.View>
                      )}
                    </>
                  ) : null}
                  {notice && (
                    <Animated.Text
                      entering={enter}
                      accessibilityLiveRegion="polite"
                      style={[styles.notice, { color: colors.danger }]}
                    >
                      {t(
                        notice === "protection"
                          ? "security:backupFailed"
                          : `messenger:${notice}`,
                      )}
                    </Animated.Text>
                  )}
                </Animated.View>
              )}
              <View style={styles.spacer} />
              {!hold && (
                <View style={styles.actions}>
                  {notice === "saveFailed" ? (
                    <OpeningButton
                      primary
                      label={t("common:retry")}
                      onPress={() => {
                        if (canUseIdentity()) advance();
                      }}
                    />
                  ) : mode === "create" ? (
                    <OpeningButton
                      primary
                      label={t("messenger:create")}
                      disabled={!name.trim()}
                      onPress={() => void install({ name, about })}
                    />
                  ) : candidate && active ? (
                    <OpeningButton
                      primary
                      label={t("messenger:confirmImport")}
                      icon="check"
                      onPress={() =>
                        void install({ importToken: candidate.token })
                      }
                    />
                  ) : showSecrets ? (
                    <>
                      <OpeningButton
                        primary
                        label={t("messenger:reviewIdentity")}
                        disabled={picking || !input.trim()}
                        onPress={() => void review()}
                      />
                      <OpeningButton
                        label={t("messenger:importFile")}
                        icon="download"
                        disabled={picking}
                        onPress={() => void chooseFile()}
                      />
                    </>
                  ) : null}
                </View>
              )}
            </Animated.View>
          </Animated.ScrollView>
        </KeyboardAvoidingView>
      ) : null}
      {first && !introduced && !skip && !reduceMotion && (
        <Pressable
          accessibilityRole="button"
          onPress={() => setSkip(true)}
          style={[styles.skip, { top: insets.top + 8 }]}
        >
          <Text style={[styles.label, { color: colors.muted }]}>
            {t("messenger:skipIntro")}
          </Text>
        </Pressable>
      )}
      {hold && (
        <Animated.View
          accessible
          accessibilityState={{ busy: true }}
          accessibilityLiveRegion="polite"
          style={[styles.waiting, { top: height / 2 + 52 }, waiting]}
        >
          <Text
            style={[styles.description, styles.center, { color: colors.muted }]}
          >
            {progressLabel}
          </Text>
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, overflow: "hidden" },
  fill: { flex: 1 },
  welcomeLayer: StyleSheet.absoluteFill,
  welcome: { flexGrow: 1 },
  heroSpace: { flexGrow: 1, width: "100%", minHeight: 150 },
  wordmark: { alignItems: "center", paddingHorizontal: 12, paddingBottom: 20 },
  brandName: {
    fontSize: 79,
    letterSpacing: -5.3,
    lineHeight: 86,
    fontWeight: "800",
    textAlign: "center",
  },
  tagline: {
    fontSize: 17,
    lineHeight: 24,
    fontWeight: "500",
    textAlign: "center",
  },
  actions: { width: "100%", maxWidth: 440, alignSelf: "center", gap: 10 },
  welcomeActions: { marginTop: 10 },
  skip: {
    position: "absolute",
    end: 16,
    minHeight: 48,
    paddingHorizontal: 12,
    justifyContent: "center",
  },
  label: { fontSize: 14, fontWeight: "600" },
  formScroll: { flexGrow: 1 },
  formFrame: { flexGrow: 1, maxWidth: 440, width: "100%", alignSelf: "center" },
  back: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    alignSelf: "flex-start",
  },
  formLead: { flexGrow: 0.7 },
  formArt: { height: 92 },
  formBody: { gap: 14 },
  heading: {
    fontSize: 37,
    lineHeight: 43,
    letterSpacing: -1.2,
    fontWeight: "800",
  },
  description: { fontSize: 16, lineHeight: 23 },
  spacer: { minHeight: 27, flexGrow: 1 },
  center: { textAlign: "center" },
  notice: { fontSize: 14, lineHeight: 20, fontWeight: "600" },
  addressPanel: {
    gap: 12,
    padding: 20,
    borderWidth: 1,
    borderRadius: 22,
    marginTop: 6,
  },
  address: {
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 15,
    lineHeight: 24,
    writingDirection: "ltr",
    textAlign: "left",
  },
  waiting: { position: "absolute", start: 24, end: 24, alignItems: "center" },
});
