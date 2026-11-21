import ExpoModulesCore
import Foundation

public final class BoopMarmotModule: Module {
  private let runtime = Runtime()

  public func definition() -> ModuleDefinition {
    Name("BoopMarmot")
    Events("windowChanged", "windowClosed")

    AsyncFunction("openAccount") { (key: String, secret: String, nsec: String, general: [String], inbox: [String], discovery: [String]) async throws -> String in
      try await protocolCall { try await self.runtime.open(key: key, secret: secret, nsec: nsec, general: general, inbox: inbox, discovery: discovery) }
    }
    AsyncFunction("closeAccount") { () async throws in
      try await protocolCall { try await self.runtime.close() }
    }
    AsyncFunction("accountReadiness") { () async throws -> String in
      try await self.withAccount { try wireName($0.accountSetupReadiness(accountRef: $1)) }
    }
    AsyncFunction("openChatList") { (id: String, view: String) async throws -> Document in
      try await protocolCall { try await self.runtime.openChatList(id: id, view: view) }
    }
    AsyncFunction("openAttention") { (id: String) async throws -> Document in
      try await protocolCall { try await self.runtime.openAttention(id: id) }
    }
    AsyncFunction("openConversation") { (id: String, group: String, target: String?) async throws -> Document in
      try await protocolCall { try await self.runtime.openConversation(id: id, group: group, target: target) }
    }
    AsyncFunction("observeWindow") { (id: String) async throws in
      try await self.runtime.observe(id: id) { [weak self] event, value in
        self?.sendEvent(event, value)
      }
    }
    AsyncFunction("closeWindow") { (id: String) async in
      await self.runtime.closeWindow(id)
    }
    AsyncFunction("pageWindow") { (id: String, generation: String, sequence: String, direction: String) async throws -> Document in
      try await protocolCall {
        let window = try await self.runtime.window(id)
        return try await window.page(revision: revision(generation, sequence), direction: direction)
      }
    }
    AsyncFunction("anchorWindow") { (id: String, generation: String, sequence: String, target: String) async throws -> Document in
      try await protocolCall {
        let window = try await self.runtime.window(id)
        return try await window.anchor(revision: revision(generation, sequence), target: target)
      }
    }
    AsyncFunction("jumpToMessage") { (id: String, generation: String, sequence: String, target: String) async throws -> Document in
      try await protocolCall {
        let window = try await self.runtime.window(id)
        return try await window.jump(revision: revision(generation, sequence), target: target)
      }
    }

    AsyncFunction("startDirect") { (peer: String) async throws -> String in
      try await self.withAccount { try await $0.startDirectConversation(accountRef: $1, peerAccountId: peer) }
    }
    AsyncFunction("createGroup") { (name: String, description: String?, members: [String]) async throws -> Document in
      try await self.withAccount { kit, account in
        let result = try await kit.createGroupDetailed(accountRef: account, name: name, memberRefs: members, description: description)
        return ["groupId": bridgeValue(result.created?.groupIdHex), "members": result.memberOutcomes.map { member -> Document in
          ["account": member.accountIdHex, "status": wireName(member.status), "devices": Int(member.selectedDeviceCount)]
        }]
      }
    }
    AsyncFunction("respondToInvitation") { (group: String, accept: Bool) async throws in
      try await self.withAccount { kit, account in
        if accept { _ = try await kit.acceptGroupInvite(accountRef: account, groupIdHex: group) }
        else { _ = try await kit.declineGroupInvite(accountRef: account, groupIdHex: group) }
      }
    }
    AsyncFunction("groupDetails") { (group: String) async throws -> Document in
      try await self.withAccount { kit, account in
        let details = try await kit.groupDetails(accountRef: account, groupIdHex: group)
        let policy = try await kit.groupManagementState(accountRef: account, groupIdHex: group)
        let pending = try await kit.groupPendingCommit(accountRef: account, groupIdHex: group)
        let actions = Dictionary(policy.memberActions.map { ($0.memberIdHex, $0) }, uniquingKeysWith: { first, _ in first })
        return [
          "id": group, "name": details.group.name, "description": details.group.description,
          "inviter": bridgeValue(details.group.welcomerAccountIdHex), "relays": details.group.relays,
          "retention": Double(details.group.disappearingMessageSecs),
          "membership": wireName(details.group.selfMembership),
          "lifecycle": wireName(policy.lifecycleState), "commit": bridgeValue(pending.map { wireName($0.state) }),
          "isAdmin": policy.isSelfAdmin, "canInvite": policy.canInvite, "canLeave": policy.canLeave,
          "canCancelLeave": policy.canCancelLeave, "canDisband": policy.canDisband,
          "canEnableDisbanding": policy.canEnableDisbanding,
          "members": details.members.map { member -> Document in
            let perms = actions[member.memberIdHex]
            return [
              "id": member.memberIdHex, "npub": member.npub, "name": bridgeValue(member.displayName),
              "self": member.isSelf, "admin": member.isAdmin, "devices": Int(member.deviceCount),
              "canPromote": perms?.canPromote ?? false, "canRemove": perms?.canRemove ?? false,
              "canDemote": perms?.canDemote ?? false,
            ]
          },
        ]
      }
    }
    AsyncFunction("updateGroup") { (group: String, name: String?, description: String?) async throws in
      try await self.withAccount { _ = try await $0.updateGroupProfile(accountRef: $1, groupIdHex: group, name: name, description: description) }
    }
    AsyncFunction("updateRetention") { (group: String, seconds: Int) async throws in
      guard let duration = UInt64(exactly: seconds) else { throw problem("InvalidRetention") }
      try await self.withAccount { _ = try await $0.updateMessageRetention(accountRef: $1, groupIdHex: group, disappearingMessageSecs: duration) }
    }
    AsyncFunction("inviteMembers") { (group: String, members: [String]) async throws -> [Document] in
      try await self.withAccount { kit, account in
        let result = try await kit.inviteMembersDetailed(accountRef: account, groupIdHex: group, memberRefs: members)
        return result.invite.memberOutcomes.map { ["account": $0.accountIdHex, "status": wireName($0.status), "devices": Int($0.selectedDeviceCount)] }
      }
    }
    AsyncFunction("changeMember") { (group: String, member: String, action: String) async throws in
      try await self.withAccount { kit, account in
        switch action {
        case "remove": _ = try await kit.removeMembers(accountRef: account, groupIdHex: group, memberRefs: [member])
        case "promote": _ = try await kit.promoteAdmin(accountRef: account, groupIdHex: group, memberRef: member)
        case "demote": _ = try await kit.demoteAdmin(accountRef: account, groupIdHex: group, memberRef: member)
        default: throw problem("InvalidGroupAction")
        }
      }
    }
    AsyncFunction("changeMembership") { (group: String, action: String) async throws in
      try await self.withAccount { kit, account in
        switch action {
        case "leave": _ = try await kit.leaveGroup(accountRef: account, groupIdHex: group)
        case "cancelLeave": try await kit.cancelLeave(accountRef: account, groupIdHex: group)
        case "forget": _ = try await kit.deleteGroupLocal(accountRef: account, groupIdHex: group)
        case "disband": _ = try await kit.disbandGroup(accountRef: account, groupIdHex: group)
        case "enableDisbanding": _ = try await kit.enableGroupDisbanding(accountRef: account, groupIdHex: group)
        default: throw problem("InvalidGroupAction")
        }
      }
    }
    AsyncFunction("sendText") { (group: String, text: String, token: String, reply: String?) async throws -> String in
      try await self.withAccount { kit, account in
        if let reply {
          return try await kit.replyToMessageWithClientToken(accountRef: account, groupIdHex: group, targetMessageId: reply, text: text, clientToken: token).messageIdHex
        }
        return try await kit.sendTextWithClientToken(accountRef: account, groupIdHex: group, text: text, clientToken: token).messageIdHex
      }
    }
    AsyncFunction("saveDraft") { (group: String, text: String, reply: String?) async throws in
      try await self.withAccount { kit, account in
        let draft = try kit.selectedMessageDraft(accountRef: account, groupIdHex: group)
        let retained = (draft.draft?.mediaAttachments ?? []).map { MessageDraftAttachmentInputFfi.retained(id: $0.id) }
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && retained.isEmpty {
          _ = try kit.clearMessageDraftIfRevision(accountRef: account, revision: draft.revision)
        } else {
          _ = try kit.saveMessageDraftInputsIfRevision(accountRef: account, revision: draft.revision, content: text, replyToMessageIdHex: reply, mediaAttachments: retained)
        }
      }
    }
    AsyncFunction("sendSpecial") { (group: String, kind: UInt64, body: String, reply: String?) async throws in
      guard kind == 24881 || kind == 24883 else { throw problem("InvalidApplicationEvent") }
      try await self.withAccount { kit, account in
        let tags = reply.map { [["e", $0, "", "reply"]] } ?? []
        _ = try await kit.sendCustomEvent(accountRef: account, groupIdHex: group, kind: kind, tags: tags, content: body)
      }
    }
    AsyncFunction("sendMedia") { (group: String, files: [[String: String]], caption: String?, token: String, server: String?, reply: String?) async throws -> String in
      try await self.withAccount { kit, account in
        let base = URL(fileURLWithPath: NSHomeDirectory()).resolvingSymlinksInPath().path + "/"
        guard !files.isEmpty, files.count <= 16 else { throw problem("InvalidMedia") }
        let inputs = try files.map { file -> MediaFileUploadAttachmentRequestFfi in
          guard let raw = file["path"], let name = file["name"], let type = file["type"] else { throw problem("InvalidMedia") }
          let path = URL(fileURLWithPath: raw).resolvingSymlinksInPath().path
          guard path.hasPrefix(base) else { throw problem("InvalidMediaPath") }
          let attributes = try FileManager.default.attributesOfItem(atPath: path)
          guard let size = attributes[.size] as? NSNumber, attributes[.type] as? FileAttributeType == .typeRegular else {
            throw problem("InvalidMediaPath")
          }
          return MediaFileUploadAttachmentRequestFfi(sourcePath: path, expectedSize: size.uint64Value, fileName: name, mediaType: type, dim: file["dimensions"], thumbhash: file["thumbhash"])
        }
        let tags = reply.map { [["e", $0, "", "reply"]] } ?? []
        let request = MediaFileUploadRequestFfi(attachments: inputs, caption: caption, send: true, blossomServer: server, messageTags: tags)
        let result = try await kit.uploadMediaFilesWithClientToken(accountRef: account, groupIdHex: group, request: request, control: MediaFileTransferControlFfi(), clientToken: token)
        guard let accepted = result.acceptance else { throw problem("MediaSendNotAccepted") }
        return accepted.messageIdHex
      }
    }
    AsyncFunction("downloadAttachment") { (group: String, id: String, source: String, index: UInt32) async throws in
      try await self.withAccount { kit, account in
        let target = AttachmentLocalTargetFfi(messageIdHex: id, sourceMessageIdHex: source, attachmentIndex: index)
        let updates = try await kit.subscribeAttachmentTransfers(accountRef: account, groupIdHex: group, targets: [target])
        _ = try await kit.requestExplicitAttachment(accountRef: account, groupIdHex: group, target: target)
        try await withThrowingTaskGroup(of: Void.self) { tasks in
          tasks.addTask {
            var snapshot = try await updates.next()
            while true {
              switch snapshot?.items.first?.state {
              case .ready: return
              case .failed, .unavailable, .policyBlocked, .removed, .previouslyAcquiredUnavailable:
                throw problem("MediaUnavailable")
              default:
                guard let next = try await updates.next() else { throw problem("MediaUnavailable") }
                snapshot = next
              }
            }
          }
          tasks.addTask {
            try await Task.sleep(for: .seconds(180))
            throw problem("MediaUnavailable")
          }
          defer { tasks.cancelAll() }
          _ = try await tasks.next()
        }
      }
    }
    AsyncFunction("openAttachment") { (group: String, id: String, source: String, index: UInt32) async throws -> Document? in
      try await self.withAccount { kit, account in
        let target = AttachmentLocalTargetFfi(messageIdHex: id, sourceMessageIdHex: source, attachmentIndex: index)
        let handoff = try await kit.openAttachmentHandoff(accountRef: account, groupIdHex: group, target: target, control: MediaFileTransferControlFfi())
        return handoff.map { ["lease": $0.lease, "path": $0.path, "type": $0.mediaType, "name": $0.fileName] }
      }
    }
    AsyncFunction("releaseAttachment") { (lease: String) async throws in
      try await self.withAccount { kit, _ in try await kit.releaseAttachmentHandoff(lease: lease) }
    }
    AsyncFunction("storageUsage") { () async throws -> Double in
      try await self.withAccount { kit, account in
        let usage = try await kit.attachmentStorageUsage(accountRef: account)
        return Double(usage.mediaBytes) + Double(usage.legacyBytes)
      }
    }
    AsyncFunction("clearDownloads") { () async throws in
      try await self.withAccount { kit, account in
        _ = try await kit.removeAttachmentsOlderThan(accountRef: account, receivedBefore: UInt64(Date().timeIntervalSince1970) + 1, groupIdHex: nil)
      }
    }
    AsyncFunction("editMessage") { (group: String, id: String, content: String) async throws in
      try await self.withAccount { _ = try await $0.editMessage(accountRef: $1, groupIdHex: group, targetMessageId: id, content: content) }
    }
    AsyncFunction("deleteMessage") { (group: String, id: String) async throws in
      try await self.withAccount { _ = try await $0.deleteMessage(accountRef: $1, groupIdHex: group, targetMessageId: id) }
    }
    AsyncFunction("reactToMessage") { (group: String, id: String, emoji: String, remove: Bool) async throws in
      try await self.withAccount { kit, account in
        if remove { _ = try await kit.unreactFromMessageMatching(accountRef: account, groupIdHex: group, targetMessageId: id, emoji: emoji) }
        else { _ = try await kit.reactToMessage(accountRef: account, groupIdHex: group, targetMessageId: id, emoji: emoji) }
      }
    }
    AsyncFunction("markRead") { (group: String, id: String) async throws in
      try await self.withAccount { _ = try $0.markTimelineMessageRead(accountRef: $1, groupIdHex: group, messageIdHex: id) }
    }
    AsyncFunction("setArchived") { (group: String, archived: Bool) async throws in
      try await self.withAccount { _ = try await $0.setGroupArchived(accountRef: $1, groupIdHex: group, archived: archived) }
    }
    AsyncFunction("setPinned") { (group: String, pinned: Bool) async throws in
      try await self.withAccount { _ = try $0.setChatPinned(accountRef: $1, groupIdHex: group, pinned: pinned) }
    }
    AsyncFunction("setMuted") { (group: String, muted: Bool) async throws in
      try await self.withAccount { kit, account in
        if muted { _ = try kit.setChatMuted(accountRef: account, groupIdHex: group, mutedUntilMs: nil) }
        else { _ = try kit.clearChatMuted(accountRef: account, groupIdHex: group) }
      }
    }
    AsyncFunction("setBlocked") { (key: String, blocked: Bool) async throws in
      try await self.withAccount { kit, account in
        if blocked { _ = try await kit.blockUser(accountRef: account, userAccountIdHex: key) }
        else { _ = try await kit.unblockUser(accountRef: account, userAccountIdHex: key) }
      }
    }
    AsyncFunction("retryConversation") { (group: String) async throws in
      try await self.withAccount { _ = try await $0.retryGroupConvergence(accountRef: $1, groupIdHex: group) }
    }
    AsyncFunction("createPoll") { (group: String, question: String, options: [String], multiple: Bool, expiresAt: UInt64?) async throws in
      try await self.withAccount { kit, account in
        _ = try await kit.createPoll(accountRef: account, groupIdHex: group, question: question, options: options,
          pollType: multiple ? .multipleChoice : .singleChoice, endsAt: expiresAt)
      }
    }
    AsyncFunction("vote") { (group: String, message: String, selected: [String]) async throws in
      try await self.withAccount { _ = try await $0.castPollVote(accountRef: $1, groupIdHex: group, pollEventId: message, optionIds: selected) }
    }
    AsyncFunction("deviceState") { () async throws -> Document in
      try await self.withAccount { kit, account in
        let snapshot = try await kit.deviceLinkSnapshot(accountRef: account)
        let devices = try await kit.linkedDevices(accountRef: account)
        var code = [String]()
        if case .comparing(let entries)? = snapshot.newDevice { code = entries.map(\.emoji) }
        return [
          "state": bridgeValue(snapshot.newDevice.map(wireCase)), "code": code,
          "prompts": snapshot.prompts.map { prompt -> Document in
            var code = [String]()
            if case .comparing(let entries) = prompt.state { code = entries.map(\.emoji) }
            return ["id": prompt.promptId, "state": wireCase(prompt.state), "code": code]
          },
          "stalled": snapshot.deviceGroupStalled,
          "progress": snapshot.chatProgress.map { row -> Document in
            ["slot": row.slotIdHex, "remaining": Int(row.remaining), "total": Int(row.total)]
          },
          "devices": devices.map { device -> Document in
            ["slot": device.slotIdHex, "current": device.isThisDevice, "label": device.label,
              "platform": device.platform, "client": device.client]
          },
        ]
      }
    }
    AsyncFunction("deviceAction") { (action: String, target: String?, label: String?, allChats: Bool, history: Bool) async throws in
      try await self.withAccount { kit, account in
        switch action {
        case "start": _ = try await kit.startDeviceLink(accountRef: account)
        case "match": _ = try await kit.confirmDeviceLinkMatch(accountRef: account)
        case "cancel": _ = try await kit.cancelDeviceLink(accountRef: account)
        case "link":
          guard let target else { throw problem("InvalidDevice") }
          _ = try await kit.linkDevice(accountRef: account, promptId: target, label: label ?? "", addToAllChats: allChats, bringHistory: history)
        case "decline":
          guard let target else { throw problem("InvalidDevice") }
          _ = try await kit.declineDeviceLink(accountRef: account, promptId: target)
        case "remove":
          guard let target else { throw problem("InvalidDevice") }
          try await kit.removeLinkedDevice(accountRef: account, slotIdHex: target)
        default: throw problem("InvalidDeviceAction")
        }
      }
    }
    OnDestroy { [runtime] in Task { try? await runtime.close() } }
  }

