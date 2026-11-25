package app.boop.marmot

import dev.ipf.marmotkit.*
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

internal class SharedMediaHistory {
  data class Query(
    val group: String?,
    val sender: String?,
    val after: ULong?,
    val before: ULong?,
    val caption: String?,
  ) {
    val groupHistory get() = group != null && sender == null && after == null && before == null
  }

  private sealed interface Baseline : AutoCloseable {
    val query: Query
    data class Group(override val query: Query, val version: AttachmentHistoryVersion) : Baseline {
      override fun close() = version.destroy()
    }
    data class Account(override val query: Query, val version: AccountAttachmentVersion) : Baseline {
      override fun close() = version.destroy()
    }
  }
  private sealed interface Cursor : AutoCloseable {
    val baseline: String
    data class Group(override val baseline: String, val value: AttachmentHistoryCursor) : Cursor {
      override fun close() = value.destroy()
    }
    data class Account(override val baseline: String, val value: AccountAttachmentCursor) : Cursor {
      override fun close() = value.destroy()
    }
  }

  private val versions = ConcurrentHashMap<String, Baseline>()
  private val cursors = ConcurrentHashMap<String, Cursor>()
  private val restart: Document = mapOf("rows" to emptyList<Document>(), "next" to null, "baseline" to null, "restart" to true)

  suspend fun page(
    kit: Marmot,
    account: String,
    query: Query,
    token: String?,
    baseline: String?,
    limit: UInt = 36u,
  ): Document {
    if (baseline != null && versions[baseline]?.query != query) return restart
    val baseId = baseline ?: UUID.randomUUID().toString()
    val saved = token?.let {
      val handle = cursors[it] ?: return restart
      if (handle.baseline != baseline || !cursors.remove(it, handle)) return restart
      handle
    }
    return saved.use { cursor ->
      val group = query.group
      if (group != null && query.groupHistory) {
        if (cursor != null && cursor !is Cursor.Group) return restart
        val result = kit.attachmentHistoryPage(account, group, limit, (cursor as? Cursor.Group)?.value)
        if (result == AttachmentPageReadFfi.RestartRequired) return restart
        val page = (result as? AttachmentPageReadFfi.Page)?.page ?: throw problem("AttachmentHistoryUnavailable")
        page.use { history ->
          val rows = project(kit, account, history.entries.map { group to it }, query.caption)
          currentCoroutineContext().ensureActive()
          if (baseline == null) {
            val copy = FfiConverterTypeAttachmentHistoryVersion.lift(FfiConverterTypeAttachmentHistoryVersion.lower(history.version))
            versions[baseId] = Baseline.Group(query, copy)
          }
          val next = history.nextCursor?.let { value ->
            UUID.randomUUID().toString().also { id ->
              cursors[id] = Cursor.Group(baseId, value)
              history.nextCursor = null
            }
          }
          document(rows, next, baseId)
        }
      } else {
        if (cursor != null && cursor !is Cursor.Account) return restart
        val filters = AccountAttachmentQueryFfi(listOfNotNull(group), listOfNotNull(query.sender), query.after, query.before)
        val result = kit.accountAttachmentHistoryPage(account, filters, limit, (cursor as? Cursor.Account)?.value)
        if (result == AccountAttachmentPageReadFfi.RestartRequired) return restart
        val page = (result as? AccountAttachmentPageReadFfi.Page)?.page ?: throw problem("AttachmentHistoryUnavailable")
        page.use { history ->
          val rows = project(kit, account, history.entries.map { it.groupIdHex to it.entry }, query.caption)
          currentCoroutineContext().ensureActive()
          if (baseline == null) {
            val copy = FfiConverterTypeAccountAttachmentVersion.lift(FfiConverterTypeAccountAttachmentVersion.lower(history.version))
            versions[baseId] = Baseline.Account(query, copy)
          }
          val next = history.nextCursor?.let { value ->
            UUID.randomUUID().toString().also { id ->
              cursors[id] = Cursor.Account(baseId, value)
              history.nextCursor = null
            }
          }
          document(rows, next, baseId)
        }
      }
    }
  }

  suspend fun changes(kit: Marmot, account: String, id: String): String {
    val change = when (val version = versions[id] ?: return "restart") {
      is Baseline.Group -> kit.attachmentHistoryVersion(account, checkNotNull(version.query.group)).use {
        it.changeSince(version.version)
      }
      is Baseline.Account -> kit.accountAttachmentHistoryVersion(account).use {
        it.changeSince(version.version)
      }
    }
    return when (change) {
      AttachmentHistoryChangeFfi.UNCHANGED -> "unchanged"
      AttachmentHistoryChangeFfi.ADDITIONS -> "additions"
      AttachmentHistoryChangeFfi.RESTART_REQUIRED -> "restart"
    }
  }

  fun release(id: String) {
    cursors.remove(id)?.close()
    versions.remove(id)?.let { version ->
      version.close()
      cursors.entries.filter { it.value.baseline == id }.forEach {
        if (cursors.remove(it.key, it.value)) it.value.close()
      }
    }
  }

  fun close() {
    cursors.keys.toList().forEach(::release)
    versions.keys.toList().forEach(::release)
  }

