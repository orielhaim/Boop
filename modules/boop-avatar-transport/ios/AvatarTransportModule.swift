import CryptoKit
import Darwin
import ExpoModulesCore
import Foundation
import ImageIO
import Network
import UniformTypeIdentifiers

private enum AvatarTransferError: Error {
  case unavailable, destination, response, image, size, hash, missing
}

public final class AvatarTransportModule: Module {
  private let lock = NSLock()
  private var jobs: [String: DownloadJob] = [:]

  public func definition() -> ModuleDefinition {
    Name("BoopAvatarTransport")
    Events("attachmentProgress", "uploadProgress")

    Function("available") {
      if #available(iOS 17.0, *) { return true }
      return false
    }

    Function("prepare") { (id: String) in
      self.lock.lock()
      defer { self.lock.unlock() }
      guard self.jobs[id] == nil else { throw AvatarTransferError.unavailable }
      self.jobs[id] = DownloadJob()
    }

    Function("cancel") { (id: String) in
      self.getJob(id)?.cancel()
    }

    AsyncFunction("download") { (id: String, url: String, output: String, hash: String?, attachmentLimit: Int?, promise: Promise) in
      self.transfer(id, url, output, hash, attachmentLimit, nil, promise)
    }
    AsyncFunction("downloadPreview") { (id: String, url: String, output: String, image: Bool, promise: Promise) in
      self.transfer(id, url, output, nil, nil, image, promise)
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
                        _ attachmentLimit: Int?, _ previewImage: Bool?, _ promise: Promise) {
      guard let job = self.getJob(id) else {
        promise.reject("AVATAR_UNAVAILABLE", "Avatar operation missing")
        return
      }
      let task = Task.detached {
        defer { self.removeJob(id) }
        do {
          guard #available(iOS 17.0, *) else { throw AvatarTransferError.unavailable }
          let size = try await downloadMedia(url, output, hash, attachmentLimit, previewImage, job) { received, total in
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
  private var cancelled = false
  private var task: Task<Void, Never>?

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

  func cancel() {
    lock.lock()
    defer { lock.unlock() }
    cancelled = true
    task?.cancel()
  }
}

private let imageTypes = Set(["image/jpeg", "image/png", "image/webp"])
private let maxBytes = 2 * 1024 * 1024

@available(iOS 17.0, *)
private func downloadMedia(
  _ input: String, _ output: String, _ hash: String?, _ attachmentLimit: Int?, _ previewImage: Bool?, _ job: DownloadJob,
  _ progress: (Int, Int64) -> Void
) async throws -> Int {
  let html = previewImage == false
  let images = attachmentLimit == nil && !html
  let limit = html ? 512 * 1024 : attachmentLimit ?? maxBytes
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
  request.setValue(html ? "text/html" : images ? "image/jpeg, image/png, image/webp" : "*/*", forHTTPHeaderField: "Accept")
  request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
  try job.check()
  let (stream, response) = try await session.bytes(for: request)
  if attachmentLimit != nil && (response as? HTTPURLResponse)?.statusCode == 404 {
    throw AvatarTransferError.missing
  }
  guard let http = response as? HTTPURLResponse, http.statusCode == 200,
        !images || imageTypes.contains(response.mimeType ?? ""),
        !html || response.mimeType == "text/html",
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
