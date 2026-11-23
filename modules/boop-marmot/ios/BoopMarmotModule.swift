import AVFoundation
import ExpoModulesCore
import Foundation
import ImageIO
import UIKit

private let attachmentStallTimeout: TimeInterval = 180

public final class BoopMarmotModule: Module {
  private let runtime = Runtime()
  private let uploadLock = NSLock()
  private let attachmentLock = NSLock()
  private var attachmentAdmissions: [String: AttachmentCancellation] = [:]
  private var isForeground = true
  private var foregroundGeneration: UInt64 = 0
  private var uploads: [String: MediaFileTransferControlFfi] = [:]

  public func definition() -> ModuleDefinition {
    Name("BoopMarmot")
    Events("windowChanged", "windowClosed", "attachmentProgress")
    OnAppEntersBackground {
      let pending = self.attachmentLock.withLock { () -> [AttachmentCancellation] in
        self.isForeground = false
        self.foregroundGeneration &+= 1
        return Array(self.attachmentAdmissions.values)
      }
      Task { for attempt in pending { await attempt.cancel() } }
    }
    OnAppBecomesActive {
      self.attachmentLock.withLock {
        self.isForeground = true
        self.foregroundGeneration &+= 1
      }
    }

    AsyncFunction("openAccount") { (key: String, secret: String, nsec: String, general: [String], inbox: [String], discovery: [String], mediaOrigin: String?, generated: Bool) async throws -> String in
      try await protocolCall { try await self.runtime.open(key: key, secret: secret, nsec: nsec, general: general, inbox: inbox, discovery: discovery, mediaOrigin: mediaOrigin, generated: generated) }
    }
    AsyncFunction("closeAccount") { () async throws in
      try await protocolCall { try await self.closeAccount() }
    }
    AsyncFunction("catchUp") { () async throws in
      try await self.withAccount { kit, _ in try await kit.catchUpAccounts() }
    }
    AsyncFunction("diagnostics") { () async throws -> Document in
      try await self.withAccount { kit, account in
        let relays = try await kit.relayHealth()
        let keys = try await kit.keyPackageMaintenanceStatus(accountRef: account)
        return ["account": account, "readiness": try wireName(kit.accountSetupReadiness(accountRef: account)),
          "relays": Int(relays.totalRelays), "connected": Int(relays.connected),
          "keyPackages": try kit.localAccountKeyPackages(accountRef: account).count,
          "keyPhase": bridgeValue(keys.map { wireName($0.phase) }), "published": bridgeValue(keys.map { Int($0.acceptedFanoutTargets) }),
          "refreshOverdue": try await kit.keyPackageRefreshOverdue(accountRef: account)]
      }
    }
    AsyncFunction("rotateKeys") { () async throws in
      try await self.withAccount { _ = try await $0.rotateKeyPackage(accountRef: $1) }
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
    AsyncFunction("openGroupState") { (id: String, group: String) async throws -> Document in
      try await protocolCall { try await self.runtime.openGroupState(id: id, group: group) }
    }
    AsyncFunction("openGroupCall") { (id: String, group: String) async throws -> Document in
      try await protocolCall { try await self.runtime.openGroupCall(id: id, group: group) }
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
    AsyncFunction("windowSnapshot") { (id: String) async throws -> Document in
      try await protocolCall {
        let window = try await self.runtime.window(id)
        guard let snapshot = window.initial() else { throw problem("WindowClosed") }
        return snapshot
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
    AsyncFunction("checkInvitee") { (peer: String) async throws in
      try await self.withAccount { _ = try await $0.prewarmGroupMemberKeyPackages(accountRef: $1, memberRefs: [peer]) }
    }
    AsyncFunction("createGroup") { (name: String, description: String?, members: [String], image: String?) async throws -> Document in
      try await self.withAccount { kit, account in
        let initial = try image.map { path in
          InitialGroupImageFfi(plaintext: try groupImageInput(path), mediaType: "image/jpeg", sourceUrl: nil, dim: nil, thumbhash: nil)
        }
        let result = try await kit.createGroupWithInitialImageDetailed(accountRef: account, name: name, memberRefs: members, description: description, initialImage: initial)
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
        let delivery = try await kit.groupCommitDelivery(accountRef: account, groupIdHex: group)
        let recovery = try await kit.groupRecoveryStatus(accountRef: account, groupIdHex: group)
        let chat = try kit.chatListRow(accountRef: account, groupIdHex: group)
        let actions = Dictionary(policy.memberActions.map { ($0.memberIdHex, $0) }, uniquingKeysWith: { first, _ in first })
        return [
          "id": group, "name": details.group.name, "description": details.group.description,
          "inviter": bridgeValue(details.group.welcomerAccountIdHex), "relays": details.group.relays,
          "image": bridgeValue(details.group.imageHashHex), "epoch": String(details.mlsState.epoch),
          "mediaV2": details.group.encryptedMedia.version == .v2,
          "mediaEndpoints": details.group.encryptedMedia.defaultBlobEndpoints.map(\.baseUrl),
          "unrecoverable": details.mlsState.unrecoverable,
          "convergenceParked": details.mlsState.convergenceParked || recovery.automaticRecoveryFailed,
          "historyIncomplete": recovery.historyMayBeIncomplete,
          "relayChangesOutstanding": (delivery?.owedRelayUrls.count ?? 0) + (delivery?.refusedRelays.count ?? 0),
          "membership": wireName(details.group.selfMembership),
          "pendingInvitation": details.group.pendingConfirmation,
          "kind": bridgeValue(chat.map { wireName($0.conversationKind) }),
          "pendingLeave": details.group.leaveRequestPending, "leaveBlocked": details.group.leaveBlocked,
          "createdAt": bridgeValue(chat.map { Double($0.conversationCreatedAt) }), "muted": chat?.muted ?? false,
          "archived": details.group.archived, "canEdit": policy.isSelfAdmin,
          "lifecycle": wireName(policy.lifecycleState), "commit": bridgeValue(pending.map { wireName($0.state) }),
          "isAdmin": policy.isSelfAdmin, "canInvite": policy.canInvite, "canLeave": policy.canLeave,
          "canCancelLeave": policy.canCancelLeave, "canDisband": policy.canDisband,
          "canEnableDisbanding": policy.canEnableDisbanding,
          "members": details.members.map { member -> Document in
            let perms = actions[member.memberIdHex]
            let name = member.displayName.flatMap { $0 == member.memberIdHex ? nil : $0 }
              ?? kit.defaultProfilePseudonym(accountIdHex: member.memberIdHex)
            return [
              "id": member.memberIdHex, "npub": member.npub,
              "name": name,
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
    AsyncFunction("updateGroupImage") { (group: String, path: String?) async throws in
      try await self.withAccount { kit, account in
        if let path {
          _ = try await kit.updateGroupImage(accountRef: account, groupIdHex: group, plaintext: groupImageInput(path), mediaType: "image/jpeg")
        } else {
          _ = try await kit.clearGroupImage(accountRef: account, groupIdHex: group)
        }
      }
    }
    AsyncFunction("updateGroupMedia") { (group: String, origins: [String]) async throws in
      try await self.withAccount { kit, account in
        _ = try await kit.replaceEncryptedMediaBlobEndpoints(accountRef: account, groupIdHex: group, endpoints: origins.map {
          AppBlobEndpointFfi(locatorKind: "blossom", baseUrl: $0)
        })
      }
    }
    AsyncFunction("groupImage") { (group: String, hash: String, fetch: Bool) async throws -> String? in
      try await self.withAccount { kit, account in
        guard hash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw problem("InvalidMedia") }
        let details = try await kit.groupDetails(accountRef: account, groupIdHex: group).group
        guard !details.pendingConfirmation, details.selfMembership == .member, details.imageHashHex == hash else { throw problem("MediaUnavailable") }
        let manager = FileManager.default
        let cache = try manager.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let folder = cache.appendingPathComponent("marmot-group-images").appendingPathComponent(account)
        let file = folder.appendingPathComponent(hash + ".jpg")
        if !manager.fileExists(atPath: file.path) {
          guard fetch else { return nil }
          let bytes = try await kit.downloadGroupBlossomImage(accountRef: account, groupIdHex: group)
          let current = try await kit.groupDetails(accountRef: account, groupIdHex: group).group
          guard !bytes.isEmpty, bytes.count <= maxGroupImage, current.selfMembership == .member, current.imageHashHex == hash else {
            throw problem("MediaUnavailable")
          }
          try manager.createDirectory(at: folder, withIntermediateDirectories: true)
          try bytes.write(to: file, options: [.atomic, .completeFileProtection])
        }
        return file.path
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
      guard [24881, 24883, 24884].contains(kind) else { throw problem("InvalidApplicationEvent") }
      try await self.withAccount { kit, account in
        let tags = reply.map { [["e", $0, "", "reply"]] } ?? []
        _ = try await kit.sendCustomEvent(accountRef: account, groupIdHex: group, kind: kind, tags: tags, content: body)
      }
    }
    AsyncFunction("stageMediaDraft") { (group: String, files: [[String: String]], caption: String, token: String, reply: String?) async throws in
      try await self.withAccount { kit, account in
        let inputs = try self.uploadInputs(files)
        var draft = try kit.selectedMessageDraft(accountRef: account, groupIdHex: group)
        guard draft.draft?.mediaAttachments.isEmpty != false else { throw problem("MediaDraftPending") }
        draft = try kit.saveMessageDraftInputsIfRevision(accountRef: account, revision: draft.revision, content: caption, replyToMessageIdHex: reply, mediaAttachments: [])
        let control = MediaFileTransferControlFfi()
        let registered = self.uploadLock.withLock {
          guard self.uploads[token] == nil else { return false }
          self.uploads[token] = control
          return true
        }
        guard registered else { throw problem("TransferInProgress") }
        defer { _ = self.uploadLock.withLock { self.uploads.removeValue(forKey: token) } }
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
        let selected = try kit.selectedMessageDraft(accountRef: account, groupIdHex: group)
        guard let draft = selected.draft else { return }
        _ = try kit.saveMessageDraftInputsIfRevision(accountRef: account, revision: selected.revision,
          content: draft.content, replyToMessageIdHex: draft.replyToMessageIdHex, mediaAttachments: [])
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
            let accepted = try await kit.sendTaggedMessageDraftWithClientToken(accountRef: account, revision: selected.revision,
              attachments: uploaded.attachments.map(\.reference), messageTags: metadata, clientToken: token)
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
    AsyncFunction("attachmentStatus") { (group: String, id: String, source: String, index: UInt32) async throws -> Bool in
      try await self.withAccount { kit, account in
        let target = AttachmentLocalTargetFfi(messageIdHex: id, sourceMessageIdHex: source, attachmentIndex: index)
        return try await kit.attachmentTransferSnapshot(accountRef: account, groupIdHex: group, targets: [target]).items.first?.state == .ready
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
    AsyncFunction("markUnread") { (group: String) async throws in
      try await self.withAccount { _ = try $0.setChatManuallyUnread(accountRef: $1, groupIdHex: group, manuallyUnread: true) }
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
    OnDestroy { Task { try? await self.closeAccount() } }
  }

  private func closeAccount() async throws {
    uploadLock.withLock { uploads.values.forEach { $0.cancel() } }
    try await runtime.close { [weak self] id in
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

  private func withAccount<T>(_ call: (Marmot, String) async throws -> T) async throws -> T {
    try await protocolCall {
      let account = try await runtime.account()
      return try await call(account.kit, account.key)
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

  func open(key: String, secret: String, nsec: String, general: [String], inbox: [String], discovery: [String], mediaOrigin: String?, generated: Bool) async throws -> String {
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
    var deployment = marmotDeploymentNeutral()
    deployment.discoveryIndexerRelays = discovery
    deployment.groupImageEndpoint = mediaOrigin
    deployment.newGroupMediaEndpoints = mediaOrigin.map { [$0] } ?? []
    var seen = Set<String>()
    let directorySources = (general + discovery).filter { seen.insert($0).inserted }
    let kit = try Marmot.newWithConfiguration(rootPath: root.resolvingSymlinksInPath().path, relayUrls: directorySources, options: MarmotOptions(
      clientName: "Boop", devicePlatform: "iOS", secretStore: store,
      attachmentAcquisitionMode: .hostManaged, deployment: deployment
    ))
    do {
      let known = try kit.listAccounts()
      guard !known.contains(where: { $0.accountIdHex != key || $0.label != key }) else { throw problem("IdentityMismatch") }
      guard !known.contains(where: { $0.unlinked || $0.signedOut }) else { throw problem("AccountSignedOut") }
      try await kit.start()
      if known.isEmpty {
        let created = if generated {
          try await kit.createHostIdentity(nsec: nsec, defaultRelays: general, bootstrapRelays: discovery, inboxRelays: inbox)
        } else {
          try await kit.login(identity: nsec, defaultRelays: general, bootstrapRelays: discovery, inboxRelays: inbox)
        }
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

  func close(notify: (String) -> Void) async throws {
    guard !changingAccount else { throw problem("AccountBusy") }
    guard let active else { return }
    changingAccount = true
    defer { changingAccount = false }
    self.active = nil
    for id in Array(windows.keys) {
      await closeWindow(id)
      notify(id)
    }
    try await active.kit.shutdownAndClose()
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
  func openGroupState(id: String, group: String) async throws -> Document {
    let account = try account()
    let handle = try await account.kit.subscribeGroupState(accountRef: account.key, groupIdHex: group)
    return try await install(.groupState(GroupStateWindow(generation: id, handle: handle)), id: id, account: account)
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

  func openConversation(id: String, group: String, target: String?) async throws -> Document {
    let account = try account()
    let handle = try await account.kit.openConversationWindow(accountRef: account.key, groupIdHex: group, mode: target == nil ? .automatic : .message, messageIdHex: target, initialRows: 40, timeoutMs: 0)
    return try await install(.conversation(handle), id: id, account: account)
  }

  private func install(_ window: NativeWindow, id: String, account: Account) async throws -> Document {
    guard active?.kit === account.kit else {
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
    windows[id] = window
    return initial
  }

  func observe(id: String, notify: @escaping (String, Document) -> Void) throws {
    let window = try window(id)
    guard observers[id] == nil else { return }
    observers[id] = Task {
      do {
        var previous: Document?
        while !Task.isCancelled, let snapshot = try await window.next() {
          guard !Task.isCancelled else { return }
          if let previous, let delta = windowDelta(previous, snapshot) {
            notify("windowChanged", ["id": id, "delta": delta])
          } else {
            notify("windowChanged", ["id": id, "snapshot": snapshot])
          }
          previous = snapshot
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
  if let error = error as? MarmotKitError {
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
