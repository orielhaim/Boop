package app.boop.marmot

import dev.ipf.marmotkit.*
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.ModuleDefinitionBuilder

/** Explicit JSON boundary for device and account-security DTOs. */
internal fun deviceLinkSnapshotWire(snapshot: DeviceLinkSnapshotFfi): Document = mapOf(
  "newDevice" to snapshot.newDevice?.let(::newDeviceLinkStateWire),
  "prompts" to snapshot.prompts.map(::deviceLinkPromptWire),
  "moves" to snapshot.moves.map(::deviceGroupMoveWire),
  "deviceGroupStalled" to snapshot.deviceGroupStalled,
  "chatProgress" to snapshot.chatProgress.map(::linkChatProgressWire),
)

internal fun linkedDeviceWire(value: LinkedDeviceFfi): Document = mapOf(
  "slotIdHex" to value.slotIdHex,
  "isThisDevice" to value.isThisDevice,
  "label" to value.label,
  "client" to value.client,
  "platform" to value.platform,
  "linkedAt" to value.linkedAt.toLong(),
  "linkedBySlotIdHex" to value.linkedBySlotIdHex,
  "status" to linkedDeviceStatusWire(value.status),
  "addToAllChats" to value.addToAllChats,
  "bringHistory" to value.bringHistory,
  "keepWhileInactive" to value.keepWhileInactive,
  "lastActiveAt" to value.lastActiveAt?.toLong(),
  "inactive" to value.inactive,
  "removalPending" to value.removalPending,
)

internal fun unrecognizedSignInWire(value: UnrecognizedSignInFfi): Document = mapOf(
  "slotIdHex" to value.slotIdHex,
  "client" to value.client,
  "appearedAt" to value.appearedAt.toLong(),
  "lastSeenAt" to value.lastSeenAt.toLong(),
  "beforeThisDevice" to value.beforeThisDevice,
  "signedIn" to value.signedIn,
  "state" to unrecognizedSignInStateWire(value.state),
  "linkedBySlotIdHex" to value.linkedBySlotIdHex,
  "previouslyLinkedHere" to value.previouslyLinkedHere,
)

internal fun compromiseWarningWire(value: CompromiseWarningItemFfi): Document = mapOf(
  "reason" to compromiseWarningReasonWire(value.reason),
  "slotIdHex" to value.slotIdHex,
  "keyPackageRefHex" to value.keyPackageRefHex,
  "occurredAt" to value.occurredAt.toLong(),
)

internal fun chatHistoryImportWire(value: ChatHistoryImportFfi): Document = mapOf(
  "groupIdHex" to value.groupIdHex,
  "state" to when (val state = value.state) {
    is ChatHistoryImportStateFfi.Receiving -> mapOf("kind" to "receiving", "retrying" to state.retrying)
    is ChatHistoryImportStateFfi.Imported -> mapOf(
      "kind" to "imported",
      "from" to mapOf("deviceSlotIdHex" to state.from.deviceSlotIdHex, "deviceLabel" to state.from.deviceLabel),
      "at" to state.at.toLong(),
    )
  },
)

internal fun accountDevicesActivationWire(value: AccountDevicesActivationFfi): Document = mapOf(
  "kind" to when (value) {
    AccountDevicesActivationFfi.ELIGIBLE -> "eligible"
    AccountDevicesActivationFfi.NOT_ADMIN -> "notAdmin"
    AccountDevicesActivationFfi.ALREADY_ENABLED -> "alreadyEnabled"
    AccountDevicesActivationFfi.LEGACY_GROUP -> "legacyGroup"
    AccountDevicesActivationFfi.MEMBERS_NEED_UPDATE -> "membersNeedUpdate"
    AccountDevicesActivationFfi.DEVICES_NEED_REPLACEMENT -> "devicesNeedReplacement"
    AccountDevicesActivationFfi.DEVICE_LIMIT_EXCEEDED -> "deviceLimitExceeded"
  },
)

private fun deviceLinkPromptWire(value: DeviceLinkPromptFfi): Document = mapOf(
  "promptId" to value.promptId,
  "slotIdHex" to value.slotIdHex,
  "requestedAt" to value.requestedAt.toLong(),
  "state" to deviceLinkPromptStateWire(value.state),
)

private fun newDeviceLinkStateWire(value: NewDeviceLinkStateFfi): Document = when (value) {
  NewDeviceLinkStateFfi.WaitingForAnswer -> mapOf("kind" to "waitingForAnswer")
  is NewDeviceLinkStateFfi.Comparing -> mapOf("kind" to "comparing", "code" to value.code.map(::deviceLinkEmojiWire))
  NewDeviceLinkStateFfi.WaitingForOtherDevice -> mapOf("kind" to "waitingForOtherDevice")
  NewDeviceLinkStateFfi.Joining -> mapOf("kind" to "joining")
  NewDeviceLinkStateFfi.Linked -> mapOf("kind" to "linked")
  is NewDeviceLinkStateFfi.Ended -> mapOf("kind" to "ended", "reason" to deviceLinkEndReasonWire(value.reason))
}

