package app.boop.marmot

import dev.ipf.marmotkit.*
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin

internal typealias Document = Map<String, Any?>

internal fun mediaPresentation(kind: String?, mime: String) = when {
  kind == "round" && mime.startsWith("video/", ignoreCase = true) -> "round"
  kind == "voice" && mime.startsWith("audio/", ignoreCase = true) -> "voice"
  else -> "file"
}

internal fun mediaDuration(value: String?) = value?.toDoubleOrNull()?.takeIf { it.isFinite() && it > 0 && it <= 604800 }

internal fun mediaWaveform(value: String?) = value.orEmpty().take(192).split(",").take(64)
  .mapNotNull { it.toIntOrNull()?.takeIf { level -> level in 0..31 }?.div(31.0) }

internal fun mediaMetadata(index: Int, size: ULong, duration: Double?, waveform: List<Double>, kind: String) =
  listOf("boop-media", index.toString(), size.toString(),
    duration?.toString().orEmpty(),
    waveform.take(64).joinToString(",") { kotlin.math.round(it.coerceIn(0.0, 1.0) * 31).toInt().toString() }, kind)

internal fun windowDelta(previous: Document, current: Document): Document? {
  val field = when (current["kind"]) {
    "chatList" -> "rows"
    "conversation" -> "messages"
    else -> return null
  }
  if (previous["generation"] != current["generation"]) return null
  fun rows(snapshot: Document): Map<String, Map<*, *>> =
    (snapshot[field] as List<*>).filterIsInstance<Map<*, *>>().associateBy { it["id"] as String }
  val old = rows(previous)
  val next = rows(current)
  return mapOf(
    "base" to previous["sequence"],
    "field" to field,
    "metadata" to (current - field),
    "order" to next.keys.toList(),
    "changed" to next.filter { (id, row) -> old[id] != row }.values.toList(),
  )
}

internal abstract class NativeWindow {
  var job: Job? = null
  @Volatile lateinit var latest: Document
  abstract fun initial(): Document?
  abstract suspend fun next(): Document?
  abstract suspend fun page(generation: String, sequence: ULong, direction: String): Document
  abstract suspend fun anchor(generation: String, sequence: ULong, target: String): Document
  protected abstract suspend fun release()

  suspend fun stop() {
    job?.cancelAndJoin()
    release()
  }
}

internal class ChatListWindow(private val handle: ChatListWindowSubscription) : NativeWindow() {
  override fun initial() = handle.snapshot()?.let(::project)
  override suspend fun next() = handle.next()?.let(::project)
  override suspend fun page(generation: String, sequence: ULong, direction: String) =
    project(handle.page(sequence, ChatListPageDirectionFfi.valueOf(direction.uppercase()), 40u))
  override suspend fun anchor(generation: String, sequence: ULong, target: String) =
    project(handle.setVisibleAnchor(sequence, target))
  override suspend fun release() = handle.close()
}

internal class AttentionWindow(private val handle: AccountAttentionSubscription, private val account: String) : NativeWindow() {
  override fun initial() = handle.snapshot()?.let(::project)
  override suspend fun next() = handle.next()?.let(::project)
  override suspend fun page(generation: String, sequence: ULong, direction: String): Document = throw problem("InvalidWindow")
  override suspend fun anchor(generation: String, sequence: ULong, target: String): Document = throw problem("InvalidWindow")
  override suspend fun release() = handle.close()

  private fun project(snapshot: AccountAttentionSnapshotFfi): Document {
    val state = snapshot.accounts.firstOrNull { it.accountIdHex == account }?.state as? AccountAttentionStateFfi.Ready
    return mapOf(
      "kind" to "attention", "generation" to snapshot.subscriptionGeneration, "sequence" to snapshot.sequence.toString(),
      "hasMoreBefore" to false, "hasMoreAfter" to false,
      "count" to state?.total?.let { (it.unreadCount + it.attentionOnlyConversations).toDouble() },
    )
  }
}

