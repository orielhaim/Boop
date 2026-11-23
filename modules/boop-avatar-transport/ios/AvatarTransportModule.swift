import CryptoKit
import Darwin
import ExpoModulesCore
import Foundation
import ImageIO
import Network
import UniformTypeIdentifiers

private enum AvatarTransferError: Error {
  case unavailable, destination, response, image, size, hash, missing, status(Int), range, publish, exists, storageFull
}

public final class AvatarTransportModule: Module {
  private let lock = NSLock()
  private var jobs: [String: DownloadJob] = [:]
  private var isForeground = true
  private var foregroundGeneration: UInt64 = 0

  public func definition() -> ModuleDefinition {
    Name("BoopAvatarTransport")
    Events("attachmentProgress", "uploadProgress")
    OnAppEntersBackground {
      let pending = self.lock.withLock { () -> [DownloadJob] in
        self.isForeground = false
        self.foregroundGeneration &+= 1
        return self.jobs.values.filter(\.cancelOnBackground)
      }
      pending.forEach { $0.cancel() }
    }
    OnAppBecomesActive {
      self.lock.withLock {
        self.isForeground = true
        self.foregroundGeneration &+= 1
      }
    }

    Function("available") {
      if #available(iOS 17.0, *) { return true }
      return false
    }

    Function("prepare") { (id: String) in
      self.lock.lock()
      defer { self.lock.unlock() }
      guard self.jobs[id] == nil else { throw AvatarTransferError.unavailable }
      self.jobs[id] = DownloadJob(foregroundGeneration: self.foregroundGeneration)
    }

    Function("cancel") { (id: String) in
      self.getJob(id)?.cancel()
    }

    AsyncFunction("download") { (id: String, url: String, output: String, hash: String?, attachmentLimit: Int?, promise: Promise) in
      self.transfer(id, url, output, hash, attachmentLimit, nil, promise)
    }
    AsyncFunction("downloadBlossom") { (id: String, url: String, output: String, hash: String, expectedSize: Int?, promise: Promise) in
      guard let job = self.getJob(id) else {
        promise.reject("MEDIA_OPERATION_MISSING", "Media operation missing")
        return
      }
      let foreground = self.lock.withLock { (self.isForeground, self.foregroundGeneration) }
      guard job.admitBlossom(isForeground: foreground.0, generation: foreground.1) else {
        job.cancel()
        self.removeJob(id)
        promise.reject("MEDIA_CANCELLED", "Blossom download cancelled")
        return
      }
      let task = Task { @MainActor in
        defer { self.removeJob(id) }
        do {
          guard #available(iOS 17.0, *) else { throw AvatarTransferError.unavailable }
          let size = try await downloadBlossomMedia(url, output, hash, expectedSize, job) { received, total in
            self.sendEvent("attachmentProgress", ["id": id, "received": received, "total": total])
          }
          promise.resolve(size)
        } catch AvatarTransferError.missing {
          promise.reject("MEDIA_MISSING", "Media not found")
        } catch AvatarTransferError.hash {
          promise.reject("MEDIA_INTEGRITY", "Media hash mismatch")
        } catch AvatarTransferError.size {
          promise.reject("MEDIA_TOO_LARGE", "Blossom download exceeded its limit")
        } catch AvatarTransferError.status(let code) {
          let kind = code == 408 || code == 425 || code == 429 || (500...599).contains(code)
            ? "TEMPORARY" : "PERMANENT"
          promise.reject("MEDIA_HTTP_\(kind)_\(code)", "Blossom download failed with HTTP \(code)")
        } catch AvatarTransferError.destination {
          promise.reject("MEDIA_DESTINATION", "Blossom destination rejected")
        } catch AvatarTransferError.exists {
          promise.reject("MEDIA_EXISTS", "Blossom file already exists")
        } catch AvatarTransferError.range {
          promise.reject("MEDIA_RANGE", "Blossom resume response was invalid")
        } catch AvatarTransferError.publish {
          promise.reject("MEDIA_PUBLISH", "Blossom file could not be published")
        } catch AvatarTransferError.storageFull {
          promise.reject("MEDIA_STORAGE_FULL", "Not enough storage for the Blossom download")
        } catch is CancellationError {
          promise.reject("MEDIA_CANCELLED", "Blossom download cancelled")
        } catch {
          promise.reject("MEDIA_DOWNLOAD", "Blossom download failed")
        }
      }
      job.attach(task)
    }
    AsyncFunction("downloadNip05") { (id: String, url: String, output: String, promise: Promise) in
      self.transfer(id, url, output, nil, nil, false, promise, nip05: true)
    }
    AsyncFunction("downloadPreview") { (id: String, url: String, output: String, image: Bool, promise: Promise) in
      self.transfer(id, url, output, nil, nil, image, promise)
    }
    AsyncFunction("blossomCommand") { (id: String, url: String, headers: [String: String], body: String?, promise: Promise) in
      guard let job = self.getJob(id) else {
        promise.reject("MEDIA_PREFLIGHT", "Media operation missing")
        return
      }
      let task = Task.detached {
        defer { self.removeJob(id) }
        do {
          guard #available(iOS 17.0, *) else { throw AvatarTransferError.unavailable }
          promise.resolve(try await blossomCommand(url, headers, body))
        } catch {
          promise.reject("MEDIA_PREFLIGHT", "Blossom compatibility check failed")
        }
      }
      job.attach(task)
    }
    AsyncFunction("uploadAttachment") { (id: String, url: String, source: String, headers: [String: String], size: Int, promise: Promise) in
      guard let job = self.getJob(id) else {
        promise.reject("MEDIA_UPLOAD", "Media operation missing")
        return
      }
      let task = Task.detached {
        defer { self.removeJob(id) }
        do {
          guard #available(iOS 17.0, *) else { throw AvatarTransferError.unavailable }
          let result = try await uploadMedia(url, source, headers, size) { sent in
            self.sendEvent("uploadProgress", ["id": id, "sent": sent])
          }
          promise.resolve(result)
        } catch {
          promise.reject("MEDIA_UPLOAD", "Media upload failed")
        }
      }
      job.attach(task)
    }
  }

