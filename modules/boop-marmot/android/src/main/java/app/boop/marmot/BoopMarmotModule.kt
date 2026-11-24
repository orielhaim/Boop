package app.boop.marmot

import android.content.Context
import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.ExifInterface
import android.media.MediaMetadataRetriever
import android.media.ThumbnailUtils
import android.util.Size
import android.os.SystemClock
import android.util.Log
import dev.ipf.marmotkit.*
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

private const val ATTACHMENT_STALL_TIMEOUT_MS = 180_000L
private const val ATTACHMENT_CANCEL_TIMEOUT_MS = 10_000L

class BoopMarmotModule : Module() {
  private val lifecycle = Mutex()
  private val shutdownTurn = Mutex()
  private val draftStages = mutableSetOf<String>() // Guarded by uploads.
  private val observer = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private data class Observation(val ticket: CompletableJob, val accountScoped: Boolean)
  private val observations = ConcurrentHashMap<String, Observation>()
  private val directoryWork = ConcurrentHashMap<Job, Boolean>()
  private val windows = mutableMapOf<String, NativeWindow>()
  private val uploads = mutableMapOf<String, MediaFileTransferControlFfi>()
  private var session: Session? = null
  private var signerAccount: String? = null
  private var marmotRuntime: Marmot? = null
  private var identityImport: Pair<String, PreparedIdentityImport>? = null
  private var runtimeConfiguration: RuntimeConfiguration? = null
  private var runtimeStarted = false
  private var closingAccount = false
  private val attachmentAdmissions = ConcurrentHashMap<String, AtomicBoolean>()
  private val attachmentControls = ConcurrentHashMap<String, AttachmentTransferControl>()
  @Volatile private var downloadsForeground = true
  private val foregroundGeneration = AtomicLong()