private fun deviceLinkPromptStateWire(value: DeviceLinkPromptStateFfi): Document = when (value) {
  DeviceLinkPromptStateFfi.Preparing -> mapOf("kind" to "preparing")
  is DeviceLinkPromptStateFfi.Comparing -> mapOf("kind" to "comparing", "code" to value.code.map(::deviceLinkEmojiWire))
  DeviceLinkPromptStateFfi.CompetingRequests -> mapOf("kind" to "competingRequests")
  is DeviceLinkPromptStateFfi.RateLimited -> mapOf("kind" to "rateLimited", "retryAt" to value.retryAt.toLong())
  is DeviceLinkPromptStateFfi.CannotLink -> mapOf("kind" to "cannotLink", "missing" to value.missing)
  DeviceLinkPromptStateFfi.TooManyDevices -> mapOf("kind" to "tooManyDevices")
  DeviceLinkPromptStateFfi.Linking -> mapOf("kind" to "linking")
  DeviceLinkPromptStateFfi.Linked -> mapOf("kind" to "linked")
  is DeviceLinkPromptStateFfi.AddedElsewhere -> mapOf(
    "kind" to "addedElsewhere", "deviceLabel" to value.deviceLabel, "addedByLabel" to value.addedByLabel,
  )
  is DeviceLinkPromptStateFfi.Ended -> mapOf("kind" to "ended", "reason" to deviceLinkEndReasonWire(value.reason))
}

private fun deviceLinkEndReasonWire(value: DeviceLinkEndReasonFfi): Document {
  val kind = when (value) {
    DeviceLinkEndReasonFfi.CANCELLED -> "cancelled"
    DeviceLinkEndReasonFfi.CANCELLED_ELSEWHERE -> "cancelledElsewhere"
    DeviceLinkEndReasonFfi.CODES_DIFFER -> "codesDiffer"
    DeviceLinkEndReasonFfi.VERIFICATION_FAILED -> "verificationFailed"
    DeviceLinkEndReasonFfi.TIMED_OUT -> "timedOut"
    DeviceLinkEndReasonFfi.ANSWERED_ELSEWHERE -> "answeredElsewhere"
    DeviceLinkEndReasonFfi.CANNOT_LINK -> "cannotLink"
    DeviceLinkEndReasonFfi.REJECTED -> "rejected"
    DeviceLinkEndReasonFfi.LINK_FAILED -> "linkFailed"
    else -> "unsupported"
  }
  return if (kind == "unsupported") mapOf("kind" to kind, "nativeKind" to value.name)
  else mapOf("kind" to kind)
}

private fun deviceLinkEmojiWire(value: DeviceLinkEmojiFfi): Document = mapOf("emoji" to value.emoji, "description" to value.description)

private fun compromiseWarningReasonWire(value: CompromiseWarningReasonFfi): Document {
  val kind = when (value) {
    CompromiseWarningReasonFfi.REJECTED_SIGN_IN -> "rejectedSignIn"
    CompromiseWarningReasonFfi.FOREIGN_OWN_SLOT_KEY_PACKAGE -> "foreignOwnSlotKeyPackage"
    else -> "unsupported"
  }
  return if (kind == "unsupported") mapOf("kind" to kind, "nativeKind" to value.name)
  else mapOf("kind" to kind)
}

private fun linkedDeviceStatusWire(value: LinkedDeviceStatusFfi): Document = mapOf("kind" to when (value) {
  LinkedDeviceStatusFfi.ACTIVE -> "active"
  LinkedDeviceStatusFfi.INACTIVE -> "inactive"
  LinkedDeviceStatusFfi.LEAVING -> "leaving"
  LinkedDeviceStatusFfi.MOVED -> "moved"
})

private fun unrecognizedSignInStateWire(value: UnrecognizedSignInStateFfi): Document = mapOf("kind" to when (value) {
  UnrecognizedSignInStateFfi.PROMPT -> "prompt"
  UnrecognizedSignInStateFfi.NOT_NOW -> "notNow"
  UnrecognizedSignInStateFfi.LINKED_ELSEWHERE -> "linkedElsewhere"
  UnrecognizedSignInStateFfi.REJECTED_ELSEWHERE -> "rejectedElsewhere"
})

