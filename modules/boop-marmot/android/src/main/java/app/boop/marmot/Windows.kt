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

internal class GroupStateWindow(private val generation: String, private val handle: GroupStateSubscription) : NativeWindow() {
  private val sequence = java.util.concurrent.atomic.AtomicLong(0)
  override fun initial() = handle.snapshot()?.let { current() }
  override suspend fun next() = handle.next()?.let { sequence.incrementAndGet(); current() }
  override suspend fun page(generation: String, sequence: ULong, direction: String): Document = throw problem("InvalidWindow")
  override suspend fun anchor(generation: String, sequence: ULong, target: String): Document = throw problem("InvalidWindow")
  override suspend fun release() = handle.close()
  private fun current(): Document = mapOf(
    "kind" to "groupState", "generation" to generation, "sequence" to sequence.get().toString(),
    "hasMoreBefore" to false, "hasMoreAfter" to false,
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
    "announcements" to rows.filter { it.plaintext.length <= 750 }.map {
      mapOf("text" to it.plaintext, "sender" to it.sender, "sentAt" to it.recordedAt.toDouble(), "invalidated" to it.invalidated)
    },
  )
}

internal class ConversationWindow(private val handle: ConversationWindowSubscription) : NativeWindow() {
  override fun initial() = handle.snapshot()?.let(::project)
  override suspend fun next() = handle.next()?.let(::project)
  override suspend fun page(generation: String, sequence: ULong, direction: String) =
    project(handle.page(ConversationWindowRevisionFfi(generation, sequence), ConversationPageDirectionFfi.valueOf(direction.uppercase()), 40u, 0u))
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
      "manualUnread" to chat.manuallyMarkedUnread,
      "updatedAt" to chat.activitySortAt.toDouble(),
      "preview" to chat.lastMessage?.takeUnless { it.deleted }?.plaintext,
      "previewKind" to chat.lastMessage?.kind?.toDouble(),
      "previewId" to chat.lastMessage?.messageIdHex,
      "previewSender" to chat.lastMessage?.sender,
      "draft" to (row.preview as? SelectedChatPreviewFfi.Draft)?.draft?.text,
    )
  },
)

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
  "draft" to snapshot.draft.draft?.let { draft ->
    mapOf("text" to draft.content, "replyTo" to draft.replyToMessageIdHex, "attachments" to draft.mediaAttachments.map { item ->
      mapOf("id" to item.id, "size" to item.plaintextSize.toDouble(),
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
      "sentAt" to row.timelineAt.toDouble(),
      "expiresAt" to row.retentionExpiresAt?.toDouble(),
      "eventKind" to row.kind.toInt(),
      "replyTo" to row.replyToMessageIdHex,
      "replyPreview" to row.replyPreview?.let { mapOf("id" to it.messageIdHex, "sender" to it.sender, "text" to it.plaintext) },
      "reactions" to message.references.reactions.items.map {
        mapOf("emoji" to it.emoji, "count" to it.count.toDouble(), "users" to it.reactors, "own" to it.viewerReacted)
      },
      "attachments" to row.media.mapNotNull { media ->
        (media as? MediaAttachmentOutcomeFfi.Accepted)?.takeIf { it.reference.version == EncryptedMediaVersionFfi.V2 }?.let {
          val tag = row.tags.singleOrNull { tag -> tag.values.size == 6 && tag.values[0] == "boop-media" &&
            tag.values[1] == it.attachmentIndex.toString() }?.values
          mapOf("index" to it.attachmentIndex.toInt(), "name" to it.reference.fileName, "type" to it.reference.mediaType,
            "thumbhash" to it.reference.thumbhash, "dimensions" to it.reference.dim,
            "plaintextHash" to it.reference.plaintextSha256,
            "size" to tag?.get(2)?.toULongOrNull()?.takeIf { it in 1uL..9007199254740991uL }?.toDouble(),
            "duration" to tag?.get(3)?.let(::mediaDuration),
            "waveform" to tag?.get(4)?.take(192)?.split(",")?.mapNotNull { value -> value.toIntOrNull()?.takeIf { level -> level in 0..31 } }?.take(64),
            "round" to (tag?.get(5) == "round" && it.reference.mediaType.startsWith("video/")),
            "voice" to (tag?.get(5) == "voice" && it.reference.mediaType.startsWith("audio/")))
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
      "confirmed" to (row.sourceMessageIdHex != null || row.recipientConfirmed),
      "invalidated" to (row.invalidationStatus != null),
      "systemType" to system?.systemType,
    )
  },
)