  private func transfer(_ id: String, _ url: String, _ output: String, _ hash: String?,
                        _ attachmentLimit: Int?, _ previewImage: Bool?, _ promise: Promise, nip05: Bool = false) {
      guard let job = self.getJob(id) else {
        promise.reject("AVATAR_UNAVAILABLE", "Avatar operation missing")
        return
      }
      let task = Task.detached {
        defer { self.removeJob(id) }
        do {
          guard #available(iOS 17.0, *) else { throw AvatarTransferError.unavailable }
          let size = try await downloadMedia(url, output, hash, attachmentLimit, previewImage, job, nip05: nip05) { received, total in
            self.sendEvent("attachmentProgress", ["id": id, "received": received, "total": total])
          }
          promise.resolve(size)
        } catch AvatarTransferError.missing {
          promise.reject("MEDIA_MISSING", "Media not found")
        } catch AvatarTransferError.hash {
          promise.reject("MEDIA_INTEGRITY", "Media hash mismatch")
        } catch {
          promise.reject("AVATAR_DOWNLOAD", "Avatar download failed")
        }
      }
      job.attach(task)
  }

  private func getJob(_ id: String) -> DownloadJob? {
    lock.lock()
    defer { lock.unlock() }
    return jobs[id]
  }

  private func removeJob(_ id: String) {
    lock.lock()
    defer { lock.unlock() }
    jobs.removeValue(forKey: id)
  }
}

private final class DownloadJob: @unchecked Sendable {
  private let lock = NSLock()
  private let foregroundGeneration: UInt64
  private var cancelled = false
  private var task: Task<Void, Never>?
  private var _cancelOnBackground = false

  init(foregroundGeneration: UInt64) {
    self.foregroundGeneration = foregroundGeneration
  }

  var cancelOnBackground: Bool {
    get {
      lock.lock()
      defer { lock.unlock() }
      return _cancelOnBackground
    }
    set {
      lock.lock()
      defer { lock.unlock() }
      _cancelOnBackground = newValue
    }
  }

  func admitBlossom(isForeground: Bool, generation: UInt64) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard isForeground, generation == foregroundGeneration, !cancelled else { return false }
    _cancelOnBackground = true
    return true
  }

  func attach(_ task: Task<Void, Never>) {
    lock.lock()
    defer { lock.unlock() }
    self.task = task
    if cancelled { task.cancel() }
  }

  func check() throws {
    lock.lock()
    defer { lock.unlock() }
    if cancelled { throw CancellationError() }
  }

  func publish(_ action: () throws -> Void) throws {
    lock.lock()
    defer { lock.unlock() }
    if cancelled { throw CancellationError() }
    try action()
  }

  func cancel() {
    lock.lock()
    defer { lock.unlock() }
    cancelled = true
    task?.cancel()
  }
}

