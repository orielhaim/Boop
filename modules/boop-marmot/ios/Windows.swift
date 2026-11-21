import Foundation

typealias Document = [String: Any]

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

  func initial() -> Document? {
    switch self {
    case .chatList(let handle): return handle.snapshot().map(project)
    case .conversation(let handle): return handle.snapshot().map(project)
    case .attention(let handle, let account): return handle.snapshot().map { project($0, account) }
    }
  }

  func next() async throws -> Document? {
    switch self {
    case .chatList(let handle): return try await handle.next().map(project)
    case .conversation(let handle): return try await handle.next().map(project)
    case .attention(let handle, let account): return try await handle.next().map { project($0, account) }
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
    case .attention: throw problem("InvalidWindow")
    }
  }

  func anchor(revision: ConversationWindowRevisionFfi, target: String) async throws -> Document {
    switch self {
    case .chatList(let handle):
      return project(try await handle.setVisibleAnchor(sequence: revision.sequence, groupIdHex: target))
    case .conversation(let handle):
      return project(try await handle.setVisibleAnchor(revision: revision, messageIdHex: target, timeoutMs: 0))
    case .attention: throw problem("InvalidWindow")
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
      return [
        "id": chat.groupIdHex,
        "title": bridgeValue(literal(row.presentation)),
        "peer": bridgeValue(row.presentation.peerId),
        "kind": wireName(chat.conversationKind),
        "lifecycle": wireName(chat.lifecycleState),
        "membership": wireName(chat.selfMembership),
        "invited": chat.pendingConfirmation,
        "pinned": chat.pinned,
        "muted": chat.muted,
        "archived": chat.archived,
        "unread": Double(chat.unreadCount),
        "updatedAt": Double(chat.activitySortAt),
        "preview": bridgeValue(chat.lastMessage?.plaintext),
      ]
    },
  ]
}

private func project(_ snapshot: ConversationWindowSnapshotFfi) -> Document {
  [
    "kind": "conversation",
    "generation": snapshot.revision.generation,
    "sequence": String(snapshot.revision.sequence),
    "hasMoreBefore": snapshot.hasMoreBefore,
    "hasMoreAfter": snapshot.hasMoreAfter,
    "title": bridgeValue(literal(snapshot.header.selected)),
    "peer": bridgeValue(snapshot.header.selected.peerId),
    "lifecycle": wireName(snapshot.header.lifecycle),
    "memberCount": bridgeValue(snapshot.header.memberCount.map(Double.init)),
    "invited": snapshot.pendingConfirmation,
    "canSend": snapshot.header.capabilities.canSend,
    "firstUnread": bridgeValue(snapshot.readState.firstUnreadMessageIdHex),
    "draft": bridgeValue(snapshot.draft.draft.map { ["text": $0.content, "replyTo": bridgeValue($0.replyToMessageIdHex)] }),
    "identities": snapshot.identities.map { ["id": $0.accountIdHex, "name": $0.displayName] },
    "messages": snapshot.messages.map { message -> Document in
      let row = message.timeline
      return [
        "id": row.messageIdHex,
        "token": bridgeValue(row.clientToken),
        "sender": row.sender,
        "text": row.plaintext,
        "sentAt": Double(row.timelineAt),
        "eventKind": Double(row.kind),
        "replyTo": bridgeValue(row.replyToMessageIdHex),
        "replyPreview": bridgeValue(row.replyPreview.map { ["id": $0.messageIdHex, "sender": $0.sender, "text": $0.plaintext] }),
        "reactions": message.references.reactions.items.map { item -> Document in
          ["emoji": item.emoji, "count": Double(item.count), "users": item.reactors, "own": item.viewerReacted]
        },
        "attachments": row.media.compactMap { outcome -> Document? in
          guard case .accepted(let index, let reference) = outcome else { return nil }
          return ["index": Int(index), "name": reference.fileName, "type": reference.mediaType,
            "thumbhash": bridgeValue(reference.thumbhash), "dimensions": bridgeValue(reference.dim)]
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
        "systemType": bridgeValue(row.groupSystem?.systemType),
      ]
    },
  ]
}
