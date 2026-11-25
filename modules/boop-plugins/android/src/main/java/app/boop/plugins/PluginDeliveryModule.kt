package app.boop.plugins

import android.content.Context
import com.getkeepsafe.relinker.ReLinker
import com.google.android.gms.tasks.Tasks
import com.google.android.play.core.splitcompat.SplitCompat
import com.google.android.play.core.splitinstall.SplitInstallException
import com.google.android.play.core.splitinstall.SplitInstallManagerFactory
import com.google.android.play.core.splitinstall.SplitInstallRequest
import com.google.android.play.core.splitinstall.SplitInstallSessionState
import com.google.android.play.core.splitinstall.SplitInstallStateUpdatedListener
import com.google.android.play.core.splitinstall.model.SplitInstallSessionStatus
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit

private const val TORRENTS = "torrents"
private const val ABI = 1

internal object TorrentNative {
  @JvmStatic external fun version(): Int
}

class PluginDeliveryModule : Module() {
  private val context: Context get() = requireNotNull(appContext.reactContext).applicationContext
  private val manager by lazy { SplitInstallManagerFactory.create(context) }
  private val preferences by lazy { context.getSharedPreferences("boop_plugin_delivery", Context.MODE_PRIVATE) }
  @Volatile private var latest: SplitInstallSessionState? = null
  private val listener = SplitInstallStateUpdatedListener { state ->
    if (TORRENTS in state.moduleNames()) {
      latest = state
      sendEvent("onDeliveryChanged", emptyMap<String, Any>())
    }
  }

  override fun definition() = ModuleDefinition {
    Name("BoopPluginDelivery")
    Events("onDeliveryChanged")

    OnStartObserving { manager.registerListener(listener) }
    OnStopObserving { manager.unregisterListener(listener) }

    AsyncFunction("status") {
      val session = try {
        await(manager.sessionStates).lastOrNull { TORRENTS in it.moduleNames() && !it.hasTerminalStatus() }
      } catch (_: Exception) {
        null
      } ?: latest
      snapshot(session)
    }

    AsyncFunction("install") {
      if (TORRENTS in manager.installedModules) {
        snapshot(null)
      } else {
        try {
          val id = await(manager.startInstall(SplitInstallRequest.newBuilder().addModule(TORRENTS).build()))
          mapOf("kind" to "installing", "sessionId" to id, "received" to 0, "total" to 0)
        } catch (error: Exception) {
          val code = ((error as? ExecutionException)?.cause as? SplitInstallException)?.errorCode
          mapOf("kind" to "failed", "errorCode" to (code ?: 0))
        }
      }
    }

    AsyncFunction("cancel") { id: Int ->
      val state = await(manager.getSessionState(id))
      if (TORRENTS in state.moduleNames()) await(manager.cancelInstall(id))
      Unit
    }

    AsyncFunction("confirm") { id: Int ->
      val activity = requireNotNull(appContext.currentActivity)
      val state = await(manager.getSessionState(id))
      TORRENTS in state.moduleNames() && manager.startConfirmationDialogForResult(state, activity, 8231)
    }

    AsyncFunction("uninstall") {
      await(manager.deferredUninstall(listOf(TORRENTS)))
      preferences.edit().putBoolean("pendingRemoval", true).apply()
      Unit
    }

    AsyncFunction("load") {
      check(TORRENTS in manager.installedModules && !pendingRemoval())
      check(SplitCompat.install(context))
      try {
        ReLinker.recursively().loadLibrary(context, "boop_torrent")
        check(TorrentNative.version() == ABI)
        ABI
      } catch (_: LinkageError) {
        error("Native plugin could not load")
      }
    }
  }

  private fun pendingRemoval(): Boolean {
    val pending = preferences.getBoolean("pendingRemoval", false)
    if (pending && TORRENTS !in manager.installedModules) {
      preferences.edit().remove("pendingRemoval").apply()
      return false
    }
    return pending
  }

  private fun snapshot(state: SplitInstallSessionState?): Map<String, Any> {
    if (pendingRemoval()) return mapOf("kind" to "pendingRemoval")
    if (TORRENTS in manager.installedModules) return mapOf("kind" to "installed")
    return when (state?.status()) {
      SplitInstallSessionStatus.FAILED -> mapOf("kind" to "failed", "errorCode" to state.errorCode())
      SplitInstallSessionStatus.REQUIRES_USER_CONFIRMATION ->
        mapOf("kind" to "confirmation", "sessionId" to state.sessionId())
      SplitInstallSessionStatus.PENDING, SplitInstallSessionStatus.DOWNLOADING,
      SplitInstallSessionStatus.DOWNLOADED, SplitInstallSessionStatus.INSTALLING,
      SplitInstallSessionStatus.CANCELING -> mapOf(
        "kind" to "installing", "sessionId" to state.sessionId(),
        "received" to state.bytesDownloaded(), "total" to state.totalBytesToDownload(),
      )
      else -> mapOf("kind" to "notInstalled")
    }
  }

  private fun <T> await(task: com.google.android.gms.tasks.Task<T>): T =
    Tasks.await(task, 15, TimeUnit.SECONDS)
}