internal class GroupStateWindow(
  private val generation: String,
  private val handle: GroupStateSubscription,
  details: Document,
  private val kind: String,
  private val read: suspend () -> Document,
) : NativeWindow() {
  private var sequence = 0uL
  private var initial: Document? = project(details)
  override fun initial() = initial.also { initial = null; handle.snapshot() }
  override suspend fun next(): Document? {
    handle.next() ?: return null
    val details = read()
    sequence++
    return project(details)
  }
  override suspend fun page(generation: String, sequence: ULong, direction: String): Document = throw problem("InvalidWindow")
  override suspend fun anchor(generation: String, sequence: ULong, target: String): Document = throw problem("InvalidWindow")
  override suspend fun release() = handle.close()
  private fun project(details: Document): Document = mapOf(
    "kind" to kind, "generation" to generation, "sequence" to sequence.toString(),
    "hasMoreBefore" to false, "hasMoreAfter" to false, "details" to details,
  )
}

internal suspend fun groupDocument(kit: Marmot, account: String, group: String): Document {
  val snapshot = kit.groupConversationSnapshot(account, group)
  val details = snapshot.details
  val policy = snapshot.managementState
  val presented = kit.presentedChatListRow(account, group)
  val chat = presented?.row
  val actions = policy.memberActions.associateBy { row -> row.memberIdHex }
  return mapOf(
    "id" to group, "name" to details.group.name, "description" to details.group.description,
    "inviter" to details.group.welcomerAccountIdHex, "relays" to details.group.relays,
    "avatarAsset" to presented?.avatarAsset?.document(),
    "image" to details.group.imageHashHex,
    "mediaV2" to (details.group.encryptedMedia.version == EncryptedMediaVersionFfi.V2),
    "mediaEndpoints" to details.group.encryptedMedia.defaultBlobEndpoints.map { endpoint -> endpoint.baseUrl },
    "unrecoverable" to details.mlsState.unrecoverable,
    "convergenceParked" to details.mlsState.convergenceParked,
    "disbanding" to details.mlsState.disbanding,
    "epoch" to details.mlsState.epoch.toString(),
    "membership" to details.group.selfMembership.name.lowercase(),
    "pendingInvitation" to details.group.pendingConfirmation,
    "kind" to chat?.conversationKind?.name?.lowercase(),
    "pendingLeave" to details.group.leaveRequestPending, "leaveBlocked" to details.group.leaveBlocked,
    "createdAt" to chat?.conversationCreatedAt?.toDouble(), "muted" to (chat?.muted ?: false),
    "archived" to details.group.archived, "canEdit" to policy.isSelfAdmin,
    "lifecycle" to policy.lifecycleState.name.lowercase(),
    "canStepDown" to (policy.isSelfAdmin && !policy.isLastAdmin),
    "canInvite" to policy.canInvite, "canLeave" to policy.canLeave,
    "canCancelLeave" to policy.canCancelLeave, "canDisband" to policy.canDisband,
    "canEnableDisbanding" to policy.canEnableDisbanding,
    "members" to details.members.map { member ->
      val perms = actions[member.memberIdHex]
      member.document(kit) + mapOf(
        "canPromote" to (perms?.canPromote ?: false), "canRemove" to (perms?.canRemove ?: false),
        "canDemote" to (perms?.canDemote ?: false),
      )
    },
  )
}

private fun GroupMemberDetailsFfi.document(kit: Marmot): Document = mapOf(
  "id" to memberIdHex, "npub" to npub,
  "name" to (displayName?.takeUnless { it == memberIdHex } ?: kit.defaultProfilePseudonym(memberIdHex)),
  "self" to isSelf, "admin" to isAdmin, "devices" to deviceCount.toLong(),
)

internal suspend fun rosterDocument(kit: Marmot, account: String, group: String): Document {
  val roster = kit.groupRoster(account, group)
  return mapOf(
    "revision" to roster.rosterRevision.toString(),
    "membership" to roster.selfMembership.name.lowercase(),
    "lifecycle" to roster.lifecycleState.name.lowercase(),
    "members" to roster.members.map { it.document(kit) },
  )
}

