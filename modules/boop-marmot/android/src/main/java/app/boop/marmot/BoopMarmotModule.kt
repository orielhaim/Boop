package app.boop.marmot

import android.content.Context
import android.util.AtomicFile
import dev.ipf.marmotkit.*
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.File
import java.io.FileNotFoundException

class BoopMarmotModule : Module() {
  private val lifecycle = Mutex()
  private val observer = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val windows = mutableMapOf<String, NativeWindow>()
  private var session: Session? = null

  override fun definition() = ModuleDefinition {
    Name("BoopMarmot")
    Events("windowChanged", "windowClosed")

    AsyncFunction("openAccount") Coroutine { key: String, secret: String, nsec: String, general: List<String>, inbox: List<String>, discovery: List<String> ->
      lifecycle.withLock {
        protocol {
          val current = session
          if (current != null) {
            if (current.account != key) throw problem("IdentityMismatch")
            current.readiness()
          } else {
            val context = appContext.reactContext ?: throw problem("ContextUnavailable")
            val opened = open(context, key, secret, nsec, general, inbox, discovery)
            session = opened
            opened.readiness()
          }
        }
      }
    }

    AsyncFunction("closeAccount").Coroutine<Unit> { shutdown() }
    AsyncFunction("accountReadiness").Coroutine<String> {
      withSession { it.readiness() }
    }

    AsyncFunction("openChatList") Coroutine { id: String, view: String ->
      lifecycle.withLock {
        protocol {
          val active = requireSession()
          val handle = active.kit.openChatListWindow(active.account, ChatListViewFfi.valueOf(view.uppercase()), 40u)
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
    AsyncFunction("openConversation") Coroutine { id: String, group: String, target: String? ->
      lifecycle.withLock {
        protocol {
          val active = requireSession()
          val mode = if (target == null) ConversationOpenModeFfi.AUTOMATIC else ConversationOpenModeFfi.MESSAGE
          val handle = active.kit.openConversationWindow(active.account, group, mode, target, 40u, 0u)
          install(id, ConversationWindow(handle))
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
              sendEvent("windowChanged", mapOf("id" to id, "snapshot" to value))
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
    AsyncFunction("createGroup") Coroutine { name: String, description: String?, members: List<String> ->
      withSession {
        val result = it.kit.createGroupDetailed(it.account, name, members, description)
        mapOf("groupId" to result.created?.groupIdHex, "members" to result.memberOutcomes.map { member ->
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
    AsyncFunction("groupDetails") Coroutine { group: String ->
      withSession {
        val details = it.kit.groupDetails(it.account, group)
        val policy = it.kit.groupManagementState(it.account, group)
        val pending = it.kit.groupPendingCommit(it.account, group)
        val actions = policy.memberActions.associateBy { row -> row.memberIdHex }
        mapOf(
          "id" to group, "name" to details.group.name, "description" to details.group.description,
          "inviter" to details.group.welcomerAccountIdHex, "relays" to details.group.relays,
          "retention" to details.group.disappearingMessageSecs.toDouble(),
          "membership" to details.group.selfMembership.name.lowercase(),
          "lifecycle" to policy.lifecycleState.name.lowercase(), "commit" to pending?.state?.name?.lowercase(),
          "isAdmin" to policy.isSelfAdmin, "canInvite" to policy.canInvite, "canLeave" to policy.canLeave,
          "canCancelLeave" to policy.canCancelLeave, "canDisband" to policy.canDisband,
          "canEnableDisbanding" to policy.canEnableDisbanding,
          "members" to details.members.map { member ->
            val perms = actions[member.memberIdHex]
            mapOf(
              "id" to member.memberIdHex, "npub" to member.npub, "name" to member.displayName,
              "self" to member.isSelf, "admin" to member.isAdmin, "devices" to member.deviceCount.toInt(),
              "canPromote" to (perms?.canPromote ?: false), "canRemove" to (perms?.canRemove ?: false),
              "canDemote" to (perms?.canDemote ?: false),
            )
          },
        )
      }
    }
    AsyncFunction("updateGroup") Coroutine { group: String, name: String?, description: String? ->
      withSession { it.kit.updateGroupProfile(it.account, group, name, description); Unit }
    }
    AsyncFunction("updateRetention") Coroutine { group: String, seconds: Int ->
      withSession { it.kit.updateMessageRetention(it.account, group, seconds.toULong()); Unit }
    }
    AsyncFunction("inviteMembers") Coroutine { group: String, members: List<String> ->
      withSession { session ->
        val result = session.kit.inviteMembersDetailed(session.account, group, members)
        result.invite.memberOutcomes.map {
          mapOf("account" to it.accountIdHex, "status" to it.status.name.lowercase(), "devices" to it.selectedDeviceCount.toInt())
        }
      }
    }
    AsyncFunction("changeMember") Coroutine { group: String, member: String, action: String ->
      withSession {
        when (action) {
          "remove" -> it.kit.removeMembers(it.account, group, listOf(member))
          "promote" -> it.kit.promoteAdmin(it.account, group, member)
          "demote" -> it.kit.demoteAdmin(it.account, group, member)
          else -> throw problem("InvalidGroupAction")
        }
        Unit
      }
    }
    AsyncFunction("changeMembership") Coroutine { group: String, action: String ->
      withSession {
        when (action) {
          "leave" -> it.kit.leaveGroup(it.account, group)
          "cancelLeave" -> it.kit.cancelLeave(it.account, group)
          "forget" -> it.kit.deleteGroupLocal(it.account, group)
          "disband" -> it.kit.disbandGroup(it.account, group)
          "enableDisbanding" -> it.kit.enableGroupDisbanding(it.account, group)
          else -> throw problem("InvalidGroupAction")
        }
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
      withSession {
        val draft = it.kit.selectedMessageDraft(it.account, group)
        try {
          val retained = draft.draft?.mediaAttachments.orEmpty().map { item -> MessageDraftAttachmentInputFfi.Retained(item.id) }
          if (text.isBlank() && retained.isEmpty()) it.kit.clearMessageDraftIfRevision(it.account, draft.revision).destroy()
          else it.kit.saveMessageDraftInputsIfRevision(it.account, draft.revision, text, reply, retained).destroy()
        } finally { draft.destroy() }
      }
    }
    AsyncFunction("sendSpecial") Coroutine { group: String, kind: Int, body: String, reply: String? ->
      withSession {
        if (kind != 24881 && kind != 24883) throw problem("InvalidApplicationEvent")
        val tags = reply?.let { target -> listOf(listOf("e", target, "", "reply")) } ?: emptyList()
        it.kit.sendCustomEvent(it.account, group, kind.toULong(), tags, body)
        Unit
      }
    }
    AsyncFunction("sendMedia") Coroutine { group: String, files: List<Map<String, String>>, caption: String?, token: String, server: String?, reply: String? ->
      withSession {
        val context = appContext.reactContext ?: throw problem("ContextUnavailable")
        val base = File(context.applicationInfo.dataDir).canonicalFile.toPath()
        if (files.isEmpty() || files.size > 16) throw problem("InvalidMedia")
        val inputs = files.map { file ->
          val path = File(file.getValue("path")).canonicalFile
          if (!path.toPath().startsWith(base) || !path.isFile) throw problem("InvalidMediaPath")
          MediaFileUploadAttachmentRequestFfi(path.path, path.length().toULong(), file.getValue("name"), file.getValue("type"), file["dimensions"], file["thumbhash"])
        }
        val tags = reply?.let { id -> listOf(listOf("e", id, "", "reply")) } ?: emptyList()
        MediaFileTransferControlFfi().use { control ->
          val result = it.kit.uploadMediaFilesWithClientToken(it.account, group,
            MediaFileUploadRequestFfi(inputs, caption, true, server, tags), control, token)
          result.acceptance?.messageIdHex ?: throw problem("MediaSendNotAccepted")
        }
      }
    }
    AsyncFunction("downloadAttachment") Coroutine { group: String, id: String, source: String, index: Int ->
      withSession { active ->
        val target = AttachmentLocalTargetFfi(id, source, index.toUInt())
        active.kit.subscribeAttachmentTransfers(active.account, group, listOf(target)).use { updates ->
          active.kit.requestExplicitAttachment(active.account, group, target)
          withTimeout(180_000) {
            var snapshot = updates.next()
            while (true) {
              val status = snapshot?.items?.firstOrNull()?.state
              when (status) {
                AttachmentTransferStateFfi.READY -> break
                AttachmentTransferStateFfi.FAILED, AttachmentTransferStateFfi.UNAVAILABLE,
                AttachmentTransferStateFfi.POLICY_BLOCKED, AttachmentTransferStateFfi.REMOVED,
                AttachmentTransferStateFfi.PREVIOUSLY_ACQUIRED_UNAVAILABLE -> throw problem("MediaUnavailable")
                else -> snapshot = updates.next() ?: throw problem("MediaUnavailable")
              }
            }
          }
        }
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
    AsyncFunction("editMessage") Coroutine { group: String, id: String, content: String ->
      withSession { it.kit.editMessage(it.account, group, id, content); Unit }
    }
    AsyncFunction("deleteMessage") Coroutine { group: String, id: String ->
      withSession { it.kit.deleteMessage(it.account, group, id); Unit }
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
    AsyncFunction("setBlocked") Coroutine { key: String, blocked: Boolean ->
      withSession {
        if (blocked) it.kit.blockUser(it.account, key) else it.kit.unblockUser(it.account, key)
        Unit
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
              "platform" to device.platform, "client" to device.client)
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
    OnDestroy { observer.launch { shutdown(); observer.cancel() } }
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
    windows[id] = window
    return initial
  }

  private suspend fun shutdown() = withContext(NonCancellable + Dispatchers.IO) {
    lifecycle.withLock {
      val active = session ?: return@withLock
      session = null
      val open = windows.toMap()
      windows.clear()
      try {
        for ((id, window) in open) {
          window.stop()
          sendEvent("windowClosed", mapOf("id" to id, "code" to "AccountClosed"))
        }
      } finally {
        try { active.kit.shutdownAndClose() } finally { active.kit.close() }
      }
    }
  }

  private fun requireSession() = session ?: throw problem("AccountClosed")
  private suspend fun <T> withSession(work: suspend (Session) -> T): T =
    protocol { work(lifecycle.withLock { requireSession() }) }
  private suspend fun <T> withWindow(id: String, work: suspend (NativeWindow) -> T): T =
    protocol { work(lifecycle.withLock { windows[id] ?: throw problem("WindowClosed") }) }

  private data class Session(val account: String, val kit: Marmot) {
    fun readiness() = kit.accountSetupReadiness(account).name.lowercase()
  }

  private suspend fun open(
    context: Context, key: String, secret: String, nsec: String,
    general: List<String>, inbox: List<String>, discovery: List<String>,
  ): Session {
    if (!key.matches(HEX) || !secret.matches(HEX)) throw problem("IdentityMismatch")
    initializeBindings(context)
    val root = File(context.noBackupFilesDir, "marmot/$key")
    val store = AccountCredential(key, secret, File(root, "boop-credential"))
    val kit = Marmot.newWithConfiguration(root.canonicalPath, general, MarmotOptions(
      clientName = "Boop", devicePlatform = "Android", secretStore = store,
      attachmentAcquisitionMode = AttachmentAcquisitionModeFfi.HOST_MANAGED,
      deployment = marmotDeploymentNeutral(),
    ))
    try {
      val known = kit.listAccounts()
      if (known.any { it.accountIdHex != key || it.label != key }) throw problem("IdentityMismatch")
      if (known.any { it.unlinked || it.signedOut }) throw problem("AccountSignedOut")
      kit.start()
      if (known.isEmpty()) {
        val account = kit.login(nsec, general, discovery, inbox)
        if (account.accountIdHex != key || account.label != key) throw problem("IdentityMismatch")
      }
      return Session(key, kit)
    } catch (error: Throwable) {
      withContext(NonCancellable) {
        try { kit.shutdownAndClose() } catch (_: Exception) {} finally { kit.close() }
      }
      throw error
    }
  }

  companion object {
    private val HEX = Regex("[a-f0-9]{64}")
    private var initialized = false
    @Synchronized private fun initializeBindings(context: Context) {
      if (initialized) return
      MarmotAndroid.initialize(context)
      initialized = true
    }
  }
}

private class AccountCredential(
  private val account: String, private val secret: String, marker: File,
) : SecretStore {
  private val file = AtomicFile(marker)

  @Synchronized override fun hasSecretForLabel(label: String) = label == account && registered()
  @Synchronized override fun hasSecretForAccountId(accountIdHex: String) = accountIdHex == account && registered()

  @Synchronized override fun writeSecret(label: String, accountIdHex: String, secretKeyHex: String) {
    if (label != account || accountIdHex != account || secretKeyHex != secret) {
      throw MarmotKitException.KeystoreUnavailable("Identity mismatch")
    }
    val stream = file.startWrite()
    try {
      stream.write(account.toByteArray(Charsets.US_ASCII))
      file.finishWrite(stream)
    } catch (error: Exception) {
      file.failWrite(stream)
      throw MarmotKitException.KeystoreUnavailable("Account credential registration failed")
    }
  }

  @Synchronized override fun loadSecret(label: String, accountIdHex: String): String {
    if (label != account || accountIdHex != account || !registered()) {
      throw MarmotKitException.SecretNotFound("Account credential unavailable")
    }
    return secret
  }

  @Synchronized override fun removeSecret(label: String, accountIdHex: String) {
    if (label == account && accountIdHex == account) file.delete()
  }

  private fun registered(): Boolean {
    val stored = try { file.readFully() } catch (_: FileNotFoundException) { return false }
    if (stored.toString(Charsets.US_ASCII) != account) {
      throw MarmotKitException.KeystoreUnavailable("Identity mismatch")
    }
    return true
  }
}

internal fun problem(code: String) = CodedException(code, code, null)
internal fun errorCode(error: Exception) = when (error) {
  is MarmotKitException -> error.javaClass.simpleName
  is CodedException -> error.code
  else -> "NativeFailure"
}

private suspend fun <T> protocol(work: suspend () -> T): T = withContext(Dispatchers.IO) {
  try { work() }
  catch (error: CancellationException) { throw error }
  catch (error: Exception) { throw problem(errorCode(error)) }
}