private fun linkChatProgressWire(value: LinkChatProgressFfi): Document = mapOf(
  "slotIdHex" to value.slotIdHex,
  "onNewDevice" to value.onNewDevice,
  "total" to value.total.toLong(),
  "remaining" to value.remaining.toLong(),
)

private fun deviceGroupMoveWire(value: DeviceGroupMoveViewFfi): Document = mapOf(
  "moveId" to value.moveId,
  "state" to mapOf("kind" to when (value.state) {
    DeviceGroupMoveStateFfi.WAITING_FOR_WELCOME -> "waitingForWelcome"
    DeviceGroupMoveStateFfi.JOINING -> "joining"
    DeviceGroupMoveStateFfi.MADE -> "made"
    DeviceGroupMoveStateFfi.FAILED -> "failed"
  }),
  "oldSiblings" to value.oldSiblings.map { mapOf(
    "slotIdHex" to it.slotIdHex, "label" to it.label, "questionSuppressed" to it.questionSuppressed,
  ) },
  "overriddenRejectionSlots" to value.overriddenRejectionSlots,
)

internal fun ModuleDefinitionBuilder.defineDeviceCommands(module: BoopMarmotModule) {
  AsyncFunction("accountIsUnlinked") Coroutine { account: String ->
    module.accountIsUnlinked(account)
  }
  AsyncFunction("accountRecoveryStatus") Coroutine { account: String ->
    module.withSecurityAccount(account) { kit -> accountRecoveryStatusWire(kit.accountRecoveryStatus(account)) }
  }
  AsyncFunction("linkedDevices") Coroutine { account: String ->
    module.withSecurityAccount(account) { kit -> kit.linkedDevices(account).map(::linkedDeviceWire) }
  }
  AsyncFunction("deviceLinkSnapshot") Coroutine { account: String ->
    module.withSecurityAccount(account) { kit -> deviceLinkSnapshotWire(kit.deviceLinkSnapshot(account)) }
  }
  AsyncFunction("startDeviceLink") Coroutine { account: String ->
    module.withSecurityAccount(account) { kit -> deviceLinkSnapshotWire(kit.startDeviceLink(account)) }
  }
  AsyncFunction("cancelDeviceLink") Coroutine { account: String ->
    module.withSecurityAccount(account) { kit -> deviceLinkSnapshotWire(kit.cancelDeviceLink(account)) }
  }
  AsyncFunction("confirmDeviceLinkMatch") Coroutine { account: String, code: List<String> ->
    module.withSecurityAccount(account) { kit ->
      val comparing = kit.deviceLinkSnapshot(account).newDevice as? NewDeviceLinkStateFfi.Comparing
      if (comparing?.code?.map { it.emoji } != code) throw problem("PairingChanged")
      deviceLinkSnapshotWire(kit.confirmDeviceLinkMatch(account))
    }
  }
  AsyncFunction("linkDevice") Coroutine { account: String, prompt: String, code: List<String>, label: String, allChats: Boolean, history: Boolean ->
    module.withSecurityAccount(account) { kit ->
      val comparing = kit.deviceLinkSnapshot(account).prompts.firstOrNull { it.promptId == prompt }?.state as? DeviceLinkPromptStateFfi.Comparing
      if (comparing?.code?.map { it.emoji } != code) throw problem("PairingChanged")
      deviceLinkSnapshotWire(kit.linkDevice(account, prompt, label, allChats, history))
    }
  }
  AsyncFunction("declineDeviceLink") Coroutine { account: String, prompt: String ->
    module.withSecurityAccount(account) { kit -> deviceLinkSnapshotWire(kit.declineDeviceLink(account, prompt)) }
  }
  AsyncFunction("renameLinkedDevice") Coroutine { account: String, slot: String, label: String ->
    module.withSecurityAccount(account) { kit -> kit.renameLinkedDevice(account, slot, label); Unit }
  }
  AsyncFunction("updateLinkedDeviceSettings") Coroutine { account: String, slot: String, allChats: Boolean?, history: Boolean?, keep: Boolean? ->
    module.withSecurityAccount(account) { kit -> kit.updateLinkedDeviceSettings(account, slot, allChats, history, keep); Unit }
  }
  AsyncFunction("removeLinkedDevice") Coroutine { account: String, slot: String ->
    module.withSecurityAccount(account) { kit -> kit.removeLinkedDevice(account, slot); Unit }
  }
  AsyncFunction("unrecognizedSignIns") Coroutine { account: String ->
    module.withSecurityAccount(account) { kit -> kit.unrecognizedSignIns(account).map(::unrecognizedSignInWire) }
  }
  AsyncFunction("checkSignIns") Coroutine { account: String ->
    module.withSecurityAccount(account) { kit -> kit.checkSignIns(account).map(::unrecognizedSignInWire) }
  }
  AsyncFunction("answerSignIn") Coroutine { account: String, slot: String, response: String ->
    module.withSecurityAccount(account) { kit ->
      val answer = when (response) {
        "notNow" -> SignInResponseFfi.NOT_NOW
        "reject" -> SignInResponseFfi.REJECT
        "dismiss" -> SignInResponseFfi.DISMISS
        else -> throw problem("InvalidSignInResponse")
      }
      kit.answerSignIn(account, slot, answer)
    }
  }
  AsyncFunction("compromiseWarning") Coroutine { account: String ->
    module.withSecurityAccount(account) { kit -> kit.compromiseWarning(account).map(::compromiseWarningWire) }
  }
  AsyncFunction("dismissCompromiseWarning") Coroutine { account: String ->
    module.withSecurityAccount(account) { kit -> kit.dismissCompromiseWarning(account); Unit }
  }
  AsyncFunction("startFresh") Coroutine { account: String ->
    module.withSecurityAccount(account) { kit -> kit.startFresh(account); Unit }
  }
  AsyncFunction("startedFresh") Coroutine { account: String ->
    module.withSecurityAccount(account) { kit -> kit.startedFresh(account) }
  }
  AsyncFunction("chatHistoryImports") Coroutine { account: String ->
    module.withSecurityAccount(account) { kit -> kit.chatHistoryImports(account).map(::chatHistoryImportWire) }
  }
  AsyncFunction("keyPackageRefreshOverdue") Coroutine { account: String ->
    module.withSecurityAccount(account) { kit -> kit.keyPackageRefreshOverdue(account) }
  }
  AsyncFunction("removedDeviceLeftoverChats") Coroutine { account: String ->
    module.withSecurityAccount(account) { kit -> kit.removedDeviceLeftoverChats(account).toInt() }
  }
  AsyncFunction("chatsClosedToLinkedDevices") Coroutine { account: String ->
    module.withSecurityAccount(account) { kit -> kit.chatsClosedToLinkedDevices(account).toInt() }
  }
  AsyncFunction("resetDeviceGroupForRepair") Coroutine { account: String ->
    module.withSecurityAccount(account) { kit -> deviceLinkSnapshotWire(kit.resetDeviceGroupForRepair(account)) }
  }
  AsyncFunction("rotateKeyPackage") Coroutine { account: String ->
    module.withSecurityAccount(account) { kit -> kit.rotateKeyPackage(account); Unit }
  }
  AsyncFunction("dismissDeviceGroupMoveSibling") Coroutine { account: String, move: String, slot: String ->
    module.withSecurityAccount(account) { kit -> deviceLinkSnapshotWire(kit.dismissDeviceGroupMoveSibling(account, move, slot)) }
  }
  AsyncFunction("accountDevicesActivation") Coroutine { account: String, group: String ->
    module.withSecurityAccount(account) { kit -> accountDevicesActivationWire(kit.accountDevicesActivation(account, group)) }
  }
  AsyncFunction("enableAccountDevices") Coroutine { account: String, group: String ->
    module.withSecurityAccount(account) { kit -> kit.enableAccountDevices(account, group); Unit }
  }
}