internal suspend fun groupDiagnostics(kit: Marmot, account: String, group: String): Document {
  val pending = kit.groupPendingCommit(account, group)
  val recovery = kit.groupRecoveryStatus(account, group)
  return mapOf(
    "commit" to pending?.state?.name?.lowercase(),
    "automaticRecoveryFailed" to recovery.automaticRecoveryFailed,
    "historyIncomplete" to recovery.historyMayBeIncomplete,
    "rejoinOffers" to recovery.rejoinInvitations.map { offer ->
      mapOf("welcome" to offer.welcomeIdHex, "inviter" to offer.welcomerAccountIdHex, "token" to offer.localStateToken)
    },
  )
}

internal class GroupCallWindow(
  private val generation: String,
  private val handle: MessagesSubscription,
  private val read: () -> List<AppMessageRecordFfi>,
) : NativeWindow() {
  private var sequence = 0L
  override fun initial() = project(handle.snapshot())
  override suspend fun next() = handle.next()?.let { sequence++; project(read()) }
  override suspend fun page(generation: String, sequence: ULong, direction: String): Document = throw problem("InvalidWindow")
  override suspend fun anchor(generation: String, sequence: ULong, target: String): Document = throw problem("InvalidWindow")
  override suspend fun release() = handle.close()
  private fun project(rows: List<AppMessageRecordFfi>): Document = mapOf(
    "kind" to "groupCall", "generation" to generation, "sequence" to sequence.toString(),
    "hasMoreBefore" to false, "hasMoreAfter" to false,
    "announcements" to rows.filter {
      it.plaintext.length <= 750 && it.plaintext.encodeToByteArray().size <= 750
    }.map {
      mapOf("text" to it.plaintext, "sender" to it.sender, "sentAt" to it.recordedAt.toDouble(), "invalidated" to it.invalidated)
    },
  )
}

internal class ConversationWindow(private val handle: ConversationWindowSubscription) : NativeWindow() {
  override fun initial() = handle.snapshot()?.let(::project)
  override suspend fun next() = handle.next()?.let(::project)
  override suspend fun page(generation: String, sequence: ULong, direction: String): Document {
    val revision = ConversationWindowRevisionFfi(generation, sequence)
    return project(
      if (direction == "latest") handle.returnToLatest(revision, 0u)
      else handle.page(revision, ConversationPageDirectionFfi.valueOf(direction.uppercase()), 40u, 0u)
    )
  }
  override suspend fun anchor(generation: String, sequence: ULong, target: String) =
    project(handle.setVisibleAnchor(ConversationWindowRevisionFfi(generation, sequence), target, 0u))
  suspend fun jump(generation: String, sequence: ULong, target: String) =
    project(handle.jumpToMessage(ConversationWindowRevisionFfi(generation, sequence), target, 0u))
  override suspend fun release() {
    try { handle.cancel() } finally { handle.close() }
  }
}

internal fun AvatarAssetFfi.document(): Document = mapOf(
  "target" to target,
  "reference" to reference,
  "revision" to contentRevision.toString(),
  "availability" to availability.name.lowercase(),
)

private fun ConversationPresentationFfi.literal() = (title as? PresentationTextFfi.Literal)?.text

private fun project(snapshot: ChatListWindowSnapshotFfi): Document = mapOf(
  "kind" to "chatList",
  "generation" to snapshot.subscriptionGeneration,
  "sequence" to snapshot.sequence.toString(),
  "hasMoreBefore" to snapshot.hasMoreBefore,
  "hasMoreAfter" to snapshot.hasMoreAfter,
  "rows" to snapshot.rows.map { row ->
    val chat = row.row
    mapOf(
      "id" to chat.groupIdHex,
      "title" to row.presentation.literal(),
      "peer" to row.presentation.peerId,
      "image" to chat.avatar?.imageHashHex,
      "avatarAsset" to row.avatarAsset?.document(),
      "kind" to chat.conversationKind.name.lowercase(),
      "lifecycle" to chat.lifecycleState.name.lowercase(),
      "membership" to chat.selfMembership.name.lowercase(),
      "invited" to chat.pendingConfirmation,
      "pinned" to chat.pinned,
      "muted" to chat.muted,
      "archived" to chat.archived,
      "unread" to chat.unreadCount.toDouble(),
      "mentioned" to (chat.unreadMentionCount > 0uL),
      "manualUnread" to chat.manuallyMarkedUnread,
      "updatedAt" to chat.activitySortAt.toDouble(),
      "previewSelection" to when (row.preview) {
        is SelectedChatPreviewFfi.Draft -> "draft"
        SelectedChatPreviewFfi.Message -> "message"
        SelectedChatPreviewFfi.Invitation -> "invitation"
        SelectedChatPreviewFfi.Empty -> "empty"
      },
      "preview" to chat.lastMessage?.let {
        mapOf("id" to it.messageIdHex, "sender" to it.sender, "kind" to it.kind.toDouble(),
          "text" to it.plaintext.takeUnless { _ -> it.deleted }, "expiresAt" to it.retentionExpiresAt?.toDouble(),
          "content" to it.contentTokens.takeIf { _ -> !it.deleted && (it.kind == 9uL || it.kind == 1111uL) }?.document())
      },
      "draft" to (row.preview as? SelectedChatPreviewFfi.Draft)?.draft?.text,
    )
  },
)

