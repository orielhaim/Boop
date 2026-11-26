import Foundation

func accountRecoveryStatusWire(_ status: AccountRecoveryStatusFfi) -> Document {
  [
    "catchingUpGroupIdsHex": status.catchingUpGroupIdsHex,
    "inboxCatchingUp": status.inboxCatchingUp,
    "notices": status.notices.map { notice -> Document in
      let cause: String
      switch notice.cause {
      case .deliveryLoss: cause = "deliveryLoss"
      case .notificationLoss: cause = "notificationLoss"
      case .epochGap: cause = "epochGap"
      case .incrementalHistory: cause = "incrementalHistory"
      case .explicitRepair: cause = "explicitRepair"
      case .knownEvent: cause = "knownEvent"
      case .maintenanceBoundary: cause = "maintenanceBoundary"
      case .unprovenHistory: cause = "unprovenHistory"
      case .beforeRejoin: cause = "beforeRejoin"
      }
      return ["noticeId": notice.noticeId, "groupIdHex": notice.groupIdHex.map { $0 as Any } ?? NSNull(),
        "parkedAtMs": notice.parkedAtMs.map { Double($0) as Any } ?? NSNull(), "cause": cause]
    },
  ]
}

// Explicit JSON boundary for device and account-security DTOs.
func deviceLinkSnapshotWire(_ snapshot: DeviceLinkSnapshotFfi) -> Document {
  [
    "newDevice": snapshot.newDevice.map(newDeviceLinkStateWire) ?? NSNull(),
    "prompts": snapshot.prompts.map(deviceLinkPromptWire),
    "moves": snapshot.moves.map(deviceGroupMoveWire),
    "deviceGroupStalled": snapshot.deviceGroupStalled,
    "chatProgress": snapshot.chatProgress.map(linkChatProgressWire),
  ]
}

func linkedDeviceWire(_ value: LinkedDeviceFfi) -> Document {
  [
    "slotIdHex": value.slotIdHex,
    "isThisDevice": value.isThisDevice,
    "label": value.label,
    "client": value.client,
    "platform": value.platform,
    "linkedAt": Int(value.linkedAt),
    "linkedBySlotIdHex": bridgeValue(value.linkedBySlotIdHex),
    "status": ["kind": linkedDeviceStatusKind(value.status)],
    "addToAllChats": value.addToAllChats,
    "bringHistory": value.bringHistory,
    "keepWhileInactive": value.keepWhileInactive,
    "lastActiveAt": value.lastActiveAt.map(Int.init) ?? NSNull() as Any,
    "inactive": value.inactive,
    "removalPending": value.removalPending,
  ]
}

func unrecognizedSignInWire(_ value: UnrecognizedSignInFfi) -> Document {
  [
    "slotIdHex": value.slotIdHex,
    "client": value.client,
    "appearedAt": Int(value.appearedAt),
    "lastSeenAt": Int(value.lastSeenAt),
    "beforeThisDevice": value.beforeThisDevice,
    "signedIn": value.signedIn,
    "state": ["kind": unrecognizedSignInStateKind(value.state)],
    "linkedBySlotIdHex": bridgeValue(value.linkedBySlotIdHex),
    "previouslyLinkedHere": value.previouslyLinkedHere,
  ]
}

func compromiseWarningWire(_ value: CompromiseWarningItemFfi) -> Document {
  [
    "reason": compromiseWarningReasonWire(value.reason),
    "slotIdHex": value.slotIdHex,
    "keyPackageRefHex": bridgeValue(value.keyPackageRefHex),
    "occurredAt": Int(value.occurredAt),
  ]
}

func chatHistoryImportWire(_ value: ChatHistoryImportFfi) -> Document {
  let state: Document
  switch value.state {
  case .receiving(let retrying): state = ["kind": "receiving", "retrying": retrying]
  case .imported(let from, let at):
    state = ["kind": "imported", "from": [
      "deviceSlotIdHex": from.deviceSlotIdHex,
      "deviceLabel": from.deviceLabel,
    ], "at": Int(at)]
  }
  return ["groupIdHex": value.groupIdHex, "state": state]
}

func accountDevicesActivationWire(_ value: AccountDevicesActivationFfi) -> Document {
  ["kind": accountDevicesActivationKind(value)]
}

private func deviceLinkPromptWire(_ value: DeviceLinkPromptFfi) -> Document {
  [
    "promptId": value.promptId,
    "slotIdHex": bridgeValue(value.slotIdHex),
    "requestedAt": Int(value.requestedAt),
    "state": deviceLinkPromptStateWire(value.state),
  ]
}

