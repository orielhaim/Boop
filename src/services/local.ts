import { createBlockedUsers } from "@/core/marmot/blocked-users";
import { createAudioController } from "@/core/audio/controller";
import { createNativePlayback, setupPlayback } from "@/core/audio/engine";
import { createAudioSources } from "@/core/audio/sources";
import { speeds, voiceOrigin, type Track } from "@/core/audio/types";
import { audioPersistence } from "@/db/audio";
import {
  addBatteryStateListener,
  addLowPowerModeListener,
  BatteryState,
  getBatteryStateAsync,
} from "expo-battery";
import {
  addNetworkStateListener,
  getNetworkStateAsync,
  NetworkStateType,
} from "expo-network";
import { createDownloadManager } from "@/core/downloads/manager";
import { createBlossomDownloads } from "@/core/downloads/blossom-transfer";
import { marmotDownloads } from "@/core/downloads/marmot";
import { downloadTransports } from "@/core/downloads/transport";
import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { downloadStore } from "@/db/downloads";
import { priority as speechPriority } from "@/core/speech/scheduler";
import { createMediaSdk } from "@/core/media";
import { createNativeLinkPreviews } from "@/core/messaging/native-link-previews";
import { File } from "expo-file-system";
import { getRandomValues } from "expo-crypto";
import { uploadAvatar } from "@/core/avatars/blossom";
import { createProfileEditor } from "@/core/avatars/editor";
import { createAvatars } from "@/core/avatars/service";
import { createProfileDirectory } from "@/core/profiles/directory";
import { getLocales } from "expo-localization";
import { addDatabaseChangeListener } from "expo-sqlite";
import { AppState } from "react-native";
import { createStore } from "zustand/vanilla";
import { createCallSignalingService } from "@/core/calling/signaling-service";
import { createNip05Lookup } from "@/core/nostr/nip05-lookup";
import { createBlossomServerList } from "@/core/media/server-list";
import {
  connectivityRestored,
  type NetworkRoute,
} from "@/core/nostr/connectivity";
import { createAccountRelays } from "@/core/nostr/account-relays";
import { createRelayService } from "@/core/nostr/relay-service";
import { createCallController } from "@/core/calling/controller";
import { attachGroupCallLifecycle } from "@/core/calling/group-call-lifecycle";
import { callTone } from "@/core/calling/native-audio";
import {
  attachSystemPresentation,
  openTelecomAudio,
} from "@/core/calling/system-calling";
import {
  initializeCallingRuntime,
  randomCallId,
  trysteroMedia,
} from "@/core/calling/trystero";
import {
  accountDownloadKey,
  accountSigner,
  copyInstallationPreferences,
  removeLocalAccount,
  selectedAccount,
  selectAccount,
} from "@/core/identity";
import { createChatPreferences } from "@/core/marmot/chat-preferences";
import { createMarmotSession } from "@/core/marmot/account-session";
import { createMarmotViewport } from "@/core/marmot/viewport";
import {
  marmot,
  marmotAccounts,
  marmotBlocks,
  marmotDirectory,
  marmotRelays,
} from "@/core/marmot/native";
import { toNpub } from "@/core/identity/keys";
import { messagingMetric } from "@/core/messaging/diagnostics";
import { createConversationCache } from "@/core/marmot/conversations";
import {
  callHandoffPreference,
  callInboxDisabledPreference,
  discoveryPreference,
  initialAccountRelays,
  readDiscovery,
  readCallHandoff,
  relayRoutes,
  sameRelays,
} from "@/core/nostr/config";
import { createPrivacy } from "@/core/privacy";
import { type AppLock, createAppLock } from "@/core/security/app-lock";
import { authenticateApp, protectAppWindow } from "@/core/security/native-auth";
import { loadTranslationEngine } from "@/core/translation/native";
import { initializeTranslationPreferences } from "@/core/translation/preferences";
import { createTranslationService } from "@/core/translation/service";
import { createVoiceTranscription, speechSource } from "@/core/speech/service";
import { openDatabase } from "@/db";
import {
  callById,
  contactByKey,
  preference,
  saveCallRecord,
  setPreference,
  updateContactPreferences,
} from "@/db/queries";
import { createDerivedTranslations } from "@/db/translations";
import { purgeExpiredOpenedMessages } from "@/db/open-later";
import { i18n, preferredLanguage, resolveLanguage } from "@/i18n";
import { readLanguagePreference } from "@/i18n/preference";

