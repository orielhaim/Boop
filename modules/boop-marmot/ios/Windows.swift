import Foundation

typealias Document = [String: Any]

func windowDelta(_ previous: Document, _ current: Document) -> Document? {
  let field: String
  switch current["kind"] as? String {
  case "chatList": field = "rows"
  case "conversation": field = "messages"
  default: return nil
  }
  guard let generation = current["generation"] as? String,
    generation == previous["generation"] as? String,
    let old = previous[field] as? [Document], let next = current[field] as? [Document],
    let base = previous["sequence"] as? String
  else { return nil }
  let prior = Dictionary(uniqueKeysWithValues: old.compactMap { row in
    (row["id"] as? String).map { ($0, NSDictionary(dictionary: row)) }
  })
  var metadata = current
  metadata.removeValue(forKey: field)
  return [
    "base": base, "field": field, "metadata": metadata,
    "order": next.compactMap { $0["id"] as? String },
    "changed": next.filter { row in
      guard let id = row["id"] as? String, let old = prior[id] else { return true }
      return !old.isEqual(to: row)
    },
  ]
}

func bridgeValue<T>(_ value: T?) -> Any {
  if let value { return value }
  return NSNull()
}

func wireName<T>(_ value: T) -> String {
  String(describing: value)
    .replacingOccurrences(of: "([a-z0-9])([A-Z])", with: "$1_$2", options: .regularExpression)
    .lowercased()
}

enum NativeWindow: Sendable {
  case chatList(ChatListWindowSubscription)
  case conversation(ConversationWindowSubscription)
  case attention(AccountAttentionSubscription, String)
  case groupState(GroupStateWindow)

  func initial() -> Document? {
    switch self {
    case .chatList(let handle): return handle.snapshot().map(project)
    case .conversation(let handle): return handle.snapshot().map(project)
    case .attention(let handle, let account): return handle.snapshot().map { project($0, account) }
    case .groupState(let window): return window.initial()
    }
  }

  func next() async throws -> Document? {
    switch self {
    case .chatList(let handle): return try await handle.next().map(project)
    case .conversation(let handle): return try await handle.next().map(project)
    case .attention(let handle, let account): return try await handle.next().map { project($0, account) }
    case .groupState(let window): return try await window.next()
    }
  }

  func page(revision: ConversationWindowRevisionFfi, direction: String) async throws -> Document {
    switch self {
    case .chatList(let handle):
      guard direction == "forward" || direction == "backward" else { throw problem("InvalidDirection") }
      return project(try await handle.page(sequence: revision.sequence, direction: direction == "forward" ? .forward : .backward, count: 40))
    case .conversation(let handle):
      guard direction == "older" || direction == "newer" else { throw problem("InvalidDirection") }
      return project(try await handle.page(revision: revision, direction: direction == "older" ? .older : .newer, count: 40, timeoutMs: 0))
    case .attention, .groupState: throw problem("InvalidWindow")
    }
  }

  func anchor(revision: ConversationWindowRevisionFfi, target: String) async throws -> Document {
    switch self {
    case .chatList(let handle):
      return project(try await handle.setVisibleAnchor(sequence: revision.sequence, groupIdHex: target))
    case .conversation(let handle):
      return project(try await handle.setVisibleAnchor(revision: revision, messageIdHex: target, timeoutMs: 0))
    case .attention, .groupState: throw problem("InvalidWindow")
    }
  }

  func jump(revision: ConversationWindowRevisionFfi, target: String) async throws -> Document {
    guard case .conversation(let handle) = self else { throw problem("InvalidWindow") }
    return project(try await handle.jumpToMessage(revision: revision, messageIdHex: target, timeoutMs: 0))
  }

  func cancel() async {
    if case .conversation(let handle) = self { await handle.cancel() }
  }
}

final class GroupStateWindow: @unchecked Sendable {
  private let generation: String
  private let handle: GroupStateSubscription
  private let guardSequence = NSLock()
  private var sequence: UInt64 = 0

  init(generation: String, handle: GroupStateSubscription) {
    self.generation = generation
    self.handle = handle
  }

  func initial() -> Document? {
    handle.snapshot().map { _ in current(advance: false) }
  }

  func next() async throws -> Document? {
    try await handle.next().map { _ in current(advance: true) }
  }

  private func current(advance: Bool) -> Document {
    guardSequence.withLock {
      if advance { sequence += 1 }
      return ["kind": "groupState", "generation": generation, "sequence": String(sequence),
        "hasMoreBefore": false, "hasMoreAfter": false]
    }
  }
}

private func project(_ snapshot: AccountAttentionSnapshotFfi, _ account: String) -> Document {
  let entry = snapshot.accounts.first { $0.accountIdHex == account }
  let count: Double?
  if case .ready(let total)? = entry?.state {
    count = Double(total.unreadCount) + Double(total.attentionOnlyConversations)
  } else { count = nil }
  return [
    "kind": "attention", "generation": snapshot.subscriptionGeneration, "sequence": String(snapshot.sequence),
    "hasMoreBefore": false, "hasMoreAfter": false, "count": bridgeValue(count),
  ]
}

private func literal(_ presentation: ConversationPresentationFfi) -> String? {
  if case .literal(let title) = presentation.title { return title }
  return nil
}