private func newDeviceLinkStateWire(_ value: NewDeviceLinkStateFfi) -> Document {
  switch value {
  case .waitingForAnswer: return ["kind": "waitingForAnswer"]
  case .comparing(let code): return ["kind": "comparing", "code": code.map(deviceLinkEmojiWire)]
  case .waitingForOtherDevice: return ["kind": "waitingForOtherDevice"]
  case .joining: return ["kind": "joining"]
  case .linked: return ["kind": "linked"]
  case .ended(let reason): return ["kind": "ended", "reason": deviceLinkEndReasonWire(reason)]
  }
}

private func deviceLinkPromptStateWire(_ value: DeviceLinkPromptStateFfi) -> Document {
  switch value {
  case .preparing: return ["kind": "preparing"]
  case .comparing(let code): return ["kind": "comparing", "code": code.map(deviceLinkEmojiWire)]
  case .competingRequests: return ["kind": "competingRequests"]
  case .rateLimited(let retryAt): return ["kind": "rateLimited", "retryAt": Int(retryAt)]
  case .cannotLink(let missing): return ["kind": "cannotLink", "missing": missing]
  case .tooManyDevices: return ["kind": "tooManyDevices"]
  case .linking: return ["kind": "linking"]
  case .linked: return ["kind": "linked"]
  case .addedElsewhere(let deviceLabel, let addedByLabel):
    return ["kind": "addedElsewhere", "deviceLabel": deviceLabel, "addedByLabel": addedByLabel]
  case .ended(let reason): return ["kind": "ended", "reason": deviceLinkEndReasonWire(reason)]
  }
}

private func deviceLinkEndReasonWire(_ value: DeviceLinkEndReasonFfi) -> Document {
  switch value {
  case .cancelled: return ["kind": "cancelled"]
  case .cancelledElsewhere: return ["kind": "cancelledElsewhere"]
  case .codesDiffer: return ["kind": "codesDiffer"]
  case .verificationFailed: return ["kind": "verificationFailed"]
  case .timedOut: return ["kind": "timedOut"]
  case .answeredElsewhere: return ["kind": "answeredElsewhere"]
  case .cannotLink: return ["kind": "cannotLink"]
  case .rejected: return ["kind": "rejected"]
  case .linkFailed: return ["kind": "linkFailed"]
  @unknown default: return ["kind": "unsupported", "nativeKind": String(describing: value)]
  }
}

private func deviceLinkEmojiWire(_ value: DeviceLinkEmojiFfi) -> Document {
  ["emoji": value.emoji, "description": value.description]
}

private func linkedDeviceStatusKind(_ value: LinkedDeviceStatusFfi) -> String {
  switch value {
  case .active: return "active"
  case .inactive: return "inactive"
  case .leaving: return "leaving"
  case .moved: return "moved"
  }
}

private func unrecognizedSignInStateKind(_ value: UnrecognizedSignInStateFfi) -> String {
  switch value {
  case .prompt: return "prompt"
  case .notNow: return "notNow"
  case .linkedElsewhere: return "linkedElsewhere"
  case .rejectedElsewhere: return "rejectedElsewhere"
  }
}

private func compromiseWarningReasonWire(_ value: CompromiseWarningReasonFfi) -> Document {
  switch value {
  case .rejectedSignIn: return ["kind": "rejectedSignIn"]
  case .foreignOwnSlotKeyPackage: return ["kind": "foreignOwnSlotKeyPackage"]
  @unknown default: return ["kind": "unsupported", "nativeKind": String(describing: value)]
  }
}

private func accountDevicesActivationKind(_ value: AccountDevicesActivationFfi) -> String {
  switch value {
  case .eligible: return "eligible"
  case .notAdmin: return "notAdmin"
  case .alreadyEnabled: return "alreadyEnabled"
  case .legacyGroup: return "legacyGroup"
  case .membersNeedUpdate: return "membersNeedUpdate"
  case .devicesNeedReplacement: return "devicesNeedReplacement"
  case .deviceLimitExceeded: return "deviceLimitExceeded"
  }
}

private func linkChatProgressWire(_ value: LinkChatProgressFfi) -> Document {
  ["slotIdHex": value.slotIdHex, "onNewDevice": value.onNewDevice,
    "total": Int(value.total), "remaining": Int(value.remaining)]
}

private func deviceGroupMoveWire(_ value: DeviceGroupMoveViewFfi) -> Document {
  let state: String
  switch value.state {
  case .waitingForWelcome: state = "waitingForWelcome"
  case .joining: state = "joining"
  case .made: state = "made"
  case .failed: state = "failed"
  }
  return [
    "moveId": value.moveId,
    "state": ["kind": state],
    "oldSiblings": value.oldSiblings.map { sibling in
      ["slotIdHex": sibling.slotIdHex, "label": sibling.label,
        "questionSuppressed": sibling.questionSuppressed] as Document
    },
    "overriddenRejectionSlots": value.overriddenRejectionSlots,
  ]
}
