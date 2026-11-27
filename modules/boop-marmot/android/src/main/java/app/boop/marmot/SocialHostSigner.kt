package app.boop.marmot

import app.boop.social.ffi.HostException
import app.boop.social.ffi.HostSigner
import app.boop.social.ffi.SignEventRequest
import app.boop.social.ffi.SigningPurpose
import app.boop.social.ffi.SessionPolicy
import org.json.JSONObject
import kotlinx.coroutines.CancellationException

/** Native bridge from the independent Social FFI to this account's MDK signer. */
internal class SocialHostSigner(
  private val account: String,
  private val currentPolicy: () -> SocialPolicy,
  private val eligible: suspend (String) -> Boolean,
  private val signWithMdk: suspend (String, String) -> String,
) : HostSigner {
  @Volatile private var sessionGeneration: ULong? = null

  fun bindGeneration(generation: ULong) {
    sessionGeneration = generation
  }

  override suspend fun publicKey(): String = account

  override suspend fun authorize(account: String, generation: ULong) {
    if (account != this.account || generation != sessionGeneration || !currentPolicy().permits()) {
      throw HostException.Unauthorized()
    }
    val isEligible = try {
      eligible(account)
    } catch (_: CancellationException) {
      throw HostException.Cancelled()
    } catch (_: Throwable) {
      false
    }
    if (!isEligible) throw HostException.Unauthorized()
  }

  override suspend fun signEvent(request: SignEventRequest): String {
    authorize(request.account, request.generation)
    if (request.version != 1.toUShort() || request.purpose != SigningPurpose.PUBLIC_TEXT_NOTE) {
      throw HostException.Unauthorized()
    }
    val event = runCatching { JSONObject(request.unsignedJson) }.getOrElse {
      throw HostException.SigningFailed()
    }
    if (event.optString("pubkey") != account || event.optInt("kind", -1) != 1 ||
      !event.has("tags") || event.optJSONArray("tags")?.length() != 0 ||
      !event.has("id") || !event.has("created_at") || !event.has("content")) {
      throw HostException.Unauthorized()
    }
    val signature = try {
      signWithMdk(account, request.unsignedJson)
    } catch (_: CancellationException) {
      throw HostException.Cancelled()
    } catch (_: Throwable) {
      try {
        authorize(request.account, request.generation)
      } catch (_: CancellationException) {
        throw HostException.Cancelled()
      } catch (_: Throwable) {
        throw HostException.Unauthorized()
      }
      throw HostException.SigningFailed()
    }
    authorize(request.account, request.generation)
    return signature
  }
}

internal data class SocialPolicy(
  val enabled: Boolean = false,
  val foreground: Boolean = false,
  val unlocked: Boolean = false,
) {
  fun permits() = enabled && foreground && unlocked

  fun ffi() = SessionPolicy(enabled = enabled, foreground = foreground, unlocked = unlocked)
}