  override fun definition() = ModuleDefinition {
    Name("BoopMarmot")
    Events("windowChanged", "windowClosed", "attachmentProgress", "directorySearchResults", "relayLiveness", "blockedUsers")
    OnActivityEntersForeground {
      foregroundGeneration.incrementAndGet()
      downloadsForeground = true
    }
    OnActivityEntersBackground {
      downloadsForeground = false
      observations.forEach { (id, observation) ->
        if (!observation.accountScoped && observations.remove(id, observation)) observation.ticket.cancel()
      }
      directoryWork.forEach { (job, foreground) -> if (foreground) job.cancel() }
      foregroundGeneration.incrementAndGet()
      attachmentAdmissions.values.forEach { it.set(true) }
      val controls = attachmentControls.values.toList()
      observer.launch {
        lifecycle.withLock { discardImport() }
        controls.forEach { runCatching { it.cancel() } }
      }
    }

    AsyncFunction("listAccounts") Coroutine { general: List<String>, discovery: List<String>, mediaOrigin: String? ->
      withRuntime(general, discovery, mediaOrigin, start = false) { kit ->
        kit.listAccounts().filter { it.localSigning }.map {
          mapOf("key" to it.accountIdHex, "signedOut" to it.signedOut, "unlinked" to it.unlinked,
            "readiness" to if (kit.onboardingRecoveryRequired(it.accountIdHex)) "recovery_required" else kit.accountSetupReadiness(it.accountIdHex).name.lowercase())
        }
      }
    }
    AsyncFunction("prepareIdentityImport") Coroutine { token: String, input: String, password: String ->
      lifecycle.withLock {
        protocol {
          if (!downloadsForeground || closingAccount) throw problem("AccountClosed")
          discardImport()
          val generation = foregroundGeneration.get()
          val kit = marmotRuntime ?: throw problem("AccountClosed")
          val prepared = kit.prepareIdentityImport(input, password)
          if (!downloadsForeground || generation != foregroundGeneration.get()) {
            prepared.close()
            throw problem("AccountClosed")
          }
          identityImport = token to prepared
          prepared.publicKey()
        }
      }
    }
    AsyncFunction("discardIdentityImport") Coroutine { token: String ->
      lifecycle.withLock { if (identityImport?.first == token) discardImport() }
    }
    AsyncFunction("installAccount") Coroutine { token: String?, name: String?, about: String?, general: List<String>, inbox: List<String>, discovery: List<String> ->
      withRuntime(general, discovery, null, reconfigure = false) { kit ->
        if (!downloadsForeground) throw problem("AccountClosed")
        if (token != null) {
          val prepared = identityImport?.takeIf { it.first == token }?.second ?: throw problem("IdentityImportExpired")
          identityImport = null
          try {
            kit.beginPreparedOnboarding(prepared, OnboardingOptionsFfi(general, discovery, inbox)).accountIdHex
          } finally { prepared.close() }
        } else {
          val profile = UserProfileMetadataFfi(name, name, about, null, null, null, null)
          kit.createIdentityWithInitialProfile(profile, general, general, inbox).account.accountIdHex
        }
      }
    }
    AsyncFunction("accountOnboarding") Coroutine { key: String, action: String, step: String?, revision: String?, epoch: String? ->
      lifecycle.withLock {
        protocol {
          val kit = marmotRuntime ?: throw problem("AccountClosed")
          if (action != "read") startRuntime(kit)
          val selectedStep = { OnboardingStepFfi.valueOf(step?.uppercase() ?: throw problem("InvalidOnboardingStep")) }
          val snapshot = when (action) {
            "read" -> kit.onboardingSnapshot(key)
            "run" -> kit.runOnboarding(key)
            "retry" -> kit.retryOnboardingStep(key, selectedStep())
            "skip" -> kit.continueOnboardingWithout(key, selectedStep())
            "propose" -> kit.proposeOnboardingRecommendedRelays(key, selectedStep())
            "approve" -> {
              val displayed = revision?.toULongOrNull() ?: throw problem("InvalidOnboardingRevision")
              if (epoch == null) kit.approveOnboardingRepair(key, displayed)
              else kit.approveOnboardingRepairInEpoch(key, displayed, epoch)
            }
            "acknowledge" -> {
              val displayed = revision?.toULongOrNull() ?: throw problem("InvalidOnboardingRevision")
              if (epoch == null) kit.acknowledgeOnboardingSingleDevice(key, displayed)
              else kit.acknowledgeOnboardingSingleDeviceInEpoch(key, displayed, epoch)
            }
            "cancelRepair" -> kit.cancelOnboardingRepair(key)
            "recover" -> { kit.recoverOnboarding(key, true); null }
            "cancel" -> { kit.cancelOnboarding(key); null }
            else -> throw problem("InvalidOnboardingAction")
          }
          snapshot?.let {
            mapOf("ready" to it.ready, "revision" to it.revision.toString(), "epoch" to it.recoveryEpoch,
              "proposal" to it.proposal?.let { proposal ->
                mapOf("read" to proposal.readRelays, "write" to proposal.writeRelays,
                  "inconclusive" to proposal.inconclusive)
              },
              "deviceNotice" to it.singleDeviceNotice?.let { notice ->
                mapOf("discovery" to notice.discovery.name.lowercase(), "complete" to notice.discoveryComplete)
              },
              "steps" to it.steps.map { row ->
                mapOf("step" to row.step.name.lowercase(), "status" to row.status.name.lowercase(),
                  "actions" to row.actions.map { action -> action.name.lowercase() })
              })
          }
        }
      }
    }
    AsyncFunction("selectSigner") Coroutine { key: String ->
      lifecycle.withLock {
        protocol {
          val kit = marmotRuntime ?: throw problem("AccountClosed")
          if (closingAccount || signerAccount?.let { it != key } == true)
            throw problem("AccountBusy")
          if (kit.listAccounts().none { it.accountIdHex == key && it.localSigning && !it.signedOut && !it.unlinked })
            throw problem("AccountSignedOut")
          kit.localAccountKeyPackages(key)
          val profile = kit.userProfile(key)
          signerAccount = key
          mapOf("name" to (profile?.displayName ?: profile?.name), "about" to profile?.about)
        }
      }
    }
    AsyncFunction("readProfiles") Coroutine { owner: String, keys: List<String> ->
      withSigner(owner) { kit ->
        kit.cachedIdentityProjections(keys).mapNotNull { item ->
          val key = item.accountIdHex ?: return@mapNotNull null
          val profile = item.profile ?: return@mapNotNull null
          profileDocument(key, profile, item.website, item.bot)
        }
      }
    }
    AsyncFunction("refreshPublicProfile") Coroutine { owner: String, key: String, relays: List<String> ->
      withDirectory(owner) { kit -> kit.refreshProfile(key, relays); Unit }
    }
    AsyncFunction("updatePublicProfile") Coroutine { owner: String, fields: Map<String, String> ->
      withDirectory(owner) { kit -> kit.updateUserProfileUsingAccountRelays(owner, fields); Unit }
    }
    AsyncFunction("normalizeDirectoryIdentity") Coroutine { owner: String, reference: String ->
      withSigner(owner) { it.accountIdHex(reference) }
    }
    AsyncFunction("cachedDirectorySearch") Coroutine { owner: String, query: String ->
      withSigner(owner) { kit -> kit.searchCachedUsers(owner, query, 48u).map { searchResultDocument(it) } }
    }
    Function("prepareObservation") { id: String, accountScoped: Boolean ->
      if (observations.size >= 8) throw problem("SearchInProgress")
      observations.putIfAbsent(id, Observation(Job(), accountScoped)) == null
    }
    AsyncFunction("searchDirectory") Coroutine { owner: String, id: String, query: String ->
      withObservation(owner, id) { kit ->
        kit.searchUsers(owner, query, 0u, 2u).use { search ->
          while (true) {
            val update = search.nextUpdate() ?: break
            currentCoroutineContext().ensureActive()
            if (update.trigger is SearchUpdateTriggerFfi.Error) continue
            val rows = (update.newResults + update.updatedResults).take(48).map { searchResultDocument(it) }
            if (rows.isNotEmpty()) sendEvent("directorySearchResults", mapOf("id" to id, "rows" to rows))
          }
        }
      }
    }
    Function("cancelObservation") { id: String -> observations.remove(id)?.ticket?.cancel(); Unit }
    AsyncFunction("requestAvatarAssets") Coroutine { targets: List<String> ->
      withSession { active ->
        active.kit.requestAvatarAssets(active.account, targets).map { it.document() }
      }
    }
    AsyncFunction("readAvatarAssets") Coroutine { references: List<String> ->
      withSession { active ->
        active.kit.readAvatarAssets(active.account, references, 4uL * 1024uL * 1024uL).map { asset ->
          val mime = asset.mediaType
          val uri = if (asset.bytes.isNotEmpty() && mime != null && mime in setOf("image/jpeg", "image/png", "image/webp", "image/gif")) {
            val data = android.util.Base64.encodeToString(asset.bytes, android.util.Base64.NO_WRAP)
            "data:$mime;base64,$data"
          } else null
          mapOf("reference" to asset.reference, "revision" to asset.contentRevision.toString(),
            "availability" to asset.availability.name.lowercase(), "deferred" to asset.deferred, "uri" to uri)
        }
      }
    }
    AsyncFunction("clearMarmotAvatarCache") Coroutine { owner: String ->
      withDirectory(owner) { it.clearAvatarCache(owner) }
    }
    AsyncFunction("accountNetworkReady") Coroutine { key: String ->
      withSigner(key) { it.accountSetupReadiness(key) == AccountSetupReadinessFfi.NETWORK_READY }
    }
    AsyncFunction("removeAccount") Coroutine { key: String ->
      lifecycle.withLock {
        protocol {
          if (closingAccount || signerAccount == key || session?.account == key) throw problem("AccountBusy")
          (marmotRuntime ?: throw problem("AccountClosed")).removeAccount(key)
        }
      }
    }
    AsyncFunction("signOutAccount") Coroutine { key: String ->
      lifecycle.withLock {
        protocol {
          if (session?.account == key || closingAccount) throw problem("AccountBusy")
          (marmotRuntime ?: throw problem("AccountClosed")).signOut(key, false)
          Unit
        }
      }
    }
    AsyncFunction("resumeAccountSetup").Coroutine<Unit> {
      lifecycle.withLock { protocol { startRuntime(marmotRuntime ?: throw problem("AccountClosed")) } }
    }
    AsyncFunction("signInAccount") Coroutine { key: String ->
      lifecycle.withLock { protocol { (marmotRuntime ?: throw problem("AccountClosed")).signInAccount(key); Unit } }
    }
    AsyncFunction("openAccount") Coroutine { key: String, general: List<String>, discovery: List<String>, mediaOrigin: String? ->
      withRuntime(general, discovery, mediaOrigin) { kit ->
        if (signerAccount != key) throw problem("IdentityMismatch")
        val known = kit.listAccounts().singleOrNull { it.accountIdHex == key && it.localSigning }
          ?: throw problem("IdentityMismatch")
        if (known.unlinked || known.signedOut) throw problem("AccountSignedOut")
        val current = session
        if (current != null && current.account != key) throw problem("IdentityMismatch")
        val opened = current ?: Session(key, kit)
        val readiness = opened.readiness()
        session = opened
        readiness
      }
    }
    AsyncFunction("signNostrEvent") Coroutine { key: String, event: String ->
      withSigner(key) { it.signNostrEvent(key, event) }
    }
    AsyncFunction("nostrCipher") Coroutine { key: String, peer: String, value: String, nip44: Boolean, encrypt: Boolean ->
      withSigner(key) { it.nostrCipher(key, peer, value, nip44, encrypt) }
    }
    AsyncFunction("exportIdentity") Coroutine { key: String, password: String? ->
      withSigner(key) { kit ->
        if (password == null) kit.revealNsec(key) else kit.exportEncryptedSecretKey(key, password)
      }
    }
    AsyncFunction("closeAccount") Coroutine { pauseMessaging: Boolean -> shutdown(pauseMessaging = pauseMessaging) }
    AsyncFunction("shutdownRuntime").Coroutine<Unit> { shutdown(closeRuntime = true) }
    AsyncFunction("catchUp").Coroutine<Unit> { withSession { it.kit.catchUpAccounts() } }
    AsyncFunction("notifyConnectivityRestored").Coroutine<Unit> {
      withSession { it.kit.notifyConnectivityRestored() }
    }
    AsyncFunction("accountRelayLists") Coroutine { key: String ->
      withSigner(key) { kit ->
        val lists = kit.accountRelayLists(key)
        val general = kit.accountNip65Relays(key)
        val inbox = lists.inbox.relays
        val allowed = kit.classifyRelayEndpoints((general + inbox).distinct())
          .filter { it.policy == RelayEndpointPolicyFfi.ALLOWED }.map { it.endpoint }
        mapOf("general" to general, "write" to lists.nip65.relays, "inbox" to inbox,
          "bootstrap" to lists.bootstrapRelays, "allowed" to allowed,
          "retiredHosts" to kit.retiredRelayHosts())
      }
    }
    AsyncFunction("refreshAccountRelayLists") Coroutine { key: String, urls: List<String> ->
      withDirectory(key) { kit -> kit.refreshUserRelayLists(key, urls); Unit }
    }
    AsyncFunction("classifyRelays") Coroutine { key: String, urls: List<String> ->
      withSigner(key) { kit ->
        kit.classifyRelayEndpoints(urls).map { it.policy.name.lowercase() }
      }
    }
    AsyncFunction("setAccountRelays") Coroutine { key: String, inbox: Boolean, urls: List<String>, bootstrap: List<String> ->
      withDirectory(key) { kit ->
        if (inbox) kit.setAccountInboxRelays(key, urls, bootstrap)
        else kit.setAccountNip65Relays(key, urls, bootstrap)
        Unit
      }
    }
    AsyncFunction("reconnectMarmotRelay") Coroutine { url: String ->
      withSession { it.kit.reconnectRelay(it.account, url); Unit }
    }
    AsyncFunction("watchRelayLiveness") Coroutine { key: String, id: String ->
      withObservation(key, id) { kit ->
        kit.subscribeRelayLiveness(key).use { stream ->
          fun emit(rows: List<RelayLivenessFfi>) {
            sendEvent("relayLiveness", mapOf("id" to id, "rows" to rows.map {
              mapOf("url" to it.url, "status" to it.status.name.lowercase(),
                "lastError" to it.lastError, "lastAttempt" to it.lastAttemptUnix?.toDouble())
            }))
          }
          try {
            emit(stream.snapshot())
            while (true) {
              val rows = stream.next() ?: break
              currentCoroutineContext().ensureActive()
              emit(rows)
            }
          } finally { stream.cancel() }
        }
      }
    }
    AsyncFunction("backupState").Coroutine<Document> {
      withSession {
        val settings = it.kit.backupSettings(it.account)
        val restore = it.kit.backupRestoreStatus(it.account)
        mapOf("enabled" to settings.enabled, "thisDeviceWrites" to settings.thisDeviceWrites,
          "phase" to restore.phase.name.lowercase(), "operation" to restore.operation,
          "imported" to restore.importedEvents.toDouble(),
          "failed" to (restore.failedArchives + restore.failedBundles).toDouble())
      }
    }
    AsyncFunction("beginBackup").Coroutine<Document> {
      withSession {
        val setup = it.kit.beginRecoveryWords(it.account)
        mapOf("words" to setup.words, "positions" to setup.confirmPositions.map(UInt::toInt))
      }
    }
    AsyncFunction("backupAction") Coroutine { action: String, words: List<String> ->
      withSession {
        when (action) {
          "confirm" -> it.kit.confirmRecoveryWords(it.account, words)
          "cancel" -> it.kit.cancelRecoveryWords(it.account)
          "disable" -> it.kit.turnOffBackups(it.account)
          "restore" -> it.kit.beginBackupRestore(it.account, words.single())
          "cancelRestore" -> it.kit.cancelBackupRestore(it.account, words.single())
          else -> throw problem("InvalidBackupAction")
        }
        Unit
      }
    }
    AsyncFunction("backupConditions") Coroutine { wifi: Boolean, charging: Boolean ->
      withSession { it.kit.setRuntimeBackupBackgroundConditions(wifi, charging) }
    }
    AsyncFunction("backupNow").Coroutine<String> {
      withSession { it.kit.runDueBackupPass(it.account).name.lowercase() }
    }

    AsyncFunction("openChatList") Coroutine { id: String, view: String, invitations: Boolean, search: String? ->
      lifecycle.withLock {
        protocol {
          val active = requireSession()
          val selected = ChatListViewFfi.valueOf(view.uppercase())
          val pending = ChatListFilterNodeFfi.Condition(ChatListConditionFfi.PENDING_INVITE)
          val filter = when {
            invitations -> listOf(pending)
            search != null -> listOf(ChatListFilterNodeFfi.All(listOf(1u, 2u)), ChatListFilterNodeFfi.Not(3u), ChatListFilterNodeFfi.Text(search), pending)
            else -> listOf(ChatListFilterNodeFfi.Not(1u), pending)
          }
          val handle = active.kit.openChatListQueryWindow(active.account, ChatListViewQueryFfi(selected, filter), 40u)
          install(id, ChatListWindow(handle))
        }
      }
    }
    AsyncFunction("openAttention") Coroutine { id: String ->
      lifecycle.withLock {
        protocol {
          val active = requireSession()
          install(id, AttentionWindow(active.kit.subscribeAccountAttention(), active.account))
        }
      }
    }
    AsyncFunction("openGroupState") Coroutine { id: String, group: String, roster: Boolean ->
      withSession { active ->
        val handle = active.kit.subscribeGroupState(active.account, group)
        val read: suspend () -> Document = {
          if (roster) rosterDocument(active.kit, active.account, group)
          else groupDocument(active.kit, active.account, group)
        }
        val details = try { read() } catch (error: Throwable) { handle.close(); throw error }
        lifecycle.withLock {
          if (session !== active || active.closing) {
            handle.close()
            throw problem("AccountClosed")
          }
          install(id, GroupStateWindow(id, handle, details, if (roster) "groupRoster" else "groupState", read))
        }
      }
    }
    AsyncFunction("openConversation") Coroutine { id: String, group: String, target: String?, speculative: Boolean ->
      withSession { active ->
        val started = SystemClock.elapsedRealtime()
        val mode = when {
          target != null -> ConversationOpenModeFfi.MESSAGE
          speculative -> ConversationOpenModeFfi.LATEST
          else -> ConversationOpenModeFfi.AUTOMATIC
        }
        val rows = if (speculative) 56u else if (target != null) 40u else 100u
        val timeoutMs = if (speculative) 1_500u else 0u
        val handle = active.kit.openConversationWindow(
          active.account, group, mode, target, rows, timeoutMs,
        )
        try {
          val snapshot = lifecycle.withLock {
            if (session !== active || active.closing) {
              val window = ConversationWindow(handle)
              window.stop()
              throw problem("AccountClosed")
            }
            install(id, ConversationWindow(handle))
          }
          if (isDebuggable()) Log.i(
            "BoopMarmot",
            "conversation_open elapsedMs=${SystemClock.elapsedRealtime() - started} speculative=$speculative rows=$rows ok=true",
          )
          snapshot
        } catch (error: Throwable) {
          if (isDebuggable()) Log.i(
            "BoopMarmot",
            "conversation_open elapsedMs=${SystemClock.elapsedRealtime() - started} speculative=$speculative rows=$rows ok=false",
          )
          throw error
        }
      }
    }
    AsyncFunction("openGroupCall") Coroutine { id: String, group: String ->
      lifecycle.withLock {
        protocol {
          val active = requireSession()
          val kinds = listOf(24884uL)
          val handle = active.kit.subscribeMessages(active.account, group, 64u, kinds)
          install(id, GroupCallWindow(id, handle) { active.kit.messages(active.account, group, 64u, kinds) })
        }
      }
    }
    AsyncFunction("observeWindow") Coroutine { id: String ->
      lifecycle.withLock {
        val window = windows[id] ?: throw problem("WindowClosed")
        if (window.job == null) window.job = observer.launch {
          try {
            while (isActive) {
              val value = window.next() ?: break
              val delta = windowDelta(window.latest, value)
              window.latest = value
              sendEvent("windowChanged", if (delta == null) mapOf("id" to id, "snapshot" to value)
                else mapOf("id" to id, "delta" to delta))
            }
            sendEvent("windowClosed", mapOf("id" to id, "code" to "WindowClosed"))
          } catch (e: CancellationException) {
            throw e
          } catch (e: Exception) {
            sendEvent("windowClosed", mapOf("id" to id, "code" to errorCode(e)))
          }
        }
      }
    }
    AsyncFunction("closeWindow") Coroutine { id: String ->
      lifecycle.withLock { windows.remove(id)?.stop() }
    }
    AsyncFunction("windowSnapshot") Coroutine { id: String ->
      withWindow(id) { it.latest }
    }
    AsyncFunction("pageWindow") Coroutine { id: String, generation: String, sequence: String, direction: String ->
      withWindow(id) { it.page(generation, sequence.toULong(), direction) }
    }
    AsyncFunction("anchorWindow") Coroutine { id: String, generation: String, sequence: String, target: String ->
      withWindow(id) { it.anchor(generation, sequence.toULong(), target) }
    }
    AsyncFunction("jumpToMessage") Coroutine { id: String, generation: String, sequence: String, target: String ->
      withWindow(id) { window ->
        (window as? ConversationWindow ?: throw problem("InvalidWindow")).jump(generation, sequence.toULong(), target)
      }
    }

    AsyncFunction("startDirect") Coroutine { peer: String ->
      withSession { it.kit.startDirectConversation(it.account, peer) }
    }
    AsyncFunction("prewarmInvitees") Coroutine { members: List<String> ->
      withSession { it.kit.prewarmGroupMemberKeyPackages(it.account, members); Unit }
    }
    AsyncFunction("createGroup") Coroutine { name: String, description: String?, members: List<String>, image: String? ->
      withSession {
        val initial = image?.let { path -> InitialGroupImageFfi(groupImageInput(path), "image/jpeg", null, null, null) }
        val result = it.kit.createGroupWithInitialImageDetailed(it.account, name, members, description, initial)
        mapOf("groupId" to result.created?.groupIdHex,
          "createdAt" to result.created?.chatListRow?.conversationCreatedAt?.toDouble(), "members" to result.memberOutcomes.map { member ->
          mapOf("account" to member.accountIdHex, "status" to member.status.name.lowercase(), "devices" to member.selectedDeviceCount.toInt())
        })
      }
    }
    AsyncFunction("respondToInvitation") Coroutine { group: String, accept: Boolean ->
      withSession {
        if (accept) it.kit.acceptGroupInvite(it.account, group)
        else it.kit.declineGroupInvite(it.account, group)
        Unit
      }
    }
    AsyncFunction("groupDiagnostics") Coroutine { group: String ->
      withSession { groupDiagnostics(it.kit, it.account, group) }
    }
    AsyncFunction("groupAccess") Coroutine { group: String, includeMembers: Boolean ->
      withSession<Document> {
        val details = it.kit.groupDetails(it.account, group)
        val row = if (includeMembers) it.kit.chatListRow(it.account, group) else null
        mapOf(
          "membership" to details.group.selfMembership.name.lowercase(),
          "pendingInvitation" to details.group.pendingConfirmation,
          "pendingLeave" to details.group.leaveRequestPending,
          "unrecoverable" to details.mlsState.unrecoverable,
          "disbanding" to details.mlsState.disbanding,
          "lifecycle" to details.mlsState.lifecycleState.name.lowercase(),
          "kind" to row?.conversationKind?.name?.lowercase(),
          "members" to if (includeMembers) details.members.map { member -> member.memberIdHex } else emptyList(),
        )
      }
    }
    AsyncFunction("groupInvitation") Coroutine { group: String, preview: Boolean ->
      withSession<Document> {
        val details = it.kit.groupDetails(it.account, group)
        mapOf(
          "inviter" to details.group.welcomerAccountIdHex.takeIf { _ -> details.group.pendingConfirmation },
          "name" to details.group.name,
          "memberCount" to details.members.size,
          "members" to if (preview) details.members.asSequence().filterNot { member -> member.isSelf }.take(16).map { member ->
            mapOf("id" to member.memberIdHex, "npub" to member.npub, "name" to member.displayName)
          }.toList() else emptyList(),
        )
      }
    }
    AsyncFunction("groupMemberIds") Coroutine { groups: List<String> ->
      withSession { it.kit.groupMemberIdsPage(it.account, groups).associate { row -> row.groupIdHex to row.memberIdsHex } }
    }
    AsyncFunction("updateGroup") Coroutine { group: String, name: String?, description: String? ->
      withSession { it.kit.updateGroupProfile(it.account, group, name, description).acceptDisposition.name.lowercase() }
    }
    AsyncFunction("updateGroupImage") Coroutine { group: String, path: String? ->
      withSession {
        val result = if (path == null) it.kit.clearGroupImage(it.account, group)
        else it.kit.updateGroupImage(it.account, group, groupImageInput(path), "image/jpeg")
        result.acceptDisposition.name.lowercase()
      }
    }
    AsyncFunction("updateGroupMedia") Coroutine { group: String, origins: List<String> ->
      withSession {
        it.kit.replaceEncryptedMediaBlobEndpoints(it.account, group, origins.map { origin -> AppBlobEndpointFfi("blossom", origin) })
          .acceptDisposition.name.lowercase()
      }
    }
    AsyncFunction("viewGroupImage") Coroutine { group: String, hash: String ->
      withSession {
        val details = it.kit.groupDetails(it.account, group).group
        if (details.pendingConfirmation || details.selfMembership != SelfMembershipFfi.MEMBER ||
          details.imageHashHex != hash) throw problem("MediaUnavailable")
        val bytes = it.kit.downloadGroupBlossomImage(it.account, group)
        val current = it.kit.groupDetails(it.account, group).group
        if (bytes.isEmpty() || bytes.size > MAX_GROUP_IMAGE || current.pendingConfirmation ||
          current.selfMembership != SelfMembershipFfi.MEMBER || current.imageHashHex != hash)
          throw problem("MediaUnavailable")
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        val mime = bounds.outMimeType?.takeIf { it in setOf("image/jpeg", "image/png", "image/webp", "image/gif") }
          ?: throw problem("InvalidMedia")
        if (bounds.outWidth !in 1..4096 || bounds.outHeight !in 1..4096) throw problem("InvalidMedia")
        val encoded = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
        "data:$mime;base64,$encoded"
      }
    }
    AsyncFunction("inviteMembers") Coroutine { group: String, members: List<String> ->
      withSession { session ->
        val result = session.kit.inviteMembersDetailed(session.account, group, members)
        mapOf(
          "disposition" to result.invite.summary?.acceptDisposition?.name?.lowercase(),
          "members" to result.invite.memberOutcomes.map {
            mapOf("account" to it.accountIdHex, "status" to it.status.name.lowercase(), "devices" to it.selectedDeviceCount.toLong())
          },
        )
      }
    }
    AsyncFunction("changeMember") Coroutine { group: String, member: String, action: String ->
      withSession {
        val result = when (action) {
          "remove" -> it.kit.removeMembers(it.account, group, listOf(member))
          "promote" -> it.kit.promoteAdmin(it.account, group, member)
          "demote" -> it.kit.demoteAdmin(it.account, group, member)
          "stepDown" -> it.kit.selfDemoteAdmin(it.account, group)
          else -> throw problem("InvalidGroupAction")
        }
        result.acceptDisposition.name.lowercase()
      }
    }
    AsyncFunction("changeMembership") Coroutine { group: String, action: String ->
      withSession {
        when (action) {
          "leave" -> it.kit.leaveGroup(it.account, group).acceptDisposition.name.lowercase()
          "cancelLeave" -> { it.kit.cancelLeave(it.account, group); null }
          "deleteLocal" -> { it.kit.deleteGroupLocal(it.account, group); null }
          "disband" -> { it.kit.disbandGroup(it.account, group); null }
          "enableDisbanding" -> it.kit.enableGroupDisbanding(it.account, group).summary.acceptDisposition.name.lowercase()
          else -> throw problem("InvalidGroupAction")
        }
      }
    }
    AsyncFunction("respondToRejoin") Coroutine { welcome: String, token: String? ->
      withSession {
        if (token == null) it.kit.declineGroupRejoin(it.account, welcome)
        else it.kit.confirmGroupRejoin(it.account, welcome, token)
        Unit
      }
    }
    AsyncFunction("sendText") Coroutine { group: String, text: String, token: String, reply: String? ->
      withSession {
        val result = if (reply == null) it.kit.sendTextWithClientToken(it.account, group, text, token)
        else it.kit.replyToMessageWithClientToken(it.account, group, reply, text, token)
        result.messageIdHex
      }
    }
    AsyncFunction("saveDraft") Coroutine { group: String, text: String, reply: String? ->
      withSession { active ->
        retryDraftEdit {
          active.kit.selectedMessageDraft(active.account, group).use { selected ->
            if (text.isBlank() && selected.draft?.mediaAttachments.orEmpty().isEmpty()) {
              active.kit.clearMessageDraftIfRevision(active.account, selected.revision).destroy()
            } else {
              active.kit.saveMessageDraftInputsIfRevision(active.account, selected.revision, text, reply, emptyList()).destroy()
            }
          }
        }
      }
    }
    AsyncFunction("sendSpecial") Coroutine { group: String, kind: Int, body: String, reply: String? ->
      withSession {
        if (kind !in setOf(24881, 24883, 24884)) throw problem("InvalidApplicationEvent")
        val tags = reply?.let { target -> listOf(listOf("e", target, "", "reply")) } ?: emptyList()
        it.kit.sendCustomEvent(it.account, group, kind.toULong(), tags, body)
        Unit
      }
    }
    AsyncFunction("stageMediaDraft") Coroutine { group: String, files: List<Map<String, String>>, caption: String, token: String, reply: String? ->
      withSession { active ->
        val inputs = uploadInputs(files)
        MediaFileTransferControlFfi().use { control ->
          registerUpload(active, token, control, draftGroup = group)
          try {
            var draft = active.kit.selectedMessageDraft(active.account, group)
            try {
              if (draft.draft?.mediaAttachments?.isNotEmpty() == true) throw problem("MediaDraftPending")
              val updated = active.kit.saveMessageDraftInputsIfRevision(active.account, draft.revision, caption, reply, emptyList())
              draft.destroy()
              draft = updated
              sendEvent("attachmentProgress", mapOf("transfer" to token, "received" to 0.0, "state" to "preparing"))
              for ((index, input) in inputs.withIndex()) {
                val file = files[index]
                val presentation = mediaPresentation(file["presentation"], input.mediaType)
                val waveform = mediaWaveform(file["waveform"])
                val request = MessageDraftAttachmentFileRequestFfi(
                  "$token:${inputs.size}:$index:$presentation", input.sourcePath, input.expectedSize,
                  input.fileName, input.mediaType, input.dim, input.thumbhash,
                  mediaDuration(file["duration"]), waveform,
                )
                val next = active.kit.stageMessageDraftAttachmentFile(active.account, draft.revision, request, control)
                draft.destroy()
                draft = next
              }
            } finally { draft.destroy() }
          } finally {
            synchronized(uploads) {
              uploads.remove(token)
              draftStages.remove(group)
            }
          }
        }
      }
    }
    AsyncFunction("discardMediaDraft") Coroutine { group: String ->
      withSession { active ->
        if (synchronized(uploads) { group in draftStages }) throw problem("TransferInProgress")
        var idsToRemove: Set<String>? = null
        retryDraftEdit {
          active.kit.selectedMessageDraft(active.account, group).use { selected ->
            val draft = selected.draft ?: return@use
            val ids = idsToRemove ?: draft.mediaAttachments.map { it.id }.toSet().also { idsToRemove = it }
            val removed = draft.mediaAttachments.filter { it.id in ids }.map { MessageDraftAttachmentInputFfi.Removed(it.id) }
            if (removed.isNotEmpty()) {
              active.kit.saveMessageDraftInputsIfRevision(active.account, selected.revision, draft.content, draft.replyToMessageIdHex, removed).destroy()
            }
          }
        }
      }
    }
    AsyncFunction("sendMedia") Coroutine { group: String, files: List<Map<String, String>>, caption: String?, token: String, server: String?, reply: String? ->
      withSession { active ->
        when (val status = active.kit.localSendStatus(active.account, group, token)) {
          is LocalSendStatusFfi.Completed -> return@withSession mapOf("id" to status.summary.messageIds.firstOrNull().orEmpty(), "blobs" to emptyList<Any>())
          LocalSendStatusFfi.Queued, LocalSendStatusFfi.EngineOwned -> return@withSession mapOf("id" to "", "blobs" to emptyList<Any>())
          LocalSendStatusFfi.Rejected -> throw problem("MediaSendNotAccepted")
          null -> Unit
        }
        if (active.kit.groupDetails(active.account, group).group.encryptedMedia.version != EncryptedMediaVersionFfi.V2) throw problem("MediaNotConfigured")
        val inputs = if (files.isEmpty()) emptyList() else uploadInputs(files)
        val selected = if (files.isEmpty()) active.kit.selectedMessageDraft(active.account, group) else null
        val draftFiles = selected?.draft?.mediaAttachments.orEmpty()
        if (selected != null && !matchesDraftBatch(token, draftFiles)) {
          selected.destroy()
          throw problem("MediaDraftPending")
        }
        val tags = inputs.mapIndexed { index, input ->
          val file = files[index]
          mediaMetadata(index, input.expectedSize ?: throw problem("InvalidMediaPath"), mediaDuration(file["duration"]), mediaWaveform(file["waveform"]),
            mediaPresentation(file["presentation"], input.mediaType))
        } + reply?.let { id -> listOf(listOf("e", id, "", "reply")) }.orEmpty()
        MediaFileTransferControlFfi().use { control ->
          registerUpload(active, token, control)
          try {
            coroutineScope {
              val total = (inputs.sumOf { it.expectedSize?.toLong() ?: 0L } + draftFiles.sumOf { it.plaintextSize.toLong() }) * 3.0
              val progress = launch {
                while (isActive) {
                  sendEvent("attachmentProgress", mapOf("transfer" to token, "received" to control.processedBytes().toDouble(),
                    "total" to total, "state" to "uploading"))
                  delay(250)
                }
              }
              try {
                val (id, uploaded) = if (selected == null) {
                  val result = active.kit.uploadMediaFilesWithClientToken(active.account, group,
                    MediaFileUploadRequestFfi(inputs, caption, true, server, tags), control, token)
                  (result.acceptance?.messageIdHex ?: throw problem("MediaSendNotAccepted")) to result.upload
                } else {
                  val result = active.kit.uploadMessageDraftAttachments(active.account, selected.revision, draftFiles.map { it.id }, server, control)
                  if (control.isCancelled()) throw problem("MediaCancelled")
                  val metadata = draftFiles.mapIndexed { index, item ->
                    mediaMetadata(index, item.plaintextSize, item.durationSeconds, item.waveformSamples, item.id.substringAfterLast(":"))
                  }
                  val accepted = active.kit.sendMessageDraftWithClientToken(active.account, selected.revision, result.attachments.map { it.reference }, metadata, token)
                  accepted.messageIdHex to result
                }
                mapOf("id" to id, "blobs" to uploaded.attachments.mapNotNull { item ->
                  item.reference.locators.firstOrNull()?.let { locator ->
                    mapOf("url" to locator.value, "hash" to item.reference.ciphertextSha256, "size" to item.encryptedSizeBytes.toDouble())
                  }
                })
              } catch (error: MarmotKitException.Runtime) {
                if (control.isCancelled()) throw problem("MediaCancelled")
                if (error.details == "media upload timed out" ||
                  error.details.startsWith("blob store request failed: upload failed for all Blossom servers:"))
                  throw problem("UploadEndpointFailed")
                throw error
              } finally { progress.cancelAndJoin() }
            }
          } finally {
            synchronized(uploads) { uploads.remove(token) }
            selected?.destroy()
          }
        }
      }
    }
    AsyncFunction("cancelUpload") Coroutine { token: String ->
      synchronized(uploads) { uploads[token]?.also { it.cancel() } != null }
    }
    AsyncFunction("audioMetadata") Coroutine { path: String ->
      protocol {
        val context = appContext.reactContext ?: throw problem("ContextUnavailable")
        val base = File(context.applicationInfo.dataDir).canonicalFile
        val file = File(path).canonicalFile
        if (!file.toPath().startsWith(base.toPath()) || !file.isFile) throw problem("InvalidMediaPath")
        MediaMetadataRetriever().use { reader ->
          reader.setDataSource(file.path)
          val data = mutableMapOf<String, Any>()
          val keys = mapOf(
            "title" to MediaMetadataRetriever.METADATA_KEY_TITLE,
            "artist" to MediaMetadataRetriever.METADATA_KEY_ARTIST,
            "album" to MediaMetadataRetriever.METADATA_KEY_ALBUM
          )
          for ((key, field) in keys) {
            reader.extractMetadata(field)?.trim()?.take(500)?.takeIf { it.isNotEmpty() }?.let { data[key] = it }
          }
          reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
            ?.toDoubleOrNull()?.takeIf { it.isFinite() && it > 0 }?.let { data["duration"] = it / 1000 }
          reader.embeddedPicture?.takeIf { it.size <= 512 * 1024 }?.let { picture ->
            val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(picture, 0, picture.size, options)
            val mime = options.outMimeType
            if (mime in setOf("image/jpeg", "image/png", "image/webp") &&
              options.outWidth in 1..2048 && options.outHeight in 1..2048
            ) {
              data["artworkUrl"] = "data:$mime;base64," + android.util.Base64.encodeToString(picture, android.util.Base64.NO_WRAP)
            }
          }
          data
        }
      }
    }
    AsyncFunction("inspectMediaFile") Coroutine { path: String, image: Boolean, poster: Boolean ->
      protocol {
        val context = appContext.reactContext ?: throw problem("ContextUnavailable")
        val base = File(context.applicationInfo.dataDir).canonicalFile
        val file = File(path).canonicalFile
        if (!file.toPath().startsWith(base.toPath()) || !file.isFile) throw problem("InvalidMediaPath")
        if (image) {
          val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
          BitmapFactory.decodeFile(file.path, options)
          val rotates = runCatching {
            ExifInterface(file.path).getAttributeInt(ExifInterface.TAG_ORIENTATION, 1) in 5..8
          }.getOrDefault(false)
          return@protocol mapOf("dimensions" to if (rotates) dimensions(options.outHeight, options.outWidth)
            else dimensions(options.outWidth, options.outHeight))
        }
        val metadata = MediaMetadataRetriever().use { reader ->
          reader.setDataSource(file.path)
          val width = reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
          val height = reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
          val rotate = reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION) in setOf("90", "270")
          val duration = reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()?.takeIf { it > 0 }
          mapOf("dimensions" to if (rotate) dimensions(height, width) else dimensions(width, height),
            "duration" to duration?.div(1000.0))
        }
        if (!poster) return@protocol metadata
        val thumbnail = runCatching { ThumbnailUtils.createVideoThumbnail(file, Size(144, 144), null) }.getOrNull()
          ?: return@protocol metadata
        try {
          val output = File.createTempFile("marmot-poster-", ".jpg", context.cacheDir)
          try {
            output.outputStream().use { if (!thumbnail.compress(Bitmap.CompressFormat.JPEG, 75, it)) throw problem("MediaUnavailable") }
            metadata + ("path" to output.canonicalPath)
          } catch (error: Exception) {
            output.delete()
            throw error
          }
        } finally { thumbnail.recycle() }
      }
    }
    AsyncFunction("retainedAttachmentBytes") Coroutine { group: String, id: String, source: String, index: Int ->
      withSession { active ->
        val target = AttachmentLocalTargetFfi(id, source, index.toUInt())
        active.kit.attachmentLocalAssets(active.account, group, listOf(target))
          .firstOrNull()?.takeIf { it.reference != null }?.byteCount?.toDouble()
      }
    }
    AsyncFunction("attachmentTransferState") Coroutine { group: String, id: String, source: String, index: Int ->
      withSession { active ->
        val target = AttachmentLocalTargetFfi(id, source, index.toUInt())
        active.kit.attachmentTransferSnapshot(active.account, group, listOf(target)).items.firstOrNull()?.state?.name?.lowercase()
      }
    }
    AsyncFunction("controlAttachment") Coroutine { group: String, id: String, source: String, index: Int, action: String ->
      withSession { active ->
        val target = AttachmentLocalTargetFfi(id, source, index.toUInt())
        val item = active.kit.attachmentTransferSnapshot(active.account, group, listOf(target)).items.firstOrNull()
        val control = if (action == "remove") AttachmentControlFfi.REMOVE else AttachmentControlFfi.CANCEL
        item?.reference?.let { active.kit.controlAttachment(active.account, it, control) } ?: false
      }
    }
    Function("registerAttachmentTransfer") { transfer: String ->
      val admission = AtomicBoolean()
      attachmentAdmissions[transfer] = admission
      if (!downloadsForeground) admission.set(true)
    }
    AsyncFunction("interruptAttachmentTransfer") Coroutine { group: String, id: String, source: String, index: Int, transfer: String ->
      val admission = attachmentAdmissions[transfer] ?: return@Coroutine
      admission.set(true)
      attachmentControls[transfer]?.cancel()
    }
    AsyncFunction("downloadAttachment") Coroutine { group: String, id: String, source: String, index: Int, transfer: String ->
      val admission = attachmentAdmissions[transfer] ?: throw problem("MediaUnavailable")
      try {
        withSession { active ->
          if (admission.get()) return@withSession "cancelled"
          val target = AttachmentLocalTargetFfi(id, source, index.toUInt())
          val before = active.kit.attachmentTransferSnapshot(active.account, group, listOf(target)).items.firstOrNull()
          val reference = when (before?.state) {
            AttachmentTransferStateFfi.READY -> return@withSession "ready"
            AttachmentTransferStateFfi.REMOVED, AttachmentTransferStateFfi.CLEANED_BY_SETTING,
            AttachmentTransferStateFfi.PREVIOUSLY_ACQUIRED_UNAVAILABLE, AttachmentTransferStateFfi.COMPLETED_UNRETAINED ->
              active.kit.downloadAttachmentAgain(active.account, group, target)
            AttachmentTransferStateFfi.FAILED, AttachmentTransferStateFfi.RETRY_EXHAUSTED,
            AttachmentTransferStateFfi.CANCELLED, AttachmentTransferStateFfi.STORAGE_BLOCKED,
            AttachmentTransferStateFfi.PAUSED -> before.reference?.takeIf {
              active.kit.controlAttachment(active.account, it, AttachmentControlFfi.RETRY)
            }
            AttachmentTransferStateFfi.QUEUED, AttachmentTransferStateFfi.DOWNLOADING, AttachmentTransferStateFfi.VERIFYING_CIPHERTEXT,
            AttachmentTransferStateFfi.DECRYPTING, AttachmentTransferStateFfi.VERIFYING_PLAINTEXT,
            AttachmentTransferStateFfi.RETRY_SCHEDULED -> before.reference
            else -> active.kit.requestExplicitAttachment(active.account, group, target)
          } ?: return@withSession before?.state?.name?.lowercase() ?: "unavailable"
          if (admission.get()) {
            active.kit.controlAttachment(active.account, reference, AttachmentControlFfi.CANCEL)
            return@withSession "cancelled"
          }
          val control = AttachmentTransferControl(active.kit, active.account, reference)
          attachmentControls[transfer] = control
          if (admission.get()) {
            control.cancel()
            return@withSession "cancelled"
          }
          active.kit.subscribeAttachmentTransfers(active.account, group, listOf(target)).use { updates ->
            var lastProgress = before?.takeIf { it.reference == reference }?.let { it.state.name.lowercase() to it.received }
            var lastProgressAt = SystemClock.elapsedRealtime()
            while (true) {
              val remaining = (ATTACHMENT_STALL_TIMEOUT_MS - (SystemClock.elapsedRealtime() - lastProgressAt)).coerceAtLeast(1L)
              val (timedOut, snapshot) = withTimeoutOrNull(remaining) { false to updates.next() } ?: (true to null)
              val item = if (timedOut) {
                active.kit.attachmentTransferSnapshot(active.account, group, listOf(target)).items.firstOrNull()
              } else {
                snapshot?.items?.firstOrNull()
              }
              if (item == null) {
                if (admission.get()) return@withSession "cancelled"
                control.cancel()
                return@withSession "interrupted"
              }
              if (item.reference != reference) return@withSession "unavailable"
              val state = item.state.name.lowercase()
              val progress = state to item.received
              if (progress != lastProgress) {
                lastProgress = progress
                lastProgressAt = SystemClock.elapsedRealtime()
                sendEvent("attachmentProgress", mapOf("transfer" to transfer, "received" to item.received.toDouble(), "total" to item.total?.toDouble(), "state" to state))
              }
              when (item.state) {
                AttachmentTransferStateFfi.READY, AttachmentTransferStateFfi.FAILED, AttachmentTransferStateFfi.UNAVAILABLE,
                AttachmentTransferStateFfi.POLICY_BLOCKED, AttachmentTransferStateFfi.REMOVED,
                AttachmentTransferStateFfi.PREVIOUSLY_ACQUIRED_UNAVAILABLE, AttachmentTransferStateFfi.RETRY_EXHAUSTED,
                AttachmentTransferStateFfi.CANCELLED, AttachmentTransferStateFfi.STORAGE_BLOCKED, AttachmentTransferStateFfi.PAUSED,
                AttachmentTransferStateFfi.CLEANED_BY_SETTING, AttachmentTransferStateFfi.COMPLETED_UNRETAINED ->
                  return@withSession state
                else -> Unit
              }
              if (timedOut) {
                if (admission.get()) {
                  control.cancel()
                  return@withSession "cancelled"
                }
                control.cancel()
                return@withSession "interrupted"
              }
            }
            @Suppress("UNREACHABLE_CODE")
            "interrupted"
          }
        }
      } finally {
        attachmentControls.remove(transfer)
        attachmentAdmissions.remove(transfer)
      }
    }
    AsyncFunction("openAttachment") Coroutine { group: String, id: String, source: String, index: Int ->
      withSession {
        MediaFileTransferControlFfi().use { control ->
          it.kit.openAttachmentHandoff(it.account, group, AttachmentLocalTargetFfi(id, source, index.toUInt()), control)?.let { file ->
            mapOf("lease" to file.lease, "path" to file.path, "type" to file.mediaType, "name" to file.fileName)
          }
        }
      }
    }
    AsyncFunction("releaseAttachment") Coroutine { lease: String ->
      withSession { it.kit.releaseAttachmentHandoff(lease) }
    }
    AsyncFunction("storageUsage").Coroutine<Double> {
      withSession {
        val usage = it.kit.attachmentStorageUsage(it.account)
        (usage.mediaBytes + usage.legacyBytes).toDouble()
      }
    }
    AsyncFunction("clearDownloads").Coroutine<Unit> {
      withSession { it.kit.removeAttachmentsOlderThan(it.account, (System.currentTimeMillis() / 1_000 + 1).toULong(), null); Unit }
    }
    AsyncFunction("recentVoiceNotes") Coroutine { sender: String, since: Double, onlyOutgoing: Boolean ->
      withSession { active ->
        val query = TimelineMessageQueryFfi(null, null, sender.takeIf { onlyOutgoing }, since.toULong(), null,
          attachmentType = 3u, cursorGroupId = null, before = null,
          beforeMessageId = null, after = null, afterMessageId = null, limit = 24u)
        active.kit.timelineMessages(active.account, query).messages
          .filter { !it.deleted && it.invalidationStatus == null }
          .flatMap { row ->
            val source = row.sourceMessageIdHex ?: return@flatMap emptyList()
            row.media.mapNotNull { media ->
              val attachment = media as? MediaAttachmentOutcomeFfi.Accepted ?: return@mapNotNull null
              val reference = attachment.reference
              if (reference.version != EncryptedMediaVersionFfi.V2 || !reference.mediaType.startsWith("audio/")) return@mapNotNull null
              val index = attachment.attachmentIndex
              val tag = row.tags.singleOrNull { tag -> tag.values.size == 6 && tag.values[0] == "boop-media" &&
                tag.values[1] == index.toString() && tag.values[5] == "voice" }?.values ?: return@mapNotNull null
              mapOf("target" to listOf(row.groupIdHex, row.messageIdHex, source, index.toInt()),
                "hash" to reference.plaintextSha256, "sender" to row.sender, "incoming" to (row.sender != sender),
                "duration" to mediaDuration(tag[3]), "expiresAt" to row.retentionExpiresAt?.toDouble()?.times(1000),
                "sentAt" to row.timelineAt.toDouble())
            }
          }.take(24)
      }
    }
    AsyncFunction("editMessage") Coroutine { group: String, id: String, content: String ->
      withSession { it.kit.editMessage(it.account, group, id, content); Unit }
    }
    AsyncFunction("searchConversation") Coroutine { group: String, text: String?, media: Boolean ->
      withSession {
        val query = TimelineMessageQueryFfi(group, text, null, null, null,
          attachmentType = if (media) 5u else 0u, cursorGroupId = null, before = null,
          beforeMessageId = null, after = null, afterMessageId = null, limit = 40u)
        it.kit.timelineMessages(it.account, query).messages.filterNot { row -> row.deleted }.map { row ->
          mapOf("id" to row.messageIdHex, "sender" to row.sender, "text" to row.plaintext, "sentAt" to row.timelineAt.toDouble())
        }
      }
    }
    AsyncFunction("editHistory") Coroutine { group: String, message: String, before: Double?, id: String? ->
      withSession {
        val page = it.kit.messageEditHistory(it.account, group, message, before?.toULong(), id, 25u)
        mapOf("more" to page.hasMoreBefore, "versions" to page.versions.map { row ->
          mapOf("id" to row.messageIdHex, "text" to row.plaintext, "at" to row.editedAt.toDouble())
        })
      }
    }
    AsyncFunction("discardFailedSend") Coroutine { group: String, id: String ->
      withSession {
        it.kit.discardFailedSend(it.account, group, id).outcome.name.lowercase()
      }
    }
    AsyncFunction("deleteMessage") Coroutine { group: String, id: String ->
      withSession { it.kit.deleteMessage(it.account, group, id); Unit }
    }
    AsyncFunction("reportMessage") Coroutine { group: String, id: String, spam: Boolean ->
      withSession {
        val reason = if (spam) ReportReasonFfi.SPAM else ReportReasonFfi.OTHER
        it.kit.reportMessage(it.account, group, id, reason, "")
        Unit
      }
    }
    AsyncFunction("reactToMessage") Coroutine { group: String, id: String, emoji: String, remove: Boolean ->
      withSession {
        if (remove) it.kit.unreactFromMessageMatching(it.account, group, id, emoji)
        else it.kit.reactToMessage(it.account, group, id, emoji)
        Unit
      }
    }
    AsyncFunction("markRead") Coroutine { group: String, id: String ->
      withSession { it.kit.markTimelineMessageRead(it.account, group, id); Unit }
    }
    AsyncFunction("setArchived") Coroutine { group: String, archived: Boolean ->
      withSession { it.kit.setGroupArchived(it.account, group, archived); Unit }
    }
    AsyncFunction("setPinned") Coroutine { group: String, pinned: Boolean ->
      withSession { it.kit.setChatPinned(it.account, group, pinned); Unit }
    }
    AsyncFunction("setMuted") Coroutine { group: String, muted: Boolean ->
      withSession {
        if (muted) it.kit.setChatMuted(it.account, group, null)
        else it.kit.clearChatMuted(it.account, group)
        Unit
      }
    }
    AsyncFunction("watchBlockedUsers") Coroutine { owner: String, id: String ->
      withObservation(owner, id) { kit ->
        kit.subscribeBlockedUsers(owner).use { stream ->
          fun emit(snapshot: BlockListSnapshotFfi) {
            sendEvent("blockedUsers", mapOf("id" to id, "rows" to snapshot.document()))
          }
          currentCoroutineContext().ensureActive()
          emit(stream.snapshot() ?: throw problem("BlockListUnavailable"))
          while (true) {
            val snapshot = stream.next() ?: break
            currentCoroutineContext().ensureActive()
            emit(snapshot)
          }
        }
      }
    }
    AsyncFunction("setBlocked") Coroutine { owner: String, key: String, blocked: Boolean ->
      withDirectory(owner) { kit ->
        if (blocked) kit.blockUser(owner, key) else kit.unblockUser(owner, key)
        kit.subscribeBlockedUsers(owner).use { stream ->
          (stream.snapshot() ?: throw problem("BlockListUnavailable")).document()
        }
      }
    }
    AsyncFunction("retryConversation") Coroutine { group: String ->
      withSession { it.kit.retryGroupConvergence(it.account, group); Unit }
    }
    AsyncFunction("createPoll") Coroutine { group: String, question: String, options: List<String>, multiple: Boolean, expiresAt: Double? ->
      withSession {
        val type = if (multiple) PollTypeFfi.MULTIPLE_CHOICE else PollTypeFfi.SINGLE_CHOICE
        it.kit.createPoll(it.account, group, question, options, type, expiresAt?.toULong())
        Unit
      }
    }
    AsyncFunction("vote") Coroutine { group: String, message: String, selected: List<String> ->
      withSession { it.kit.castPollVote(it.account, group, message, selected); Unit }
    }
    AsyncFunction("deviceState").Coroutine<Document> {
      withSession { active ->
        val snapshot = active.kit.deviceLinkSnapshot(active.account)
        val joining = snapshot.newDevice
        mapOf(
          "state" to joining?.javaClass?.simpleName,
          "code" to (joining as? NewDeviceLinkStateFfi.Comparing)?.code.orEmpty().map { it.emoji },
          "prompts" to snapshot.prompts.map { prompt ->
            mapOf("id" to prompt.promptId, "state" to prompt.state.javaClass.simpleName,
              "code" to (prompt.state as? DeviceLinkPromptStateFfi.Comparing)?.code.orEmpty().map { it.emoji })
          },
          "stalled" to snapshot.deviceGroupStalled,
          "progress" to snapshot.chatProgress.map { row ->
            mapOf("slot" to row.slotIdHex, "remaining" to row.remaining.toInt(), "total" to row.total.toInt())
          },
          "devices" to active.kit.linkedDevices(active.account).map { device ->
            mapOf("slot" to device.slotIdHex, "current" to device.isThisDevice, "label" to device.label,
              "platform" to device.platform, "client" to device.client, "removalPending" to device.removalPending)
          },
        )
      }
    }
    AsyncFunction("deviceAction") Coroutine { action: String, target: String?, label: String?, allChats: Boolean, history: Boolean ->
      withSession {
        when (action) {
          "start" -> it.kit.startDeviceLink(it.account)
          "match" -> it.kit.confirmDeviceLinkMatch(it.account)
          "cancel" -> it.kit.cancelDeviceLink(it.account)
          "link" -> it.kit.linkDevice(it.account, target ?: throw problem("InvalidDevice"), label.orEmpty(), allChats, history)
          "decline" -> it.kit.declineDeviceLink(it.account, target ?: throw problem("InvalidDevice"))
          "remove" -> it.kit.removeLinkedDevice(it.account, target ?: throw problem("InvalidDevice"))
          else -> throw problem("InvalidDeviceAction")
        }
        Unit
      }
    }
    OnDestroy { observer.launch { try { shutdown(closeRuntime = true) } finally { observer.cancel() } } }
  }

  private fun dimensions(width: Int, height: Int): String? =
    if (width > 0 && height > 0) "${width}x$height" else null

  private fun uploadInputs(files: List<Map<String, String>>): List<MediaFileUploadAttachmentRequestFfi> {
    val context = appContext.reactContext ?: throw problem("ContextUnavailable")
    val base = File(context.applicationInfo.dataDir).canonicalFile.toPath()
    if (files.isEmpty() || files.size > 16) throw problem("InvalidMedia")
    return files.map { file ->
      val path = File(file.getValue("path")).canonicalFile
      if (!path.toPath().startsWith(base) || !path.isFile) throw problem("InvalidMediaPath")
      MediaFileUploadAttachmentRequestFfi(path.path, path.length().toULong(), file.getValue("name"), file.getValue("type"), file["dimensions"], file["thumbhash"])
    }
  }

  private fun matchesDraftBatch(token: String, draft: List<SelectedMessageDraftAttachmentFfi>) =
    draft.isNotEmpty() && draft.withIndex().all { (index, item) ->
      item.fileBacked && item.id.startsWith("$token:${draft.size}:$index:")
    }

  private suspend fun install(id: String, window: NativeWindow): Document {
    if (id in windows || windows.size >= 16) {
      window.stop()
      throw problem("WindowLimit")
    }
    val initial = window.initial()
    if (initial == null) {
      window.stop()
      throw problem("WindowClosed")
    }
    window.latest = initial
    windows[id] = window
    return initial
  }

  private suspend fun shutdown(closeRuntime: Boolean = false, pauseMessaging: Boolean = false) = withContext(NonCancellable + Dispatchers.IO) {
    shutdownTurn.withLock {
      val work = lifecycle.withLock {
        closingAccount = true
        directoryWork.keys.toList()
      }
      observations.values.toList().also { observations.clear() }.forEach { it.ticket.cancel() }
      work.forEach { it.cancel() }
      try {
        work.joinAll()
        drain(pauseMessaging, closeRuntime)
      } finally {
        lifecycle.withLock { closingAccount = false }
      }
    }
  }

  private suspend fun drain(pauseMessaging: Boolean, closeRuntime: Boolean) {
    val closing = lifecycle.withLock {
      if (closeRuntime) signerAccount = null
      val active = session ?: run {
        if (closeRuntime) stopRuntime()
        else if (pauseMessaging) pauseRuntime()
        return@withLock null
      }
      session = null
      active.closing = true
      if (active.activeCalls == 0) active.callsDrained.complete(Unit)
      synchronized(uploads) { uploads.values.toList() }.also { controls -> controls.forEach { it.cancel() } }
      attachmentAdmissions.values.forEach { it.set(true) }
      val transferControls = attachmentControls.values.toList()
      val open = windows.toMap()
      windows.clear()
      Triple(active, open, transferControls)
    } ?: return
    val (active, open, transferControls) = closing
    transferControls.forEach { runCatching { it.cancel() } }
    try {
      for ((id, window) in open) {
        window.stop()
        sendEvent("windowClosed", mapOf("id" to id, "code" to "AccountClosed"))
      }
    } finally {
      active.callsDrained.await()
      lifecycle.withLock {
        if (closeRuntime) stopRuntime()
        else if (pauseMessaging) pauseRuntime()
      }
    }
  }

  private fun requireSession() = session ?: throw problem("AccountClosed")
  private fun isDebuggable() =
    ((appContext.reactContext?.applicationInfo?.flags ?: 0) and ApplicationInfo.FLAG_DEBUGGABLE) != 0

  private suspend fun <T> withSession(work: suspend (Session) -> T): T = protocol {
    val active = lifecycle.withLock {
      requireSession().also { it.activeCalls += 1 }
    }
    try { work(active) } finally {
      withContext(NonCancellable) {
        lifecycle.withLock {
          active.activeCalls -= 1
          if (active.closing && active.activeCalls == 0) active.callsDrained.complete(Unit)
        }
      }
    }
  }
  private inline fun retryDraftEdit(edit: () -> Unit) {
    repeat(3) { attempt ->
      try {
        edit()
        return
      } catch (error: MarmotKitException.MessageDraftRevisionConflict) {
        if (attempt == 2) throw error
      }
    }
  }

  private suspend fun registerUpload(
    active: Session, token: String, control: MediaFileTransferControlFfi, draftGroup: String? = null,
  ) {
    lifecycle.withLock {
      if (session !== active || active.closing) throw problem("AccountClosed")
      synchronized(uploads) {
        if (uploads.containsKey(token) || (draftGroup != null && !draftStages.add(draftGroup))) throw problem("TransferInProgress")
        uploads[token] = control
      }
    }
  }
  private suspend fun <T> withWindow(id: String, work: suspend (NativeWindow) -> T): T =
    protocol { work(lifecycle.withLock { windows[id] ?: throw problem("WindowClosed") }) }

  private data class Session(
    val account: String,
    val kit: Marmot,
    var activeCalls: Int = 0,
    var closing: Boolean = false,
    val callsDrained: CompletableDeferred<Unit> = CompletableDeferred(),
  ) {
    fun readiness() = kit.accountSetupReadiness(account).name.lowercase()
  }

  private data class RuntimeConfiguration(
    val general: List<String>, val discovery: List<String>, val mediaOrigin: String?,
  )

  private fun discardImport() {
    identityImport?.second?.close()
    identityImport = null
  }

  private suspend fun stopRuntime() {
    discardImport()
    val kit = marmotRuntime ?: return
    marmotRuntime = null
    runtimeConfiguration = null
    runtimeStarted = false
    try { kit.shutdownAndClose() } finally { kit.close() }
  }

  private fun makeRuntime(configuration: RuntimeConfiguration): Marmot {
    val context = appContext.reactContext ?: throw problem("ContextUnavailable")
    initializeBindings(context)
    val kit = Marmot.newWithConfiguration(
      File(context.noBackupFilesDir, "marmot-accounts").canonicalPath,
      (configuration.general + configuration.discovery).distinct(),
      MarmotOptions(
        clientName = "Boop", devicePlatform = "Android",
        attachmentAcquisitionMode = AttachmentAcquisitionModeFfi.HOST_MANAGED,
        acquirePublicAvatars = false,
        deployment = marmotDeploymentNeutral().copy(
          keychainService = "app.boop.accounts",
          discoveryIndexerRelays = configuration.discovery,
          groupImageEndpoint = configuration.mediaOrigin,
          newGroupMediaEndpoints = listOfNotNull(configuration.mediaOrigin),
        ),
      ),
    )
    runtimeConfiguration = configuration
    marmotRuntime = kit
    return kit
  }

  private suspend fun pauseRuntime() {
    val configuration = runtimeConfiguration ?: return
    if (!runtimeStarted) return
    stopRuntime()
    makeRuntime(configuration)
  }

  private suspend fun <T> withRuntime(
    general: List<String>, discovery: List<String>, mediaOrigin: String?,
    reconfigure: Boolean = true, start: Boolean = true,
    work: suspend (Marmot) -> T,
  ): T = lifecycle.withLock {
    protocol {
      if (closingAccount) throw problem("AccountBusy")
      val configuration = RuntimeConfiguration(general, discovery, mediaOrigin)
      val kit = if (marmotRuntime != null && (!reconfigure || runtimeConfiguration == configuration)) {
        checkNotNull(marmotRuntime)
      } else {
        if (session != null) throw problem("AccountBusy")
        stopRuntime()
        makeRuntime(configuration)
      }
      if (start) startRuntime(kit)
      work(kit)
    }
  }

  private suspend fun startRuntime(kit: Marmot) {
    if (runtimeStarted) return
    try {
      kit.start()
      runtimeStarted = true
    } catch (error: Throwable) {
      withContext(NonCancellable) {
        val configuration = runtimeConfiguration
        runCatching { stopRuntime() }
        if (signerAccount != null && configuration != null) runCatching { makeRuntime(configuration) }
      }
      throw error
    }
  }

  private suspend fun withObservation(owner: String, id: String, work: suspend (Marmot) -> Unit) {
    val observation = observations[id] ?: throw problem("AccountClosed")
    val ticket = observation.ticket
    val job = currentCoroutineContext().job
    val cancellation = ticket.invokeOnCompletion { if (ticket.isCancelled) job.cancel() }
    try {
      withDirectory(owner, foreground = !observation.accountScoped, work = work)
    } finally {
      cancellation.dispose()
      observations.remove(id, observation)
      ticket.complete()
    }
  }

  private suspend fun <T> withDirectory(owner: String, foreground: Boolean = true, work: suspend (Marmot) -> T): T = protocol {
    val job = currentCoroutineContext().job
    val kit = lifecycle.withLock {
      if (closingAccount || (foreground && !downloadsForeground) || signerAccount != owner) throw problem("AccountClosed")
      (marmotRuntime ?: throw problem("AccountClosed")).also { directoryWork[job] = foreground }
    }
    try { work(kit) } finally { directoryWork.remove(job) }
  }

  private suspend fun <T> withSigner(key: String, work: suspend (Marmot) -> T): T =
    lifecycle.withLock {
      protocol {
        if (closingAccount || !downloadsForeground || signerAccount != key) throw problem("AccountClosed")
        val kit = marmotRuntime ?: throw problem("AccountClosed")
        work(kit)
      }
    }

  private fun BlockListSnapshotFfi.document(): Document =
    mapOf("revision" to revision.toString(), "keys" to users.map { it.publicKey })

  private fun searchResultDocument(row: UserDirectorySearchResultFfi): Document =
    mapOf("key" to row.accountIdHex, "profile" to row.profile?.let { profileDocument(row.accountIdHex, it, null, false) })

  private fun profileDocument(key: String, profile: UserProfileMetadataFfi, website: String?, bot: Boolean): Document =
    mapOf("key" to key, "name" to profile.name, "displayName" to profile.displayName,
      "about" to profile.about, "picture" to profile.picture, "banner" to profile.banner,
      "nip05" to profile.nip05, "lud16" to profile.lud16, "website" to website, "bot" to bot)

  private fun groupImageInput(path: String): ByteArray {
    val context = appContext.reactContext ?: throw problem("ContextUnavailable")
    val file = File(path).canonicalFile
    if (!file.toPath().startsWith(File(context.applicationInfo.dataDir).canonicalFile.toPath()) ||
      !file.isFile || file.length() !in 1L..MAX_GROUP_IMAGE.toLong()) throw problem("InvalidMediaPath")
    return file.inputStream().use { stream ->
      val bytes = stream.readNBytes(MAX_GROUP_IMAGE + 1)
      if (bytes.size !in 1..MAX_GROUP_IMAGE) throw problem("InvalidMedia")
      bytes
    }
  }

  companion object {
    private val HEX = Regex("[a-f0-9]{64}")
    private const val MAX_GROUP_IMAGE = 4 * 1024 * 1024
    private var initialized = false
    @Synchronized internal fun initializeBindings(context: Context) {
      if (initialized) return
      MarmotAndroid.initialize(context)
      initialized = true
    }
  }
}

