package app.boop.marmot

import app.boop.social.ffi.SocialEngine
import app.boop.social.ffi.SocialOptions
import app.boop.social.ffi.SocialSession
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Native-only owner for the independent Social engine and its MDK-backed signer. */
internal class SocialNativeOwner(
  private val storageRoot: String,
  private val accountEligible: suspend (String) -> Boolean,
  private val signWithMdk: suspend (String, String) -> String,
  allowLoopbackRelay: Boolean = false,
) {
  private val lifecycle = Mutex()
  private val policyMonitor = Any()
  private val policy = AtomicReference(SocialPolicy())
  private val engine = SocialEngine(
    SocialOptions(
      storageRoot = storageRoot,
      cacheMib = 64u,
      operationTimeoutMs = 5_000u,
      allowLoopbackRelay = allowLoopbackRelay,
    ),
  )
  @Volatile private var session: SocialSession? = null
  private var foregroundGeneration = 0L
  private var closed = false

  /** Called by the native feature owner; a newly activated session stays denied by default. */
  suspend fun activate(
    account: String,
    storageKey: ByteArray,
    foreground: Boolean = false,
    foregroundGeneration: Long = 0L,
  ): SocialSession = lifecycle.withLock {
    check(!closed) { "Social native owner is closed" }
    retireLocked()
    synchronized(policyMonitor) {
      val current = policy.get()
      val selectedForeground = if (foregroundGeneration >= this.foregroundGeneration) {
        this.foregroundGeneration = foregroundGeneration
        foreground
      } else current.foreground
      policy.set(SocialPolicy(foreground = selectedForeground))
    }
    val hostSigner = SocialHostSigner(
      account = account,
      currentPolicy = policy::get,
      eligible = accountEligible,
      signWithMdk = signWithMdk,
    )
    val opened = engine.activate(account, hostSigner, storageKey)
    synchronized(policyMonitor) {
      hostSigner.bindGeneration(opened.generation())
      session = opened
      try {
        opened.setPolicy(policy.get().ffi())
      } catch (error: Throwable) {
        session = null
        policy.set(SocialPolicy(foreground = policy.get().foreground))
        opened.invalidate()
        throw error
      }
    }
    opened
  }

  fun setForeground(foreground: Boolean, generation: Long) {
    synchronized(policyMonitor) {
      if (generation < foregroundGeneration) return
      foregroundGeneration = generation
      val next = policy.updateAndGet { it.copy(foreground = foreground) }
      runCatching { session?.setPolicy(next.ffi()) }
    }
  }

  /** `unlocked` must be supplied by the native owner of app security state. */
  fun setAuthorization(current: SocialSession, enabled: Boolean, unlocked: Boolean) {
    synchronized(policyMonitor) {
      if (session !== current) return
      val next = policy.updateAndGet { it.copy(enabled = enabled, unlocked = unlocked) }
      runCatching { current.setPolicy(next.ffi()) }
    }
  }

  suspend fun retire(account: String? = null) = lifecycle.withLock {
    if (account == null || session?.account() == account) retireLocked()
  }

  suspend fun removeAccount(account: String) = lifecycle.withLock {
    check(!closed) { "Social native owner is closed" }
    if (session?.account() == account) retireLocked()
    engine.removeAccount(account)
  }

  suspend fun shutdown() = lifecycle.withLock {
    if (closed) return@withLock
    retireLocked()
    engine.shutdown()
    closed = true
  }

  private suspend fun retireLocked() {
    val current = synchronized(policyMonitor) {
      val foreground = policy.get().foreground
      policy.set(SocialPolicy(foreground = foreground))
      session.also {
        session = null
        it?.invalidate()
      }
    }
    if (current != null) {
      engine.retire(current.generation())
    }
  }
}