  private func withAccount<T>(_ call: (Marmot, String) async throws -> T) async throws -> T {
    try await protocolCall {
      let account = try await runtime.account()
      return try await call(account.kit, account.key)
    }
  }
}

private actor Runtime {
  struct Account {
    let key: String
    let kit: Marmot
  }

  private var active: Account?
  private var changingAccount = false
  private var windows: [String: NativeWindow] = [:]
  private var observers: [String: Task<Void, Never>] = [:]

  func account() throws -> Account {
    guard let active, !changingAccount else { throw problem("AccountClosed") }
    return active
  }

  func open(key: String, secret: String, nsec: String, general: [String], inbox: [String], discovery: [String]) async throws -> String {
    guard !changingAccount else { throw problem("AccountBusy") }
    if let active {
      guard active.key == key else { throw problem("IdentityMismatch") }
      return try wireName(active.kit.accountSetupReadiness(accountRef: key))
    }
    guard [key, secret].allSatisfy({ $0.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil }) else {
      throw problem("IdentityMismatch")
    }
    changingAccount = true
    defer { changingAccount = false }
    let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    var directory = base.appendingPathComponent("marmot", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    var resources = URLResourceValues()
    resources.isExcludedFromBackup = true
    try directory.setResourceValues(resources)
    let root = directory.appendingPathComponent(key, isDirectory: true)
    let store = AccountCredential(account: key, secret: secret, marker: root.appendingPathComponent("boop-credential"))
    let kit = try Marmot.newWithConfiguration(rootPath: root.resolvingSymlinksInPath().path, relayUrls: general, options: MarmotOptions(
      clientName: "Boop", devicePlatform: "iOS", secretStore: store,
      attachmentAcquisitionMode: .hostManaged, deployment: marmotDeploymentNeutral()
    ))
    do {
      let known = try kit.listAccounts()
      guard !known.contains(where: { $0.accountIdHex != key || $0.label != key }) else { throw problem("IdentityMismatch") }
      guard !known.contains(where: { $0.unlinked || $0.signedOut }) else { throw problem("AccountSignedOut") }
      try await kit.start()
      if known.isEmpty {
        let created = try await kit.login(identity: nsec, defaultRelays: general, bootstrapRelays: discovery, inboxRelays: inbox)
        guard created.accountIdHex == key, created.label == key else { throw problem("IdentityMismatch") }
      }
      let readiness = try wireName(kit.accountSetupReadiness(accountRef: key))
      active = Account(key: key, kit: kit)
      return readiness
    } catch {
      try? await kit.shutdownAndClose()
      throw error
    }
  }

  func close() async throws {
    guard !changingAccount else { throw problem("AccountBusy") }
    guard let active else { return }
    changingAccount = true
    defer { changingAccount = false }
    self.active = nil
    for id in Array(windows.keys) { await closeWindow(id) }
    try await active.kit.shutdownAndClose()
  }

  func window(_ id: String) throws -> NativeWindow {
    guard let window = windows[id] else { throw problem("WindowClosed") }
    return window
  }

  func openChatList(id: String, view: String) async throws -> Document {
    let account = try account()
    let views: [String: ChatListViewFfi] = ["chats": .chats, "archived": .archived, "left": .left, "unread": .unread]
    guard let selected = views[view] else { throw problem("InvalidView") }
    let handle = try await account.kit.openChatListWindow(accountRef: account.key, view: selected, initialRows: 40)
    return try await install(.chatList(handle), id: id, account: account)
  }

  func openAttention(id: String) async throws -> Document {
    let account = try account()
    let handle = try await account.kit.subscribeAccountAttention()
    return try await install(.attention(handle, account.key), id: id, account: account)
  }

  func openConversation(id: String, group: String, target: String?) async throws -> Document {
    let account = try account()
    let handle = try await account.kit.openConversationWindow(accountRef: account.key, groupIdHex: group, mode: target == nil ? .automatic : .message, messageIdHex: target, initialRows: 40, timeoutMs: 0)
    return try await install(.conversation(handle), id: id, account: account)
  }

  private func install(_ window: NativeWindow, id: String, account: Account) async throws -> Document {
    guard windows[id] == nil, windows.count < 16, active?.kit === account.kit else {
      await window.cancel()
      throw problem("WindowLimit")
    }
    guard let initial = window.initial() else {
      await window.cancel()
      throw problem("WindowClosed")
    }
    windows[id] = window
    return initial
  }

  func observe(id: String, notify: @escaping (String, Document) -> Void) throws {
    let window = try window(id)
    guard observers[id] == nil else { return }
    observers[id] = Task {
      do {
        while !Task.isCancelled, let snapshot = try await window.next() {
          guard !Task.isCancelled else { return }
          notify("windowChanged", ["id": id, "snapshot": snapshot])
        }
        if !Task.isCancelled { notify("windowClosed", ["id": id, "code": "WindowClosed"]) }
      } catch {
        if !Task.isCancelled { notify("windowClosed", ["id": id, "code": errorCode(error)]) }
      }
    }
  }

  func closeWindow(_ id: String) async {
    let handle = windows.removeValue(forKey: id)
    let observer = observers.removeValue(forKey: id)
    observer?.cancel()
    await handle?.cancel()
    await observer?.value
  }
}

private final class AccountCredential: SecretStore, @unchecked Sendable {
  let account: String
  private let secret: String
  private let marker: URL
  private let lock = NSLock()

  init(account: String, secret: String, marker: URL) {
    self.account = account
    self.secret = secret
    self.marker = marker
  }

  func hasSecretForLabel(label: String) throws -> Bool {
    try lock.withLock { try label == account && registered() }
  }
  func hasSecretForAccountId(accountIdHex: String) throws -> Bool {
    try lock.withLock { try accountIdHex == account && registered() }
  }
  func writeSecret(label: String, accountIdHex: String, secretKeyHex: String) throws {
    try lock.withLock {
      guard label == account, accountIdHex == account, secretKeyHex == secret else {
        throw MarmotKitError.KeystoreUnavailable(details: "Identity mismatch")
      }
      try Data(account.utf8).write(to: marker, options: .atomic)
    }
  }
  func loadSecret(label: String, accountIdHex: String) throws -> String {
    try lock.withLock {
      guard label == account, accountIdHex == account, try registered() else {
        throw MarmotKitError.SecretNotFound(details: "Account credential unavailable")
      }
      return secret
    }
  }
  func removeSecret(label: String, accountIdHex: String) throws {
    try lock.withLock {
      if label == account, accountIdHex == account, FileManager.default.fileExists(atPath: marker.path) {
        try FileManager.default.removeItem(at: marker)
      }
    }
  }
  private func registered() throws -> Bool {
    guard FileManager.default.fileExists(atPath: marker.path) else { return false }
    guard try Data(contentsOf: marker) == Data(account.utf8) else {
      throw MarmotKitError.KeystoreUnavailable(details: "Identity mismatch")
    }
    return true
  }
}

private func revision(_ generation: String, _ sequence: String) throws -> ConversationWindowRevisionFfi {
  guard let number = UInt64(sequence) else { throw problem("InvalidSequence") }
  return ConversationWindowRevisionFfi(generation: generation, sequence: number)
}

func problem(_ code: String) -> Exception {
  Exception(name: code, description: code, code: code)
}

private func errorCode(_ error: Error) -> String {
  if let error = error as? Exception { return error.code }
  if let error = error as? MarmotKitError { return Mirror(reflecting: error).children.first?.label ?? "MarmotFailure" }
  return "NativeFailure"
}

private func wireCase<T>(_ value: T) -> String {
  let name = Mirror(reflecting: value).children.first?.label ?? String(describing: value)
  return name.prefix(1).uppercased() + name.dropFirst()
}

private func protocolCall<T>(_ work: () async throws -> T) async throws -> T {
  do { return try await work() }
  catch is CancellationError { throw CancellationError() }
  catch { throw problem(errorCode(error)) }
}
