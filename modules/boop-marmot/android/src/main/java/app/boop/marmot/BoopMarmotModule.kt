package app.boop.marmot

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.ExifInterface
import android.media.MediaMetadataRetriever
import android.media.ThumbnailUtils
import android.util.AtomicFile
import android.util.Size
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
  private val uploads = mutableMapOf<String, MediaFileTransferControlFfi>()
  private var session: Session? = null

  override fun definition() = ModuleDefinition {
    Name("BoopMarmot")
    Events("windowChanged", "windowClosed", "attachmentProgress")

    AsyncFunction("openAccount") Coroutine { key: String, secret: String, nsec: String, general: List<String>, inbox: List<String>, discovery: List<String>, mediaOrigin: String?, generated: Boolean ->
      lifecycle.withLock {
        protocol {
          val current = session
          if (current != null) {
            if (current.account != key) throw problem("IdentityMismatch")
            current.readiness()
          } else {
            val context = appContext.reactContext ?: throw problem("ContextUnavailable")
            val (opened, readiness) = open(context, key, secret, nsec, general, inbox, discovery, mediaOrigin, generated)
            session = opened
            readiness
          }
        }
      }
    }

    AsyncFunction("closeAccount").Coroutine<Unit> { shutdown() }
    AsyncFunction("catchUp").Coroutine<Unit> { withSession { it.kit.catchUpAccounts() } }
    AsyncFunction("diagnostics").Coroutine<Document> {
      withSession {
        val relays = it.kit.relayHealth()
        val keys = it.kit.keyPackageMaintenanceStatus(it.account)
        mapOf("account" to it.account, "readiness" to it.readiness(),
          "relays" to relays.totalRelays.toInt(), "connected" to relays.connected.toInt(),
          "keyPackages" to it.kit.localAccountKeyPackages(it.account).size,
          "keyPhase" to keys?.phase?.name?.lowercase(), "published" to keys?.acceptedFanoutTargets?.toInt(),
          "refreshOverdue" to it.kit.keyPackageRefreshOverdue(it.account))
      }
    }
    AsyncFunction("rotateKeys").Coroutine<Unit> {
      withSession { it.kit.rotateKeyPackage(it.account); Unit }
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
    AsyncFunction("openGroupState") Coroutine { id: String, group: String ->
      lifecycle.withLock {
        protocol {
          val active = requireSession()
          install(id, GroupStateWindow(id, active.kit.subscribeGroupState(active.account, group)))
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
            var previous: Document? = null
            while (isActive) {
              val value = window.next() ?: break
              val delta = previous?.let { windowDelta(it, value) }
              sendEvent("windowChanged", if (delta == null) mapOf("id" to id, "snapshot" to value)
                else mapOf("id" to id, "delta" to delta))
              previous = value
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
      withWindow(id) { it.initial() ?: throw problem("WindowClosed") }
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
    AsyncFunction("checkInvitee") Coroutine { peer: String ->
      withSession { it.kit.prewarmGroupMemberKeyPackages(it.account, listOf(peer)); Unit }
    }
    AsyncFunction("createGroup") Coroutine { name: String, description: String?, members: List<String>, image: String? ->
      withSession {
        val initial = image?.let { path -> InitialGroupImageFfi(groupImageInput(path), "image/jpeg", null, null, null) }
        val result = it.kit.createGroupWithInitialImageDetailed(it.account, name, members, description, initial)
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
        val delivery = it.kit.groupCommitDelivery(it.account, group)
        val recovery = it.kit.groupRecoveryStatus(it.account, group)
        val chat = it.kit.chatListRow(it.account, group)
        val actions = policy.memberActions.associateBy { row -> row.memberIdHex }
        mapOf(
          "id" to group, "name" to details.group.name, "description" to details.group.description,
          "inviter" to details.group.welcomerAccountIdHex, "relays" to details.group.relays,
          "image" to details.group.imageHashHex, "epoch" to details.mlsState.epoch.toString(),
          "mediaV2" to (details.group.encryptedMedia.version == EncryptedMediaVersionFfi.V2),
          "mediaEndpoints" to details.group.encryptedMedia.defaultBlobEndpoints.map { endpoint -> endpoint.baseUrl },
          "unrecoverable" to details.mlsState.unrecoverable,
          "convergenceParked" to (details.mlsState.convergenceParked || recovery.automaticRecoveryFailed),
          "historyIncomplete" to recovery.historyMayBeIncomplete,
          "relayChangesOutstanding" to ((delivery?.owedRelayUrls?.size ?: 0) + (delivery?.refusedRelays?.size ?: 0)),
          "membership" to details.group.selfMembership.name.lowercase(),
          "pendingInvitation" to details.group.pendingConfirmation,
          "kind" to chat?.conversationKind?.name?.lowercase(),
          "pendingLeave" to details.group.leaveRequestPending, "leaveBlocked" to details.group.leaveBlocked,
          "createdAt" to chat?.conversationCreatedAt?.toDouble(), "muted" to (chat?.muted ?: false),
          "archived" to details.group.archived, "canEdit" to policy.isSelfAdmin,
          "lifecycle" to policy.lifecycleState.name.lowercase(), "commit" to pending?.state?.name?.lowercase(),
          "isAdmin" to policy.isSelfAdmin, "canInvite" to policy.canInvite, "canLeave" to policy.canLeave,
          "canCancelLeave" to policy.canCancelLeave, "canDisband" to policy.canDisband,
          "canEnableDisbanding" to policy.canEnableDisbanding,
          "members" to details.members.map { member ->
            val perms = actions[member.memberIdHex]
            mapOf(
              "id" to member.memberIdHex, "npub" to member.npub,
              "name" to (member.displayName?.takeUnless { it == member.memberIdHex }
                ?: it.kit.defaultProfilePseudonym(member.memberIdHex)),
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
    AsyncFunction("updateGroupImage") Coroutine { group: String, path: String? ->
      withSession {
        if (path == null) it.kit.clearGroupImage(it.account, group)
        else it.kit.updateGroupImage(it.account, group, groupImageInput(path), "image/jpeg")
        Unit
      }
    }
    AsyncFunction("updateGroupMedia") Coroutine { group: String, origins: List<String> ->
      withSession {
        it.kit.replaceEncryptedMediaBlobEndpoints(it.account, group, origins.map { origin -> AppBlobEndpointFfi("blossom", origin) })
        Unit
      }
    }
    AsyncFunction("groupImage") Coroutine { group: String, hash: String, fetch: Boolean ->
      withSession {
        if (!hash.matches(HEX)) throw problem("InvalidMedia")
        val context = appContext.reactContext ?: throw problem("ContextUnavailable")
        val details = it.kit.groupDetails(it.account, group).group
        if (details.pendingConfirmation || details.selfMembership != SelfMembershipFfi.MEMBER || details.imageHashHex != hash) throw problem("MediaUnavailable")
        val folder = File(context.cacheDir, "marmot-group-images/${it.account}")
        folder.mkdirs()
        val file = AtomicFile(File(folder, "$hash.jpg"))
        if (!file.baseFile.isFile) {
          if (!fetch) return@withSession null
          val bytes = it.kit.downloadGroupBlossomImage(it.account, group)
          val current = it.kit.groupDetails(it.account, group).group
          if (bytes.isEmpty() || bytes.size > MAX_GROUP_IMAGE || current.selfMembership != SelfMembershipFfi.MEMBER ||
            current.imageHashHex != hash) throw problem("MediaUnavailable")
          val output = file.startWrite()
          try { output.write(bytes); file.finishWrite(output) }
          catch (error: Exception) { file.failWrite(output); throw error }
        }
        file.baseFile.canonicalPath
      }
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
        if (kind !in setOf(24881, 24883, 24884)) throw problem("InvalidApplicationEvent")
        val tags = reply?.let { target -> listOf(listOf("e", target, "", "reply")) } ?: emptyList()
        it.kit.sendCustomEvent(it.account, group, kind.toULong(), tags, body)
        Unit
      }
    }
    AsyncFunction("stageMediaDraft") Coroutine { group: String, files: List<Map<String, String>>, caption: String, token: String, reply: String? ->
      withSession { active ->
        val inputs = uploadInputs(files)
        var draft = active.kit.selectedMessageDraft(active.account, group)
        try {
          if (draft.draft?.mediaAttachments?.isNotEmpty() == true) throw problem("MediaDraftPending")
          val updated = active.kit.saveMessageDraftInputsIfRevision(active.account, draft.revision, caption, reply, emptyList())
          draft.destroy()
          draft = updated
          MediaFileTransferControlFfi().use { control ->
            synchronized(uploads) {
              if (uploads.containsKey(token)) throw problem("TransferInProgress")
              uploads[token] = control
            }
            try {
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
            } finally {
              synchronized(uploads) { uploads.remove(token) }
            }
          }
        } finally { draft.destroy() }
      }
    }
    AsyncFunction("discardMediaDraft") Coroutine { group: String ->
      withSession { active ->
        val selected = active.kit.selectedMessageDraft(active.account, group)
        try {
          val draft = selected.draft ?: return@withSession
          active.kit.saveMessageDraftInputsIfRevision(active.account, selected.revision, draft.content, draft.replyToMessageIdHex, emptyList()).destroy()
        } finally { selected.destroy() }
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
          synchronized(uploads) {
            if (uploads.containsKey(token)) throw problem("TransferInProgress")
            uploads[token] = control
          }
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
                  val accepted = active.kit.sendTaggedMessageDraftWithClientToken(active.account, selected.revision, result.attachments.map { it.reference }, metadata, token)
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
    AsyncFunction("attachmentStatus") Coroutine { group: String, id: String, source: String, index: Int ->
      withSession {
        val target = AttachmentLocalTargetFfi(id, source, index.toUInt())
        it.kit.attachmentTransferSnapshot(it.account, group, listOf(target)).items.firstOrNull()?.state == AttachmentTransferStateFfi.READY
      }
    }
    AsyncFunction("retainedAttachmentBytes") Coroutine { group: String, id: String, source: String, index: Int ->
      withSession { active ->
        val target = AttachmentLocalTargetFfi(id, source, index.toUInt())
        active.kit.attachmentLocalAssets(active.account, group, listOf(target))
          .firstOrNull()?.takeIf { it.reference != null }?.byteCount?.toDouble()
      }
    }
    AsyncFunction("cancelAttachment") Coroutine { group: String, id: String, source: String, index: Int ->
      withSession { active ->
        val target = AttachmentLocalTargetFfi(id, source, index.toUInt())
        val item = active.kit.attachmentTransferSnapshot(active.account, group, listOf(target)).items.firstOrNull()
        item?.reference?.let { active.kit.controlAttachment(active.account, it, AttachmentControlFfi.CANCEL) } ?: false
      }
    }
    AsyncFunction("downloadAttachment") Coroutine { group: String, id: String, source: String, index: Int, transfer: String ->
      withSession { active ->
        val target = AttachmentLocalTargetFfi(id, source, index.toUInt())
        val before = active.kit.attachmentTransferSnapshot(active.account, group, listOf(target)).items.firstOrNull()
        val reference = when (before?.state) {
          AttachmentTransferStateFfi.READY -> return@withSession
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
        } ?: throw problem("MediaUnavailable")
        val finished = withTimeoutOrNull(180_000) {
          active.kit.subscribeAttachmentTransfers(active.account, group, listOf(target)).use { updates ->
            while (true) {
              val item = updates.next()?.items?.firstOrNull() ?: throw problem("MediaUnavailable")
              if (item.reference != reference) throw problem("MediaUnavailable")
              sendEvent("attachmentProgress", mapOf("transfer" to transfer, "received" to item.received.toDouble(), "total" to item.total?.toDouble(), "state" to item.state.name.lowercase()))
              when (item.state) {
                AttachmentTransferStateFfi.READY -> break
                AttachmentTransferStateFfi.FAILED, AttachmentTransferStateFfi.UNAVAILABLE,
                AttachmentTransferStateFfi.POLICY_BLOCKED, AttachmentTransferStateFfi.REMOVED,
                AttachmentTransferStateFfi.PREVIOUSLY_ACQUIRED_UNAVAILABLE, AttachmentTransferStateFfi.RETRY_EXHAUSTED,
                AttachmentTransferStateFfi.CANCELLED, AttachmentTransferStateFfi.STORAGE_BLOCKED, AttachmentTransferStateFfi.PAUSED,
                AttachmentTransferStateFfi.CLEANED_BY_SETTING, AttachmentTransferStateFfi.COMPLETED_UNRETAINED ->
                  throw problem("MediaUnavailable")
                else -> Unit
              }
            }
          }
          true
        }
        if (finished != true) throw problem("MediaTimeout")
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
    AsyncFunction("markUnread") Coroutine { group: String ->
      withSession { it.kit.setChatManuallyUnread(it.account, group, true); Unit }
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
    OnDestroy { observer.launch { try { shutdown() } finally { observer.cancel() } } }
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
    windows[id] = window
    return initial
  }

  private suspend fun shutdown() = withContext(NonCancellable + Dispatchers.IO) {
    lifecycle.withLock {
      val active = session ?: return@withLock
      session = null
      synchronized(uploads) { uploads.values.forEach { it.cancel() } }
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
    general: List<String>, inbox: List<String>, discovery: List<String>, mediaOrigin: String?, generated: Boolean,
  ): Pair<Session, String> {
    if (!key.matches(HEX) || !secret.matches(HEX)) throw problem("IdentityMismatch")
    initializeBindings(context)
    val root = File(context.noBackupFilesDir, "marmot/$key")
    val store = AccountCredential(key, secret, File(root, "boop-credential"))
    val directorySources = (general + discovery).distinct()
    val kit = Marmot.newWithConfiguration(root.canonicalPath, directorySources, MarmotOptions(
      clientName = "Boop", devicePlatform = "Android", secretStore = store,
      attachmentAcquisitionMode = AttachmentAcquisitionModeFfi.HOST_MANAGED,
      deployment = marmotDeploymentNeutral().copy(
        discoveryIndexerRelays = discovery,
        groupImageEndpoint = mediaOrigin,
        newGroupMediaEndpoints = listOfNotNull(mediaOrigin),
      ),
    ))
    try {
      val known = kit.listAccounts()
      if (known.any { it.accountIdHex != key || it.label != key }) throw problem("IdentityMismatch")
      if (known.any { it.unlinked || it.signedOut }) throw problem("AccountSignedOut")
      kit.start()
      if (known.isEmpty()) {
        val account = if (generated) kit.createHostIdentity(nsec, general, discovery, inbox)
          else kit.login(nsec, general, discovery, inbox)
        if (account.accountIdHex != key || account.label != key) throw problem("IdentityMismatch")
      }
      val opened = Session(key, kit)
      return opened to opened.readiness()
    } catch (error: Throwable) {
      withContext(NonCancellable) {
        try { kit.shutdownAndClose() } catch (_: Exception) {} finally { kit.close() }
      }
      throw error
    }
  }

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
