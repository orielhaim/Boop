import AVFoundation
import BoopSocial
import ExpoModulesCore
import Foundation
import ImageIO
import UIKit

private let attachmentStallTimeout: TimeInterval = 180

public final class BoopMarmotModule: Module {
  private let runtime = Runtime()
  private let socialOwnerLock = NSLock()
  private var storedSocialOwner: SocialNativeOwner?
  private var draftStages: Set<String> = [] // Guarded by uploadLock.
  private let uploadLock = NSLock()
  private let attachmentLock = NSLock()
  private let directoryLock = NSLock()
  private let historyLock = NSLock()
  private var accountAttachmentHistoryCursors: [String: (scope: String, cursor: AccountAttachmentCursor)] = [:]
  private enum SharedMediaCursor {
    case group(AttachmentHistoryCursor)
    case account(AccountAttachmentCursor)
  }
  private enum SharedMediaRead {
    case group(AttachmentPageReadFfi)
    case account(AccountAttachmentPageReadFfi)
  }
  private enum SharedMediaVersion {
    case group(String, AttachmentHistoryVersion)
    case account(AccountAttachmentVersion)
  }
  private var sharedMediaCursors: [String: (scope: String, cursor: SharedMediaCursor)] = [:]
  private var sharedMediaVersions: [String: (scope: String, version: SharedMediaVersion)] = [:]
  private let securityObservationLock = NSLock()
  private var securityObservations: [String: (account: String, events: EventsSubscription, task: Task<Void, Never>)] = [:]
  private struct Observation {
    let accountScoped: Bool
    var task: Task<Void, Error>?
  }
  private var observations: [String: Observation] = [:]
  private var attachmentAdmissions: [String: AttachmentCancellation] = [:]
  private var isForeground = true
  private var foregroundGeneration: UInt64 = 0

  private func timelineRowsAt(
    kit: Marmot,
    account: String,
    group: String,
    at: UInt64,
    targetIds: Set<String>,
    attachmentType: UInt32,
    search: String? = nil
  ) throws -> [String: TimelineMessageRecordFfi] {
    var found: [String: TimelineMessageRecordFfi] = [:]
    var before: UInt64?
    var beforeId: String?
    var pages = 0
    let exclusiveEnd = at < UInt64(Int64.max) ? at + 1 : nil
    while found.count < targetIds.count && pages < 4 {
      let query = TimelineMessageQueryFfi(groupIdHex: group, search: search, sender: nil,
        since: at, until: exclusiveEnd, attachmentType: attachmentType, searchWallClock: false,
        cursorGroupId: before == nil ? nil : group, before: before, beforeMessageId: beforeId,
        after: nil, afterMessageId: nil, limit: 200)
      let page = try kit.timelineMessages(accountRef: account, query: query)
      for row in page.messages where targetIds.contains(row.messageIdHex) { found[row.messageIdHex] = row }
      pages += 1
      guard page.hasMoreBefore, let oldest = page.messages.first else { break }
      before = oldest.timelineAt
      beforeId = oldest.messageIdHex
    }
    return found
  }

  private func historyTimestamp(_ value: Double?) throws -> UInt64? {
    guard let value else { return nil }
    guard value.isFinite, value >= 0, value.rounded(.towardZero) == value,
      let timestamp = UInt64(exactly: value) else { throw problem("InvalidHistoryRange") }
    return timestamp
  }

  private var uploads: [String: MediaFileTransferControlFfi] = [:]