private class AttachmentTransferControl(
  private val kit: Marmot,
  private val account: String,
  private val reference: String,
) {
  private val cancellation = Mutex()
  private var cancelled = false

  suspend fun cancel(): Unit = cancellation.withLock {
    if (cancelled) return@withLock
    val completed = withTimeoutOrNull(ATTACHMENT_CANCEL_TIMEOUT_MS) {
      kit.controlAttachment(account, reference, AttachmentControlFfi.CANCEL)
      true
    } ?: false
    cancelled = completed
    if (!completed) Log.w("BoopMarmot", "Attachment cancellation did not settle before its deadline")
  }
}

internal fun problem(code: String) = CodedException(code, code, null)
internal fun errorCode(error: Exception) = when (error) {
  is MarmotKitException.InvalidIdentity -> if (error.details == "identity backup exceeds the supported scrypt cost") "BackupCost" else "InvalidIdentity"
  is MarmotKitException.Runtime -> if (error.details == "device group refused: device_link_pending") "DeviceLinkPending" else "Runtime"
  is MarmotKitException -> error.javaClass.simpleName
  is CodedException -> error.code
  else -> "NativeFailure"
}

private suspend fun <T> protocol(work: suspend () -> T): T = withContext(Dispatchers.IO) {
  try { work() }
  catch (error: CancellationException) { throw error }
  catch (error: Exception) { throw problem(errorCode(error)) }
}