  private fun document(rows: List<Document>, next: String?, baseline: String): Document =
    mapOf("rows" to rows, "next" to next, "baseline" to baseline, "restart" to false)

  private suspend fun project(
    kit: Marmot,
    account: String,
    entries: List<Pair<String, AttachmentEntryFfi>>,
    caption: String?,
  ): List<Document> {
    val candidates = entries.filter { (_, entry) ->
      entry.role == AttachmentRoleFfi.SHARED &&
        entry.category != AttachmentCategoryFfi.REJECTED &&
        (entry.attachment as? MediaAttachmentOutcomeFfi.Accepted)?.reference?.version == EncryptedMediaVersionFfi.V2
    }
    val chats = candidates.map { it.first }.distinct().mapNotNull { group ->
      val row = kit.chatListRow(account, group) ?: return@mapNotNull null
      if (row.selfMembership != SelfMembershipFfi.MEMBER || row.pendingConfirmation ||
        row.leaveRequestPending || row.disbanding ||
        row.lifecycleState == GroupLifecycleStateFfi.UNRECOVERABLE) return@mapNotNull null
      group to row
    }.toMap()
    val directGroups = chats.filterValues { it.conversationKind == ChatConversationKindFfi.DIRECT }.keys.toList()
    val peers = if (directGroups.isEmpty()) emptyMap() else kit.groupMemberIdsPage(account, directGroups).associate {
      it.groupIdHex to it.memberIdsHex.singleOrNull { member -> member != account }
    }
    val rows = mutableMapOf<Pair<String, String>, TimelineMessageRecordFfi>()
    val assets = mutableSetOf<Pair<String, AttachmentLocalTargetFfi>>()
    for ((group, groupEntries) in candidates.groupBy({ it.first }, { it.second })) {
      if (group !in chats || (group in directGroups && peers[group] == null)) continue
      for ((at, batch) in groupEntries.groupBy { it.timelineAt }) {
        rows += kit.timelineRowsAt(account, group, at, batch.map { it.messageIdHex }.toSet(), 5u, caption)
          .mapKeys { group to it.key }
      }
      val targets = groupEntries.mapNotNull { entry ->
        val item = entry.attachment as? MediaAttachmentOutcomeFfi.Accepted ?: return@mapNotNull null
        AttachmentLocalTargetFfi(entry.messageIdHex, entry.sourceMessageIdHex, item.attachmentIndex)
      }
      if (targets.isNotEmpty()) {
        val local = kit.attachmentLocalAssets(account, group, targets)
        targets.zip(local).forEach { (target, asset) -> if (asset.reference != null) assets.add(group to target) }
      }
    }
    val now = (System.currentTimeMillis() / 1_000L).toULong()
    return candidates.mapNotNull { (group, entry) ->
      val row = rows[group to entry.messageIdHex]?.takeIf {
        !it.deleted && it.invalidationStatus == null && it.sourceMessageIdHex == entry.sourceMessageIdHex &&
          it.sender == entry.sender && (it.retentionExpiresAt?.let { deadline -> deadline > now } ?: true)
      } ?: return@mapNotNull null
      val item = entry.attachment as? MediaAttachmentOutcomeFfi.Accepted ?: return@mapNotNull null
      val target = AttachmentLocalTargetFfi(entry.messageIdHex, entry.sourceMessageIdHex, item.attachmentIndex)
      mapOf(
        "group" to group, "groupLabel" to chats[group]?.title?.takeIf { it.isNotBlank() }, "peer" to peers[group],
        "message" to entry.messageIdHex, "source" to entry.sourceMessageIdHex, "sender" to row.sender,
        "at" to row.timelineAt.toDouble(), "expiresAt" to row.retentionExpiresAt?.toDouble(),
        "caption" to row.plaintext, "category" to entry.category.name.lowercase(),
        "item" to attachmentDocument(row, item),
        "local" to ((group to target) in assets),
      )
    }
  }
}

internal suspend fun Marmot.timelineRowsAt(
  account: String,
  group: String,
  at: ULong,
  targetIds: Set<String>,
  attachmentType: UInt,
  search: String? = null,
): Map<String, TimelineMessageRecordFfi> {
  val found = mutableMapOf<String, TimelineMessageRecordFfi>()
  var before: ULong? = null
  var beforeId: String? = null
  var pages = 0
  val exclusiveEnd = at.takeIf { it < Long.MAX_VALUE.toULong() }?.plus(1uL)
  while (found.size < targetIds.size && pages < 4) {
    currentCoroutineContext().ensureActive()
    val query = TimelineMessageQueryFfi(group, search, null, at, exclusiveEnd, attachmentType = attachmentType,
      cursorGroupId = group.takeIf { before != null }, before = before, beforeMessageId = beforeId,
      after = null, afterMessageId = null, limit = 200u)
    val page = timelineMessages(account, query)
    page.messages.filter { it.messageIdHex in targetIds }.forEach { found[it.messageIdHex] = it }
    pages++
    if (!page.hasMoreBefore || page.messages.isEmpty()) break
    val oldest = page.messages.first()
    before = oldest.timelineAt
    beforeId = oldest.messageIdHex
  }
  return found
}