private let imageTypes = Set(["image/jpeg", "image/png", "image/webp"])
private let maxBytes = 2 * 1024 * 1024
private let maxBlossomBytes: Int64 = 1024 * 1024 * 1024

internal struct BlossomContentRange {
  let start: Int64
  let end: Int64
  let total: Int64
}

internal func parseBlossomContentRange(_ value: String?) -> BlossomContentRange? {
  guard let value,
        let match = value.range(of: #"^bytes (\d+)-(\d+)/(\d+)$"#, options: .regularExpression) else {
    return nil
  }
  let fields = value[match].split(whereSeparator: { $0 == " " || $0 == "-" || $0 == "/" })
  guard fields.count == 4, let start = Int64(fields[1]), let end = Int64(fields[2]),
        let total = Int64(fields[3]), total > 0, start <= end, end < total else { return nil }
  return BlossomContentRange(start: start, end: end, total: total)
}

private func isStorageFull(_ error: Error) -> Bool {
  let value = error as NSError
  return (value.domain == NSPOSIXErrorDomain && value.code == Int(ENOSPC)) ||
    (value.domain == NSCocoaErrorDomain && value.code == CocoaError.Code.fileWriteOutOfSpace.rawValue)
}

private func writeBlossomChunk(_ data: Data, to handle: FileHandle) throws {
  do { try handle.write(contentsOf: data) }
  catch {
    if isStorageFull(error) { throw AvatarTransferError.storageFull }
    throw error
  }
}

