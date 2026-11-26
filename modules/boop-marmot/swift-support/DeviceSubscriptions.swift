// Appended to MarmotKit.swift so these receives use the same cancellation
// bridge as the existing chat, directory, and blocked-user subscriptions.
extension EventsSubscription {
  public func nextCancellable() async throws -> MarmotEventFfi? {
    try Task.checkCancellation()
    return try await cancellableProjectionNext(
      uniffi_marmot_uniffi_fn_method_eventssubscription_next(uniffiClonePointer()),
      read: FfiConverterTypeMarmotEventFfi.read
    )
  }
}

extension BackupRestoreSubscription {
  public func nextCancellable() async throws -> BackupRestoreStatusFfi? {
    try Task.checkCancellation()
    return try await cancellableProjectionNext(
      uniffi_marmot_uniffi_fn_method_backuprestoresubscription_next(uniffiClonePointer()),
      read: FfiConverterTypeBackupRestoreStatusFfi.read
    )
  }
}