private func project(_ snapshot: ChatListWindowSnapshotFfi) -> Document {
  [
    "kind": "chatList",
    "generation": snapshot.subscriptionGeneration,
    "sequence": String(snapshot.sequence),
    "hasMoreBefore": snapshot.hasMoreBefore,
    "hasMoreAfter": snapshot.hasMoreAfter,
    "rows": snapshot.rows.map { row -> Document in
      let chat = row.row
      let draft: String?
      if case .draft(let preview) = row.preview { draft = preview.text }
      else { draft = nil }
      return [
        "id": chat.groupIdHex,
        "title": bridgeValue(literal(row.presentation)),
        "peer": bridgeValue(row.presentation.peerId),
        "image": bridgeValue(chat.avatar?.imageHashHex),
        "kind": wireName(chat.conversationKind),
        "lifecycle": wireName(chat.lifecycleState),
        "membership": wireName(chat.selfMembership),
        "invited": chat.pendingConfirmation,
        "pinned": chat.pinned,
        "muted": chat.muted,
        "archived": chat.archived,
        "unread": Double(chat.unreadCount),
        "manualUnread": chat.manuallyMarkedUnread,
        "updatedAt": Double(chat.activitySortAt),
        "preview": bridgeValue(chat.lastMessage.flatMap { $0.deleted ? nil : $0.plaintext }),
        "previewKind": bridgeValue(chat.lastMessage.map { Double($0.kind) }),
        "previewId": bridgeValue(chat.lastMessage?.messageIdHex),
        "previewSender": bridgeValue(chat.lastMessage?.sender),
        "draft": bridgeValue(draft),
      ]
    },
  ]
}

private func project(_ snapshot: ConversationWindowSnapshotFfi) -> Document {
  let selected = snapshot.header.selected
  let peer = selected.titleSource == .peerProfile || selected.titleSource == .peerFallback ? selected.peerId : nil
  let image: String?
  if case .encryptedGroupImage(let avatar, _) = snapshot.header.selected.avatar { image = avatar.imageHashHex }
  else { image = nil }
  return [
    "kind": "conversation",
    "generation": snapshot.revision.generation,
    "sequence": String(snapshot.revision.sequence),
    "hasMoreBefore": snapshot.hasMoreBefore,
    "hasMoreAfter": snapshot.hasMoreAfter,
    "title": bridgeValue(literal(snapshot.header.selected)),
    "peer": bridgeValue(peer),
    "image": bridgeValue(image),
    "lifecycle": wireName(snapshot.header.lifecycle),
    "memberCount": bridgeValue(snapshot.header.memberCount.map(Double.init)),
    "invited": snapshot.pendingConfirmation,
    "canSend": snapshot.header.capabilities.canSend,
    "firstUnread": bridgeValue(snapshot.readState.firstUnreadMessageIdHex),
    "draft": bridgeValue(snapshot.draft.draft.map { ["text": $0.content, "replyTo": bridgeValue($0.replyToMessageIdHex)] }),
    "identities": snapshot.identities.map { ["id": $0.accountIdHex, "name": $0.displayName] },
    "messages": snapshot.messages.compactMap { message -> Document? in
      let row = message.timeline
      let system = row.groupSystem.flatMap { $0.provenance == .authenticatedGroupState ? $0 : nil }
      guard system != nil || row.poll != nil || [9, 1111, 24881, 24883].contains(row.kind) else { return nil }
      return [
        "id": row.messageIdHex,
        "token": bridgeValue(row.clientToken),
        "sender": row.sender,
        "text": row.plaintext,
        "sentAt": Double(row.timelineAt),
        "expiresAt": bridgeValue(row.retentionExpiresAt.map(Double.init)),
        "eventKind": Double(row.kind),
        "replyTo": bridgeValue(row.replyToMessageIdHex),
        "replyPreview": bridgeValue(row.replyPreview.map { ["id": $0.messageIdHex, "sender": $0.sender, "text": $0.plaintext] }),
        "reactions": message.references.reactions.items.map { item -> Document in
          ["emoji": item.emoji, "count": Double(item.count), "users": item.reactors, "own": item.viewerReacted]
        },
        "attachments": row.media.compactMap { outcome -> Document? in
          guard case .accepted(let index, let reference) = outcome, reference.version == .v2 else { return nil }
          let tag = row.tags.first { $0.values.count == 6 && $0.values[0] == "boop-media" && UInt32($0.values[1]) == index }?.values
          let duration = tag.flatMap { Int($0[3]) }.flatMap { (1...3600).contains($0) ? $0 : nil }
          let waveform = tag.map { value in Array(value[4].prefix(192).split(separator: ",").compactMap { token in
            Int(token).flatMap { (0...31).contains($0) ? $0 : nil }
          }.prefix(64)) }
          return ["index": Int(index), "name": reference.fileName, "type": reference.mediaType,
            "thumbhash": bridgeValue(reference.thumbhash), "dimensions": bridgeValue(reference.dim),
            "size": bridgeValue(tag.flatMap { UInt64($0[2]).map(Double.init) }), "duration": bridgeValue(duration),
            "waveform": bridgeValue(waveform), "round": tag?[5] == "round"]
        },
        "sourceId": bridgeValue(row.sourceMessageIdHex),
        "poll": bridgeValue(row.poll.map { poll -> Document in
          ["question": poll.question, "multiple": poll.pollType == .multipleChoice, "open": poll.open,
            "selected": poll.localSelection, "expiresAt": bridgeValue(poll.endsAt.map(Double.init)),
            "options": poll.options.map { option -> Document in ["id": option.id, "name": option.label, "votes": Double(option.votes)] }]
        }),
        "deleted": row.deleted,
        "edited": row.edit != nil,
        "confirmed": row.sourceMessageIdHex != nil || row.recipientConfirmed,
        "invalidated": row.invalidationStatus != nil,
        "systemType": bridgeValue(system?.systemType),
      ]
    },
  ]
}