private func blossomHost(_ url: URL) -> String? {
  guard url.scheme == "https", let host = url.host, url.user == nil, url.password == nil,
        url.port == nil || url.port == 443,
        host.range(of: #"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$"#, options: .regularExpression) != nil,
        host.range(of: #"\.(localhost|local|internal|lan|home|test|invalid|example|onion|arpa)$"#, options: .regularExpression) == nil
  else { return nil }
  return host
}

@available(iOS 17.0, *)
private func downloadBlossomMedia(
  _ input: String, _ output: String, _ hash: String, _ expectedSize: Int?, _ job: DownloadJob,
  _ progress: (Int64, Int64) -> Void
) async throws -> Int {
  guard hash.range(of: #"^[0-9a-f]{64}$"#, options: .regularExpression) != nil,
        expectedSize == nil || (expectedSize! >= 0 && Int64(expectedSize!) <= maxBlossomBytes),
        var url = URL(string: input), blossomHost(url) != nil,
        let destination = URL(string: output), destination.isFileURL,
        destination.lastPathComponent == "\(hash).bin"
  else { throw AvatarTransferError.destination }
  try job.check()
  let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
    .standardizedFileURL.resolvingSymlinksInPath()
  let root = documents.appendingPathComponent("blossom-downloads", isDirectory: true)
  let target = destination.standardizedFileURL
  let scope = target.deletingLastPathComponent()
  guard scope.lastPathComponent.range(of: #"^[0-9a-f]{64}$"#, options: .regularExpression) != nil,
        scope.deletingLastPathComponent().standardizedFileURL == root.standardizedFileURL else {
    throw AvatarTransferError.destination
  }
  do { try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true) }
  catch {
    if isStorageFull(error) { throw AvatarTransferError.storageFull }
    throw error
  }
  guard root.resolvingSymlinksInPath() == root.standardizedFileURL else {
    throw AvatarTransferError.destination
  }
  do { try FileManager.default.createDirectory(at: scope, withIntermediateDirectories: true) }
  catch {
    if isStorageFull(error) { throw AvatarTransferError.storageFull }
    throw error
  }
  let resolvedRoot = root.resolvingSymlinksInPath()
  let resolvedScope = scope.resolvingSymlinksInPath()
  guard resolvedRoot == root.standardizedFileURL,
        resolvedScope.deletingLastPathComponent() == resolvedRoot,
        target.deletingLastPathComponent().resolvingSymlinksInPath() == resolvedScope else {
    throw AvatarTransferError.destination
  }
  if FileManager.default.fileExists(atPath: target.path) { throw AvatarTransferError.exists }
  let incoming = target.appendingPathExtension("download")
  if (try? FileManager.default.destinationOfSymbolicLink(atPath: incoming.path)) != nil {
    throw AvatarTransferError.destination
  }
  var offset: Int64 = 0
  if FileManager.default.fileExists(atPath: incoming.path) {
    guard let attrs = try? FileManager.default.attributesOfItem(atPath: incoming.path),
          let size = attrs[.size] as? NSNumber else { throw AvatarTransferError.destination }
    guard (attrs[.type] as? FileAttributeType) == .typeRegular,
          incoming.resolvingSymlinksInPath() == incoming.standardizedFileURL else {
      throw AvatarTransferError.destination
    }
    offset = size.int64Value
  } else {
    guard FileManager.default.createFile(atPath: incoming.path, contents: Data()) else {
      throw AvatarTransferError.storageFull
    }
  }
  if offset > maxBlossomBytes || (expectedSize != nil && offset > Int64(expectedSize!)) {
    try? FileManager.default.removeItem(at: incoming)
    guard FileManager.default.createFile(atPath: incoming.path, contents: Data()) else {
      throw AvatarTransferError.storageFull
    }
    offset = 0
  }
  var digest = SHA256()
  if offset > 0 {
    let existing = try FileHandle(forReadingFrom: incoming)
    defer { try? existing.close() }
    while true {
      try job.check()
      let data = try existing.read(upToCount: 64 * 1024) ?? Data()
      if data.isEmpty { break }
      digest.update(data: data)
    }
  }

  var restarted = false
  var redirects = 0
  while true {
    try job.check()
    guard let host = blossomHost(url) else { throw AvatarTransferError.destination }
    let gate = try AvatarConnectGate(host: host, addresses: publicAddresses(host))
    defer { gate.close() }
    let endpoint = try await gate.start()
    try Task.checkCancellation()
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 20
    configuration.timeoutIntervalForResource = 3600
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.urlCredentialStorage = nil
    configuration.urlCache = nil
    var proxy = ProxyConfiguration(httpCONNECTProxy: endpoint)
    proxy.allowFailover = false
    configuration.proxyConfigurations = [proxy]
    let session = URLSession(configuration: configuration, delegate: NoAvatarRedirect(), delegateQueue: nil)
    defer { session.invalidateAndCancel() }
    var request = URLRequest(url: url)
    request.setValue("application/octet-stream", forHTTPHeaderField: "Accept")
    request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
    if offset > 0 { request.setValue("bytes=\(offset)-", forHTTPHeaderField: "Range") }
    let (stream, response) = try await session.bytes(for: request)
    guard let http = response as? HTTPURLResponse else { throw AvatarTransferError.response }
    if [301, 302, 303, 307, 308].contains(http.statusCode) {
      guard redirects < 3, let location = http.value(forHTTPHeaderField: "Location"),
            let next = URL(string: location, relativeTo: url)?.absoluteURL, blossomHost(next) != nil
      else { throw AvatarTransferError.status(http.statusCode) }
      url = next
      redirects += 1
      continue
    }
    if http.statusCode == 404 { throw AvatarTransferError.missing }
    if offset > 0 && (http.statusCode == 200 || http.statusCode == 416) {
      guard !restarted else { throw AvatarTransferError.range }
      try? FileManager.default.removeItem(at: incoming)
      guard FileManager.default.createFile(atPath: incoming.path, contents: Data()) else {
        throw AvatarTransferError.storageFull
      }
      offset = 0
      digest = SHA256()
      restarted = true
      continue
    }
    let total: Int64?
    if http.statusCode == 206 {
      guard let range = parseBlossomContentRange(http.value(forHTTPHeaderField: "Content-Range")),
            range.start == offset, range.end + 1 == range.total,
            response.expectedContentLength >= 0,
            range.end - range.start + 1 == response.expectedContentLength else {
        throw AvatarTransferError.range
      }
      total = range.total
    } else if http.statusCode == 200 && offset == 0 {
      total = response.expectedContentLength >= 0 ? response.expectedContentLength : nil
    } else {
      throw AvatarTransferError.status(http.statusCode)
    }
    if let total, total > maxBlossomBytes || (expectedSize != nil && total != Int64(expectedSize!)) {
      try? FileManager.default.removeItem(at: incoming)
      throw AvatarTransferError.hash
    }
    let handle = try FileHandle(forWritingTo: incoming)
    try handle.seekToEnd()
    defer { try? handle.close() }
    var buffer = Data()
    buffer.reserveCapacity(64 * 1024)
    var received = offset
    for try await byte in stream {
      try job.check()
      received += 1
      if received > maxBlossomBytes || (expectedSize != nil && received > Int64(expectedSize!)) {
        try? FileManager.default.removeItem(at: incoming)
        throw AvatarTransferError.size
      }
      buffer.append(byte)
      if buffer.count == 64 * 1024 {
        digest.update(data: buffer)
        try writeBlossomChunk(buffer, to: handle)
        buffer.removeAll(keepingCapacity: true)
        progress(received, Int64(expectedSize ?? Int(total ?? -1)))
      }
    }
    if !buffer.isEmpty {
      digest.update(data: buffer)
      try writeBlossomChunk(buffer, to: handle)
    }
    do { try handle.synchronize() }
    catch {
      if isStorageFull(error) { throw AvatarTransferError.storageFull }
      throw error
    }
    if let total, received != total { throw AvatarTransferError.response }
    if expectedSize != nil && received != Int64(expectedSize!) {
      try? FileManager.default.removeItem(at: incoming)
      throw AvatarTransferError.hash
    }
    guard digest.finalize().map({ String(format: "%02x", $0) }).joined() == hash else {
      try? FileManager.default.removeItem(at: incoming)
      throw AvatarTransferError.hash
    }
    try job.publish {
      guard !FileManager.default.fileExists(atPath: target.path) else { throw AvatarTransferError.exists }
      do { try FileManager.default.moveItem(at: incoming, to: target) }
      catch {
        if isStorageFull(error) { throw AvatarTransferError.storageFull }
        throw AvatarTransferError.publish
      }
    }
    progress(received, Int64(expectedSize ?? Int(total ?? -1)))
    return Int(received)
  }
}

@available(iOS 17.0, *)
private func downloadMedia(
  _ input: String, _ output: String, _ hash: String?, _ attachmentLimit: Int?, _ previewImage: Bool?, _ job: DownloadJob, nip05: Bool,
  _ progress: (Int, Int64) -> Void
) async throws -> Int {
  let html = previewImage == false && !nip05
  let images = attachmentLimit == nil && !html && !nip05
  let limit = nip05 ? 64 * 1024 : html ? 512 * 1024 : attachmentLimit ?? maxBytes
  guard attachmentLimit == nil || ((17...(32 * 1024 * 1024)).contains(limit) &&
    hash?.range(of: #"^[0-9a-f]{64}$"#, options: .regularExpression) != nil)
  else { throw AvatarTransferError.destination }
  try job.check()
  guard let url = URL(string: input), url.scheme == "https",
        let host = url.host, url.user == nil, url.password == nil,
        url.port == nil || url.port == 443,
        host.range(of: #"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$"#, options: .regularExpression) != nil,
        host.range(of: #"\.(localhost|local|internal|lan|home|test|invalid|example|onion|arpa)$"#, options: .regularExpression) == nil,
        let destination = URL(string: output), destination.isFileURL,
        destination.pathExtension == (images ? "jpg" : html ? "html" : "bin"),
        let directory = FileManager.default.urls(for: previewImage == nil && images ? .documentDirectory : .cachesDirectory, in: .userDomainMask).first
  else { throw AvatarTransferError.destination }
  let root = directory.appendingPathComponent(previewImage != nil ? "link-previews" : images ? "avatar-cache" : "attachment-work").resolvingSymlinksInPath()
  let target = destination.resolvingSymlinksInPath()
  guard target.path.hasPrefix(root.path + "/") else { throw AvatarTransferError.destination }

  let addresses = try publicAddresses(host)
  try Task.checkCancellation()
  let gate = try AvatarConnectGate(host: host, addresses: addresses)
  defer { gate.close() }
  let endpoint = try await gate.start()
  try Task.checkCancellation()

  let configuration = URLSessionConfiguration.ephemeral
  configuration.timeoutIntervalForRequest = 8
  configuration.timeoutIntervalForResource = attachmentLimit == nil ? 12 : 295
  configuration.httpCookieStorage = nil
  configuration.httpShouldSetCookies = false
  configuration.urlCredentialStorage = nil
  configuration.urlCache = nil
  var proxy = ProxyConfiguration(httpCONNECTProxy: endpoint)
  proxy.allowFailover = false
  configuration.proxyConfigurations = [proxy]
  let session = URLSession(configuration: configuration, delegate: NoAvatarRedirect(), delegateQueue: nil)
  defer { session.invalidateAndCancel() }
  var request = URLRequest(url: url)
  request.setValue(nip05 ? "application/json" : html ? "text/html" : images ? "image/jpeg, image/png, image/webp" : "*/*", forHTTPHeaderField: "Accept")
  request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
  try job.check()
  let (stream, response) = try await session.bytes(for: request)
  if attachmentLimit != nil && (response as? HTTPURLResponse)?.statusCode == 404 {
    throw AvatarTransferError.missing
  }
  guard let http = response as? HTTPURLResponse, http.statusCode == 200,
        !images || imageTypes.contains(response.mimeType ?? ""),
        !html || response.mimeType == "text/html",
        !nip05 || response.mimeType == "application/json" || response.mimeType == "text/plain",
        response.expectedContentLength <= limit
  else { throw AvatarTransferError.response }
  if attachmentLimit != nil {
    let incoming = target.appendingPathExtension("download")
    defer { try? FileManager.default.removeItem(at: incoming) }
    try Data().write(to: incoming, options: [.withoutOverwriting])
    let handle = try FileHandle(forWritingTo: incoming)
    defer { try? handle.close() }
    var digest = SHA256()
    var chunk = Data()
    chunk.reserveCapacity(64 * 1024)
    var count = 0
    for try await byte in stream {
      guard count < limit else { throw AvatarTransferError.size }
      chunk.append(byte)
      count += 1
      if chunk.count == 64 * 1024 {
        try job.check()
        digest.update(data: chunk)
        try handle.write(contentsOf: chunk)
        chunk.removeAll(keepingCapacity: true)
        progress(count, response.expectedContentLength)
      }
    }
    digest.update(data: chunk)
    guard count >= 17,
          response.expectedContentLength < 0 || response.expectedContentLength == Int64(count),
          digest.finalize().map({ String(format: "%02x", $0) }).joined() == hash
    else { throw AvatarTransferError.hash }
    try handle.write(contentsOf: chunk)
    try job.check()
    try FileManager.default.moveItem(at: incoming, to: target)
    return count
  }
  var data = Data()
  for try await byte in stream {
    guard data.count < limit else { throw AvatarTransferError.size }
    data.append(byte)
  }
  if let hash, SHA256.hash(data: data).map({ String(format: "%02x", $0) }).joined() != hash {
    throw AvatarTransferError.hash
  }
  if !images {
    try Task.checkCancellation()
    guard !data.isEmpty else { throw AvatarTransferError.size }
    try data.write(to: target, options: [.withoutOverwriting])
    return data.count
  }
  let options = [kCGImageSourceShouldCache: false] as CFDictionary
  guard let source = CGImageSourceCreateWithData(data as CFData, options),
        CGImageSourceGetCount(source) == 1,
        CGImageSourceGetStatus(source) == .statusComplete,
        let kind = CGImageSourceGetType(source),
        let type = UTType(kind as String)?.preferredMIMEType, imageTypes.contains(type),
        let info = CGImageSourceCopyPropertiesAtIndex(source, 0, options) as? [CFString: Any],
        let width = info[kCGImagePropertyPixelWidth] as? Int,
        let height = info[kCGImagePropertyPixelHeight] as? Int,
        (1...4096).contains(width), (1...4096).contains(height),
        width * height <= 8_000_000,
        let bitmap = CGImageSourceCreateThumbnailAtIndex(source, 0, [
          kCGImageSourceThumbnailMaxPixelSize: 512,
          kCGImageSourceCreateThumbnailFromImageAlways: true,
          kCGImageSourceCreateThumbnailWithTransform: true,
        ] as CFDictionary),
        let buffer = CFDataCreateMutable(nil, 0),
        let encoder = CGImageDestinationCreateWithData(buffer, UTType.jpeg.identifier as CFString, 1, nil)
  else { throw AvatarTransferError.image }
  CGImageDestinationAddImage(encoder, bitmap, [kCGImageDestinationLossyCompressionQuality: 0.86] as CFDictionary)
  guard CGImageDestinationFinalize(encoder) else { throw AvatarTransferError.image }
  try Task.checkCancellation()
  let bytes = buffer as Data
  try bytes.write(to: target, options: .atomic)
  return bytes.count
}

@available(iOS 17.0, *)
private func blossomCommand(_ input: String, _ headers: [String: String], _ body: String?) async throws -> [String: Any] {
  guard let url = URL(string: input), url.scheme == "https",
        let host = url.host, url.user == nil, url.password == nil,
        url.port == nil || url.port == 443, url.path == (body == nil ? "/upload" : "/mirror"),
        (body?.utf8.count ?? 0) <= 8192,
        url.query == nil, url.fragment == nil,
        host.range(of: #"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$"#, options: .regularExpression) != nil,
        host.range(of: #"\.(localhost|local|internal|lan|home|test|invalid|example|onion|arpa)$"#, options: .regularExpression) == nil
  else { throw AvatarTransferError.destination }
  let gate = try AvatarConnectGate(host: host, addresses: try publicAddresses(host))
  defer { gate.close() }
  let endpoint = try await gate.start()
  try Task.checkCancellation()
  let configuration = URLSessionConfiguration.ephemeral
  configuration.timeoutIntervalForResource = 12
  configuration.httpCookieStorage = nil
  configuration.httpShouldSetCookies = false
  configuration.urlCredentialStorage = nil
  configuration.urlCache = nil
  var proxy = ProxyConfiguration(httpCONNECTProxy: endpoint)
  proxy.allowFailover = false
  configuration.proxyConfigurations = [proxy]
  var request = URLRequest(url: url)
  request.httpMethod = body == nil ? "HEAD" : "PUT"
  request.httpBody = body.map { Data($0.utf8) }
  request.allHTTPHeaderFields = headers
  let session = URLSession(configuration: configuration, delegate: NoAvatarRedirect(), delegateQueue: nil)
  defer { session.invalidateAndCancel() }
  let (bytes, response) = try await session.bytes(for: request)
  guard let http = response as? HTTPURLResponse else { throw AvatarTransferError.destination }
  var data = Data()
  if body != nil {
    for try await byte in bytes {
      guard data.count < 8192 else { throw AvatarTransferError.size }
      data.append(byte)
    }
  }
  return ["status": http.statusCode, "body": String(decoding: data, as: UTF8.self)]
}

private class NoAvatarRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
  func urlSession(_ session: URLSession, task: URLSessionTask,
                  willPerformHTTPRedirection response: HTTPURLResponse,
                  newRequest request: URLRequest,
                  completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
  }
}

private final class MediaUploadResponse: NoAvatarRedirect, URLSessionDataDelegate, @unchecked Sendable {
  private let continuation: CheckedContinuation<(Int, String), Error>
  private let progress: (Int64) -> Void
  private var data = Data()

  init(_ continuation: CheckedContinuation<(Int, String), Error>, _ progress: @escaping (Int64) -> Void) {
    self.continuation = continuation
    self.progress = progress
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    guard data.count <= 8192 - self.data.count else {
      dataTask.cancel()
      return
    }
    self.data.append(data)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
                  totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
    progress(totalBytesSent)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    if let error {
      continuation.resume(throwing: error)
    } else if let response = task.response as? HTTPURLResponse,
              let body = String(data: data, encoding: .utf8) {
      continuation.resume(returning: (response.statusCode, body))
    } else {
      continuation.resume(throwing: AvatarTransferError.response)
    }
  }
}

@available(iOS 17.0, *)
private func uploadMedia(
  _ input: String, _ source: String, _ headers: [String: String], _ size: Int,
  _ progress: @escaping (Int64) -> Void
) async throws -> [String: Any] {
  guard let url = URL(string: input), url.scheme == "https",
        let host = url.host, url.user == nil, url.password == nil,
        url.port == nil || url.port == 443, url.path == "/upload",
        url.query == nil, url.fragment == nil,
        host.range(of: #"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$"#, options: .regularExpression) != nil,
        host.range(of: #"\.(localhost|local|internal|lan|home|test|invalid|example|onion|arpa)$"#, options: .regularExpression) == nil,
        let file = URL(string: source)?.resolvingSymlinksInPath(), file.isFileURL,
        let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
        file.path.hasPrefix(directory.appendingPathComponent("attachment-blobs").resolvingSymlinksInPath().path + "/"),
        file.lastPathComponent.range(of: #"^sent-[0-9a-f]{64}\.bin$"#, options: .regularExpression) != nil,
        (17...(32 * 1024 * 1024)).contains(size),
        try file.resourceValues(forKeys: [.fileSizeKey]).fileSize == size
  else { throw AvatarTransferError.destination }
  let addresses = try publicAddresses(host)
  try Task.checkCancellation()
  let gate = try AvatarConnectGate(host: host, addresses: addresses)
  defer { gate.close() }
  let endpoint = try await gate.start()
  try Task.checkCancellation()
  let configuration = URLSessionConfiguration.ephemeral
  configuration.timeoutIntervalForRequest = 20
  configuration.timeoutIntervalForResource = 300
  configuration.httpCookieStorage = nil
  configuration.httpShouldSetCookies = false
  configuration.urlCredentialStorage = nil
  configuration.urlCache = nil
  var proxy = ProxyConfiguration(httpCONNECTProxy: endpoint)
  proxy.allowFailover = false
  configuration.proxyConfigurations = [proxy]
  var request = URLRequest(url: url)
  request.httpMethod = "PUT"
  request.allHTTPHeaderFields = headers
  request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
  let cancellation = UploadCancellation()
  let (status, body) = try await withTaskCancellationHandler {
    try await withCheckedThrowingContinuation { continuation in
      let delegate = MediaUploadResponse(continuation, progress)
      let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
      let task = session.uploadTask(with: request, fromFile: file)
      cancellation.start(task)
      session.finishTasksAndInvalidate()
    }
  } onCancel: {
    cancellation.cancel()
  }
  return ["status": status, "body": body]
}

private final class UploadCancellation: @unchecked Sendable {
  private let lock = NSLock()
  private var task: URLSessionUploadTask?
  private var cancelled = false

  func start(_ task: URLSessionUploadTask) {
    lock.lock()
    defer { lock.unlock() }
    self.task = task
    if cancelled { task.cancel() } else { task.resume() }
  }

  func cancel() {
    lock.lock()
    defer { lock.unlock() }
    cancelled = true
    task?.cancel()
  }
}

private func publicAddresses(_ host: String) throws -> [NWEndpoint.Host] {
  var hints = addrinfo()
  hints.ai_socktype = SOCK_STREAM
  hints.ai_flags = AI_NUMERICSERV
  var result: UnsafeMutablePointer<addrinfo>?
  guard getaddrinfo(host, "443", &hints, &result) == 0, let first = result else {
    throw AvatarTransferError.destination
  }
  defer { freeaddrinfo(first) }
  var addresses: [NWEndpoint.Host] = []
  var node: UnsafeMutablePointer<addrinfo>? = first
  while let entry = node {
    let value = entry.pointee
    node = value.ai_next
    var numeric = [CChar](repeating: 0, count: Int(NI_MAXHOST))
    guard getnameinfo(value.ai_addr, value.ai_addrlen, &numeric, socklen_t(numeric.count),
                      nil, 0, NI_NUMERICHOST) == 0 else { throw AvatarTransferError.destination }
    let address = String(cString: numeric)
    if let ipv4 = IPv4Address(address) {
      let octets = Array(ipv4.rawValue)
      let a = octets[0], b = octets[1], c = octets[2]
      guard (1...223).contains(a), a != 10, a != 127,
            !(a == 100 && (64...127).contains(b)), !(a == 169 && b == 254),
            !(a == 172 && (16...31).contains(b)),
            !(a == 192 && (b == 168 || (b == 0 && (c == 0 || c == 2)) || (b == 88 && c == 99))),
            !(a == 198 && ((18...19).contains(b) || (b == 51 && c == 100))),
            !(a == 203 && b == 0 && c == 113)
      else { throw AvatarTransferError.destination }
      addresses.append(.ipv4(ipv4))
    } else if let ipv6 = IPv6Address(address) {
      let octets = Array(ipv6.rawValue)
      let a = octets[0], b = octets[1], c = octets[2], d = octets[3]
      guard (0x20...0x3f).contains(a), !(a == 0x20 && b == 0x02),
            !(a == 0x20 && b == 0x01 && (c < 2 || (c == 0x0d && d == 0xb8))),
            !(a == 0x3f && b == 0xff)
      else { throw AvatarTransferError.destination }
      addresses.append(.ipv6(ipv6))
    } else {
      throw AvatarTransferError.destination
    }
  }
  guard !addresses.isEmpty else { throw AvatarTransferError.destination }
  return addresses
}
