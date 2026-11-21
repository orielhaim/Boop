package app.boop.marmot

import dev.ipf.marmotkit.*
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin

internal typealias Document = Map<String, Any?>

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
      "kind" to chat.conversationKind.name.lowercase(),
      "lifecycle" to chat.lifecycleState.name.lowercase(),
      "membership" to chat.selfMembership.name.lowercase(),
      "invited" to chat.pendingConfirmation,
      "pinned" to chat.pinned,
      "muted" to chat.muted,
      "archived" to chat.archived,
      "unread" to chat.unreadCount.toDouble(),
      "updatedAt" to chat.activitySortAt.toDouble(),
      "preview" to chat.lastMessage?.plaintext,
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
  "peer" to snapshot.header.selected.peerId,
  "lifecycle" to snapshot.header.lifecycle.name.lowercase(),
  "memberCount" to snapshot.header.memberCount?.toDouble(),
  "invited" to snapshot.pendingConfirmation,
  "canSend" to snapshot.header.capabilities.canSend,
  "firstUnread" to snapshot.readState.firstUnreadMessageIdHex,
  "draft" to snapshot.draft.draft?.let { mapOf("text" to it.content, "replyTo" to it.replyToMessageIdHex) },
  "identities" to snapshot.identities.map { mapOf("id" to it.accountIdHex, "name" to it.displayName) },
  "messages" to snapshot.messages.map { message ->
    val row = message.timeline
    mapOf(
      "id" to row.messageIdHex,
      "token" to row.clientToken,
      "sender" to row.sender,
      "text" to row.plaintext,
      "sentAt" to row.timelineAt.toDouble(),
      "eventKind" to row.kind.toInt(),
      "replyTo" to row.replyToMessageIdHex,
      "replyPreview" to row.replyPreview?.let { mapOf("id" to it.messageIdHex, "sender" to it.sender, "text" to it.plaintext) },
      "reactions" to message.references.reactions.items.map {
        mapOf("emoji" to it.emoji, "count" to it.count.toDouble(), "users" to it.reactors, "own" to it.viewerReacted)
      },
      "attachments" to row.media.mapNotNull { media ->
        (media as? MediaAttachmentOutcomeFfi.Accepted)?.let {
          mapOf("index" to it.attachmentIndex.toInt(), "name" to it.reference.fileName, "type" to it.reference.mediaType,
            "thumbhash" to it.reference.thumbhash, "dimensions" to it.reference.dim)
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
      "systemType" to row.groupSystem?.systemType,
    )
  },
)