  public func definition() -> ModuleDefinition {
    Name("BoopMarmot")
    Events("windowChanged", "windowClosed", "attachmentProgress", "directorySearchResults", "relayLiveness", "blockedUsers", "backupRestore", "accountSecurityEvent")
    OnAppEntersBackground {
      self.directoryLock.withLock { self.observations.values.filter { !$0.accountScoped }.forEach { $0.task?.cancel() } }
      let (pending, generation) = self.attachmentLock.withLock { () -> ([AttachmentCancellation], UInt64) in
        self.isForeground = false
        self.foregroundGeneration &+= 1
        return (Array(self.attachmentAdmissions.values), self.foregroundGeneration)
      }
      Task { try? await self.existingSocialHost()?.setForeground(false, generation: generation) }
      Task {
        await self.runtime.discardImport()
        for attempt in pending { await attempt.cancel() }
      }
    }
    OnAppBecomesActive {
      let generation = self.attachmentLock.withLock {
        self.isForeground = true
        self.foregroundGeneration &+= 1
        return self.foregroundGeneration
      }
      Task { try? await self.existingSocialHost()?.setForeground(true, generation: generation) }
    }

    AsyncFunction("listAccounts") { (general: [String], discovery: [String], origin: String?) async throws -> [Document] in
      try await protocolCall { try await self.runtime.listAccounts(general: general, discovery: discovery, origin: origin) }
    }
    AsyncFunction("startAccountSecurityEvents") { (subscriptionId: String, account: String) async throws in
      try await self.startAccountSecurityEvents(subscriptionId, account)
    }
    AsyncFunction("stopAccountSecurityEvents") { (subscriptionId: String) async in
      await self.stopAccountSecurityEvents(subscriptionId)
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
          if !rows.isEmpty {
            try await self.withSigner(owner) { _ in () }
            self.sendEvent("directorySearchResults", ["id": id, "rows": rows])
          }
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
      try await protocolCall {
        await self.existingSocialHost()?.retire(account: key)
        try await self.runtime.remove(key)
        try await self.cleanupSocialAccount(key)
      }
    }
    AsyncFunction("signOutAccount") { (key: String, deleteKeyPackages: Bool) async throws -> Document in
      try await protocolCall {
        await self.existingSocialHost()?.retire(account: key)
        let outcome = try await self.runtime.signOut(key, deleteKeyPackages: deleteKeyPackages)
        await self.stopAccountSecurityEvents(for: key)
        return signOutOutcomeWire(outcome)
      }
    }
    AsyncFunction("signOutAndWipeAccount") { (key: String) async throws -> Document in
      try await protocolCall {
        await self.existingSocialHost()?.retire(account: key)
        let outcome = try await self.runtime.signOutAndWipe(key)
        let socialCleanup: Document
        if outcome.localCleanup.completed {
          do {
            try await self.cleanupSocialAccount(key)
            socialCleanup = ["completed": true, "reason": NSNull()]
          } catch {
            socialCleanup = ["completed": false, "reason": "SocialCleanupFailedAfterAccountRemoval"]
          }
        } else {
          socialCleanup = ["completed": false, "reason": "MarmotCleanupIncomplete"]
        }
        await self.stopAccountSecurityEvents(for: key)
        var wire = wipeOutcomeWire(outcome)
        wire["socialCleanup"] = socialCleanup
        return wire
      }
    }
    AsyncFunction("resumeAccountSetup") { () async throws in
      try await protocolCall { try await self.runtime.resumeSetup() }
    }
    AsyncFunction("signInAccount") { (key: String) async throws in
      try await protocolCall { try await self.runtime.signIn(key) }
    }
    AsyncFunction("releaseSignerAccount") { (key: String) async throws in
      try await protocolCall {
        await self.existingSocialHost()?.retire(account: key)
        try await self.runtime.releaseSigner(key)
      }
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
        func emit(_ rows: [RelayLivenessFfi]) async throws {
          try await self.withSigner(key) { _ in () }
          self.sendEvent("relayLiveness", ["id": id, "rows": rows.map { row -> Document in
            ["url": row.url, "status": wireName(row.status), "lastError": bridgeValue(row.lastError),
             "lastAttempt": bridgeValue(row.lastAttemptUnix.map { Double($0) })]
          }])
        }
        try Task.checkCancellation()
        try await emit(stream.snapshot())
        while let rows = try await withTaskCancellationHandler(operation: { try await stream.next() }, onCancel: { stream.cancel() }) {
          try Task.checkCancellation()
          try await emit(rows)
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
    AsyncFunction("watchBackupRestore") { (owner: String, id: String) async throws in
      try await self.withObservation(id) {
        let stream = try await self.withSigner(owner, foreground: false) {
          try await $0.watchBackupRestore(accountRef: owner)
        }
        func emit(_ restore: BackupRestoreStatusFfi) async throws {
          try Task.checkCancellation()
          let settings = try await self.withSigner(owner, foreground: false) {
            try await $0.backupSettings(accountRef: owner)
          }
          self.sendEvent("backupRestore", ["id": id, "rows": [
            "enabled": settings.enabled,
            "thisDeviceWrites": settings.thisDeviceWrites,
            "phase": wireName(restore.phase),
            "operation": bridgeValue(restore.operation),
            "imported": Double(restore.importedEvents),
            "failed": Double(restore.failedArchives) + Double(restore.failedBundles),
          ]])
        }
        try Task.checkCancellation()
        guard let initial = stream.snapshot() else { throw problem("BackupRestoreUnavailable") }
        try await emit(initial)
        while let status = try await stream.nextCancellable() {
          try Task.checkCancellation()
          try await emit(status)
        }
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
        try await self.runtime.pageWindow(id, generation: generation, sequence: sequence, direction: direction)
      }
    }
    AsyncFunction("anchorWindow") { (id: String, generation: String, sequence: String, target: String) async throws -> Document in
      try await protocolCall {
        try await self.runtime.anchorWindow(id, generation: generation, sequence: sequence, target: target)
      }
    }
    AsyncFunction("jumpToMessage") { (id: String, generation: String, sequence: String, target: String) async throws -> Document in
      try await protocolCall {
        try await self.runtime.jumpToMessage(id, generation: generation, sequence: sequence, target: target)
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
    AsyncFunction("searchConversation") { (group: String, text: String?) async throws -> Document in
      try await self.withAccount { kit, account in
        let query = TimelineMessageQueryFfi(groupIdHex: group, search: text, sender: nil, since: nil, until: nil, attachmentType: 0, cursorGroupId: nil, before: nil, beforeMessageId: nil, after: nil, afterMessageId: nil, limit: 40)
        let rows: [Document] = try kit.timelineMessages(accountRef: account, query: query).messages.filter { !$0.deleted }.map {
          ["id": $0.messageIdHex, "sender": $0.sender, "text": $0.plaintext, "sentAt": Double($0.timelineAt)]
        }
        return ["rows": rows, "next": NSNull()]
      }
    }
    AsyncFunction("releaseAttachmentHistoryCursor") { (token: String) in
      self.historyLock.withLock {
        _ = self.accountAttachmentHistoryCursors.removeValue(forKey: token)
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
          return try await kit.replyToMessageWithClientToken(accountRef: account, groupIdHex: group,
            targetMessageId: reply, text: text, clientToken: token).messageIdHex
        }
        return try await kit.sendTextWithClientToken(accountRef: account, groupIdHex: group,
          text: text, clientToken: token).messageIdHex
      }
    }
    AsyncFunction("sendDraftText") { (group: String, text: String, token: String, reply: String?) async throws -> String in
      try await self.withAccount { kit, account in
        switch try kit.localSendStatus(accountRef: account, groupIdHex: group, clientToken: token) {
        case .completed(let summary): return summary.messageIds.first ?? ""
        case .queued, .engineOwned: return ""
        case .rejected: throw problem("MessageSendNotAccepted")
        case nil: break
        }
        for attempt in 0..<3 {
          do {
            let selected = try kit.selectedMessageDraft(accountRef: account, groupIdHex: group)
            guard selected.draft?.mediaAttachments.isEmpty != false else { throw problem("MediaDraftPending") }
            let draft = try kit.saveMessageDraftInputsIfRevision(accountRef: account, revision: selected.revision,
              content: text, replyToMessageIdHex: reply, mediaAttachments: [])
            return try await kit.sendMessageDraftWithClientToken(accountRef: account, revision: draft.revision,
              attachments: [], tags: [], clientToken: token).messageIdHex
          } catch MarmotKitError.MessageDraftRevisionConflict where attempt < 2 {
            continue
          }
        }
        throw problem("MessageDraftRevisionConflict")
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
    AsyncFunction("sendSpecial") { (group: String, kind: UInt64, body: String, reply: String?, token: String) async throws -> String in
      guard [24881, 24883, 24884].contains(kind) else { throw problem("InvalidApplicationEvent") }
      return try await self.withAccount { kit, account in
        let tags = reply.map { [["e", $0, "", "reply"]] } ?? []
        if kind == 24884 {
          _ = try await kit.sendCustomEvent(accountRef: account, groupIdHex: group,
            kind: kind, tags: tags, content: body)
          return ""
        }
        return try await kit.submitCustomEventWithClientToken(accountRef: account, groupIdHex: group,
          kind: kind, tags: tags, content: body, clientToken: token).messageIdHex
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
    AsyncFunction("editLocalMessageWithClientToken") { (group: String, originalToken: String, content: String, editToken: String) async throws -> String in
      try await self.withAccount { kit, account in
        try await kit.editLocalMessageWithClientToken(accountRef: account, groupIdHex: group,
          originalClientToken: originalToken, content: content, editClientToken: editToken).messageIdHex
      }
    }
    AsyncFunction("existingDirectConversation") { (peer: String) async throws -> String? in
      try await self.withAccount { kit, account in
        try await kit.existingDirectConversation(accountRef: account, peerAccountId: peer).flatMap { $0.reusable ? $0.groupIdHex : nil }
      }
    }
    AsyncFunction("sharedMediaPage") { (group: String?, sender: String?, after: Double?, before: Double?, caption: String?, token: String?, baseline: String?) async throws -> Document in
      try await self.withAccount { kit, account in
        let groupOnly = group != nil && sender == nil && after == nil && before == nil
        let versionScope = groupOnly ? "group:\(group ?? "")" : "account"
        let queryScope = "\(versionScope):\(group ?? ""):\(sender ?? ""):\(String(describing: after)):\(String(describing: before)):\(caption ?? "")"
        let cursorScope = queryScope + ":" + (baseline ?? "initial")
        let restart: Document = ["rows": [], "next": NSNull(), "baseline": NSNull(), "restart": true]
        if let baseline {
          guard self.historyLock.withLock({ self.sharedMediaVersions[baseline]?.scope }) == queryScope else { return restart }
        } else if token != nil {
          return restart
        }
        let savedCursor: SharedMediaCursor? = self.historyLock.withLock {
          guard let token else { return nil }
          guard self.sharedMediaCursors[token]?.scope == cursorScope else { return nil }
          return self.sharedMediaCursors.removeValue(forKey: token)?.cursor
        }
        if token != nil && savedCursor == nil { return restart }
        let groupCursor: AttachmentHistoryCursor?
        let accountCursor: AccountAttachmentCursor?
        switch savedCursor {
        case .group(let value): groupCursor = value; accountCursor = nil
        case .account(let value): accountCursor = value; groupCursor = nil
        case nil: groupCursor = nil; accountCursor = nil
        }
        let read: SharedMediaRead
        if groupOnly, let group {
          read = .group(try await kit.attachmentHistoryPage(accountRef: account, groupIdHex: group, limit: 40, cursor: groupCursor))
        } else {
          let minimum = try self.historyTimestamp(after)
          let maximum = try self.historyTimestamp(before)
          if let minimum, let maximum, minimum > maximum { throw problem("InvalidHistoryRange") }
          let query = AccountAttachmentQueryFfi(groups: group.map { [$0] } ?? [], senders: sender.map { [$0] } ?? [],
            minTimelineAt: minimum, maxTimelineAt: maximum)
          read = .account(try await kit.accountAttachmentHistoryPage(accountRef: account, query: query, limit: 40, cursor: accountCursor))
        }
        var groupPage: AttachmentPageFfi?
        var accountPage: AccountAttachmentPageFfi?
        switch read {
        case .group(.restartRequired), .account(.restartRequired):
          if let baseline {
            self.historyLock.withLock {
              self.sharedMediaVersions.removeValue(forKey: baseline)
              self.sharedMediaCursors = self.sharedMediaCursors.filter { !$0.value.scope.hasSuffix(":" + baseline) }
            }
          }
          return restart
        case .group(.page(let page)):
          groupPage = page
          accountPage = nil
        case .account(.page(let page)):
          groupPage = nil
          accountPage = page
        }
        let baselineId: String
        var pendingVersion: SharedMediaVersion?
        if let baseline { baselineId = baseline }
        else {
          baselineId = UUID().uuidString
          if let page = groupPage, let group { pendingVersion = .group(group, page.version) }
          else if let page = accountPage { pendingVersion = .account(page.version) }
          else { throw problem("AttachmentHistoryVersionUnavailable") }
        }
        let entries: [(String, AttachmentEntryFfi)]
        if let page = groupPage, let group { entries = page.entries.map { (group, $0) } }
        else if let page = accountPage { entries = page.entries.map { ($0.groupIdHex, $0.entry) } }
        else { throw problem("AttachmentHistoryUnavailable") }
        let shared = entries.filter { item in
          if case .accepted(_, let reference) = item.1.attachment {
            return item.1.role == .shared && item.1.category != .rejected && reference.version == .v2
          }
          return false
        }
        var eligibleGroups: [String: ChatListRowFfi] = [:]
        for conversation in Set(shared.map { $0.0 }) {
          if let row = try kit.chatListRow(accountRef: account, groupIdHex: conversation),
            row.selfMembership == .member, !row.pendingConfirmation, !row.leaveRequestPending, !row.disbanding,
            row.lifecycleState != .unrecoverable {
            eligibleGroups[conversation] = row
          }
        }
        let directGroups = eligibleGroups.keys.filter { eligibleGroups[$0]?.conversationKind == .direct }
        let peers = try await kit.groupMemberIdsPage(accountRef: account, groupIdsHex: Array(directGroups)).reduce(into: [String: String]()) { result, row in
          let others = row.memberIdsHex.filter { $0 != account }
          if others.count == 1 { result[row.groupIdHex] = others[0] }
        }
        let candidates = shared.filter { eligibleGroups[$0.0] != nil && (!directGroups.contains($0.0) || peers[$0.0] != nil) }
        var metadata: [String: [String: TimelineMessageRecordFfi]] = [:]
        for (_, entries) in Dictionary(grouping: candidates, by: { "\($0.0):\($0.1.timelineAt)" }) {
          guard let first = entries.first else { continue }
          let found = try self.timelineRowsAt(kit: kit, account: account, group: first.0,
            at: first.1.timelineAt, targetIds: Set(entries.map { $0.1.messageIdHex }), attachmentType: 5, search: caption)
          metadata[first.0, default: [:]].merge(found) { current, _ in current }
        }
        var localAssets: [String: Bool] = [:]
        for (conversation, items) in Dictionary(grouping: candidates, by: { $0.0 }) {
          let targets = items.compactMap { item -> (String, AttachmentLocalTargetFfi)? in
            guard case .accepted(let index, _) = item.1.attachment else { return nil }
            let key = "\(item.1.messageIdHex):\(item.1.sourceMessageIdHex):\(index)"
            return (key, AttachmentLocalTargetFfi(messageIdHex: item.1.messageIdHex,
              sourceMessageIdHex: item.1.sourceMessageIdHex, attachmentIndex: index))
          }
          let assets = try await kit.attachmentLocalAssets(accountRef: account, groupIdHex: conversation, targets: targets.map { $0.1 })
          for (target, asset) in zip(targets, assets) { localAssets["\(conversation):\(target.0)"] = asset.reference != nil }
        }
        var rows: [Document] = []
        for (conversation, entry) in candidates {
          guard let row = metadata[conversation]?[entry.messageIdHex], !row.deleted,
            row.invalidationStatus == nil, row.sourceMessageIdHex == entry.sourceMessageIdHex, row.sender == entry.sender,
            case .accepted(let index, let reference) = entry.attachment, reference.version == .v2 else { continue }
          let tag = row.tags.singleOrNil { $0.values.count == 6 && $0.values[0] == "boop-media" && $0.values[1] == String(index) }?.values
          let metadataValues = tag.map { Array($0.dropFirst(2)) }.flatMap { values in
            values.allSatisfy { $0.count <= 192 } ? values : nil
          }
          let asset: Document = ["outcome": "accepted", "index": Double(index), "name": reference.fileName,
            "type": reference.mediaType, "thumbhash": bridgeValue(reference.thumbhash), "dimensions": bridgeValue(reference.dim),
            "plaintextHash": reference.plaintextSha256, "metadata": bridgeValue(metadataValues)]
          rows.append(["group": conversation, "groupLabel": bridgeValue(eligibleGroups[conversation]?.title),
            "peer": bridgeValue(peers[conversation]),
            "message": entry.messageIdHex, "source": entry.sourceMessageIdHex, "sender": row.sender,
            "at": Double(row.timelineAt), "expiresAt": bridgeValue(row.retentionExpiresAt.map(Double.init)),
            "caption": row.plaintext, "item": asset, "category": wireName(entry.category),
            "local": localAssets["\(conversation):\(entry.messageIdHex):\(entry.sourceMessageIdHex):\(index)"] == true])
        }
        let cursorScope = queryScope + ":" + baselineId
        if let pendingVersion {
          self.historyLock.withLock { self.sharedMediaVersions[baselineId] = (queryScope, pendingVersion) }
        }
        let continuation: SharedMediaCursor? = groupPage?.nextCursor.map(SharedMediaCursor.group) ??
          accountPage?.nextCursor.map(SharedMediaCursor.account)
        let next = continuation.map { value -> String in
          let id = UUID().uuidString
          self.historyLock.withLock { self.sharedMediaCursors[id] = (cursorScope, value) }
          return id
        }
        groupPage?.nextCursor = nil
        accountPage?.nextCursor = nil
        return ["rows": rows, "next": bridgeValue(next), "baseline": baselineId, "restart": false]
      }
    }
    AsyncFunction("sharedMediaChanges") { (baseline: String) async throws -> String in
      try await self.withAccount { kit, account in
        guard let saved = self.historyLock.withLock({ self.sharedMediaVersions[baseline]?.version }) else {
          return "restart"
        }
        let change: AttachmentHistoryChangeFfi
        switch saved {
        case .account(let version):
          let current = try await kit.accountAttachmentHistoryVersion(accountRef: account)
          change = current.changeSince(previous: version)
        case .group(let group, let version):
          let current = try await kit.attachmentHistoryVersion(accountRef: account, groupIdHex: group)
          change = current.changeSince(previous: version)
        }
        switch change {
        case .unchanged: return "unchanged"
        case .additions: return "additions"
        case .restartRequired:
          self.historyLock.withLock {
            self.sharedMediaVersions.removeValue(forKey: baseline)
            self.sharedMediaCursors = self.sharedMediaCursors.filter { !$0.value.scope.hasSuffix(":" + baseline) }
          }
          return "restart"
        }
      }
    }
    AsyncFunction("sharedMediaRelease") { (handle: String) in
      self.historyLock.withLock {
        _ = self.sharedMediaCursors.removeValue(forKey: handle)
        if self.sharedMediaVersions.removeValue(forKey: handle) != nil {
          self.sharedMediaCursors = self.sharedMediaCursors.filter { !$0.value.scope.hasSuffix(":" + handle) }
        }
      }
    }
    AsyncFunction("recentVoiceNotes") { (sender: String, since: UInt64, onlyOutgoing: Bool, token: String?) async throws -> Document in
      try await self.withAccount { kit, account in
        let scope = "voice:\(sender):\(since):\(onlyOutgoing)"
        let cursor: AccountAttachmentCursor? = try self.historyLock.withLock {
          guard let token else { return nil }
          guard let saved = self.accountAttachmentHistoryCursors.removeValue(forKey: token), saved.scope == scope else {
            throw problem("AttachmentHistoryCursorMismatch")
          }
          return saved.cursor
        }
        if token == nil {
          self.historyLock.withLock {
            self.accountAttachmentHistoryCursors = self.accountAttachmentHistoryCursors.filter { !$0.value.scope.hasPrefix("voice:\(sender):") }
          }
        }
        let query = AccountAttachmentQueryFfi(groups: [], senders: onlyOutgoing ? [sender] : [], minTimelineAt: since, maxTimelineAt: nil)
        var read = try await kit.accountAttachmentHistoryPage(accountRef: account, query: query, limit: 24, cursor: cursor)
        if case .restartRequired = read {
          read = try await kit.accountAttachmentHistoryPage(accountRef: account, query: query, limit: 24, cursor: nil)
        }
        guard case .page(let pageValue) = read else { throw problem("AttachmentHistoryUnavailable") }
        var page = pageValue
        var metadataByGroup: [String: [String: TimelineMessageRecordFfi]] = [:]
        for (_, items) in Dictionary(grouping: page.entries, by: { "\($0.groupIdHex):\($0.entry.timelineAt)" }) {
          guard let first = items.first else { continue }
          let metadata = try self.timelineRowsAt(kit: kit, account: account, group: first.groupIdHex,
            at: first.entry.timelineAt, targetIds: Set(items.map { $0.entry.messageIdHex }), attachmentType: 3)
          metadataByGroup[first.groupIdHex, default: [:]].merge(metadata) { current, _ in current }
        }
        var notes: [Document] = []
        for item in page.entries {
            let entry = item.entry
            guard entry.category == .audio,
              case .accepted(let index, let reference) = entry.attachment,
              reference.version == .v2, reference.mediaType.hasPrefix("audio/") else { continue }
            guard let row = metadataByGroup[item.groupIdHex]?[entry.messageIdHex], !row.deleted, row.invalidationStatus == nil,
              row.sourceMessageIdHex == entry.sourceMessageIdHex else { continue }
            let source = entry.sourceMessageIdHex
            let matches = row.tags.filter { $0.values.count == 6 && $0.values[0] == "boop-media" &&
              $0.values[1] == String(index) && $0.values[5] == "voice" }
            guard matches.count == 1, let tag = matches.first?.values else { continue }
            let target: [Any] = [item.groupIdHex, row.messageIdHex, source, Int(index)]
            notes.append(["target": target, "hash": reference.plaintextSha256,
              "sender": row.sender, "incoming": row.sender != sender,
              "duration": bridgeValue(mediaDuration(tag[3])),
              "expiresAt": bridgeValue(row.retentionExpiresAt.map { Double($0) * 1000 }),
              "sentAt": Double(row.timelineAt)])
        }
        let continuation = page.nextCursor
        page.nextCursor = nil
        let next = continuation.map { value -> String in
          let id = UUID().uuidString
          self.historyLock.withLock { self.accountAttachmentHistoryCursors[id] = (scope, value) }
          return id
        }
        return ["rows": notes, "next": bridgeValue(next)]
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
    AsyncFunction("setPinned") { (groups: [String], pinned: Bool) async throws in
      try await protocolCall { try await self.runtime.setPinned(groups, pinned) }
    }
    AsyncFunction("reorderPinnedChats") { (visibleOrder: [String]) async throws in
      try await protocolCall { try await self.runtime.reorderPinnedChats(visibleOrder) }
    }
    AsyncFunction("setChatMuted") { (group: String, until: Int64?) async throws in
      try await self.withAccount { _ = try $0.setChatMuted(accountRef: $1, groupIdHex: group, mutedUntilMs: until) }
    }
    AsyncFunction("clearChatMuted") { (group: String) async throws in
      try await self.withAccount { _ = try $0.clearChatMuted(accountRef: $1, groupIdHex: group) }
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
    AsyncFunction("accountIsUnlinked") { (account: String) async throws -> Bool in
      try await protocolCall { try await self.runtime.accountIsUnlinked(account) }
    }
    AsyncFunction("accountRecoveryStatus") { (account: String) async throws -> Document in
      try await self.withSecurityAccount(account) { kit in
        accountRecoveryStatusWire(try await kit.accountRecoveryStatus(accountRef: account))
      }
    }
    AsyncFunction("linkedDevices") { (account: String) async throws -> [Document] in
      try await self.withSecurityAccount(account) { kit in
        try await kit.linkedDevices(accountRef: account).map(linkedDeviceWire)
      }
    }
    AsyncFunction("deviceLinkSnapshot") { (account: String) async throws -> Document in
      try await self.withSecurityAccount(account) { kit in
        deviceLinkSnapshotWire(try await kit.deviceLinkSnapshot(accountRef: account))
      }
    }
    AsyncFunction("startDeviceLink") { (account: String) async throws -> Document in
      try await self.withSecurityAccount(account) { kit in
        deviceLinkSnapshotWire(try await kit.startDeviceLink(accountRef: account))
      }
    }
    AsyncFunction("cancelDeviceLink") { (account: String) async throws -> Document in
      try await self.withSecurityAccount(account) { kit in
        deviceLinkSnapshotWire(try await kit.cancelDeviceLink(accountRef: account))
      }
    }
    AsyncFunction("confirmDeviceLinkMatch") { (account: String, code: [String]) async throws -> Document in
      try await self.withSecurityAccount(account) { kit in
        guard case .some(.comparing(let current)) = (try await kit.deviceLinkSnapshot(accountRef: account)).newDevice,
              current.map(\.emoji) == code else { throw problem("PairingChanged") }
        return deviceLinkSnapshotWire(try await kit.confirmDeviceLinkMatch(accountRef: account))
      }
    }
    AsyncFunction("linkDevice") { (account: String, prompt: String, code: [String], label: String, allChats: Bool, history: Bool) async throws -> Document in
      try await self.withSecurityAccount(account) { kit in
        let state = try await kit.deviceLinkSnapshot(accountRef: account).prompts.first { $0.promptId == prompt }?.state
        guard case .some(.comparing(let current)) = state,
              current.map(\.emoji) == code else { throw problem("PairingChanged") }
        return deviceLinkSnapshotWire(try await kit.linkDevice(accountRef: account, promptId: prompt, label: label, addToAllChats: allChats, bringHistory: history))
      }
    }
    AsyncFunction("declineDeviceLink") { (account: String, prompt: String) async throws -> Document in
      try await self.withSecurityAccount(account) { kit in
        deviceLinkSnapshotWire(try await kit.declineDeviceLink(accountRef: account, promptId: prompt))
      }
    }
    AsyncFunction("renameLinkedDevice") { (account: String, slot: String, label: String) async throws in
      try await self.withSecurityAccount(account) { kit in
        try await kit.renameLinkedDevice(accountRef: account, slotIdHex: slot, label: label)
      }
    }
    AsyncFunction("updateLinkedDeviceSettings") { (account: String, slot: String, allChats: Bool?, history: Bool?, keep: Bool?) async throws in
      try await self.withSecurityAccount(account) { kit in
        try await kit.updateLinkedDeviceSettings(accountRef: account, slotIdHex: slot, addToAllChats: allChats, bringHistory: history, keepWhileInactive: keep)
      }
    }
    AsyncFunction("removeLinkedDevice") { (account: String, slot: String) async throws in
      try await self.withSecurityAccount(account) { kit in
        try await kit.removeLinkedDevice(accountRef: account, slotIdHex: slot)
      }
    }
    AsyncFunction("unrecognizedSignIns") { (account: String) async throws -> [Document] in
      try await self.withSecurityAccount(account) { kit in
        try await kit.unrecognizedSignIns(accountRef: account).map(unrecognizedSignInWire)
      }
    }
    AsyncFunction("checkSignIns") { (account: String) async throws -> [Document] in
      try await self.withSecurityAccount(account) { kit in
        try await kit.checkSignIns(accountRef: account).map(unrecognizedSignInWire)
      }
    }
    AsyncFunction("answerSignIn") { (account: String, slot: String, response: String) async throws in
      try await self.withSecurityAccount(account) { kit in
        let answer: SignInResponseFfi
        switch response {
        case "notNow": answer = .notNow
        case "reject": answer = .reject
        case "dismiss": answer = .dismiss
        default: throw problem("InvalidSignInResponse")
        }
        try await kit.answerSignIn(accountRef: account, slotIdHex: slot, response: answer)
      }
    }
    AsyncFunction("compromiseWarning") { (account: String) async throws -> [Document] in
      try await self.withSecurityAccount(account) { kit in
        try await kit.compromiseWarning(accountRef: account).map(compromiseWarningWire)
      }
    }
    AsyncFunction("dismissCompromiseWarning") { (account: String) async throws in
      try await self.withSecurityAccount(account) { kit in
        try await kit.dismissCompromiseWarning(accountRef: account)
      }
    }
    AsyncFunction("startFresh") { (account: String) async throws in
      try await self.withSecurityAccount(account) { kit in
        try await kit.startFresh(accountRef: account)
      }
    }
    AsyncFunction("startedFresh") { (account: String) async throws -> Bool in
      try await self.withSecurityAccount(account) { kit in
        try await kit.startedFresh(accountRef: account)
      }
    }
    AsyncFunction("chatHistoryImports") { (account: String) async throws -> [Document] in
      try await self.withSecurityAccount(account) { kit in
        try await kit.chatHistoryImports(accountRef: account).map(chatHistoryImportWire)
      }
    }
    AsyncFunction("keyPackageRefreshOverdue") { (account: String) async throws -> Bool in
      try await self.withSecurityAccount(account) { kit in
        try await kit.keyPackageRefreshOverdue(accountRef: account)
      }
    }
    AsyncFunction("removedDeviceLeftoverChats") { (account: String) async throws -> Int in
      try await self.withSecurityAccount(account) { kit in
        Int(try await kit.removedDeviceLeftoverChats(accountRef: account))
      }
    }
    AsyncFunction("chatsClosedToLinkedDevices") { (account: String) async throws -> Int in
      try await self.withSecurityAccount(account) { kit in
        Int(try await kit.chatsClosedToLinkedDevices(accountRef: account))
      }
    }
    AsyncFunction("resetDeviceGroupForRepair") { (account: String) async throws -> Document in
      try await self.withSecurityAccount(account) { kit in
        deviceLinkSnapshotWire(try await kit.resetDeviceGroupForRepair(accountRef: account))
      }
    }
    AsyncFunction("rotateKeyPackage") { (account: String) async throws in
      try await self.withSecurityAccount(account) { kit in
        _ = try await kit.rotateKeyPackage(accountRef: account)
      }
    }
    AsyncFunction("dismissDeviceGroupMoveSibling") { (account: String, move: String, slot: String) async throws -> Document in
      try await self.withSecurityAccount(account) { kit in
        deviceLinkSnapshotWire(try await kit.dismissDeviceGroupMoveSibling(accountRef: account, moveId: move, slotIdHex: slot))
      }
    }
    AsyncFunction("accountDevicesActivation") { (account: String, group: String) async throws -> Document in
      try await self.withSecurityAccount(account) { kit in
        accountDevicesActivationWire(try await kit.accountDevicesActivation(accountRef: account, groupIdHex: group))
      }
    }
    AsyncFunction("enableAccountDevices") { (account: String, group: String) async throws in
      try await self.withSecurityAccount(account) { kit in
        _ = try await kit.enableAccountDevices(accountRef: account, groupIdHex: group)
      }
    }
    OnDestroy { Task { try? await self.closeAccount(closeRuntime: true) } }
  }

  private func closeAccount(closeRuntime: Bool = false, pauseMessaging: Bool = false) async throws {
    if closeRuntime, let owner = existingSocialHost() {
      do { try await owner.shutdown() }
      catch { NSLog("[BoopMarmot] Social shutdown failed: %@", String(describing: error)) }
    }
    if closeRuntime {
      let ids = securityObservationLock.withLock { Array(securityObservations.keys) }
      for id in ids { await stopAccountSecurityEvents(id) }
    }
    defer {
      historyLock.withLock {
        sharedMediaCursors.removeAll()
        sharedMediaVersions.removeAll()
        accountAttachmentHistoryCursors.removeAll()
      }
    }
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

  private func socialHost() -> SocialNativeOwner {
    socialOwnerLock.withLock {
      if let current = storedSocialOwner { return current }
      let created = SocialNativeOwner(runtime: runtime, foreground: { [weak self] in
        guard let self else { return false }
        return self.attachmentLock.withLock { self.isForeground }
      })
      storedSocialOwner = created
      return created
    }
  }

  private func existingSocialHost() -> SocialNativeOwner? {
    socialOwnerLock.withLock { storedSocialOwner }
  }

  private func socialStorageRoot(create: Bool) throws -> URL {
    let base = try FileManager.default.url(
      for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
    )
    let root = base.appendingPathComponent("boop-social", isDirectory: true)
    if create {
      try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      var mutableRoot = root
      try mutableRoot.setResourceValues(values)
    }
    return root
  }

  private func cleanupSocialAccount(_ account: String) async throws {
    guard account.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else {
      throw problem("SocialCleanupFailedAfterAccountRemoval")
    }
    do {
      let root = try socialStorageRoot(create: false)
      let accountDirectory = root.appendingPathComponent(account, isDirectory: true)
      if let owner = existingSocialHost() {
        try await owner.removeAccount(account, storageRoot: root.path)
      } else if FileManager.default.fileExists(atPath: accountDirectory.path) {
        let cleanupOwner = SocialNativeOwner(runtime: runtime, foreground: { false })
        try await cleanupOwner.removeAccount(account, storageRoot: root.path)
        try await cleanupOwner.shutdown()
      }
      try SocialStorageKey.remove(account: account)
    } catch {
      throw problem("SocialCleanupFailedAfterAccountRemoval")
    }
  }

  /// Bootstrap and policy updates are native-owner APIs; no JavaScript route is registered.
  func activateSocialForNativeOwner(account: String) async throws -> SocialSession {
    let owner = socialHost()
    try await withSigner(account) { _ in () }
    let root = try socialStorageRoot(create: true)
    let (foreground, generation) = attachmentLock.withLock { (isForeground, foregroundGeneration) }
    var key = try SocialStorageKey.load(account: account)
    defer { key.resetBytes(in: 0..<key.count) }
    return try await owner.activate(
      account: account, storageRoot: root.path, storageKey: key,
      foreground: foreground, foregroundGeneration: generation
    )
  }

  func setSocialAuthorizationForNativeOwner(current: SocialSession, enabled: Bool, unlocked: Bool) async throws {
    try await existingSocialHost()?.setPolicy(current: current, enabled: enabled, unlocked: unlocked)
  }

  private func withSecurityAccount<T>(_ key: String, _ call: (Marmot) async throws -> T) async throws -> T {
    try await protocolCall {
      guard self.attachmentLock.withLock({ self.isForeground }) else { throw problem("AccountClosed") }
      let kit = try await self.runtime.beginSecurityAccountCall(key)
      do {
        let result = try await call(kit)
        await self.runtime.endCall()
        return result
      } catch {
        await self.runtime.endCall()
        throw error
      }
    }
  }

  private func startAccountSecurityEvents(_ id: String, _ account: String) async throws {
    let (events, unlinked) = try await runtime.beginSecurityEvents(account)
    await stopAccountSecurityEvents(id)
    securityObservationLock.withLock {
      let task = Task { [weak self] in
        do {
          while !Task.isCancelled, let event = try await events.nextCancellable() {
            guard !Task.isCancelled, let module = self else { break }
            guard let (eventAccount, kind) = module.securityEvent(event), eventAccount == account else { continue }
            if kind == "deviceUnlinked" {
              Task { await module.existingSocialHost()?.retire(account: account) }
            }
            module.sendEvent("accountSecurityEvent", ["account": account, "subscriptionId": id, "kind": kind])
          }
        } catch {
          // Closing the runtime or canceling the task ends the receive.
        }
        guard let self else { return }
        let removed = self.securityObservationLock.withLock {
          guard let current = self.securityObservations[id], current.events === events else { return false }
          self.securityObservations.removeValue(forKey: id)
          return true
        }
        if removed { self.sendEvent("accountSecurityEvent", ["account": account, "subscriptionId": id, "kind": "ended"]) }
      }
      securityObservations[id] = (account, events, task)
    }
    // Subscription is established before the persisted-state read in Runtime;
    // queued events cover an unlink racing this initial snapshot.
    if unlinked {
      Task { await existingSocialHost()?.retire(account: account) }
      sendEvent("accountSecurityEvent", ["account": account, "subscriptionId": id, "kind": "deviceUnlinked"])
    }
  }

  private func stopAccountSecurityEvents(_ id: String) async {
    let observation = securityObservationLock.withLock { securityObservations.removeValue(forKey: id) }
    guard let observation else { return }
    observation.task.cancel()
    await observation.task.value
    sendEvent("accountSecurityEvent", ["account": observation.account, "subscriptionId": id, "kind": "ended"])
  }

  private func stopAccountSecurityEvents(for account: String) async {
    let ids = securityObservationLock.withLock {
      securityObservations.filter { $0.value.account == account }.map(\.key)
    }
    for id in ids { await stopAccountSecurityEvents(id) }
  }

  private func securityEvent(_ event: MarmotEventFfi) -> (String, String)? {
    switch event {
    case .linkedDevicesChanged(let accountIdHex, _): return (accountIdHex, "linkedDevicesChanged")
    case .keyPackageRefreshOverdueChanged(let accountIdHex, _): return (accountIdHex, "keyPackageRefreshOverdueChanged")
    case .unrecognizedSignInsChanged(let accountIdHex, _): return (accountIdHex, "unrecognizedSignInsChanged")
    case .compromiseWarningChanged(let accountIdHex, _): return (accountIdHex, "compromiseWarningChanged")
    case .deviceLinkChanged(let accountIdHex, _): return (accountIdHex, "deviceLinkChanged")
    case .chatHistoryImportsChanged(let accountIdHex, _): return (accountIdHex, "chatHistoryImportsChanged")
    case .recoveryStatusChanged(let accountIdHex, _): return (accountIdHex, "recoveryStatusChanged")
    case .deviceUnlinked(let accountIdHex, _): return (accountIdHex, "deviceUnlinked")
    default: return nil
    }
  }

  private func signOutOutcomeWire(_ outcome: SignOutOutcomeFfi) -> Document {
    ["keyPackagesDeleted": Int(outcome.keyPackagesDeleted),
      "keyPackageFailures": outcome.keyPackageFailures.map { ["eventId": $0.eventIdHex, "reason": $0.reason] },
      "localCleanup": ["completed": outcome.localCleanup.completed, "reason": bridgeValue(outcome.localCleanup.reason)]]
  }

  private func wipeOutcomeWire(_ outcome: WipeOutcomeFfi) -> Document {
    ["groupsLeft": Int(outcome.groupsLeft),
      "groupLeaveFailures": outcome.groupLeaveFailures.map { ["groupId": $0.groupIdHex, "reason": $0.reason] },
      "keyPackagesDeleted": Int(outcome.keyPackagesDeleted),
      "keyPackageFailures": outcome.keyPackageFailures.map { ["eventId": $0.eventIdHex, "reason": $0.reason] },
      "localCleanup": ["completed": outcome.localCleanup.completed, "reason": bridgeValue(outcome.localCleanup.reason)],
      "localAccountRemoved": outcome.localCleanup.completed,
      "groupsLeftToSiblings": Int(outcome.groupsLeftToSiblings),
      "siblingsNotReached": outcome.siblingsNotReached]
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

private func retryDraftEdit<T>(_ edit: () throws -> T) throws -> T {
  for attempt in 0..<3 {
    do {
      return try edit()
    } catch MarmotKitError.MessageDraftRevisionConflict where attempt < 2 {
      continue
    }
  }
  throw problem("MessageDraftRevisionConflict")
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

actor Runtime {
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
  private var windowGenerations: [String: UUID] = [:]
  private var latestWindows: [String: Document] = [:]
  private var observers: [String: Task<Void, Never>] = [:]

  func account() throws -> Account {
    guard let active, !changingAccount else { throw problem("AccountClosed") }
    guard try availableSigner(active.kit, active.key) else { throw problem("AccountSignedOut") }
    return active
  }

  func beginAccountCall() throws -> Account {
    let current = try account()
    activeCalls += 1
    return current
  }

  func setPinned(_ groups: [String], _ pinned: Bool) throws {
    let account = try account()
    for group in groups.reversed() {
      _ = try account.kit.setChatPinned(accountRef: account.key, groupIdHex: group, pinned: pinned)
    }
  }

  func reorderPinnedChats(_ visibleOrder: [String]) throws {
    let account = try account()
    let current = try account.kit.chatList(accountRef: account.key, includeArchived: true)
      .filter { $0.pinned }.map { $0.groupIdHex }
    let requested = Set(visibleOrder)
    guard requested.count == visibleOrder.count else { throw problem("InvalidPinOrder") }
    let currentSet = Set(current)
    let reordered = visibleOrder.filter { currentSet.contains($0) }
    // Replace only the slots from this drop. Hidden pins and concurrent new pins keep their places.
    var merged = current
    let slots = current.indices.filter { requested.contains(current[$0]) }
    for (slot, group) in zip(slots, reordered) { merged[slot] = group }
    if merged != current {
      _ = try account.kit.setPinnedChatOrder(accountRef: account.key, orderedGroupIds: merged)
    }
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
    guard try availableSigner(kit, key) else { throw problem("AccountSignedOut") }
    activeCalls += 1
    return kit
  }

  func socialEligible(_ key: String) throws -> Bool {
    guard signerAccount == key else { return false }
    return try availableSigner(existingRuntime(), key)
  }

  func socialSignEvent(
    account: String, unsignedJson: String, foreground: @Sendable () -> Bool
  ) async throws -> String {
    guard foreground() else { throw problem("AccountClosed") }
    let kit = try beginSignerCall(account)
    do {
      let signature = try await kit.signNostrEvent(accountRef: account, unsignedJson: unsignedJson)
      let stillEligible: Bool
      if foreground() { stillEligible = try socialEligible(account) }
      else { stillEligible = false }
      guard stillEligible else { throw problem("AccountClosed") }
      endCall()
      return signature
    } catch {
      endCall()
      throw error
    }
  }

  func beginSecurityAccountCall(_ key: String) throws -> Marmot {
    guard signerAccount == key else { throw problem("AccountClosed") }
    let kit = try existingRuntime()
    guard try availableSigner(kit, key) else { throw problem("AccountSignedOut") }
    activeCalls += 1
    return kit
  }

  func beginSecurityEvents(_ key: String) throws -> (EventsSubscription, Bool) {
    guard signerAccount == key else { throw problem("AccountClosed") }
    let kit = try existingRuntime()
    let events = kit.subscribeEvents()
    return (events, try accountIsUnlinked(key))
  }

  func accountIsUnlinked(_ key: String) throws -> Bool {
    guard signerAccount == key else { throw problem("AccountClosed") }
    let kit = try existingRuntime()
    guard let summary = try kit.listAccounts().first(where: { $0.accountIdHex == key && $0.localSigning }) else {
      throw problem("IdentityMismatch")
    }
    return summary.unlinked
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

  func signOut(_ key: String, deleteKeyPackages: Bool) async throws -> SignOutOutcomeFfi {
    let kit = try existingRuntime()
    guard active?.key != key else { throw problem("AccountBusy") }
    changingAccount = true
    defer { endTransition() }
    if activeCalls > 0 { await withCheckedContinuation { drained = $0 } }
    let outcome = try await kit.signOut(accountRef: key, deleteKeyPackages: deleteKeyPackages)
    if signerAccount == key { signerAccount = nil }
    return outcome
  }

  func signOutAndWipe(_ key: String) async throws -> WipeOutcomeFfi {
    let kit = try existingRuntime()
    guard active?.key != key else { throw problem("AccountBusy") }
    changingAccount = true
    defer { endTransition() }
    if activeCalls > 0 { await withCheckedContinuation { drained = $0 } }
    let outcome = try await kit.signOutAndWipe(accountRef: key)
    if signerAccount == key { signerAccount = nil }
    return outcome
  }

  func releaseSigner(_ key: String) async throws {
    guard active?.key != key else { throw problem("AccountBusy") }
    if signerAccount == key { signerAccount = nil }
    if activeCalls > 0 { await withCheckedContinuation { drained = $0 } }
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
    guard let active, !changingAccount, windowGenerations[id] == active.generation,
      try availableSigner(active.kit, active.key) else { throw problem("AccountSignedOut") }
    return window
  }

  func pageWindow(_ id: String, generation: String, sequence: String, direction: String) async throws -> Document {
    _ = try beginAccountCall()
    do {
      let selected = try window(id)
      let result = try await selected.page(revision: revision(generation, sequence), direction: direction)
      endCall()
      return result
    } catch {
      endCall()
      throw error
    }
  }

  func anchorWindow(_ id: String, generation: String, sequence: String, target: String) async throws -> Document {
    _ = try beginAccountCall()
    do {
      let selected = try window(id)
      let result = try await selected.anchor(revision: revision(generation, sequence), target: target)
      endCall()
      return result
    } catch {
      endCall()
      throw error
    }
  }

  func jumpToMessage(_ id: String, generation: String, sequence: String, target: String) async throws -> Document {
    _ = try beginAccountCall()
    do {
      let selected = try window(id)
      let result = try await selected.jump(revision: revision(generation, sequence), target: target)
      endCall()
      return result
    } catch {
      endCall()
      throw error
    }
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
    guard active?.generation == account.generation,
      try availableSigner(account.kit, account.key) else {
      await window.cancel()
      throw problem("AccountSignedOut")
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
    windowGenerations[id] = account.generation
    return initial
  }

  func windowSnapshot(_ id: String) throws -> Document {
    _ = try window(id)
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
          _ = try self.window(id)
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
    windowGenerations.removeValue(forKey: id)
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
    if case .Runtime(let details) = error {
      switch details {
      case "device group refused: device_group_busy": return "DeviceGroupBusy"
      case "device group refused: device_link_pending": return "DeviceLinkPending"
      case "device group refused: roster_unavailable": return "DeviceRosterUnavailable"
      case "device group refused: key_packages_unreachable": return "DeviceDiscoveryUnavailable"
      case "device group refused: unknown_prompt": return "PairingChanged"
      case "device group refused: sign_in_unknown", "device group refused: sign_in_answered",
           "device group refused: sign_in_answered_elsewhere", "device group refused: sign_in_unanswered": return "SignInChanged"
      default: return "Runtime"
      }
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
