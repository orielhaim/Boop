import AVFoundation
import ExpoModulesCore
import Foundation
import ImageIO
import UIKit

private let attachmentStallTimeout: TimeInterval = 180

public final class BoopMarmotModule: Module {
  private let runtime = Runtime()
  private var draftStages: Set<String> = [] // Guarded by uploadLock.
  private let uploadLock = NSLock()
  private let attachmentLock = NSLock()
  private let directoryLock = NSLock()
  private struct Observation {
    let accountScoped: Bool
    var task: Task<Void, Error>?
  }
  private var observations: [String: Observation] = [:]
  private var attachmentAdmissions: [String: AttachmentCancellation] = [:]
  private var isForeground = true
  private var foregroundGeneration: UInt64 = 0
  private var uploads: [String: MediaFileTransferControlFfi] = [:]

  public func definition() -> ModuleDefinition {
    Name("BoopMarmot")
    Events("windowChanged", "windowClosed", "attachmentProgress", "directorySearchResults", "relayLiveness", "blockedUsers")
    OnAppEntersBackground {
      self.directoryLock.withLock { self.observations.values.filter { !$0.accountScoped }.forEach { $0.task?.cancel() } }
      let pending = self.attachmentLock.withLock { () -> [AttachmentCancellation] in
        self.isForeground = false
        self.foregroundGeneration &+= 1
        return Array(self.attachmentAdmissions.values)
      }
      Task {
        await self.runtime.discardImport()
        for attempt in pending { await attempt.cancel() }
      }
    }
    OnAppBecomesActive {
      self.attachmentLock.withLock {
        self.isForeground = true
        self.foregroundGeneration &+= 1
      }
    }

    AsyncFunction("listAccounts") { (general: [String], discovery: [String], origin: String?) async throws -> [Document] in
      try await protocolCall { try await self.runtime.listAccounts(general: general, discovery: discovery, origin: origin) }
    }
    AsyncFunction("prepareIdentityImport") { (token: String, input: String, password: String) async throws -> String in
      try await protocolCall {
        let generation = self.attachmentLock.withLock { self.isForeground ? self.foregroundGeneration : nil }
        guard let generation else { throw problem("AccountClosed") }
        let key = try await self.runtime.prepareImport(token: token, input: input, password: password)
        guard self.attachmentLock.withLock({ self.isForeground && self.foregroundGeneration == generation }) else {
          await self.runtime.discardImport(token: token)
          throw problem("AccountClosed")
        }
        return key
      }
    }
    AsyncFunction("discardIdentityImport") { (token: String) async in
      await self.runtime.discardImport(token: token)
    }
    AsyncFunction("installAccount") { (token: String?, name: String?, about: String?, general: [String], inbox: [String], discovery: [String]) async throws -> String in
      try await protocolCall {
        guard self.attachmentLock.withLock({ self.isForeground }) else { throw problem("AccountClosed") }
        return try await self.runtime.install(token: token, name: name, about: about, general: general, inbox: inbox, discovery: discovery)
      }
    }
    AsyncFunction("accountOnboarding") { (key: String, action: String, step: String?, revision: String?, epoch: String?) async throws -> Document? in
      try await protocolCall {
        try await self.runtime.onboarding(key: key, action: action, step: step, revision: revision, epoch: epoch)
      }
    }
    AsyncFunction("selectSigner") { (key: String) async throws -> Document in
      try await protocolCall { try await self.runtime.selectSigner(key) }
    }
    AsyncFunction("readProfiles") { (owner: String, keys: [String]) async throws -> [Document] in
      try await self.withSigner(owner) { kit in
        try kit.cachedIdentityProjections(accountIdHexes: keys).compactMap { item in
          guard let key = item.accountIdHex, let profile = item.profile else { return nil }
          return profileDocument(key, profile, item.website, item.bot)
        }
      }
    }
    AsyncFunction("refreshPublicProfile") { (owner: String, key: String, relays: [String]) async throws in
      try await self.withSigner(owner) { try await $0.refreshProfile(accountIdHex: key, relays: relays) }
    }
    AsyncFunction("updatePublicProfile") { (owner: String, fields: [String: String]) async throws in
      try await self.withSigner(owner) { kit in
        _ = try await kit.updateUserProfileUsingAccountRelays(accountRef: owner, edits: fields)
      }
    }
    AsyncFunction("normalizeDirectoryIdentity") { (owner: String, reference: String) async throws -> String? in
      try await self.withSigner(owner) { $0.accountIdHex(reference: reference) }
    }
    AsyncFunction("cachedDirectorySearch") { (owner: String, query: String) async throws -> [Document] in
      try await self.withSigner(owner) { try $0.searchCachedUsers(accountIdHex: owner, query: query, limit: 48).map(searchResultDocument) }
    }
    Function("prepareObservation") { (id: String, accountScoped: Bool) -> Bool in
      self.directoryLock.withLock {
        guard self.observations.count < 8, self.observations.index(forKey: id) == nil else { return false }
        self.observations[id] = Observation(accountScoped: accountScoped)
        return true
      }
    }
    AsyncFunction("searchDirectory") { (owner: String, id: String, query: String) async throws in
      try await self.withObservation(id) {
        let search = try await self.withSigner(owner) {
          try await $0.searchUsers(accountIdHex: owner, query: query, radiusStart: 0, radiusEnd: 2)
        }
        while let update = try await search.nextCancellable() {
          try Task.checkCancellation()
          if case .error = update.trigger { continue }
          let rows = (update.newResults + update.updatedResults).prefix(48).map(searchResultDocument)
          if !rows.isEmpty { self.sendEvent("directorySearchResults", ["id": id, "rows": rows]) }
        }
      }
    }
    Function("cancelObservation") { (id: String) in
      self.directoryLock.withLock { self.observations.removeValue(forKey: id)?.task?.cancel() }
    }
    AsyncFunction("requestAvatarAssets") { (targets: [String]) async throws -> [Document] in
      try await self.withAccount { try await $0.requestAvatarAssets(accountRef: $1, targets: targets).map(avatarDocument) }
    }
    AsyncFunction("readAvatarAssets") { (references: [String]) async throws -> [Document] in
      try await self.withAccount { kit, account in
        try await kit.readAvatarAssets(accountRef: account, references: references, maxBytes: 4 * 1024 * 1024).map { asset in
          let uri = asset.mediaType.flatMap { mime -> String? in
            guard !asset.bytes.isEmpty,
              ["image/jpeg", "image/png", "image/webp", "image/gif"].contains(mime) else { return nil }
            return "data:\(mime);base64,\(asset.bytes.base64EncodedString())"
          }
          return ["reference": asset.reference, "revision": String(asset.contentRevision),
                  "availability": wireName(asset.availability), "deferred": asset.deferred, "uri": bridgeValue(uri)]
        }
      }
    }
    AsyncFunction("clearMarmotAvatarCache") { (owner: String) async throws in
      try await self.withSigner(owner) { try await $0.clearAvatarCache(accountRef: owner) }
    }
    AsyncFunction("accountNetworkReady") { (key: String) async throws -> Bool in
      try await self.withSigner(key) { try $0.accountSetupReadiness(accountRef: key) == .networkReady }
    }
    AsyncFunction("removeAccount") { (key: String) async throws in
      try await protocolCall { try await self.runtime.remove(key) }
    }
    AsyncFunction("signOutAccount") { (key: String) async throws in
      try await protocolCall { try await self.runtime.signOut(key) }
    }
    AsyncFunction("resumeAccountSetup") { () async throws in
      try await protocolCall { try await self.runtime.resumeSetup() }
    }
    AsyncFunction("signInAccount") { (key: String) async throws in
      try await protocolCall { try await self.runtime.signIn(key) }
    }
    AsyncFunction("openAccount") { (key: String, general: [String], discovery: [String], mediaOrigin: String?) async throws -> String in
      try await protocolCall { try await self.runtime.open(key: key, general: general, discovery: discovery, mediaOrigin: mediaOrigin) }
    }
    AsyncFunction("signNostrEvent") { (key: String, event: String) async throws -> String in
      try await self.withSigner(key) { try await $0.signNostrEvent(accountRef: key, unsignedJson: event) }
    }
    AsyncFunction("nostrCipher") { (key: String, peer: String, value: String, nip44: Bool, encrypt: Bool) async throws -> String in
      try await self.withSigner(key) { try await $0.nostrCipher(accountRef: key, peer: peer, content: value, nip44: nip44, encrypt: encrypt) }
    }
    AsyncFunction("exportIdentity") { (key: String, password: String?) async throws -> String in
      try await self.withSigner(key) { kit in
        if let password { return try kit.exportEncryptedSecretKey(accountRef: key, passphrase: password) }
        return try kit.revealNsec(accountRef: key)
      }
    }
    AsyncFunction("closeAccount") { (pauseMessaging: Bool) async throws in
      try await protocolCall { try await self.closeAccount(pauseMessaging: pauseMessaging) }
    }
    AsyncFunction("shutdownRuntime") { () async throws in
      try await protocolCall { try await self.closeAccount(closeRuntime: true) }
    }
    AsyncFunction("catchUp") { () async throws in
      try await self.withAccount { kit, _ in try await kit.catchUpAccounts() }
    }
    AsyncFunction("notifyConnectivityRestored") { () async throws in
      try await self.withAccount { kit, _ in try await kit.notifyConnectivityRestored() }
    }
    AsyncFunction("accountRelayLists") { (key: String) async throws -> Document in
      try await self.withSigner(key) { kit in
        let lists = try kit.accountRelayLists(accountRef: key)
        let general = try kit.accountNip65Relays(accountRef: key)
        let inbox = lists.inbox.relays
        let allowed = kit.classifyRelayEndpoints(endpoints: general + inbox)
          .filter { $0.policy == .allowed }.map(\.endpoint)
        return ["general": general, "write": lists.nip65.relays, "inbox": inbox,
          "bootstrap": lists.bootstrapRelays, "allowed": allowed, "retiredHosts": kit.retiredRelayHosts()]
      }
    }
    AsyncFunction("refreshAccountRelayLists") { (key: String, urls: [String]) async throws in
      try await self.withSigner(key) { kit in _ = try await kit.refreshUserRelayLists(accountIdHex: key, relays: urls) }
    }
    AsyncFunction("classifyRelays") { (key: String, urls: [String]) async throws -> [String] in
      try await self.withSigner(key) { kit in
        kit.classifyRelayEndpoints(endpoints: urls).map { wireName($0.policy) }
      }
    }
    AsyncFunction("setAccountRelays") { (key: String, inbox: Bool, urls: [String], bootstrap: [String]) async throws in
      try await self.withSigner(key) { kit in
        if inbox { _ = try await kit.setAccountInboxRelays(accountRef: key, relays: urls, bootstrapRelays: bootstrap) }
        else { _ = try await kit.setAccountNip65Relays(accountRef: key, relays: urls, bootstrapRelays: bootstrap) }
      }
    }
    AsyncFunction("reconnectMarmotRelay") { (url: String) async throws in
      try await self.withAccount { kit, key in _ = try await kit.reconnectRelay(accountRef: key, url: url) }
    }
    AsyncFunction("watchRelayLiveness") { (key: String, id: String) async throws in
      try await self.withObservation(id) {
        let stream = try await self.withSigner(key) { try await $0.subscribeRelayLiveness(accountRef: key) }
        defer { stream.cancel() }
        func emit(_ rows: [RelayLivenessFfi]) {
          self.sendEvent("relayLiveness", ["id": id, "rows": rows.map { row -> Document in
            ["url": row.url, "status": wireName(row.status), "lastError": bridgeValue(row.lastError),
             "lastAttempt": bridgeValue(row.lastAttemptUnix.map { Double($0) })]
          }])
        }
        try Task.checkCancellation()
        emit(stream.snapshot())
        while let rows = try await withTaskCancellationHandler(operation: { try await stream.next() }, onCancel: { stream.cancel() }) {
          try Task.checkCancellation()
          emit(rows)
        }
      }
    }
    AsyncFunction("backupState") { () async throws -> Document in
      try await self.withAccount { kit, account in
        let settings = try await kit.backupSettings(accountRef: account)
        let restore = try await kit.backupRestoreStatus(accountRef: account)
        return ["enabled": settings.enabled, "thisDeviceWrites": settings.thisDeviceWrites,
          "phase": wireName(restore.phase), "operation": bridgeValue(restore.operation),
          "imported": Double(restore.importedEvents), "failed": Double(restore.failedArchives) + Double(restore.failedBundles)]
      }
    }
    AsyncFunction("beginBackup") { () async throws -> Document in
      try await self.withAccount { kit, account in
        let setup = try await kit.beginRecoveryWords(accountRef: account)
        return ["words": setup.words, "positions": setup.confirmPositions.map(Int.init)]
      }
    }
    AsyncFunction("backupAction") { (action: String, words: [String]) async throws in
      try await self.withAccount { kit, account in
        switch action {
        case "confirm": try await kit.confirmRecoveryWords(accountRef: account, answers: words)
        case "cancel": try await kit.cancelRecoveryWords(accountRef: account)
        case "disable": try await kit.turnOffBackups(accountRef: account)
        case "restore":
          guard words.count == 1 else { throw problem("InvalidBackupAction") }
          _ = try await kit.beginBackupRestore(accountRef: account, words: words[0])
        case "cancelRestore":
          guard words.count == 1 else { throw problem("InvalidBackupAction") }
          _ = try await kit.cancelBackupRestore(accountRef: account, operation: words[0])
        default: throw problem("InvalidBackupAction")
        }
      }
    }
    AsyncFunction("backupConditions") { (wifi: Bool, charging: Bool) async throws in
      try await self.withAccount { try await $0.setRuntimeBackupBackgroundConditions(wifi: wifi, charging: charging) }
    }
    AsyncFunction("backupNow") { () async throws -> String in
      try await self.withAccount { try await wireName($0.runDueBackupPass(accountRef: $1)) }
    }
    AsyncFunction("openChatList") { (id: String, view: String, invitations: Bool, search: String?) async throws -> Document in
      try await protocolCall { try await self.runtime.openChatList(id: id, view: view, invitations: invitations, search: search) }
    }
    AsyncFunction("openAttention") { (id: String) async throws -> Document in
      try await protocolCall { try await self.runtime.openAttention(id: id) }
    }
    AsyncFunction("openGroupState") { (id: String, group: String, roster: Bool) async throws -> Document in
      try await protocolCall { try await self.runtime.openGroupState(id: id, group: group, roster: roster) }
    }
    AsyncFunction("openGroupCall") { (id: String, group: String) async throws -> Document in
      try await protocolCall { try await self.runtime.openGroupCall(id: id, group: group) }
    }
    AsyncFunction("openConversation") { (id: String, group: String, target: String?, speculative: Bool) async throws -> Document in
      try await protocolCall { try await self.runtime.openConversation(id: id, group: group, target: target, speculative: speculative) }
    }
    AsyncFunction("observeWindow") { (id: String) async throws in
      try await self.runtime.observe(id: id) { [weak self] event, value in
        self?.sendEvent(event, value)
      }
    }
    AsyncFunction("closeWindow") { (id: String) async in
      await self.runtime.closeWindow(id)
    }
    AsyncFunction("windowSnapshot") { (id: String) async throws -> Document in
      try await protocolCall {
        try await self.runtime.windowSnapshot(id)
      }
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
    AsyncFunction("prewarmInvitees") { (members: [String]) async throws in
      try await self.withAccount { _ = try await $0.prewarmGroupMemberKeyPackages(accountRef: $1, memberRefs: members) }
    }
    AsyncFunction("createGroup") { (name: String, description: String?, members: [String], image: String?) async throws -> Document in
      try await self.withAccount { kit, account in
        let initial = try image.map { path in
          InitialGroupImageFfi(plaintext: try groupImageInput(path), mediaType: "image/jpeg", sourceUrl: nil, dim: nil, thumbhash: nil)
        }
        let result = try await kit.createGroupWithInitialImageDetailed(accountRef: account, name: name, memberRefs: members, description: description, initialImage: initial)
        return ["groupId": bridgeValue(result.created?.groupIdHex),
                "createdAt": bridgeValue(result.created.map { Double($0.chatListRow.conversationCreatedAt) }), "members": result.memberOutcomes.map { member -> Document in
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
    AsyncFunction("groupDiagnostics") { (group: String) async throws -> Document in
      try await self.withAccount { try await groupDiagnostics($0, $1, group) }
    }
    AsyncFunction("groupAccess") { (group: String, includeMembers: Bool) async throws -> Document in
      try await self.withAccount { kit, account in
        let details = try await kit.groupDetails(accountRef: account, groupIdHex: group)
        let row = includeMembers ? try kit.chatListRow(accountRef: account, groupIdHex: group) : nil
        return ["membership": wireName(details.group.selfMembership),
                "pendingInvitation": details.group.pendingConfirmation,
                "pendingLeave": details.group.leaveRequestPending,
                "unrecoverable": details.mlsState.unrecoverable, "disbanding": details.mlsState.disbanding,
                "lifecycle": wireName(details.mlsState.lifecycleState),
                "kind": bridgeValue(row.map { wireName($0.conversationKind) }),
                "members": includeMembers ? details.members.map(\.memberIdHex) : []]
      }
    }
    AsyncFunction("groupInvitation") { (group: String, preview: Bool) async throws -> Document in
      try await self.withAccount { kit, account in
        let details = try await kit.groupDetails(accountRef: account, groupIdHex: group)
        let members: [Document] = preview ? details.members.lazy.filter { !$0.isSelf }.prefix(16).map {
          ["id": $0.memberIdHex, "npub": $0.npub, "name": bridgeValue($0.displayName)]
        } : []
        return ["inviter": bridgeValue(details.group.pendingConfirmation ? details.group.welcomerAccountIdHex : nil),
                "name": details.group.name, "memberCount": details.members.count, "members": members]
      }
    }
    AsyncFunction("groupMemberIds") { (groups: [String]) async throws -> [String: [String]] in
      try await self.withAccount { kit, account in
        let rows = try await kit.groupMemberIdsPage(accountRef: account, groupIdsHex: groups)
        return Dictionary(rows.map { ($0.groupIdHex, $0.memberIdsHex) }, uniquingKeysWith: { first, _ in first })
      }
    }
    AsyncFunction("updateGroup") { (group: String, name: String?, description: String?) async throws -> String in
      try await self.withAccount { wireName(try await $0.updateGroupProfile(accountRef: $1, groupIdHex: group, name: name, description: description).acceptDisposition) }
    }
    AsyncFunction("updateGroupImage") { (group: String, path: String?) async throws -> String in
      try await self.withAccount { kit, account in
        if let path {
          return wireName(try await kit.updateGroupImage(accountRef: account, groupIdHex: group, plaintext: groupImageInput(path), mediaType: "image/jpeg").acceptDisposition)
        } else {
          return wireName(try await kit.clearGroupImage(accountRef: account, groupIdHex: group).acceptDisposition)
        }
      }
    }
    AsyncFunction("updateGroupMedia") { (group: String, origins: [String]) async throws -> String in
      try await self.withAccount { kit, account in
        let result = try await kit.replaceEncryptedMediaBlobEndpoints(accountRef: account, groupIdHex: group, endpoints: origins.map {
          AppBlobEndpointFfi(locatorKind: "blossom", baseUrl: $0)
        })
        return wireName(result.acceptDisposition)
      }
    }
    AsyncFunction("viewGroupImage") { (group: String, hash: String) async throws -> String in
      try await self.withAccount { kit, account in
        let details = try await kit.groupDetails(accountRef: account, groupIdHex: group).group
        guard !details.pendingConfirmation, details.selfMembership == .member,
          details.imageHashHex == hash else { throw problem("MediaUnavailable") }
        let bytes = try await kit.downloadGroupBlossomImage(accountRef: account, groupIdHex: group)
        let current = try await kit.groupDetails(accountRef: account, groupIdHex: group).group
        guard !bytes.isEmpty, bytes.count <= maxGroupImage, !current.pendingConfirmation,
          current.selfMembership == .member, current.imageHashHex == hash else { throw problem("MediaUnavailable") }
        guard let source = CGImageSourceCreateWithData(bytes as CFData, nil),
          let type = CGImageSourceGetType(source),
          let mime = ["public.jpeg": "image/jpeg", "public.png": "image/png",
                      "org.webmproject.webp": "image/webp", "com.compuserve.gif": "image/gif"][type as String],
          let dimensions = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let width = dimensions[kCGImagePropertyPixelWidth] as? Int, (1...4096).contains(width),
          let height = dimensions[kCGImagePropertyPixelHeight] as? Int, (1...4096).contains(height)
        else { throw problem("InvalidMedia") }
        return "data:\(mime);base64,\(bytes.base64EncodedString())"
      }
    }
    AsyncFunction("searchConversation") { (group: String, text: String?, media: Bool) async throws -> [Document] in
      try await self.withAccount { kit, account in
        let query = TimelineMessageQueryFfi(groupIdHex: group, search: text, sender: nil, since: nil, until: nil, attachmentType: media ? 5 : 0, cursorGroupId: nil, before: nil, beforeMessageId: nil, after: nil, afterMessageId: nil, limit: 40)
        return try kit.timelineMessages(accountRef: account, query: query).messages.filter { !$0.deleted }.map {
          ["id": $0.messageIdHex, "sender": $0.sender, "text": $0.plaintext, "sentAt": Double($0.timelineAt)]
        }
      }
    }
    AsyncFunction("editHistory") { (group: String, message: String, before: Double?, id: String?) async throws -> Document in
      try await self.withAccount { kit, account in
        let page = try kit.messageEditHistory(accountRef: account, groupIdHex: group, targetMessageIdHex: message, beforeEditedAt: before.flatMap { UInt64(exactly: $0) }, beforeMessageIdHex: id, limit: 25)
        let versions: [Document] = page.versions.map { ["id": $0.messageIdHex, "text": $0.plaintext, "at": Double($0.editedAt)] }
        return ["more": page.hasMoreBefore, "versions": versions]
      }
    }
    AsyncFunction("inviteMembers") { (group: String, members: [String]) async throws -> Document in
      try await self.withAccount { kit, account in
        let result = try await kit.inviteMembersDetailed(accountRef: account, groupIdHex: group, memberRefs: members)
        return ["disposition": bridgeValue(result.invite.summary.map { wireName($0.acceptDisposition) }),
                "members": result.invite.memberOutcomes.map { ["account": $0.accountIdHex, "status": wireName($0.status), "devices": Int($0.selectedDeviceCount)] as Document }]
      }
    }
    AsyncFunction("changeMember") { (group: String, member: String, action: String) async throws -> String in
      try await self.withAccount { kit, account in
        switch action {
        case "remove": return wireName(try await kit.removeMembers(accountRef: account, groupIdHex: group, memberRefs: [member]).acceptDisposition)
        case "promote": return wireName(try await kit.promoteAdmin(accountRef: account, groupIdHex: group, memberRef: member).acceptDisposition)
        case "demote": return wireName(try await kit.demoteAdmin(accountRef: account, groupIdHex: group, memberRef: member).acceptDisposition)
        case "stepDown": return wireName(try await kit.selfDemoteAdmin(accountRef: account, groupIdHex: group).acceptDisposition)
        default: throw problem("InvalidGroupAction")
        }
      }
    }
    AsyncFunction("changeMembership") { (group: String, action: String) async throws -> String? in
      try await self.withAccount { kit, account in
        switch action {
        case "leave": return wireName(try await kit.leaveGroup(accountRef: account, groupIdHex: group).acceptDisposition)
        case "cancelLeave": try await kit.cancelLeave(accountRef: account, groupIdHex: group)
        case "deleteLocal": _ = try await kit.deleteGroupLocal(accountRef: account, groupIdHex: group)
        case "disband": _ = try await kit.disbandGroup(accountRef: account, groupIdHex: group)
        case "enableDisbanding": return wireName(try await kit.enableGroupDisbanding(accountRef: account, groupIdHex: group).summary.acceptDisposition)
        default: throw problem("InvalidGroupAction")
        }
        return nil
      }
    }
    AsyncFunction("respondToRejoin") { (welcome: String, token: String?) async throws in
      try await self.withAccount { kit, account in
        if let token {
          _ = try await kit.confirmGroupRejoin(accountRef: account, welcomeIdHex: welcome, localStateToken: token)
        } else {
          try await kit.declineGroupRejoin(accountRef: account, welcomeIdHex: welcome)
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
        try retryDraftEdit {
          let selected = try kit.selectedMessageDraft(accountRef: account, groupIdHex: group)
          if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
             selected.draft?.mediaAttachments.isEmpty != false {
            _ = try kit.clearMessageDraftIfRevision(accountRef: account, revision: selected.revision)
          } else {
            _ = try kit.saveMessageDraftInputsIfRevision(accountRef: account, revision: selected.revision,
              content: text, replyToMessageIdHex: reply, mediaAttachments: [])
          }
        }
      }
    }
    AsyncFunction("sendSpecial") { (group: String, kind: UInt64, body: String, reply: String?) async throws in
      guard [24881, 24883, 24884].contains(kind) else { throw problem("InvalidApplicationEvent") }
      try await self.withAccount { kit, account in
        let tags = reply.map { [["e", $0, "", "reply"]] } ?? []
        _ = try await kit.sendCustomEvent(accountRef: account, groupIdHex: group, kind: kind, tags: tags, content: body)
      }
    }
    AsyncFunction("stageMediaDraft") { (group: String, files: [[String: String]], caption: String, token: String, reply: String?) async throws in
      try await self.withAccount { kit, account in
        let inputs = try self.uploadInputs(files)
        let control = MediaFileTransferControlFfi()
        let registered = self.uploadLock.withLock {
          guard self.uploads[token] == nil, self.draftStages.insert(group).inserted else { return false }
          self.uploads[token] = control
          return true
        }
        guard registered else { throw problem("TransferInProgress") }
        defer {
          self.uploadLock.withLock {
            self.uploads.removeValue(forKey: token)
            self.draftStages.remove(group)
          }
        }
        var draft = try kit.selectedMessageDraft(accountRef: account, groupIdHex: group)
        guard draft.draft?.mediaAttachments.isEmpty != false else { throw problem("MediaDraftPending") }
        draft = try kit.saveMessageDraftInputsIfRevision(accountRef: account, revision: draft.revision,
          content: caption, replyToMessageIdHex: reply, mediaAttachments: [])
        self.sendEvent("attachmentProgress", ["transfer": token, "received": 0.0, "state": "preparing"])
        for (index, input) in inputs.enumerated() {
          let file = files[index]
          let presentation = mediaPresentation(file["presentation"], input.mediaType)
          let request = MessageDraftAttachmentFileRequestFfi(id: "\(token):\(inputs.count):\(index):\(presentation)",
            sourcePath: input.sourcePath, expectedSize: input.expectedSize, fileName: input.fileName,
            mediaType: input.mediaType, dim: input.dim, thumbhash: input.thumbhash,
            durationSeconds: mediaDuration(file["duration"]), waveformSamples: mediaWaveform(file["waveform"]))
          draft = try await kit.stageMessageDraftAttachmentFile(accountRef: account, revision: draft.revision, request: request, control: control)
        }
      }
    }
    AsyncFunction("discardMediaDraft") { (group: String) async throws in
      try await self.withAccount { kit, account in
        if self.uploadLock.withLock({ self.draftStages.contains(group) }) { throw problem("TransferInProgress") }
        var idsToRemove: Set<String>?
        try retryDraftEdit {
          let selected = try kit.selectedMessageDraft(accountRef: account, groupIdHex: group)
          guard let draft = selected.draft else { return }
          let ids = idsToRemove ?? Set(draft.mediaAttachments.map(\.id))
          idsToRemove = ids
          let removed = draft.mediaAttachments.filter { ids.contains($0.id) }.map {
            MessageDraftAttachmentInputFfi.removed(id: $0.id)
          }
          guard !removed.isEmpty else { return }
          _ = try kit.saveMessageDraftInputsIfRevision(accountRef: account, revision: selected.revision,
            content: draft.content, replyToMessageIdHex: draft.replyToMessageIdHex, mediaAttachments: removed)
        }
      }
    }
    AsyncFunction("sendMedia") { (group: String, files: [[String: String]], caption: String?, token: String, server: String?, reply: String?) async throws -> Document in
      try await self.withAccount { kit, account in
        switch try kit.localSendStatus(accountRef: account, groupIdHex: group, clientToken: token) {
        case .completed(let summary): return ["id": summary.messageIds.first ?? "", "blobs": []]
        case .queued, .engineOwned: return ["id": "", "blobs": []]
        case .rejected: throw problem("MediaSendNotAccepted")
        case nil: break
        }
        let state = try await kit.groupDetails(accountRef: account, groupIdHex: group)
        guard state.group.encryptedMedia.version == .v2 else { throw problem("MediaNotConfigured") }
        let inputs = files.isEmpty ? [] : try self.uploadInputs(files)
        let selected = files.isEmpty ? try kit.selectedMessageDraft(accountRef: account, groupIdHex: group) : nil
        let draftFiles = selected?.draft?.mediaAttachments ?? []
        if selected != nil {
          guard !draftFiles.isEmpty, draftFiles.enumerated().allSatisfy({ index, item in
            item.fileBacked && item.id.hasPrefix("\(token):\(draftFiles.count):\(index):")
          }) else { throw problem("MediaDraftPending") }
        }
        let control = MediaFileTransferControlFfi()
        let registered = self.uploadLock.withLock {
          guard self.uploads[token] == nil else { return false }
          self.uploads[token] = control
          return true
        }
        guard registered else { throw problem("TransferInProgress") }
        let total = (inputs.reduce(0.0) { $0 + Double($1.expectedSize ?? 0) } + draftFiles.reduce(0.0) { $0 + Double($1.plaintextSize) }) * 3
        let progress = Task { [weak self] in
          while !Task.isCancelled {
            self?.sendEvent("attachmentProgress", ["transfer": token, "received": Double(control.processedBytes()),
              "total": total, "state": "uploading"])
            try await Task.sleep(for: .milliseconds(250))
          }
        }
        defer {
          progress.cancel()
          _ = self.uploadLock.withLock { self.uploads.removeValue(forKey: token) }
        }
        let tags = try inputs.enumerated().map { index, input in
          let file = files[index]
          guard let size = input.expectedSize else { throw problem("InvalidMediaPath") }
          return mediaMetadata(index, size, mediaDuration(file["duration"]),
            mediaWaveform(file["waveform"]), mediaPresentation(file["presentation"], input.mediaType))
        } + (reply.map { [["e", $0, "", "reply"]] } ?? [])
        let request = MediaFileUploadRequestFfi(attachments: inputs, caption: caption, send: true, blossomServer: server, messageTags: tags)
        do {
          let uploaded: MediaUploadResultFfi
          let id: String
          if let selected {
            uploaded = try await kit.uploadMessageDraftAttachments(accountRef: account, revision: selected.revision, attachmentIds: draftFiles.map(\.id), blossomServer: server, control: control)
            if control.isCancelled() { throw problem("MediaCancelled") }
            let metadata = draftFiles.enumerated().map { index, item in
              mediaMetadata(index, item.plaintextSize, item.durationSeconds, item.waveformSamples,
                item.id.split(separator: ":").last.map(String.init) ?? "file")
            }
            let accepted = try await kit.sendMessageDraftWithClientToken(accountRef: account, revision: selected.revision,
              attachments: uploaded.attachments.map(\.reference), tags: metadata, clientToken: token)
            id = accepted.messageIdHex
          } else {
            let result = try await kit.uploadMediaFilesWithClientToken(accountRef: account, groupIdHex: group, request: request, control: control, clientToken: token)
            guard let accepted = result.acceptance else { throw problem("MediaSendNotAccepted") }
            id = accepted.messageIdHex
            uploaded = result.upload
          }
          return ["id": id, "blobs": uploaded.attachments.compactMap { item -> Document? in
            guard let locator = item.reference.locators.first else { return nil }
            return ["url": locator.value, "hash": item.reference.ciphertextSha256, "size": Double(item.encryptedSizeBytes)]
          }]
        } catch MarmotKitError.Runtime(let details) {
          if control.isCancelled() { throw problem("MediaCancelled") }
          if details == "media upload timed out" || details.hasPrefix("blob store request failed: upload failed for all Blossom servers:") {
            throw problem("UploadEndpointFailed")
          }
          throw MarmotKitError.Runtime(details: details)
        }
      }
    }
    AsyncFunction("cancelUpload") { (token: String) -> Bool in
      self.uploadLock.withLock {
        guard let control = self.uploads[token] else { return false }
        control.cancel()
        return true
      }
    }
    AsyncFunction("audioMetadata") { (path: String) async throws -> Document in
      try await protocolCall {
        let home = URL(fileURLWithPath: NSHomeDirectory()).resolvingSymlinksInPath().path + "/"
        let file = URL(fileURLWithPath: path).resolvingSymlinksInPath()
        guard file.path.hasPrefix(home), try file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true else {
          throw problem("InvalidMediaPath")
        }
        let asset = AVURLAsset(url: file)
        var result: Document = [:]
        if let duration = try? await asset.load(.duration).seconds, duration.isFinite, duration > 0 {
          result["duration"] = duration
        }
        let metadata = (try? await asset.load(.commonMetadata)) ?? []
        let fields: [(String, AVMetadataIdentifier)] = [
          ("title", .commonIdentifierTitle), ("artist", .commonIdentifierArtist), ("album", .commonIdentifierAlbumName)
        ]
        for (key, identifier) in fields {
          if let item = AVMetadataItem.metadataItems(from: metadata, filteredByIdentifier: identifier).first,
            let value = try? await item.load(.stringValue), !value.isEmpty {
            result[key] = String(value.prefix(500))
          }
        }
        if let item = AVMetadataItem.metadataItems(from: metadata, filteredByIdentifier: .commonIdentifierArtwork).first,
          let data = try? await item.load(.dataValue), data.count <= 512 * 1024,
          let image = CGImageSourceCreateWithData(data as CFData, nil),
          let properties = CGImageSourceCopyPropertiesAtIndex(image, 0, nil) as? [CFString: Any],
          let width = properties[kCGImagePropertyPixelWidth] as? Int, (1...2048).contains(width),
          let height = properties[kCGImagePropertyPixelHeight] as? Int, (1...2048).contains(height),
          let type = CGImageSourceGetType(image) {
          let mime = type as String == "public.jpeg" ? "image/jpeg" : type as String == "public.png" ? "image/png" : nil
          if let mime { result["artworkUrl"] = "data:\(mime);base64,\(data.base64EncodedString())" }
        }
        return result
      }
    }
    AsyncFunction("inspectMediaFile") { (path: String, image: Bool, poster: Bool) async throws -> Document in
      try await protocolCall {
        let home = URL(fileURLWithPath: NSHomeDirectory()).resolvingSymlinksInPath().path + "/"
        let file = URL(fileURLWithPath: path).resolvingSymlinksInPath()
        guard file.path.hasPrefix(home), try file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true else {
          throw problem("InvalidMediaPath")
        }
        if image {
          let source = CGImageSourceCreateWithURL(file as CFURL, nil)
          let properties = source.flatMap { CGImageSourceCopyPropertiesAtIndex($0, 0, nil) } as? [CFString: Any]
          guard let width = properties?[kCGImagePropertyPixelWidth] as? Int,
            let height = properties?[kCGImagePropertyPixelHeight] as? Int, width > 0, height > 0 else { return [:] }
          let orientation = properties?[kCGImagePropertyOrientation] as? Int ?? 1
          return ["dimensions": (5...8).contains(orientation) ? "\(height)x\(width)" : "\(width)x\(height)"]
        }
        let asset = AVURLAsset(url: file)
        var result: Document = [:]
        if let duration = try? await asset.load(.duration).seconds, duration.isFinite, duration > 0 {
          result["duration"] = duration
        }
        if let track = try? await asset.loadTracks(withMediaType: .video).first,
          let size = try? await track.load(.naturalSize),
          let transform = try? await track.load(.preferredTransform) {
          let oriented = size.applying(transform)
          let width = abs(oriented.width), height = abs(oriented.height)
          if width.isFinite, height.isFinite, width >= 1, height >= 1, width < 65_536, height < 65_536 {
            result["dimensions"] = "\(Int(width.rounded()))x\(Int(height.rounded()))"
          }
        }
        guard poster else { return result }
        let generator = AVAssetImageGenerator(asset: asset)
        generator.maximumSize = CGSize(width: 144, height: 144)
        generator.appliesPreferredTrackTransform = true
        guard let thumbnail = try? await generator.image(at: .zero).image,
          let jpeg = UIImage(cgImage: thumbnail).jpegData(compressionQuality: 0.75) else { return result }
        let cache = try FileManager.default.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let output = cache.appendingPathComponent("marmot-poster-" + UUID().uuidString + ".jpg")
        try jpeg.write(to: output, options: [.atomic, .completeFileProtection])
        result["path"] = output.path
        return result
      }
    }
    AsyncFunction("retainedAttachmentBytes") { (group: String, id: String, source: String, index: UInt32) async throws -> Double? in
      try await self.withAccount { kit, account in
        let target = AttachmentLocalTargetFfi(messageIdHex: id, sourceMessageIdHex: source, attachmentIndex: index)
        let asset = try await kit.attachmentLocalAssets(accountRef: account, groupIdHex: group, targets: [target]).first
        guard let asset, asset.reference != nil else { return nil }
        return Double(asset.byteCount)
      }
    }
    AsyncFunction("attachmentTransferState") { (group: String, id: String, source: String, index: UInt32) async throws -> String? in
      try await self.withAccount { kit, account in
        let target = AttachmentLocalTargetFfi(messageIdHex: id, sourceMessageIdHex: source, attachmentIndex: index)
        return try await kit.attachmentTransferSnapshot(accountRef: account, groupIdHex: group, targets: [target]).items.first.map { wireName($0.state) }
      }
    }
    AsyncFunction("controlAttachment") { (group: String, id: String, source: String, index: UInt32, action: String) async throws -> Bool in
      try await self.withAccount { kit, account in
        let target = AttachmentLocalTargetFfi(messageIdHex: id, sourceMessageIdHex: source, attachmentIndex: index)
        guard let reference = try await kit.attachmentTransferSnapshot(accountRef: account, groupIdHex: group, targets: [target]).items.first?.reference else { return false }
        return try await kit.controlAttachment(accountRef: account, reference: reference, control: action == "remove" ? .remove : .cancel)
      }
    }
    Function("registerAttachmentTransfer") { (transfer: String) in
      self.attachmentLock.withLock {
        self.attachmentAdmissions[transfer] = AttachmentCancellation(
          admitted: self.isForeground,
          generation: self.foregroundGeneration
        )
      }
    }
    AsyncFunction("interruptAttachmentTransfer") { (group: String, id: String, source: String, index: UInt32, transfer: String) async throws in
      _ = (group, id, source, index)
      guard let attempt = self.attachmentLock.withLock({ self.attachmentAdmissions[transfer] }) else { return }
      await attempt.cancel()
    }
    AsyncFunction("downloadAttachment") { (group: String, id: String, source: String, index: UInt32, transfer: String) async throws -> String in
      let attempt = self.attachmentLock.withLock { self.attachmentAdmissions[transfer] }
      defer { _ = self.attachmentLock.withLock { self.attachmentAdmissions.removeValue(forKey: transfer) } }
      guard let attempt else { return "cancelled" }
      let foreground = self.attachmentLock.withLock { (self.isForeground, self.foregroundGeneration) }
      guard await attempt.start(isForeground: foreground.0, generation: foreground.1) else { return "cancelled" }
      return try await withAttachmentAttempt(attempt) {
        try await self.withAccount { kit, account in
        let target = AttachmentLocalTargetFfi(messageIdHex: id, sourceMessageIdHex: source, attachmentIndex: index)
        let before = try await kit.attachmentTransferSnapshot(accountRef: account, groupIdHex: group, targets: [target]).items.first
        let currentForeground = self.attachmentLock.withLock { (self.isForeground, self.foregroundGeneration) }
        guard await attempt.isAdmitted(isForeground: currentForeground.0, generation: currentForeground.1) else { return "cancelled" }
        let reference: String?
        switch before?.state {
        case .ready: return "ready"
        case .removed, .cleanedBySetting, .previouslyAcquiredUnavailable, .completedUnretained:
          reference = try await kit.downloadAttachmentAgain(accountRef: account, groupIdHex: group, target: target)
        case .failed, .retryExhausted, .cancelled, .storageBlocked, .paused:
          if let existing = before?.reference, try await kit.controlAttachment(accountRef: account, reference: existing, control: .retry) {
            reference = existing
          } else {
            reference = nil
          }
        case .queued, .downloading, .verifyingCiphertext, .decrypting, .verifyingPlaintext, .retryScheduled:
          reference = before?.reference
        default:
          reference = try await kit.requestExplicitAttachment(accountRef: account, groupIdHex: group, target: target)
        }
        guard let reference else { return before.map { wireName($0.state) } ?? "unavailable" }
        await attempt.installControl { _ = try? await kit.controlAttachment(accountRef: account, reference: reference, control: .cancel) }
        let foregroundAfterSnapshot = self.attachmentLock.withLock { (self.isForeground, self.foregroundGeneration) }
        guard await attempt.isAdmitted(isForeground: foregroundAfterSnapshot.0, generation: foregroundAfterSnapshot.1) else { return "cancelled" }
        var updates = try await kit.subscribeAttachmentTransfers(accountRef: account, groupIdHex: group, targets: [target])
        var lastProgress = before.map { "\(wireName($0.state)):\($0.received)" }
        var lastProgressAt = ProcessInfo.processInfo.systemUptime
        while true {
          let remaining = max(0.001, attachmentStallTimeout - (ProcessInfo.processInfo.systemUptime - lastProgressAt))
          let timedOut: Bool
          let snapshot: AttachmentTransferSnapshotFfi?
          do {
            (timedOut, snapshot) = try await nextAttachmentSnapshot(updates, timeout: remaining)
          } catch {
            await attempt.cancel()
            return "interrupted"
          }
          guard let item = snapshot?.items.first else {
            if timedOut {
              updates.cancel()
              let current = try await kit.attachmentTransferSnapshot(accountRef: account, groupIdHex: group, targets: [target]).items.first
              guard let current, current.reference == reference else {
                await attempt.cancel()
                return "interrupted"
              }
              let currentKey = "\(wireName(current.state)):\(current.received)"
              if currentKey != lastProgress {
                lastProgress = currentKey
                lastProgressAt = ProcessInfo.processInfo.systemUptime
                let currentState = wireName(current.state)
                self.sendEvent("attachmentProgress", ["transfer": transfer, "received": Double(current.received), "total": bridgeValue(current.total.map { Double($0) }), "state": currentState])
                switch current.state {
                case .ready, .failed, .unavailable, .policyBlocked, .removed, .previouslyAcquiredUnavailable,
                     .retryExhausted, .cancelled, .paused, .storageBlocked, .cleanedBySetting, .completedUnretained:
                  return currentState
                default: break
                }
                updates = try await kit.subscribeAttachmentTransfers(accountRef: account, groupIdHex: group, targets: [target])
                continue
              }
              await attempt.cancel()
              return "interrupted"
            }
            await attempt.cancel()
            return "interrupted"
          }
          guard item.reference == reference else { return "unavailable" }
          let state = wireName(item.state)
          let progress = "\(state):\(item.received)"
          if progress != lastProgress {
            lastProgress = progress
            lastProgressAt = ProcessInfo.processInfo.systemUptime
            self.sendEvent("attachmentProgress", ["transfer": transfer, "received": Double(item.received), "total": bridgeValue(item.total.map { Double($0) }), "state": state])
          }
          switch item.state {
          case .ready, .failed, .unavailable, .policyBlocked, .removed, .previouslyAcquiredUnavailable,
               .retryExhausted, .cancelled, .paused, .storageBlocked, .cleanedBySetting, .completedUnretained:
            return state
          default: break
          }
        }
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
    AsyncFunction("recentVoiceNotes") { (sender: String, since: UInt64, onlyOutgoing: Bool) async throws -> [Document] in
      try await self.withAccount { kit, account in
        let query = TimelineMessageQueryFfi(groupIdHex: nil, search: nil, sender: onlyOutgoing ? sender : nil, since: since, until: nil,
          attachmentType: 3, searchWallClock: false, cursorGroupId: nil, before: nil, beforeMessageId: nil,
          after: nil, afterMessageId: nil, limit: 24)
        let page = try kit.timelineMessages(accountRef: account, query: query)
        let sources = page.messages.filter { !$0.deleted && $0.invalidationStatus == nil }.flatMap { row -> [Document] in
          guard let source = row.sourceMessageIdHex else { return [] }
          return row.media.compactMap { outcome -> Document? in
            guard case .accepted(let index, let reference) = outcome, reference.version == .v2,
              reference.mediaType.hasPrefix("audio/") else { return nil }
            let matches = row.tags.filter { $0.values.count == 6 && $0.values[0] == "boop-media" &&
              $0.values[1] == String(index) && $0.values[5] == "voice" }
            guard matches.count == 1, let tag = matches.first?.values else { return nil }
            let target: [Any] = [row.groupIdHex, row.messageIdHex, source, Int(index)]
            return ["target": target,
              "hash": reference.plaintextSha256, "sender": row.sender, "incoming": row.sender != sender,
              "duration": bridgeValue(mediaDuration(tag[3])),
              "expiresAt": bridgeValue(row.retentionExpiresAt.map { Double($0) * 1000 }),
              "sentAt": Double(row.timelineAt)]
          }
        }
        return Array(sources.prefix(24))
      }
    }
    AsyncFunction("discardFailedSend") { (group: String, id: String) async throws -> String in
      try await self.withAccount {
        try await wireName($0.discardFailedSend(accountRef: $1, groupIdHex: group, messageIdHex: id).outcome)
      }
    }
    AsyncFunction("deleteMessage") { (group: String, id: String) async throws in
      try await self.withAccount { _ = try await $0.deleteMessage(accountRef: $1, groupIdHex: group, targetMessageId: id) }
    }
    AsyncFunction("reportMessage") { (group: String, id: String, spam: Bool) async throws in
      try await self.withAccount {
        _ = try await $0.reportMessage(accountRef: $1, groupIdHex: group, messageId: id, reason: spam ? .spam : .other, explanation: "")
      }
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
    AsyncFunction("watchBlockedUsers") { (owner: String, id: String) async throws in
      try await self.withObservation(id) {
        let stream = try await self.withSigner(owner, foreground: false) { try $0.subscribeBlockedUsers(accountRef: owner) }
        func emit(_ snapshot: BlockListSnapshotFfi) {
          self.sendEvent("blockedUsers", ["id": id, "rows": self.blockListDocument(snapshot)])
        }
        try Task.checkCancellation()
        guard let initial = stream.snapshot() else { throw problem("BlockListUnavailable") }
        emit(initial)
        while let snapshot = try await stream.nextCancellable() {
          try Task.checkCancellation()
          emit(snapshot)
        }
      }
    }
    AsyncFunction("setBlocked") { (owner: String, key: String, blocked: Bool) async throws -> Document in
      try await self.withSigner(owner) { kit in
        if blocked { try await kit.blockUser(accountRef: owner, userAccountIdHex: key) }
        else { try await kit.unblockUser(accountRef: owner, userAccountIdHex: key) }
        let stream = try kit.subscribeBlockedUsers(accountRef: owner)
        guard let snapshot = stream.snapshot() else { throw problem("BlockListUnavailable") }
        return self.blockListDocument(snapshot)
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
              "platform": device.platform, "client": device.client, "removalPending": device.removalPending]
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
    OnDestroy { Task { try? await self.closeAccount(closeRuntime: true) } }
  }

  private func closeAccount(closeRuntime: Bool = false, pauseMessaging: Bool = false) async throws {
    let work = directoryLock.withLock { () -> [Task<Void, Error>] in
      let work = observations.values.compactMap(\.task)
      observations.removeAll()
      return work
    }
    for task in work { task.cancel() }
    for task in work { _ = await task.result }
    uploadLock.withLock { uploads.values.forEach { $0.cancel() } }
    try await runtime.close(closeRuntime: closeRuntime, pauseMessaging: pauseMessaging) { [weak self] id in
      self?.sendEvent("windowClosed", ["id": id, "code": "AccountClosed"])
    }
  }

  private func uploadInputs(_ files: [[String: String]]) throws -> [MediaFileUploadAttachmentRequestFfi] {
    let base = URL(fileURLWithPath: NSHomeDirectory()).resolvingSymlinksInPath().path + "/"
    guard !files.isEmpty, files.count <= 16 else { throw problem("InvalidMedia") }
    return try files.map { file in
      guard let raw = file["path"], let name = file["name"], let type = file["type"] else { throw problem("InvalidMedia") }
      let path = URL(fileURLWithPath: raw).resolvingSymlinksInPath().path
      guard path.hasPrefix(base) else { throw problem("InvalidMediaPath") }
      let attributes = try FileManager.default.attributesOfItem(atPath: path)
      guard let size = attributes[.size] as? NSNumber, attributes[.type] as? FileAttributeType == .typeRegular else { throw problem("InvalidMediaPath") }
      return MediaFileUploadAttachmentRequestFfi(sourcePath: path, expectedSize: size.uint64Value, fileName: name,
        mediaType: type, dim: file["dimensions"], thumbhash: file["thumbhash"])
    }
  }

  private func withObservation(_ id: String, work: @escaping () async throws -> Void) async throws {
    let task = directoryLock.withLock { () -> Task<Void, Error>? in
      guard var observation = observations[id], observation.task == nil else { return nil }
      let task = Task { try await work() }
      observation.task = task
      observations[id] = observation
      return task
    }
    guard let task else { throw problem("AccountClosed") }
    defer { _ = directoryLock.withLock { observations.removeValue(forKey: id) } }
    try await task.value
  }

  private func blockListDocument(_ snapshot: BlockListSnapshotFfi) -> Document {
    ["revision": String(snapshot.revision), "keys": snapshot.users.map { $0.publicKey }]
  }

  private func withSigner<T>(_ key: String, foreground: Bool = true, _ call: (Marmot) async throws -> T) async throws -> T {
    try await protocolCall {
      guard !foreground || attachmentLock.withLock({ isForeground }) else { throw problem("AccountClosed") }
      let kit = try await runtime.beginSignerCall(key)
      do {
        let result = try await call(kit)
        await runtime.endCall()
        return result
      } catch {
        await runtime.endCall()
        throw error
      }
    }
  }

  private func withAccount<T>(_ call: (Marmot, String) async throws -> T) async throws -> T {
    try await protocolCall {
      let account = try await runtime.beginAccountCall()
      do {
        let result = try await call(account.kit, account.key)
        await runtime.endCall()
        return result
      } catch {
        await runtime.endCall()
        throw error
      }
    }
  }
}

private func nextAttachmentSnapshot(
  _ updates: AttachmentTransferSubscription,
  timeout: TimeInterval
) async throws -> (timedOut: Bool, snapshot: AttachmentTransferSnapshotFfi?) {
  try await withThrowingTaskGroup(of: (Bool, AttachmentTransferSnapshotFfi?).self) { group in
    group.addTask { (false, try await updates.next()) }
    group.addTask {
      try await Task.sleep(for: .seconds(timeout))
      return (true, nil)
    }
    guard let first = try await group.next() else { return (true, nil) }
    if first.0 { updates.cancel() }
    group.cancelAll()
    return (first.0, first.1)
  }
}

private func withAttachmentAttempt<T>(
  _ attempt: AttachmentCancellation,
  operation: () async throws -> T
) async rethrows -> T {
  do {
    let result = try await operation()
    await attempt.finish()
    return result
  } catch {
    await attempt.finish()
    throw error
  }
}

private struct AttachmentCancelControl: @unchecked Sendable {
  let run: () async -> Void
}

private func retryDraftEdit(_ edit: () throws -> Void) throws {
  for attempt in 0..<3 {
    do {
      try edit()
      return
    } catch MarmotKitError.MessageDraftRevisionConflict where attempt < 2 {
      continue
    }
  }
}

private actor AttachmentCancellation {
  private let admittedAtRegistration: Bool
  private let generationAtRegistration: UInt64
  private var started = false
  private var cancelled = false
  private var finished = false
  private var control: AttachmentCancelControl?
  private var controlWaiter: CheckedContinuation<AttachmentCancelControl?, Never>?
  private var cancellationTask: Task<Void, Never>?

  init(admitted: Bool, generation: UInt64) {
    admittedAtRegistration = admitted
    generationAtRegistration = generation
  }

  func start(isForeground: Bool, generation: UInt64) -> Bool {
    guard admittedAtRegistration, isForeground, generation == generationAtRegistration,
          !cancelled, !finished else { return false }
    started = true
    return true
  }

  func isAdmitted(isForeground: Bool, generation: UInt64) -> Bool {
    admittedAtRegistration && isForeground && generation == generationAtRegistration && !cancelled && !finished
  }

  func installControl(_ operation: @escaping () async -> Void) async {
    let installed = AttachmentCancelControl(run: operation)
    control = installed
    controlWaiter?.resume(returning: installed)
    controlWaiter = nil
    if let cancellationTask { await cancellationTask.value }
  }

  func cancel() async {
    guard !finished else { return }
    cancelled = true
    guard started else {
      finished = true
      return
    }
    if cancellationTask == nil {
      cancellationTask = Task { [weak self] in
        guard let operation = await self?.waitForControl() else { return }
        await operation.run()
      }
    }
    if let cancellationTask { await cancellationTask.value }
  }

  func finish() async {
    finished = true
    controlWaiter?.resume(returning: nil)
    controlWaiter = nil
    if let cancellationTask { await cancellationTask.value }
  }

  private func waitForControl() async -> AttachmentCancelControl? {
    if let control { return control }
    if finished { return nil }
    return await withCheckedContinuation { controlWaiter = $0 }
  }
}

private let maxGroupImage = 4 * 1024 * 1024

private func searchResultDocument(_ row: UserDirectorySearchResultFfi) -> Document {
  ["key": row.accountIdHex, "profile": bridgeValue(row.profile.map { profileDocument(row.accountIdHex, $0, nil, false) })]
}

private func profileDocument(_ key: String, _ profile: UserProfileMetadataFfi, _ website: String?, _ bot: Bool) -> Document {
  var result: Document = ["key": key, "bot": bot]
  result["name"] = profile.name
  result["displayName"] = profile.displayName
  result["about"] = profile.about
  result["picture"] = profile.picture
  result["banner"] = profile.banner
  result["nip05"] = profile.nip05
  result["lud16"] = profile.lud16
  result["website"] = website
  return result
}

private func groupImageInput(_ path: String) throws -> Data {
  let home = URL(fileURLWithPath: NSHomeDirectory()).resolvingSymlinksInPath().path + "/"
  let file = URL(fileURLWithPath: path).resolvingSymlinksInPath()
  let values = try file.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
  guard file.path.hasPrefix(home), values.isRegularFile == true, let size = values.fileSize, (1...maxGroupImage).contains(size) else {
    throw problem("InvalidMediaPath")
  }
  let input = try FileHandle(forReadingFrom: file)
  defer { try? input.close() }
  let bytes = try input.read(upToCount: maxGroupImage + 1) ?? Data()
  guard (1...maxGroupImage).contains(bytes.count) else { throw problem("InvalidMedia") }
  return bytes
}

private actor Runtime {
  struct Account {
    let generation = UUID()
    let key: String
    let kit: Marmot
  }

  private struct Configuration: Equatable {
    let general: [String]
    let discovery: [String]
    let origin: String?
  }

  private var kit: Marmot?
  private var identityImport: (token: String, prepared: PreparedIdentityImport)?
  private var cancelledImport: String?
  private var configuration: Configuration?
  private var started = false
  private var activeCalls = 0
  private var drained: CheckedContinuation<Void, Never>?
  private var active: Account?
  private var signerAccount: String?
  private var changingAccount = false
  private var transitionWaiters: [CheckedContinuation<Void, Never>] = []
  private var windows: [String: NativeWindow] = [:]
  private var latestWindows: [String: Document] = [:]
  private var observers: [String: Task<Void, Never>] = [:]

  func account() throws -> Account {
    guard let active, !changingAccount else { throw problem("AccountClosed") }
    return active
  }

  func beginAccountCall() throws -> Account {
    let current = try account()
    activeCalls += 1
    return current
  }

  func selectSigner(_ key: String) throws -> Document {
    guard signerAccount == nil || signerAccount == key else { throw problem("AccountBusy") }
    let kit = try existingRuntime()
    guard try availableSigner(kit, key) else { throw problem("AccountSignedOut") }
    _ = try kit.localAccountKeyPackages(accountRef: key)
    let profile = try kit.userProfile(accountIdHex: key)
    signerAccount = key
    return ["name": bridgeValue(profile?.displayName ?? profile?.name), "about": bridgeValue(profile?.about)]
  }

  private func availableSigner(_ kit: Marmot, _ key: String) throws -> Bool {
    try kit.listAccounts().contains { $0.accountIdHex == key && $0.localSigning && !$0.signedOut && !$0.unlinked }
  }

  func beginSignerCall(_ key: String) throws -> Marmot {
    guard signerAccount == key else { throw problem("AccountClosed") }
    let kit = try existingRuntime()
    activeCalls += 1
    return kit
  }

  func endCall() {
    activeCalls -= 1
    if activeCalls == 0 {
      drained?.resume()
      drained = nil
    }
  }

  private func existingRuntime() throws -> Marmot {
    guard !changingAccount, let kit else { throw problem("AccountClosed") }
    return kit
  }

  private func stopRuntime() async throws {
    discardImport()
    let current = kit
    kit = nil
    configuration = nil
    started = false
    try await current?.shutdownAndClose()
  }

  // The caller owns changingAccount across construction and use.
  private func prepare(_ next: Configuration, start: Bool = true) async throws -> Marmot {
    if let kit, configuration == next {
      if start && !started { try await startRuntime(kit) }
      return kit
    }
    guard active == nil else { throw problem("AccountBusy") }
    if activeCalls > 0 { await withCheckedContinuation { drained = $0 } }
    try await stopRuntime()
    let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    var root = base.appendingPathComponent("marmot-accounts", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    var resources = URLResourceValues()
    resources.isExcludedFromBackup = true
    try root.setResourceValues(resources)
    var deployment = marmotDeploymentNeutral()
    deployment.keychainService = "app.boop.accounts"
    deployment.discoveryIndexerRelays = next.discovery
    deployment.groupImageEndpoint = next.origin
    deployment.newGroupMediaEndpoints = next.origin.map { [$0] } ?? []
    var seen = Set<String>()
    let relays = (next.general + next.discovery).filter { seen.insert($0).inserted }
    let opened = try Marmot.newWithConfiguration(rootPath: root.resolvingSymlinksInPath().path, relayUrls: relays, options: MarmotOptions(
      clientName: "Boop", devicePlatform: "iOS", attachmentAcquisitionMode: .hostManaged,
      acquirePublicAvatars: false, deployment: deployment
    ))
    kit = opened
    configuration = next
    if start { try await startRuntime(opened) }
    return opened
  }

  private func startRuntime(_ kit: Marmot) async throws {
    if started { return }
    do {
      try await kit.start()
      started = true
    } catch {
      let previous = configuration
      try? await stopRuntime()
      if signerAccount != nil, let previous { _ = try? await prepare(previous, start: false) }
      throw error
    }
  }

  func listAccounts(general: [String], discovery: [String], origin: String?) async throws -> [Document] {
    guard !changingAccount else { throw problem("AccountBusy") }
    changingAccount = true
    defer { endTransition() }
    let kit = try await prepare(Configuration(general: general, discovery: discovery, origin: origin), start: false)
    return try kit.listAccounts().filter { $0.localSigning }.map {
      let key = $0.accountIdHex
      let readiness = try kit.onboardingRecoveryRequired(accountRef: key)
        ? "recovery_required" : wireName(kit.accountSetupReadiness(accountRef: key))
      return ["key": key, "signedOut": $0.signedOut, "unlinked": $0.unlinked, "readiness": readiness]
    }
  }

  func prepareImport(token: String, input: String, password: String) async throws -> String {
    let kit = try existingRuntime()
    changingAccount = true
    defer { endTransition() }
    identityImport = nil
    cancelledImport = nil
    let prepared = try await kit.prepareIdentityImport(input: input, password: password)
    guard cancelledImport != token else { throw problem("IdentityImportExpired") }
    identityImport = (token, prepared)
    return prepared.publicKey()
  }

  func discardImport(token: String? = nil) {
    if let token {
      cancelledImport = token
      if identityImport?.token != token { return }
    }
    identityImport = nil
  }

  func install(token: String?, name: String?, about: String?, general: [String], inbox: [String], discovery: [String]) async throws -> String {
    guard !changingAccount else { throw problem("AccountBusy") }
    changingAccount = true
    defer { endTransition() }
    let current: Marmot
    if let configuration { current = try await prepare(configuration) }
    else { current = try await prepare(Configuration(general: general, discovery: discovery, origin: nil)) }
    if let token {
      guard let candidate = identityImport, candidate.token == token else { throw problem("IdentityImportExpired") }
      identityImport = nil
      return try await current.beginPreparedOnboarding(identity: candidate.prepared, options: OnboardingOptionsFfi(defaultRelays: general, discoveryRelays: discovery, inboxRelays: inbox)).accountIdHex
    }
    let profile = UserProfileMetadataFfi(name: name, displayName: name, about: about, picture: nil, banner: nil, nip05: nil, lud16: nil)
    return try await current.createIdentityWithInitialProfile(profile: profile, defaultRelays: general, bootstrapRelays: general, inboxRelays: inbox).account.accountIdHex
  }

  func onboarding(key: String, action: String, step: String?, revision: String?, epoch: String?) async throws -> Document? {
    let kit = try existingRuntime()
    changingAccount = true
    defer { endTransition() }
    if action != "read" { try await startRuntime(kit) }
    func selectedStep() throws -> OnboardingStepFfi {
      switch step {
      case "profile": return .profile
      case "follows": return .follows
      case "relays": return .relays
      case "inbox_relays": return .inboxRelays
      case "single_device": return .singleDevice
      case "key_package": return .keyPackage
      default: throw problem("InvalidOnboardingStep")
      }
    }
    let snapshot: OnboardingSnapshotFfi?
    switch action {
    case "read": snapshot = try kit.onboardingSnapshot(accountRef: key)
    case "run": snapshot = try await kit.runOnboarding(accountRef: key)
    case "retry": snapshot = try await kit.retryOnboardingStep(accountRef: key, step: selectedStep())
    case "skip": snapshot = try await kit.continueOnboardingWithout(accountRef: key, step: selectedStep())
    case "propose": snapshot = try await kit.proposeOnboardingRecommendedRelays(accountRef: key, step: selectedStep())
    case "approve", "acknowledge":
      guard let revision, let displayed = UInt64(revision) else { throw problem("InvalidOnboardingRevision") }
      if action == "approve" {
        if let epoch { snapshot = try await kit.approveOnboardingRepairInEpoch(accountRef: key, revision: displayed, recoveryEpoch: epoch) }
        else { snapshot = try await kit.approveOnboardingRepair(accountRef: key, revision: displayed) }
      } else {
        if let epoch { snapshot = try await kit.acknowledgeOnboardingSingleDeviceInEpoch(accountRef: key, revision: displayed, recoveryEpoch: epoch) }
        else { snapshot = try await kit.acknowledgeOnboardingSingleDevice(accountRef: key, revision: displayed) }
      }
    case "cancelRepair": snapshot = try await kit.cancelOnboardingRepair(accountRef: key)
    case "recover":
      _ = try await kit.recoverOnboarding(accountRef: key, acknowledgeLatestOnlyEvidence: true)
      return nil
    case "cancel":
      try await kit.cancelOnboarding(accountRef: key)
      return nil
    default: throw problem("InvalidOnboardingAction")
    }
    guard let snapshot else { return nil }
    let proposal: Document? = snapshot.proposal.map {
      ["read": $0.readRelays, "write": $0.writeRelays, "inconclusive": $0.inconclusive]
    }
    let notice: Document? = snapshot.singleDeviceNotice.map {
      ["discovery": wireName($0.discovery), "complete": $0.discoveryComplete]
    }
    return ["ready": snapshot.ready, "revision": String(snapshot.revision), "epoch": bridgeValue(snapshot.recoveryEpoch),
      "proposal": bridgeValue(proposal), "deviceNotice": bridgeValue(notice),
      "steps": snapshot.steps.map { ["step": wireName($0.step), "status": wireName($0.status), "actions": $0.actions.map { wireName($0) }] }]
  }

  func remove(_ key: String) async throws {
    let kit = try existingRuntime()
    guard active?.key != key && signerAccount != key else { throw problem("AccountBusy") }
    changingAccount = true
    defer { endTransition() }
    if activeCalls > 0 { await withCheckedContinuation { drained = $0 } }
    try await kit.removeAccount(accountRef: key)
  }

  func resumeSetup() async throws {
    let kit = try existingRuntime()
    changingAccount = true
    defer { endTransition() }
    try await startRuntime(kit)
  }

  func signOut(_ key: String) async throws {
    let kit = try existingRuntime()
    guard active?.key != key else { throw problem("AccountBusy") }
    changingAccount = true
    defer { endTransition() }
    if activeCalls > 0 { await withCheckedContinuation { drained = $0 } }
    _ = try await kit.signOut(accountRef: key, deleteKeyPackages: false)
  }

  func signIn(_ key: String) async throws {
    let kit = try existingRuntime()
    changingAccount = true
    defer { endTransition() }
    _ = try await kit.signInAccount(accountRef: key)
  }

  func open(key: String, general: [String], discovery: [String], mediaOrigin: String?) async throws -> String {
    guard !changingAccount else { throw problem("AccountBusy") }
    changingAccount = true
    defer { endTransition() }
    guard signerAccount == key else { throw problem("IdentityMismatch") }
    let kit = try await prepare(Configuration(general: general, discovery: discovery, origin: mediaOrigin))
    guard let known = try kit.listAccounts().first(where: { $0.accountIdHex == key && $0.localSigning }) else { throw problem("IdentityMismatch") }
    guard !known.unlinked && !known.signedOut else { throw problem("AccountSignedOut") }
    guard active == nil || active?.key == key else { throw problem("IdentityMismatch") }
    let readiness = try wireName(kit.accountSetupReadiness(accountRef: key))
    active = Account(key: key, kit: kit)
    return readiness
  }

  private func endTransition() {
    changingAccount = false
    let waiters = transitionWaiters
    transitionWaiters.removeAll()
    waiters.forEach { $0.resume() }
  }

  func close(closeRuntime: Bool, pauseMessaging: Bool, notify: (String) -> Void) async throws {
    while changingAccount { await withCheckedContinuation { transitionWaiters.append($0) } }
    changingAccount = true
    defer { endTransition() }
    active = nil
    for id in Array(windows.keys) {
      await closeWindow(id)
      notify(id)
    }
    if activeCalls > 0 { await withCheckedContinuation { drained = $0 } }
    if closeRuntime {
      signerAccount = nil
      try await stopRuntime()
    } else if pauseMessaging, started, let configuration {
      try await stopRuntime()
      _ = try await prepare(configuration, start: false)
    }
  }

  func window(_ id: String) throws -> NativeWindow {
    guard let window = windows[id] else { throw problem("WindowClosed") }
    return window
  }

  func openChatList(id: String, view: String, invitations: Bool, search: String?) async throws -> Document {
    let account = try account()
    let views: [String: ChatListViewFfi] = ["chats": .chats, "archived": .archived, "left": .left, "unread": .unread]
    guard let selected = views[view] else { throw problem("InvalidView") }
    let pending = ChatListFilterNodeFfi.condition(condition: .pendingInvite)
    let filter: [ChatListFilterNodeFfi]
    if invitations { filter = [pending] }
    else if let search { filter = [.all(children: [1, 2]), .not(child: 3), .text(text: search), pending] }
    else { filter = [.not(child: 1), pending] }
    let handle = try await account.kit.openChatListQueryWindow(accountRef: account.key, query: ChatListViewQueryFfi(view: selected, filter: filter), initialRows: 40)
    return try await install(.chatList(handle), id: id, account: account)
  }

  func openAttention(id: String) async throws -> Document {
    let account = try account()
    let handle = try await account.kit.subscribeAccountAttention()
    return try await install(.attention(handle, account.key), id: id, account: account)
  }
  func openGroupState(id: String, group: String, roster: Bool) async throws -> Document {
    let account = try account()
    let handle = try await account.kit.subscribeGroupState(accountRef: account.key, groupIdHex: group)
    let read: @Sendable () async throws -> Document = {
      if roster { return try await rosterDocument(account.kit, account.key, group) }
      return try await groupDocument(account.kit, account.key, group)
    }
    let details = try await read()
    return try await install(.groupState(GroupStateWindow(generation: id, handle: handle, details: details, kind: roster ? "groupRoster" : "groupState", read: read)), id: id, account: account)
  }

  func openGroupCall(id: String, group: String) async throws -> Document {
    let account = try account()
    let kinds: [UInt64] = [24884]
    let handle = try await account.kit.subscribeMessages(accountRef: account.key, groupIdHex: group, limit: 64, kinds: kinds)
    let window = GroupCallWindow(generation: id, handle: handle) {
      try account.kit.messages(accountRef: account.key, groupIdHex: group, limit: 64, kinds: kinds)
    }
    return try await install(.groupCall(window), id: id, account: account)
  }

  func openConversation(id: String, group: String, target: String?, speculative: Bool) async throws -> Document {
    let account = try beginAccountCall()
    let started = ProcessInfo.processInfo.systemUptime
    let rows: UInt32 = speculative ? 56 : target == nil ? 100 : 40
    do {
      let handle = try await account.kit.openConversationWindow(
        accountRef: account.key,
        groupIdHex: group,
        mode: target != nil ? .message : speculative ? .latest : .automatic,
        messageIdHex: target,
        initialRows: rows,
        timeoutMs: speculative ? 1_500 : 0
      )
      let snapshot = try await install(.conversation(handle), id: id, account: account)
      #if DEBUG
      NSLog("[BoopMarmot] conversation_open elapsedMs=%d speculative=%@ rows=%u ok=true",
            Int((ProcessInfo.processInfo.systemUptime - started) * 1_000), String(speculative), rows)
      #endif
      endCall()
      return snapshot
    } catch {
      #if DEBUG
      NSLog("[BoopMarmot] conversation_open elapsedMs=%d speculative=%@ rows=%u ok=false",
            Int((ProcessInfo.processInfo.systemUptime - started) * 1_000), String(speculative), rows)
      #endif
      endCall()
      throw error
    }
  }

  private func install(_ window: NativeWindow, id: String, account: Account) async throws -> Document {
    guard active?.generation == account.generation else {
      await window.cancel()
      throw problem("AccountClosed")
    }
    guard windows[id] == nil, windows.count < 16 else {
      await window.cancel()
      throw problem("WindowLimit")
    }
    guard let initial = window.initial() else {
      await window.cancel()
      throw problem("WindowClosed")
    }
    latestWindows[id] = initial
    windows[id] = window
    return initial
  }

  func windowSnapshot(_ id: String) throws -> Document {
    guard let latest = latestWindows[id] else { throw problem("WindowClosed") }
    return latest
  }

  func observe(id: String, notify: @escaping (String, Document) -> Void) throws {
    let window = try window(id)
    guard observers[id] == nil else { return }
    observers[id] = Task {
      do {
        while !Task.isCancelled, let snapshot = try await window.next() {
          guard !Task.isCancelled else { return }
          let previous = latestWindows.updateValue(snapshot, forKey: id)
          if let previous, let delta = windowDelta(previous, snapshot) {
            notify("windowChanged", ["id": id, "delta": delta])
          } else {
            notify("windowChanged", ["id": id, "snapshot": snapshot])
          }
        }
        if !Task.isCancelled { notify("windowClosed", ["id": id, "code": "WindowClosed"]) }
      } catch {
        if !Task.isCancelled { notify("windowClosed", ["id": id, "code": errorCode(error)]) }
      }
    }
  }

  func closeWindow(_ id: String) async {
    latestWindows.removeValue(forKey: id)
    let handle = windows.removeValue(forKey: id)
    let observer = observers.removeValue(forKey: id)
    observer?.cancel()
    await handle?.cancel()
    await observer?.value
  }
}

func problem(_ code: String) -> Exception {
  Exception(name: code, description: code, code: code)
}

private func errorCode(_ error: Error) -> String {
  if let error = error as? Exception { return error.code }
  if let error = error as? MarmotKitError {
    if case .InvalidIdentity(let details) = error, details == "identity backup exceeds the supported scrypt cost" {
      return "BackupCost"
    }
    if case .Runtime(let details) = error, details == "device group refused: device_link_pending" {
      return "DeviceLinkPending"
    }
    if let label = Mirror(reflecting: error).children.first?.label { return label }
    let name = String(describing: error).prefix { $0.isLetter || $0.isNumber || $0 == "_" }
    return name.isEmpty ? "MarmotFailure" : String(name)
  }
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
