import Foundation
import BoopSocial

/// Native bridge from the independent Social FFI to the account's MDK signer.
actor SocialHostSigner: HostSigner {
  private let account: String
  private let currentPolicy: @Sendable () async -> SocialPolicy
  private let eligible: @Sendable (String) async throws -> Bool
  private let signWithMdk: @Sendable (String, String) async throws -> String
  private var sessionGeneration: UInt64?

  init(
    account: String,
    currentPolicy: @escaping @Sendable () async -> SocialPolicy,
    eligible: @escaping @Sendable (String) async throws -> Bool,
    signWithMdk: @escaping @Sendable (String, String) async throws -> String
  ) {
    self.account = account
    self.currentPolicy = currentPolicy
    self.eligible = eligible
    self.signWithMdk = signWithMdk
  }

  func bindGeneration(_ generation: UInt64) {
    sessionGeneration = generation
  }

  func publicKey() async throws -> String {
    account
  }

  func authorize(account: String, generation: UInt64) async throws {
    guard account == self.account, generation == sessionGeneration,
      await currentPolicy().permits else {
      throw HostError.Unauthorized
    }
    let isEligible: Bool
    do {
      isEligible = try await eligible(account)
    } catch is CancellationError {
      throw HostError.Cancelled
    } catch {
      throw HostError.Unauthorized
    }
    guard isEligible else { throw HostError.Unauthorized }
  }

  func signEvent(request: SignEventRequest) async throws -> String {
    try await authorize(account: request.account, generation: request.generation)
    guard request.version == 1, request.purpose == .publicTextNote else {
      throw HostError.Unauthorized
    }
    guard let data = request.unsignedJson.data(using: .utf8),
      let event = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      event["pubkey"] as? String == account,
      event["kind"] as? Int == 1,
      let tags = event["tags"] as? [Any], tags.isEmpty,
      event["id"] as? String != nil,
      event["created_at"] as? Int != nil,
      event["content"] as? String != nil else {
      throw HostError.Unauthorized
    }
    let signature: String
    do {
      signature = try await signWithMdk(account, request.unsignedJson)
    } catch is CancellationError {
      throw HostError.Cancelled
    } catch {
      do {
        try await authorize(account: request.account, generation: request.generation)
      } catch is CancellationError {
        throw HostError.Cancelled
      } catch {
        throw HostError.Unauthorized
      }
      throw HostError.SigningFailed
    }
    try await authorize(account: request.account, generation: request.generation)
    return signature
  }
}

struct SocialPolicy: Sendable {
  var enabled = false
  var foreground = false
  var unlocked = false

  var permits: Bool { enabled && foreground && unlocked }
}

private actor SocialTransitionGate {
  private var held = false
  private var waiters: [CheckedContinuation<Void, Never>] = []

  func acquire() async {
    if !held {
      held = true
      return
    }
    await withCheckedContinuation { waiters.append($0) }
  }

  func release() {
    if waiters.isEmpty {
      held = false
    } else {
      waiters.removeFirst().resume()
    }
  }
}

/// Native-only owner for Social and its MDK-backed host capability.
actor SocialNativeOwner {
  private let transitionGate = SocialTransitionGate()
  private let runtime: Runtime
  private let foreground: @Sendable () -> Bool
  private var policy = SocialPolicy()
  private var engine: SocialEngine?
  private var session: SocialSession?
  private var foregroundGeneration: UInt64 = 0

  init(runtime: Runtime, foreground: @escaping @Sendable () -> Bool) {
    self.runtime = runtime
    self.foreground = foreground
  }

  /// A new session starts denied; the native feature owner must opt it in explicitly.
  func activate(
    account: String, storageRoot: String, storageKey: Data,
    foreground: Bool, foregroundGeneration: UInt64
  ) async throws -> SocialSession {
    await transitionGate.acquire()
    do {
      await retireCurrent()
      if foregroundGeneration >= self.foregroundGeneration {
        self.foregroundGeneration = foregroundGeneration
        policy = SocialPolicy(foreground: foreground)
      } else {
        policy = SocialPolicy(foreground: policy.foreground)
      }
      let engine: SocialEngine
      if let current = self.engine {
        engine = current
      } else {
        engine = try SocialEngine(options: SocialOptions(
          storageRoot: storageRoot, cacheMib: 64, operationTimeoutMs: 5_000,
          allowLoopbackRelay: false
        ))
        self.engine = engine
      }
      let runtime = self.runtime
      let foreground = self.foreground
      let hostSigner = SocialHostSigner(
        account: account,
        currentPolicy: { [weak self] in await self?.currentPolicy() ?? SocialPolicy() },
        eligible: { account in
          guard foreground() else { return false }
          let eligible = try await runtime.socialEligible(account)
          return foreground() && eligible
        },
        signWithMdk: { account, event in
          guard foreground() else { throw HostError.Unauthorized }
          return try await runtime.socialSignEvent(
            account: account, unsignedJson: event, foreground: foreground
          )
        }
      )
      let opened = try await engine.activate(account: account, signer: hostSigner, storageKey: storageKey)
      await hostSigner.bindGeneration(opened.generation())
      try opened.setPolicy(policy: SessionPolicy(
        enabled: policy.enabled, foreground: policy.foreground, unlocked: policy.unlocked
      ))
      self.session = opened
      await transitionGate.release()
      return opened
    } catch {
      await transitionGate.release()
      throw error
    }
  }

  /// `unlocked` is supplied by the native owner of application security state.
  func setPolicy(current: SocialSession, enabled: Bool, unlocked: Bool) throws {
    guard session === current else { return }
    policy = SocialPolicy(enabled: enabled, foreground: policy.foreground, unlocked: unlocked)
    try current.setPolicy(policy: SessionPolicy(
      enabled: enabled, foreground: policy.foreground, unlocked: unlocked
    ))
  }

  func setForeground(_ foreground: Bool, generation: UInt64) throws {
    guard generation >= foregroundGeneration else { return }
    foregroundGeneration = generation
    policy.foreground = foreground
    try session?.setPolicy(policy: SessionPolicy(
      enabled: policy.enabled, foreground: foreground, unlocked: policy.unlocked
    ))
  }

  func retire(account: String? = nil) async {
    await transitionGate.acquire()
    guard account == nil || session?.account() == account else {
      await transitionGate.release()
      return
    }
    await retireCurrent()
    await transitionGate.release()
  }

  func removeAccount(_ account: String, storageRoot: String) async throws {
    await transitionGate.acquire()
    do {
      if session?.account() == account { await retireCurrent() }
      if engine == nil {
        engine = try SocialEngine(options: SocialOptions(
          storageRoot: storageRoot, cacheMib: 64, operationTimeoutMs: 5_000,
          allowLoopbackRelay: false
        ))
      }
      try await engine?.removeAccount(account: account)
      await transitionGate.release()
    } catch {
      await transitionGate.release()
      throw error
    }
  }

  func shutdown() async throws {
    await transitionGate.acquire()
    do {
      await retireCurrent()
      try await engine?.shutdown()
      engine = nil
      await transitionGate.release()
    } catch {
      await transitionGate.release()
      throw error
    }
  }

  private func currentPolicy() -> SocialPolicy { policy }

  private func retireCurrent() async {
    policy = SocialPolicy(foreground: policy.foreground)
    let current = session
    session = nil
    guard let current else { return }
    current.invalidate()
    try? await engine?.retire(generation: current.generation())
  }
}
