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
    Events("attachmentProgress")

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
      guard let job = self.getJob(id) else {
        promise.reject("AVATAR_UNAVAILABLE", "Avatar operation missing")
        return
      }
      let task = Task.detached {
        defer { self.removeJob(id) }
        do {
          guard #available(iOS 17.0, *) else { throw AvatarTransferError.unavailable }
          let size = try await downloadMedia(url, output, hash, attachmentLimit, job) { received, total in
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
  _ input: String, _ output: String, _ hash: String?, _ attachmentLimit: Int?, _ job: DownloadJob,
  _ progress: (Int, Int64) -> Void
) async throws -> Int {
  let limit = attachmentLimit ?? maxBytes
  let avatar = attachmentLimit == nil
  guard avatar || ((17...(32 * 1024 * 1024)).contains(limit) &&
    hash?.range(of: #"^[0-9a-f]{64}$"#, options: .regularExpression) != nil)
  else { throw AvatarTransferError.destination }
  try job.check()
  guard let url = URL(string: input), url.scheme == "https",
        let host = url.host, url.user == nil, url.password == nil,
        url.port == nil || url.port == 443,
        host.range(of: #"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$"#, options: .regularExpression) != nil,
        host.range(of: #"\.(localhost|local|internal|lan|home|test|invalid|example|onion|arpa)$"#, options: .regularExpression) == nil,
        let destination = URL(string: output), destination.isFileURL,
        destination.pathExtension == (avatar ? "jpg" : "bin"),
        let directory = FileManager.default.urls(for: avatar ? .documentDirectory : .cachesDirectory, in: .userDomainMask).first
  else { throw AvatarTransferError.destination }
  let root = directory.appendingPathComponent(avatar ? "avatar-cache" : "attachment-work").resolvingSymlinksInPath()
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
  configuration.timeoutIntervalForResource = limit > 8 * 1024 * 1024 ? 58 : 12
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
  request.setValue(avatar ? "image/jpeg, image/png, image/webp" : "*/*", forHTTPHeaderField: "Accept")
  request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
  try job.check()
  let (stream, response) = try await session.bytes(for: request)
  if !avatar && (response as? HTTPURLResponse)?.statusCode == 404 {
    throw AvatarTransferError.missing
  }
  guard let http = response as? HTTPURLResponse, http.statusCode == 200,
        avatar == false || imageTypes.contains(response.mimeType ?? ""),
        response.expectedContentLength <= limit
  else { throw AvatarTransferError.response }
  var data = Data()
  for try await byte in stream {
    guard data.count < limit else { throw AvatarTransferError.size }
    data.append(byte)
    if !avatar && response.expectedContentLength > 0 && data.count % (64 * 1024) == 0 {
      progress(data.count, response.expectedContentLength)
    }
  }
  if let hash, SHA256.hash(data: data).map({ String(format: "%02x", $0) }).joined() != hash {
    throw AvatarTransferError.hash
  }
  if !avatar {
    try Task.checkCancellation()
    guard data.count >= 17 else { throw AvatarTransferError.size }
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

private final class NoAvatarRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
  func urlSession(_ session: URLSession, task: URLSessionTask,
                  willPerformHTTPRedirection response: HTTPURLResponse,
                  newRequest request: URLRequest,
                  completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
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