private fun accountRecoveryStatusWire(status: AccountRecoveryStatusFfi): Document = mapOf(
  "catchingUpGroupIdsHex" to status.catchingUpGroupIdsHex,
  "inboxCatchingUp" to status.inboxCatchingUp,
  "notices" to status.notices.map { notice ->
    mapOf("noticeId" to notice.noticeId, "groupIdHex" to notice.groupIdHex, "parkedAtMs" to notice.parkedAtMs?.toLong(),
      "cause" to when (notice.cause) {
        HistoryNoticeCauseFfi.DELIVERY_LOSS -> "deliveryLoss"
        HistoryNoticeCauseFfi.NOTIFICATION_LOSS -> "notificationLoss"
        HistoryNoticeCauseFfi.EPOCH_GAP -> "epochGap"
        HistoryNoticeCauseFfi.INCREMENTAL_HISTORY -> "incrementalHistory"
        HistoryNoticeCauseFfi.EXPLICIT_REPAIR -> "explicitRepair"
        HistoryNoticeCauseFfi.KNOWN_EVENT -> "knownEvent"
        HistoryNoticeCauseFfi.MAINTENANCE_BOUNDARY -> "maintenanceBoundary"
        HistoryNoticeCauseFfi.UNPROVEN_HISTORY -> "unprovenHistory"
        HistoryNoticeCauseFfi.BEFORE_REJOIN -> "beforeRejoin"
      })
  },
)
