import Foundation
import Network

// URLSession owns HTTPS and TLS verification. The local gate accepts only this
// operation's CONNECT authority and dials only the validated numeric addresses.
final class AvatarConnectGate: @unchecked Sendable {
  private let queue = DispatchQueue(label: "app.boop.avatar.connect")
  private let listener: NWListener
  private let host: String
  private let addresses: [NWEndpoint.Host]
  private var inbound: NWConnection?
  private var outbound: NWConnection?
  private var startup: CheckedContinuation<NWEndpoint, Error>?
  private var closed = false

  init(host: String, addresses: [NWEndpoint.Host]) throws {
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
    listener = try NWListener(using: parameters)
    self.host = host
    self.addresses = addresses
  }

  func start() async throws -> NWEndpoint {
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        queue.async {
          guard !self.closed else {
            continuation.resume(throwing: CancellationError())
            return
          }
          self.startup = continuation
          self.listener.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
              guard let port = self.listener.port else { self.stop(); return }
              self.startup?.resume(returning: .hostPort(host: "127.0.0.1", port: port))
              self.startup = nil
            case .failed, .cancelled: self.stop()
            default: break
            }
          }
          self.listener.newConnectionHandler = { [weak self] connection in
            guard let self, !self.closed, self.inbound == nil else {
              connection.cancel()
              return
            }
            self.inbound = connection
            connection.start(queue: self.queue)
            self.readConnect(connection, Data())
          }
          self.listener.start(queue: self.queue)
          self.queue.asyncAfter(deadline: .now() + 12) { [weak self] in self?.stop() }
        }
      }
    } onCancel: { close() }
  }

  func close() { queue.async { self.stop() } }

  private func stop() {
    guard !closed else { return }
    closed = true
    startup?.resume(throwing: CancellationError())
    startup = nil
    listener.cancel()
    inbound?.cancel()
    outbound?.cancel()
    inbound = nil
    outbound = nil
  }

  private func readConnect(_ client: NWConnection, _ previous: Data) {
    client.receive(minimumIncompleteLength: 1, maximumLength: 4096 - previous.count) {
      [weak self] data, _, done, error in
      guard let self, !self.closed else { return }
      guard error == nil, !done, let data else { self.stop(); return }
      let bytes = previous + data
      let end = Data([13, 10, 13, 10])
      if let delimiter = bytes.range(of: end) {
        guard delimiter.upperBound == bytes.endIndex,
              let header = String(data: bytes, encoding: .ascii),
              let line = header.components(separatedBy: "\r\n").first,
              line == "CONNECT \(self.host):443 HTTP/1.1" || line == "CONNECT \(self.host):443 HTTP/1.0"
        else { self.stop(); return }
        self.dial(client, 0)
      } else if bytes.count < 4096 {
        self.readConnect(client, bytes)
      } else {
        self.stop()
      }
    }
  }

  private func dial(_ client: NWConnection, _ index: Int) {
    guard !closed, index < addresses.count else { stop(); return }
    let server = NWConnection(host: addresses[index], port: .https, using: .tcp)
    outbound = server
    server.stateUpdateHandler = { [weak self, weak server] state in
      guard let self, let server, self.outbound === server, !self.closed else { return }
      switch state {
      case .ready:
        server.stateUpdateHandler = nil
        client.send(content: Data("HTTP/1.1 200 Connection Established\r\n\r\n".utf8),
                    completion: .contentProcessed { error in
          guard error == nil else { self.stop(); return }
          self.tunnel(client, server)
          self.tunnel(server, client)
        })
      case .failed, .waiting:
        server.cancel()
        self.dial(client, index + 1)
      default: break
      }
    }
    server.start(queue: queue)
  }

  private func tunnel(_ from: NWConnection, _ to: NWConnection) {
    guard !closed else { return }
    from.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) {
      [weak self] data, _, done, error in
      guard let self, !self.closed else { return }
      guard error == nil else { self.stop(); return }
      if let data, !data.isEmpty {
        to.send(content: data, completion: .contentProcessed { error in
          if done || error != nil { self.stop() }
          else { self.tunnel(from, to) }
        })
      } else if done {
        self.stop()
      } else {
        self.tunnel(from, to)
      }
    }
  }
}