private val applicationReplyId = Regex("[0-9a-f]{64}")

private fun applicationReply(kind: ULong, tags: List<List<String>>): String? =
  if (kind == 24881uL) tags.singleOrNull { tag ->
    tag.size == 4 && tag[0] == "e" && tag[2].isEmpty() && tag[3] == "reply" &&
      applicationReplyId.matches(tag[1])
  }?.get(1) else null

private fun project(snapshot: ConversationWindowSnapshotFfi): Document = mapOf(
  "kind" to "conversation",
  "generation" to snapshot.revision.generation,
  "sequence" to snapshot.revision.sequence.toString(),
  "hasMoreBefore" to snapshot.hasMoreBefore,
  "hasMoreAfter" to snapshot.hasMoreAfter,
  "title" to snapshot.header.selected.literal(),
  "peer" to snapshot.header.selected.takeIf {
    it.titleSource == PresentationSourceFfi.PEER_PROFILE || it.titleSource == PresentationSourceFfi.PEER_FALLBACK
  }?.peerId,
  "image" to (snapshot.header.selected.avatar as? SelectedAvatarFfi.EncryptedGroupImage)?.image?.imageHashHex,
  "avatarAsset" to snapshot.header.avatarAsset?.document(),
  "lifecycle" to snapshot.header.lifecycle.name.lowercase(),
  "memberCount" to snapshot.header.memberCount?.toDouble(),
  "invited" to snapshot.pendingConfirmation,
  "authorityReady" to (snapshot.header.epoch != null),
  "canSend" to snapshot.header.capabilities.canSend,
  "firstUnread" to snapshot.readState.firstUnreadMessageIdHex,
  "atTail" to (snapshot.anchor.kind == ConversationAnchorKindFfi.LATEST || snapshot.anchor.kind == ConversationAnchorKindFfi.EMPTY),
  "draft" to snapshot.draft.draft?.let { draft ->
    mapOf("text" to draft.content, "replyTo" to draft.replyToMessageIdHex, "attachments" to draft.mediaAttachments.map { item ->
      mapOf("id" to item.id, "size" to item.plaintextSize.toDouble(),
        "name" to item.fileName, "type" to item.mediaType,
        "dimensions" to item.dim, "thumbhash" to item.thumbhash,
        "duration" to item.durationSeconds,
        "waveform" to item.waveformSamples.take(64).map { kotlin.math.round(it.coerceIn(0.0, 1.0) * 31).toInt() })
    })
  },
  "identities" to snapshot.identities.map {
    mapOf("id" to it.accountIdHex, "name" to it.displayName, "avatarAsset" to it.avatarAsset?.document())
  },
  "messages" to snapshot.messages.mapNotNull { message ->
    val row = message.timeline
    val system = row.groupSystem?.takeIf { it.provenance == GroupSystemEventProvenanceFfi.AUTHENTICATED_GROUP_STATE }
    if (system == null && row.poll == null && row.kind !in setOf(9uL, 1111uL, 24881uL, 24883uL)) return@mapNotNull null
    mapOf(
      "id" to row.messageIdHex,
      "token" to row.clientToken,
      "sender" to row.sender,
      "text" to row.plaintext,
      "content" to row.contentTokens.takeIf { row.kind == 9uL || row.kind == 1111uL }?.document(),
      "sentAt" to row.timelineAt.toDouble(),
      "expiresAt" to row.retentionExpiresAt?.toDouble(),
      "eventKind" to row.kind.toInt(),
      "replyTo" to (row.replyToMessageIdHex ?: applicationReply(row.kind, row.tags.map { it.values })),
      "thread" to row.thread?.let { mapOf("root" to it.rootMessageIdHex, "parent" to it.parentMessageIdHex) },
      "replyPreview" to row.replyPreview?.let {
        mapOf("id" to it.messageIdHex, "sender" to it.sender, "eventKind" to it.kind.toDouble(),
          "text" to if (it.kind == 24881uL) "" else it.plaintext,
          "deleted" to it.deleted, "deletionSource" to it.deletionSource.name.lowercase(),
          "invalidationStatus" to it.invalidationStatus,
          "content" to it.contentTokens.takeUnless { _ -> it.kind == 24881uL }?.document(),
          "expiresAt" to it.retentionExpiresAt?.toDouble(), "mentions" to message.references.replyMentions)
      },
      "mentions" to message.references.mentions,
      "retentionSeconds" to row.retentionSeconds?.toString(),
      "reactions" to message.references.reactions.items.map {
        mapOf("emoji" to it.emoji, "count" to it.count.toDouble(), "users" to it.reactors, "own" to it.viewerReacted)
      },
      "attachments" to row.media.map { media ->
        when (media) {
          is MediaAttachmentOutcomeFfi.Rejected -> mapOf(
            "outcome" to "rejected", "index" to media.attachmentIndex.toDouble(),
            "reason" to media.rejection.kind.name.lowercase(), "detail" to media.rejection.detail,
          )
          is MediaAttachmentOutcomeFfi.Accepted -> {
            val reference = media.reference
            val metadata = row.tags.singleOrNull { tag -> tag.values.size == 6 && tag.values[0] == "boop-media" &&
              tag.values[1] == media.attachmentIndex.toString() }?.values?.drop(2)
            if (reference.version != EncryptedMediaVersionFfi.V2) mapOf(
              "outcome" to "rejected", "index" to media.attachmentIndex.toDouble(), "reason" to "unsupported_format",
            ) else mapOf(
              "outcome" to "accepted", "index" to media.attachmentIndex.toDouble(),
              "name" to reference.fileName, "type" to reference.mediaType,
              "thumbhash" to reference.thumbhash, "dimensions" to reference.dim,
              "plaintextHash" to reference.plaintextSha256,
              "metadata" to metadata?.takeIf { it.all { value -> value.length <= 192 } },
            )
          }
        }
      },
      "sourceId" to row.sourceMessageIdHex,
      "poll" to row.poll?.let { poll ->
        mapOf("question" to poll.question, "multiple" to (poll.pollType == PollTypeFfi.MULTIPLE_CHOICE), "open" to poll.open,
          "selected" to poll.localSelection, "expiresAt" to poll.endsAt?.toDouble(),
          "options" to poll.options.map { mapOf("id" to it.id, "name" to it.label, "votes" to it.votes.toDouble()) })
      },
      "deleted" to row.deleted,
      "edited" to (row.edit != null),
      "recipientConfirmed" to row.recipientConfirmed,
      "invalidationStatus" to row.invalidationStatus,
      "deletionSource" to row.deletionSource.name.lowercase(),
      "historyImport" to when (row.historyImportProvenance) {
        is HistoryImportProvenanceFfi.Device -> "device"
        is HistoryImportProvenanceFfi.Backup -> "backup"
        null -> null
      },
      "system" to system?.let {
        mapOf("type" to it.systemType, "actor" to it.actorAccountIdHex, "subject" to it.subjectAccountIdHex,
          "name" to it.name, "oldName" to it.oldName, "retentionSeconds" to it.newRetentionSeconds?.toString())
      },
    )
  },
)
