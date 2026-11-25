import Foundation

typealias Document = [String: Any]

func mediaPresentation(_ kind: String?, _ mime: String) -> String {
  if kind == "round", mime.lowercased().hasPrefix("video/") { return "round" }
  if kind == "voice", mime.lowercased().hasPrefix("audio/") { return "voice" }
  return "file"
}

func mediaDuration(_ value: String?) -> Double? {
  guard let value, let duration = Double(value), duration.isFinite, duration > 0, duration <= 604_800 else { return nil }
  return duration
}

func mediaWaveform(_ value: String?) -> [Double] {
  (value ?? "").prefix(192).split(separator: ",").prefix(64).compactMap {
    guard let level = Int($0), (0...31).contains(level) else { return nil }
    return Double(level) / 31
  }
}

func mediaMetadata(_ index: Int, _ size: UInt64, _ duration: Double?, _ waveform: [Double], _ kind: String) -> [String] {
  ["boop-media", String(index), String(size), duration.map { String($0) } ?? "",
    waveform.prefix(64).map { String(Int((min(1, max(0, $0)) * 31).rounded(.toNearestOrEven))) }.joined(separator: ","), kind]
}

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
  case groupCall(GroupCallWindow)

  func initial() -> Document? {
    switch self {
    case .chatList(let handle): return handle.snapshot().map(project)
    case .conversation(let handle): return handle.snapshot().map(project)
    case .attention(let handle, let account): return handle.snapshot().map { project($0, account) }
    case .groupState(let window): return window.initial()
    case .groupCall(let window): return window.initial()
    }
  }

  func next() async throws -> Document? {
    switch self {
    case .chatList(let handle): return try await handle.next().map(project)
    case .conversation(let handle): return try await handle.next().map(project)
    case .attention(let handle, let account): return try await handle.next().map { project($0, account) }
    case .groupState(let window): return try await window.next()
    case .groupCall(let window): return try await window.next()
    }
  }

  func page(revision: ConversationWindowRevisionFfi, direction: String) async throws -> Document {
    switch self {
    case .chatList(let handle):
      guard direction == "forward" || direction == "backward" else { throw problem("InvalidDirection") }
      return project(try await handle.page(sequence: revision.sequence, direction: direction == "forward" ? .forward : .backward, count: 40))
    case .conversation(let handle):
      if direction == "latest" {
        return project(try await handle.returnToLatest(revision: revision, timeoutMs: 0))
      }
      guard direction == "older" || direction == "newer" else { throw problem("InvalidDirection") }
      return project(try await handle.page(revision: revision, direction: direction == "older" ? .older : .newer, count: 40, timeoutMs: 0))
    case .attention, .groupState, .groupCall: throw problem("InvalidWindow")
    }
  }

  func anchor(revision: ConversationWindowRevisionFfi, target: String) async throws -> Document {
    switch self {
    case .chatList(let handle):
      return project(try await handle.setVisibleAnchor(sequence: revision.sequence, groupIdHex: target))
    case .conversation(let handle):
      return project(try await handle.setVisibleAnchor(revision: revision, messageIdHex: target, timeoutMs: 0))
    case .attention, .groupState, .groupCall: throw problem("InvalidWindow")
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

final class GroupCallWindow: @unchecked Sendable {
  private let generation: String
  private let handle: MessagesSubscription
  private let read: () throws -> [AppMessageRecordFfi]
  // Only the window observer reads next(), and initial() runs before it starts.
  private var sequence: UInt64 = 0

  init(generation: String, handle: MessagesSubscription, read: @escaping () throws -> [AppMessageRecordFfi]) {
    self.generation = generation
    self.handle = handle
    self.read = read
  }

  func initial() -> Document { project(handle.snapshot()) }

  func next() async throws -> Document? {
    guard try await handle.nextCancellable() != nil else { return nil }
    sequence += 1
    return project(try read())
  }

  private func project(_ rows: [AppMessageRecordFfi]) -> Document {
    ["kind": "groupCall", "generation": generation, "sequence": String(sequence),
      "hasMoreBefore": false, "hasMoreAfter": false,
      "announcements": rows.filter { $0.plaintext.utf8.count <= 750 }.map { ["text": $0.plaintext, "sender": $0.sender,
        "sentAt": Double($0.recordedAt), "invalidated": $0.invalidated] as Document }]
  }
}

final class GroupStateWindow: @unchecked Sendable {
  private let generation: String
  private let handle: GroupStateSubscription
  private let read: @Sendable () async throws -> Document
  private var sequence: UInt64 = 0
  private var details: Document?
  private let kind: String

  init(generation: String, handle: GroupStateSubscription, details: Document, kind: String,
       read: @escaping @Sendable () async throws -> Document) {
    self.generation = generation
    self.handle = handle
    self.details = details
    self.kind = kind
    self.read = read
  }

  func initial() -> Document? {
    defer { details = nil; _ = handle.snapshot() }
    return details.map(project)
  }

  func next() async throws -> Document? {
    guard try await handle.nextCancellable() != nil else { return nil }
    let details = try await read()
    sequence += 1
    return project(details)
  }

  private func project(_ details: Document) -> Document {
    ["kind": kind, "generation": generation, "sequence": String(sequence),
     "hasMoreBefore": false, "hasMoreAfter": false, "details": details]
  }
}

func groupDocument(_ kit: Marmot, _ account: String, _ group: String) async throws -> Document {
  let snapshot = try await kit.groupConversationSnapshot(accountRef: account, groupIdHex: group)
  let details = snapshot.details
  let policy = snapshot.managementState
  let presented = try await kit.presentedChatListRow(accountRef: account, groupIdHex: group)
  let chat = presented?.row
  let actions = Dictionary(policy.memberActions.map { ($0.memberIdHex, $0) }, uniquingKeysWith: { first, _ in first })
  return [
    "id": group, "name": details.group.name, "description": details.group.description,
    "inviter": bridgeValue(details.group.welcomerAccountIdHex), "relays": details.group.relays,
    "avatarAsset": bridgeValue(presented?.avatarAsset.map(avatarDocument)),
    "image": bridgeValue(details.group.imageHashHex),
    "mediaV2": details.group.encryptedMedia.version == .v2,
    "mediaEndpoints": details.group.encryptedMedia.defaultBlobEndpoints.map(\.baseUrl),
    "unrecoverable": details.mlsState.unrecoverable,
    "convergenceParked": details.mlsState.convergenceParked,
    "disbanding": details.mlsState.disbanding, "epoch": String(details.mlsState.epoch),
    "membership": wireName(details.group.selfMembership),
    "pendingInvitation": details.group.pendingConfirmation,
    "kind": bridgeValue(chat.map { wireName($0.conversationKind) }),
    "pendingLeave": details.group.leaveRequestPending, "leaveBlocked": details.group.leaveBlocked,
    "createdAt": bridgeValue(chat.map { Double($0.conversationCreatedAt) }), "muted": chat?.muted ?? false,
    "archived": details.group.archived, "canEdit": policy.isSelfAdmin,
    "lifecycle": wireName(policy.lifecycleState),
    "canStepDown": policy.isSelfAdmin && !policy.isLastAdmin,
    "canInvite": policy.canInvite, "canLeave": policy.canLeave,
    "canCancelLeave": policy.canCancelLeave, "canDisband": policy.canDisband,
    "canEnableDisbanding": policy.canEnableDisbanding,
    "members": details.members.map { member -> Document in
      let perms = actions[member.memberIdHex]
      return memberDocument(member, kit).merging([
        "canPromote": perms?.canPromote ?? false, "canRemove": perms?.canRemove ?? false,
        "canDemote": perms?.canDemote ?? false,
      ], uniquingKeysWith: { _, action in action })
    },
  ]
}

private func memberDocument(_ member: GroupMemberDetailsFfi, _ kit: Marmot) -> Document {
  let name = member.displayName.flatMap { $0 == member.memberIdHex ? nil : $0 }
    ?? kit.defaultProfilePseudonym(accountIdHex: member.memberIdHex)
  return ["id": member.memberIdHex, "npub": member.npub, "name": name,
          "self": member.isSelf, "admin": member.isAdmin, "devices": Int(member.deviceCount)]
}

func rosterDocument(_ kit: Marmot, _ account: String, _ group: String) async throws -> Document {
  let roster = try await kit.groupRoster(accountRef: account, groupIdHex: group)
  return ["revision": String(roster.rosterRevision), "membership": wireName(roster.selfMembership),
          "lifecycle": wireName(roster.lifecycleState), "members": roster.members.map { memberDocument($0, kit) }]
}

func groupDiagnostics(_ kit: Marmot, _ account: String, _ group: String) async throws -> Document {
  let pending = try await kit.groupPendingCommit(accountRef: account, groupIdHex: group)
  let recovery = try await kit.groupRecoveryStatus(accountRef: account, groupIdHex: group)
  return ["commit": bridgeValue(pending.map { wireName($0.state) }),
          "automaticRecoveryFailed": recovery.automaticRecoveryFailed, "historyIncomplete": recovery.historyMayBeIncomplete,
          "rejoinOffers": recovery.rejoinInvitations.map {
            ["welcome": $0.welcomeIdHex, "inviter": $0.welcomerAccountIdHex, "token": $0.localStateToken]
          }]
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

func avatarDocument(_ asset: AvatarAssetFfi) -> Document {
  ["target": asset.target, "reference": bridgeValue(asset.reference),
   "revision": String(asset.contentRevision), "availability": wireName(asset.availability)]
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
      let selection: String
      let draft: String?
      switch row.preview {
      case .draft(let preview): selection = "draft"; draft = preview.text
      case .message: selection = "message"; draft = nil
      case .invitation: selection = "invitation"; draft = nil
      case .empty: selection = "empty"; draft = nil
      }
      return [
        "id": chat.groupIdHex,
        "title": bridgeValue(literal(row.presentation)),
        "peer": bridgeValue(row.presentation.peerId),
        "image": bridgeValue(chat.avatar?.imageHashHex),
        "avatarAsset": bridgeValue(row.avatarAsset.map(avatarDocument)),
        "kind": wireName(chat.conversationKind),
        "lifecycle": wireName(chat.lifecycleState),
        "membership": wireName(chat.selfMembership),
        "invited": chat.pendingConfirmation,
        "pinned": chat.pinned,
        "muted": chat.muted,
        "archived": chat.archived,
        "unread": Double(chat.unreadCount),
        "mentioned": chat.unreadMentionCount > 0,
        "manualUnread": chat.manuallyMarkedUnread,
        "updatedAt": Double(chat.activitySortAt),
        "previewSelection": selection,
        "preview": bridgeValue(chat.lastMessage.map { message -> Document in
          ["id": message.messageIdHex, "sender": message.sender, "kind": Double(message.kind),
           "text": bridgeValue(message.deleted ? nil : message.plaintext),
           "expiresAt": bridgeValue(message.retentionExpiresAt.map(Double.init)),
           "content": bridgeValue(!message.deleted && (message.kind == 9 || message.kind == 1111)
             ? messageContent(message.contentTokens) : nil)]
        }),
        "draft": bridgeValue(draft),
      ]
    },
  ]
}

private func historySource(_ source: HistoryImportProvenanceFfi?) -> String? {
  switch source {
  case .some(.device): return "device"
  case .some(.backup): return "backup"
  case .none: return nil
  }
}

private func applicationReply(kind: UInt64, tags: [[String]]) -> String? {
  guard kind == 24881 else { return nil }
  let replies = tags.filter { tag in
    tag.count == 4 && tag[0] == "e" && tag[2].isEmpty && tag[3] == "reply"
      && tag[1].utf8.count == 64
      && tag[1].utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
  }
  return replies.count == 1 ? replies.first?[1] : nil
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
    "avatarAsset": bridgeValue(snapshot.header.avatarAsset.map(avatarDocument)),
    "lifecycle": wireName(snapshot.header.lifecycle),
    "memberCount": bridgeValue(snapshot.header.memberCount.map(Double.init)),
    "invited": snapshot.pendingConfirmation,
    "authorityReady": snapshot.header.epoch != nil,
    "canSend": snapshot.header.capabilities.canSend,
    "firstUnread": bridgeValue(snapshot.readState.firstUnreadMessageIdHex),
    "atTail": snapshot.anchor.kind == .latest || snapshot.anchor.kind == .empty,
    "draft": bridgeValue(snapshot.draft.draft.map { draft in
      ["text": draft.content, "replyTo": bridgeValue(draft.replyToMessageIdHex),
        "attachments": draft.mediaAttachments.map { item -> Document in
          ["id": item.id, "size": Double(item.plaintextSize),
            "name": item.fileName, "type": item.mediaType,
            "dimensions": bridgeValue(item.dim), "thumbhash": bridgeValue(item.thumbhash),
            "duration": bridgeValue(item.durationSeconds),
            "waveform": item.waveformSamples.prefix(64).map { Int((min(1, max(0, $0)) * 31).rounded(.toNearestOrEven)) }]
        }]
    }),
    "identities": snapshot.identities.map {
      ["id": $0.accountIdHex, "name": $0.displayName, "avatarAsset": bridgeValue($0.avatarAsset.map(avatarDocument))]
    },
    "messages": snapshot.messages.compactMap { message -> Document? in
      let row = message.timeline
      let system = row.groupSystem.flatMap { $0.provenance == .authenticatedGroupState ? $0 : nil }
      guard system != nil || row.poll != nil || [9, 1111, 24881, 24883].contains(row.kind) else { return nil }
      return [
        "id": row.messageIdHex,
        "token": bridgeValue(row.clientToken),
        "sender": row.sender,
        "text": row.plaintext,
        "content": bridgeValue(row.kind == 9 || row.kind == 1111 ? messageContent(row.contentTokens) : nil),
        "sentAt": Double(row.timelineAt),
        "expiresAt": bridgeValue(row.retentionExpiresAt.map(Double.init)),
        "eventKind": Double(row.kind),
        "replyTo": bridgeValue(row.replyToMessageIdHex ?? applicationReply(kind: row.kind, tags: row.tags.map(\.values))),
        "thread": bridgeValue(row.thread.map { ["root": $0.rootMessageIdHex, "parent": $0.parentMessageIdHex] }),
        "replyPreview": bridgeValue(row.replyPreview.map { preview -> Document in
          ["id": preview.messageIdHex, "sender": preview.sender, "eventKind": Double(preview.kind),
           "text": preview.kind == 24881 ? "" : preview.plaintext,
           "deleted": preview.deleted, "deletionSource": wireName(preview.deletionSource),
           "invalidationStatus": bridgeValue(preview.invalidationStatus),
           "content": bridgeValue(preview.kind == 24881 ? nil : messageContent(preview.contentTokens)),
           "expiresAt": bridgeValue(preview.retentionExpiresAt.map(Double.init)), "mentions": message.references.replyMentions]
        }),
        "mentions": message.references.mentions,
        "retentionSeconds": bridgeValue(row.retentionSeconds.map(String.init)),
        "reactions": message.references.reactions.items.map { item -> Document in
          ["emoji": item.emoji, "count": Double(item.count), "users": item.reactors, "own": item.viewerReacted]
        },
        "attachments": row.media.map { outcome -> Document in
          switch outcome {
          case .rejected(let index, let rejection):
            return ["outcome": "rejected", "index": Double(index),
                    "reason": wireName(rejection.kind), "detail": rejection.detail]
          case .accepted(let index, let reference):
            guard reference.version == .v2 else {
              return ["outcome": "rejected", "index": Double(index), "reason": "unsupported_format"]
            }
            let matches = row.tags.filter { $0.values.count == 6 && $0.values[0] == "boop-media" && $0.values[1] == String(index) }
            let metadata = matches.count == 1 ? matches.first.map { Array($0.values.dropFirst(2)) } : nil
            return ["outcome": "accepted", "index": Double(index), "name": reference.fileName, "type": reference.mediaType,
                    "thumbhash": bridgeValue(reference.thumbhash), "dimensions": bridgeValue(reference.dim),
                    "plaintextHash": reference.plaintextSha256,
                    "metadata": bridgeValue(metadata.flatMap { $0.allSatisfy { $0.utf16.count <= 192 } ? $0 : nil })]
          }
        },
        "sourceId": bridgeValue(row.sourceMessageIdHex),
        "poll": bridgeValue(row.poll.map { poll -> Document in
          ["question": poll.question, "multiple": poll.pollType == .multipleChoice, "open": poll.open,
            "selected": poll.localSelection, "expiresAt": bridgeValue(poll.endsAt.map(Double.init)),
            "options": poll.options.map { option -> Document in ["id": option.id, "name": option.label, "votes": Double(option.votes)] }]
        }),
        "deleted": row.deleted,
        "edited": row.edit != nil,
        "recipientConfirmed": row.recipientConfirmed,
        "invalidationStatus": bridgeValue(row.invalidationStatus),
        "deletionSource": wireName(row.deletionSource),
        "historyImport": bridgeValue(historySource(row.historyImportProvenance)),
        "system": bridgeValue(system.map { event -> Document in
          ["type": event.systemType, "actor": bridgeValue(event.actorAccountIdHex),
           "subject": bridgeValue(event.subjectAccountIdHex), "name": bridgeValue(event.name),
           "oldName": bridgeValue(event.oldName), "retentionSeconds": bridgeValue(event.newRetentionSeconds.map(String.init))]
        }),
      ]
    },
  ]
}