async function start() {
  const started = performance.now();
  const installation = await openDatabase();
  let db = installation;
  try {
    const initialRelays = initialAccountRelays;
    const { account, accounts } = await selectedAccount(
      installation,
      initialRelays,
    );
    const setup =
      account && !account.unlinked && account.readiness !== "recovery_required"
        ? await marmotAccounts.onboarding(account.key, { action: "read" })
        : null;
    const ready =
      account &&
      !account.signedOut &&
      !account.unlinked &&
      (account.readiness === "local_ready" ||
        account.readiness === "publishing" ||
        account.readiness === "network_ready") &&
      (!setup || setup.ready);
    if (account && !ready) {
      for (const old of accounts) {
        if (old.key !== account.key && !old.signedOut && !old.unlinked)
          await marmotAccounts.signOut(old.key);
      }
    }
    const initialProfile = ready
      ? await marmotAccounts.selectSigner(account.key)
      : null;
    if (ready) {
      selectAccount(installation, account.key);
      for (const old of accounts) {
        if (old.key === account.key) continue;
        await removeLocalAccount(old.key);
      }
      db = await openDatabase(account.key);
      if (preference(db, "account.preferences.initialized") === null) {
        copyInstallationPreferences(installation, db);
        setPreference(db, "account.preferences.initialized", "1");
      }
      installation.$client.closeSync();
    }
    const language = readLanguagePreference(db);
    await i18n.changeLanguage(
      preferredLanguage(
        language,
        language === "auto" ? getLocales()[0]?.languageCode : undefined,
      ),
    );
    const lock = createAppLock({
      read: (key) => preference(db, key),
      write: (key, value) => setPreference(db, key, value),
      startActive: AppState.currentState === "active",
      authenticate: authenticateApp,
      protect: protectAppWindow,
    });
    appLock = lock;
    if (!ready || !initialProfile) {
      return {
        status: "welcome" as const,
        db,
        account,
        setup,
        previousAccount: accounts.find((item) => item.key !== account?.key)
          ?.key,
        relays: initialRelays,
        lock,
        theme: preference(db, "theme"),
        haptics: preference(db, "haptics") !== "off",
      };
    }
    const identity = { publicKey: account.key, npub: toNpub(account.key) };
    let retired = false;
    const isCurrent = () => !retired;
    const active = () =>
      isCurrent() &&
      AppState.currentState === "active" &&
      !lock.getState().locked;
    const signer = accountSigner(account.key, active);
    const downloadKey = await accountDownloadKey(account.key);
    initializeTranslationPreferences(db, resolveLanguage(i18n.language));
    purgeExpiredOpenedMessages(db);
    const chatPreferences = createChatPreferences(db);
    const blocks = createBlockedUsers(identity.publicKey, {
      observe: marmotBlocks.observe,
      set(owner, key, blocked) {
        if (!active()) throw new Error("AccountClosed");
        return marmotBlocks.set(owner, key, blocked);
      },
    });
    const privacy = createPrivacy(db, blocks);
    const mediaSdk = createMediaSdk(db, signer);
    const messagingStarted = performance.now();
    const relays = createRelayService(
      signer,
      readCallHandoff(preference(db, callHandoffPreference)),
      (rows) => setPreference(db, callHandoffPreference, JSON.stringify(rows)),
    );
    const accountRelays = createAccountRelays({
      owner: account.key,
      source: marmotRelays,
      initial: {
        discovery: readDiscovery(preference(db, discoveryPreference)),
        incomingCalls: preference(db, callInboxDisabledPreference) !== "1",
      },
      save({ discovery, incomingCalls }) {
        if (discovery)
          setPreference(db, discoveryPreference, JSON.stringify(discovery));
        if (incomingCalls !== undefined)
          setPreference(
            db,
            callInboxDisabledPreference,
            incomingCalls ? "0" : "1",
          );
      },
      eligibility: () => (active() ? relays.generation() : null),
      prepareInbox: relays.prepareInbox,
      configure: relays.configure,
    });
    const callSignaling = createCallSignalingService({
      signer,
      relays,
      isBlocked: privacy.isBlocked,
      canReceiveCall: privacy.canReceiveCall,
    });
    const blossomLists = createBlossomServerList(
      relays,
      identity.publicKey,
      active,
    );
    const nip05 = createNip05Lookup(active);
    const { disk, localDirectory } = mediaSdk.profileFiles;
    const profiles = createProfileDirectory(
      {
        read: (keys) => marmotDirectory.read(account.key, keys),
        refresh: (key, routes) =>
          marmotDirectory.refresh(account.key, key, routes),
      },
      active,
      privacy.isBlocked,
      () => relayRoutes(relays.configuration()).slice(0, 8),
    );
    const avatars = createAvatars(
      db,
      account.key,
      privacy,
      profiles,
      disk,
      mediaSdk.profileDownload,
      mediaSdk.profileMirrors,
      isCurrent,
      (): string[] => profileEditor.draftFiles(),
    );
    const profileEditor = createProfileEditor(
      db,
      disk,
      (filename, signal, wide) =>
        uploadAvatar(
          mediaSdk,
          new File(localDirectory, filename),
          signal,
          wide,
        ),
      async (edits, signal) => {
        if (signal.aborted || !active()) throw new Error("AccountClosed");
        await marmotDirectory.update(account.key, edits);
        if (active()) profiles.reload(account.key);
      },
      avatars.keepUploaded,
      isCurrent,
      () => marmotAccounts.networkReady(account.key),
    );
    let beforeAccountClose: (() => Promise<void>) | undefined;
    const marmotSession = createMarmotSession({
      async open(discovery, mediaOrigin) {
        if (!isCurrent()) throw new Error("AccountClosed");
        return marmotAccounts.open(
          account.key,
          { general: initialRelays.general, discovery },
          mediaOrigin,
        );
      },
      close: marmot.closeAccount,
      beforeClose: () => beforeAccountClose?.(),
    });
    const messagingAvailable = () =>
      blocks.ready() &&
      chatPreferences.enabled() &&
      marmotSession.status() === "ready";
    const canReadConversations = () =>
      isCurrent() && !lock.getState().locked && messagingAvailable();
    const conversations = createConversationCache({
      open: marmot.openConversation,
      canOpen: canReadConversations,
    });
    function updateConversations() {
      conversations.setAvailable(canReadConversations());
    }
    privacy.subscribe(avatars.invalidate);
    messagingMetric("runtime initialized", {
      ms: performance.now() - messagingStarted,
    });
    const marmotViewport = createMarmotViewport(
      identity.publicKey,
      () => active() && lock.getState().active && messagingAvailable(),
      privacy.isBlocked,
    );
    const previews = createNativeLinkPreviews(
      db,
      privacy,
      mediaSdk,
      marmotViewport,
    );
    lock.subscribe(previews.revalidate);
    chatPreferences.subscribe(previews.revalidate);
    const media = trysteroMedia(
      signer,
      {
        get(peerKey) {
          if (privacy.isBlocked(peerKey)) return "unknown";
          const row = contactByKey(db, peerKey).get();
          return row ? (row.allowIncomingVideo ? "always" : "ask") : "unknown";
        },
        allow(peerKey) {
          return (
            !privacy.isBlocked(peerKey) &&
            updateContactPreferences(db, peerKey, {
              allowIncomingVideo: true,
            }).changes === 1
          );
        },
      },
      ({ invite, peerKey, signal, onRouting }) => {
        const privateMode = lock.getState().enabled;
        const contact = contactByKey(db, peerKey).get();
        return openTelecomAudio({
          id: invite.callId,
          name: contact?.name ?? `${toNpub(peerKey).slice(0, 15)}…`,
          avatar: () => avatars.resolve(peerKey),
          subscribeAvatar: (listener) => avatars.subscribe(peerKey, listener),
          incoming: invite.recipientKey === identity.publicKey,
          privateMode,
          signal,
          onRouting,
        });
      },
      callSignaling.send,
      privacy.isBlocked,
    );
    const calling = createCallController({
      localKey: identity.publicKey,
      isBlocked: privacy.isBlocked,
      async authorizeGroup(group, peers) {
        if (!chatPreferences.enabled() || peers.some(privacy.isBlocked))
          return false;
        await marmotSession.ready();
        const details = await marmot.groupAccess(group, true);
        if (
          details.membership !== "member" ||
          details.kind !== "group" ||
          details.pendingInvitation ||
          details.pendingLeave ||
          details.disbanding ||
          details.unrecoverable ||
          details.lifecycle !== "stable"
        )
          return false;
        const current = new Set(details.members);
        return (
          current.has(identity.publicKey) &&
          peers.every((peer) => current.has(peer) && !privacy.isBlocked(peer))
        );
      },
      randomId: randomCallId,
      openMedia: media.open,
      prepareMedia: initializeCallingRuntime,
      prepareInvite: (invite, signal) => {
        void callSignaling
          .prepareRoute(invite.callId, invite.recipientKey)
          .catch(() => undefined);
        return media.prepare(invite, signal);
      },
      send: callSignaling.send,
      tone: callTone,
      record: (entry) => {
        db.transaction(() => {
          saveCallRecord(db, entry);
          if (
            entry.direction === "outgoing" &&
            entry.answeredAt !== null &&
            (entry.outcome === "completed" ||
              entry.outcome === "remote-disconnected")
          )
            privacy.noteCompletedCall(entry.peerKey);
        });
      },
      hasRecord: (id, invitationId) => {
        const entry = callById(db, id);
        return invitationId
          ? entry?.invitationIds.includes(invitationId) === true
          : !!entry;
      },
    });
    let previousBlocks: ReadonlySet<string> | undefined;
    blocks.subscribe(() => {
      profiles.authorizationChanged();
      const state = blocks.snapshot();
      if (state.status !== "ready") {
        previousBlocks = undefined;
        return;
      }
      const previous = previousBlocks;
      previousBlocks = state.keys;
      for (const key of state.keys) {
        if (previous?.has(key)) continue;
        calling.peerBlocked(key);
      }
    });
    callSignaling.subscribe((message) => {
      if (message.type === "call.rtc") media.receive(message);
      else calling.receive(message);
    });
    const nativeOpen = createStore<{ id: string | null }>(() => ({ id: null }));
    const callActive = ({ call }: ReturnType<typeof calling.store.getState>) =>
      Boolean(call && call.phase !== "ended");
    const speech = createVoiceTranscription({
      db,
      account: identity.publicKey,
      appLocale: () => i18n.language,
      active,
      available: messagingAvailable,
      audioBusy: () => callActive(calling.store.getState()),
      blocked: privacy.isBlocked,
      hidden: (group, id) => chatPreferences.hidden(group).includes(id),
    });
    const pendingVoiceNotes = new Map<
      string,
      NonNullable<ReturnType<typeof speechSource>>
    >();
    function admitDownloadedVoice() {
      if (!active() || !messagingAvailable()) return;
      for (const [key, voice] of pendingVoiceNotes) {
        pendingVoiceNotes.delete(key);
        speech.availableLocally(voice, speechPriority.download);
      }
    }
    const downloadScope = bytesToHex(sha256(downloadKey));
    const downloads = createDownloadManager({
      store: downloadStore(db, identity.publicKey, downloadKey, (size) =>
        getRandomValues(new Uint8Array(size)),
      ),
      transport: downloadTransports(
        marmotDownloads,
        createBlossomDownloads(
          downloadScope,
          () => mediaSdk.configured("attachment").map(({ origin }) => origin),
          blossomLists.discoverBlossomServers,
        ),
      ),
      eligible: active,
      available: (source) => source.kind === "http" || messagingAvailable(),
      authorized: (source) =>
        source.kind === "http" ||
        (!blocks.has(source.sender) &&
          !chatPreferences.hidden(source.target[0]).includes(source.target[1])),
      completed: (source) => {
        if (source.kind !== "marmot" || !source.voice) return;
        const { voice } = source;
        pendingVoiceNotes.set(JSON.stringify(voice.target), voice);
        admitDownloadedVoice();
      },
    });
    const read = (key: string) => preference(db, key);
    const write = (key: string, value: string) => setPreference(db, key, value);
    const allowed = (track: Track) =>
      track.kind === "device" ||
      ((track.source.expiresAt === null ||
        track.source.expiresAt > Date.now()) &&
        (track.source.kind === "http" ||
          (chatPreferences.enabled() &&
            !blocks.has(track.source.sender) &&
            !chatPreferences
              .hidden(track.source.target[0])
              .includes(track.source.target[1]))));
    let closingAudioAttachments = false;
    const audioSources = createAudioSources({
      scope: downloadScope,
      downloads,
      ready: () => !closingAudioAttachments && messagingAvailable(),
      allowed,
      canDownload: active,
      canImport: () => !lock.getState().locked,
      blocked: privacy.isBlocked,
      subscribePrivacy: blocks.subscribe,
    });
    const playback = audioPersistence({
      account: identity.publicKey,
      key: downloadKey,
      random: (size) => getRandomValues(new Uint8Array(size)),
      read,
      write,
    });
    const nativePlayback = createNativePlayback();
    const audio = createAudioController({
      saved: playback.load(),
      save: playback.save,
      preferences: {
        external: read("audio.open") === "external",
        voiceSpeed:
          speeds.find((speed) => String(speed) === read("audio.voiceSpeed")) ??
          1,
      },
      savePreferences({ external, voiceSpeed }) {
        write("audio.open", external ? "external" : "internal");
        write("audio.voiceSpeed", String(voiceSpeed));
      },
      acquire: audioSources.acquire,
      setup: setupPlayback,
      engine: nativePlayback.open,
      disposeEngine: nativePlayback.dispose,
      allowed,
      listened(track) {
        const origin = voiceOrigin(track);
        if (origin) chatPreferences.markListened(origin[0], origin[1]);
        if (
          track.kind === "attachment" &&
          track.source.kind === "marmot" &&
          track.source.voice
        )
          speech.availableLocally(track.source.voice, speechPriority.playing);
      },
      genericTitle: () => i18n.t("audio:privateTitle"),
    });
    audio.revalidate();
    audio.privacy(lock.getState());
    lock.subscribe(() => audio.privacy(lock.getState()));
    blocks.subscribe(audio.revalidate);
    chatPreferences.subscribe(audio.revalidate);

    marmotSession.subscribe(() => {
      if (marmotSession.status() === "ready") closingAudioAttachments = false;
    });
    beforeAccountClose = async () => {
      closingAudioAttachments = true;
      pendingVoiceNotes.clear();
      await audio.close();
      await Promise.all([
        speech.beforeAccountClose(),
        downloads.beforeAccountClose(),
      ]);
    };
    let stopObserving: (() => void) | undefined;

    function observeSession() {
      if (!isCurrent() || stopObserving) return;
      const databasePath =
        db.$client.getFirstSync<{ file: string }>(
          "SELECT file FROM pragma_database_list WHERE name = 'main'",
        )?.file ?? db.$client.databasePath;
      let checkAfterPrompt: ReturnType<typeof setTimeout> | undefined;
      const attachmentOrigin = () =>
        mediaSdk.configured("attachment")[0]?.origin ?? null;
      let mediaOrigin = attachmentOrigin();
      let discovery = accountRelays.snapshot().discovery;
      let mounted = true;
      let eligible = false;
      let catchUp: Promise<void> | undefined;
      let closeRelayLiveness: (() => void) | undefined;
      function observeRelayLiveness() {
        if (isCurrent() && eligible && marmotSession.status() === "ready") {
          if (closeRelayLiveness) return;
          try {
            closeRelayLiveness = marmotRelays.observe(
              identity.publicKey,
              (rows) => {
                const previous = accountRelays.snapshot().liveness;
                if (
                  !sameRelays(
                    previous.map(({ url }) => url),
                    rows.map(({ url }) => url),
                  )
                )
                  void accountRelays.refresh().catch(() => undefined);
                accountRelays.setLiveness(rows);
              },
              () => {
                closeRelayLiveness = undefined;
                accountRelays.setLiveness([]);
              },
            );
          } catch {
            accountRelays.setLiveness([]);
          }
        } else {
          closeRelayLiveness?.();
          closeRelayLiveness = undefined;
          accountRelays.setLiveness([]);
        }
      }
      let conditionsRevision = 0;
      function updateBackupConditions() {
        const revision = ++conditionsRevision;
        if (!chatPreferences.enabled()) return;
        void marmotSession
          .ready()
          .then(async () => {
            if (!mounted || revision !== conditionsRevision) return;
            const eligible = AppState.currentState === "active";
            if (!eligible) {
              await marmot.backupConditions(false, false);
              return;
            }
            const [network, battery] = await Promise.all([
              getNetworkStateAsync(),
              getBatteryStateAsync(),
            ]);
            if (
              mounted &&
              revision === conditionsRevision &&
              AppState.currentState === "active"
            ) {
              await marmot.backupConditions(
                network.type === NetworkStateType.WIFI &&
                  network.isConnected === true,
                battery === BatteryState.CHARGING ||
                  battery === BatteryState.FULL,
              );
            }
          })
          .catch(() => undefined);
      }
      function connectMessaging() {
        if (active() && chatPreferences.enabled())
          void marmotSession.start(discovery, mediaOrigin);
      }
      function observeBlocks() {
        if (mounted && isCurrent() && !marmotSession.transitioning())
          blocks.start();
        else blocks.stop();
      }
      function background() {
        calling.setForeground(false);
        if (calling.isRequestingMicrophone()) return;
        callSignaling.stop();
        relays.stop();
      }
      function catchUpMessaging() {
        if (catchUp || !chatPreferences.enabled()) return;
        catchUp = marmotSession
          .ready()
          .then(async () => {
            if (mounted && active()) await marmot.catchUp();
          })
          .catch(() => undefined)
          .finally(() => {
            catchUp = undefined;
          });
      }
      function updateRelayEligibility() {
        const next = active();
        if (!mounted || !isCurrent() || next === eligible) return;
        eligible = next;
        if (!next) {
          observeRelayLiveness();
          if (lock.getState().locked) {
            callSignaling.stop();
            relays.stop();
          }
          return;
        }
        if (blocks.ready()) callSignaling.start();
        relays.start();
        connectMessaging();
        marmotSession.reconnected();
        observeRelayLiveness();
        void accountRelays.refresh(true).catch(() => undefined);
        catchUpMessaging();
      }
      function syncPrivacyAndRouting() {
        downloads.sync();
        speech.sync();
        admitDownloadedVoice();
        const enabled = active();
        profiles.setActive(enabled);
        avatars.setActive(enabled);
        profileEditor.setActive(enabled);
        updateRelayEligibility();
        observeBlocks();
        recoverNetwork();
      }
      const update = (state: typeof AppState.currentState) => {
        clearTimeout(checkAfterPrompt);
        if (state === "active") calling.setForeground(true);
        else if (state === "background" && !lock.getState().authenticating)
          background();
        conversations.setForeground(state === "active");
        syncPrivacyAndRouting();
        updateBackupConditions();
      };
      let networkRevision = 0;
      let lastNetwork: NetworkRoute | undefined;
      let outboundWake = false;
      function updateNetwork(
        state: Awaited<ReturnType<typeof getNetworkStateAsync>>,
      ) {
        if (!mounted) return;
        const { isConnected, isInternetReachable, type } = state;
        downloads.network(
          isConnected !== false,
          type === NetworkStateType.CELLULAR,
        );
        if (isConnected === undefined) return;
        const connected = isConnected && isInternetReachable !== false;
        const previous = lastNetwork;
        if (previous?.connected === connected && previous.type === type) return;
        lastNetwork = { connected, type };
        updateBackupConditions();
        if (!connectivityRestored(previous, lastNetwork)) return;
        outboundWake = true;
        recoverNetwork();
      }
      function recoverNetwork() {
        if (!outboundWake || !lastNetwork?.connected || !active()) return;
        outboundWake = false;
        observeBlocks();
        relays.reconnect();
        profileEditor.retry();
        profiles.routesChanged();
        void accountRelays.refresh(true).catch(() => undefined);
        if (chatPreferences.enabled()) {
          marmotSession.reconnected();
          observeRelayLiveness();
          void marmotSession
            .ready()
            .then(async () => {
              if (mounted && active() && lastNetwork?.connected)
                await marmot.notifyConnectivityRestored();
            })
            .catch(() => undefined);
          catchUpMessaging();
        }
      }
      const disposers: (() => void)[] = [];
      function own(dispose: (() => void) | undefined) {
        if (dispose) disposers.push(dispose);
      }
      function ownSubscription(subscription: { remove(): void }) {
        own(() => subscription.remove());
      }
      const stop = () => {
        if (!mounted) return;
        mounted = false;
        conversations.setAvailable(false);
        conversations.setForeground(false);
        stopObserving = undefined;
        clearTimeout(checkAfterPrompt);
        for (const dispose of disposers.reverse()) dispose();
        blocks.stop();
        eligible = false;
        observeRelayLiveness();
        profiles.setActive(false);
        avatars.setActive(false);
        profileEditor.setActive(false);
        if (isCurrent()) void marmotSession.stop().catch(() => undefined);
        callSignaling.stop();
        relays.stop();
      };
      stopObserving = stop;
      try {
        own(
          attachSystemPresentation(calling, nativeOpen, {
            privateMode: () => lock.getState().enabled,
            subscribe: lock.subscribe,
          }),
        );
        own(speech.start());
        downloads.network(false, false);
        own(downloads.start());
        own(
          calling.store.subscribe((next, previous) => {
            const busy = callActive(next);
            if (busy === callActive(previous)) return;
            audio.call(busy);
            speech.sync();
          }),
        );
        audio.call(callActive(calling.store.getState()));
        ownSubscription(addLowPowerModeListener(speech.power));
        ownSubscription(
          AppState.addEventListener("memoryWarning", speech.memoryWarning),
        );
        ownSubscription(
          AppState.addEventListener(
            "memoryWarning",
            conversations.reclaimMemory,
          ),
        );
        own(
          attachGroupCallLifecycle({
            calling,
            localKey: identity.publicKey,
            ready: marmotSession.ready,
            client: marmot,
          }),
        );
        let profileRoutes = relayRoutes(relays.configuration());
        own(
          accountRelays.subscribe(() => {
            const next = accountRelays.snapshot().discovery;
            if (!sameRelays(discovery, next)) {
              discovery = next;
              connectMessaging();
            }
            const routes = relayRoutes(relays.configuration());
            if (!sameRelays(profileRoutes, routes)) {
              profileRoutes = routes;
              profiles.routesChanged();
            }
          }),
        );
        ownSubscription(
          addDatabaseChangeListener(({ databaseFilePath, tableName }) => {
            if (databaseFilePath === databasePath && tableName === "contacts") {
              queueMicrotask(() => {
                if (mounted && isCurrent()) avatars.invalidate();
              });
            }
          }),
        );
        own(
          blocks.subscribe(() => {
            speech.sync();
            if (!blocks.ready() || !active()) return;
            callSignaling.start();
            void speech.reconcile();
            downloads.accountReady();
          }),
        );
        own(
          lock.subscribe(() => {
            updateConversations();
            syncPrivacyAndRouting();
            if (
              lock.getState().authenticating ||
              AppState.currentState !== "background"
            )
              return;
            clearTimeout(checkAfterPrompt);
            checkAfterPrompt = setTimeout(() => {
              if (
                AppState.currentState === "background" &&
                !lock.getState().authenticating
              )
                background();
            }, 800);
          }),
        );
        ownSubscription(AppState.addEventListener("change", update));
        function updateConversationPrefetch() {
          const call = calling.store.getState().call;
          conversations.setCallActive(Boolean(call && call.phase !== "ended"));
        }
        own(calling.store.subscribe(updateConversationPrefetch));
        updateConversationPrefetch();
        own(
          blocks.subscribe(() => {
            conversations.clearIdle();
            updateConversations();
          }),
        );
        let chatsEnabled = chatPreferences.enabled();
        own(
          chatPreferences.subscribe(() => {
            const next = chatPreferences.enabled();
            if (next === chatsEnabled) return;
            chatsEnabled = next;
            updateConversations();
            speech.sync();
            if (next) connectMessaging();
            else void marmotSession.stop(true).catch(() => undefined);
          }),
        );
        own(
          mediaSdk.subscribe(() => {
            const next = attachmentOrigin();
            if (next === mediaOrigin) return;
            mediaOrigin = next;
            connectMessaging();
          }),
        );
        own(
          marmotSession.subscribe(() => {
            updateConversations();
            observeBlocks();
            observeRelayLiveness();
            speech.accountReady();
            if (marmotSession.status() === "ready") downloads.accountReady();
            admitDownloadedVoice();
            void speech.reconcile();
            updateBackupConditions();
          }),
        );
        ownSubscription(
          addBatteryStateListener(() => {
            updateBackupConditions();
            void speech.power();
          }),
        );
        update(AppState.currentState);
        updateConversations();
        ownSubscription(
          addNetworkStateListener((state) => {
            networkRevision += 1;
            updateNetwork(state);
          }),
        );
        void getNetworkStateAsync()
          .then((state) => {
            if (mounted && networkRevision === 0) updateNetwork(state);
          })
          .catch(() => undefined);
      } catch (error) {
        stop();
        throw error;
      }
      return stop;
    }

    messagingMetric("local startup ready", { ms: performance.now() - started });
    return {
      status: "ready" as const,
      db,
      isCurrent,
      initialProfile,
      async replaceIdentity(importToken: string, live: () => boolean) {
        const target = await marmotAccounts.install(
          { importToken },
          initialRelays,
        );
        if (!live()) {
          if (target !== account.key) await marmotAccounts.remove(target);
          if (!chatPreferences.enabled()) await marmotSession.stop(true);
          return false;
        }
        if (target === account.key) return false;
        const installation = await openDatabase();
        try {
          copyInstallationPreferences(db, installation);
          selectAccount(installation, target);
          retired = true;
          calling.end();
          stopObserving?.();
          await audio.close();
          await marmotSession.stop();
          await marmotAccounts.signOut(account.key);
          downloadKey.fill(0);
          await marmotAccounts.shutdown();
          return true;
        } finally {
          installation.$client.closeSync();
        }
      },
      translation: createTranslationService(
        createDerivedTranslations(db, marmotViewport.incomingText),
        loadTranslationEngine,
      ),
      identity,
      speech,
      downloads,
      audio,
      audioSources,
      observeSession,
      avatars,
      previews,
      mediaSdk,
      profiles,
      profileEditor,
      blossomLists,
      nip05,
      privacy,
      chatPreferences,
      marmotSession,
      conversations,
      marmotViewport,
      relays,
      accountRelays,
      callSignaling,
      calling,
      nativeOpen,
      lock,
      theme: preference(db, "theme"),
      haptics: preference(db, "haptics") !== "off",
    };
  } catch (error) {
    db.$client.closeSync();
    throw error;
  }
}

let appLock: AppLock | undefined;
let initialization: ReturnType<typeof start> | undefined;

export function acceptsLiveLink() {
  const state = appLock?.getState();
  return state && (!state.enabled || (state.active && !state.locked));
}
export function initializeLocal() {
  initialization ??= start().catch((error) => {
    initialization = undefined;
    throw error;
  });
  return initialization;
}

export function finishOnboarding(db: Awaited<ReturnType<typeof openDatabase>>) {
  db.$client.closeSync();
  initialization = undefined;
}
