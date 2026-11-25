package app.boop.plugins

import android.content.Context
import com.facebook.react.bridge.ReactContext
import com.facebook.react.common.LifecycleState
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
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong
import org.json.JSONObject

private const val TORRENTS = "torrents"
private const val ABI = 1

internal object TorrentNative {
  @JvmStatic external fun version(): Int
  @JvmStatic external fun execute(root: String, scope: String, request: String): String
}

class PluginDeliveryModule : Module() {
  private val context: Context get() = requireNotNull(appContext.reactContext).applicationContext
  private val manager by lazy { SplitInstallManagerFactory.create(context) }
  private val preferences by lazy { context.getSharedPreferences("boop_plugin_delivery", Context.MODE_PRIVATE) }
  @Volatile private var latest: SplitInstallSessionState? = null
  private val commands = Any()
  private val retirement = Executors.newSingleThreadExecutor()
  private val retirementGeneration = AtomicLong()
  @Volatile private var loaded = false
  @Volatile private var foreground = true
  @Volatile private var retiring = false
  @Volatile private var filesDirectory: File? = null
  private var torrentScope: String? = null
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
    OnActivityEntersForeground { foreground = true }
    OnActivityEntersBackground { retireRuntime() }
    OnDestroy {
      retireRuntime()
      retirement.shutdown()
    }

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

    AsyncFunction("confirm") { id: Int, promise: expo.modules.kotlin.Promise ->
      val state = await(manager.getSessionState(id))
      val activity = appContext.currentActivity
      if (activity == null || TORRENTS !in state.moduleNames()) {
        promise.resolve(false)
      } else {
        activity.runOnUiThread {
          try {
            promise.resolve(manager.startConfirmationDialogForResult(state, activity, 8231))
          } catch (_: Exception) {
            promise.resolve(false)
          }
        }
      }
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
        synchronized(commands) {
          if (!loaded) {
            ReLinker.recursively().loadLibrary(context, "boop_torrent")
            check(TorrentNative.version() == ABI)
            filesDirectory = context.filesDir
            loaded = true
          }
        }
        ABI
      } catch (_: LinkageError) {
        error("Native plugin could not load")
      }
    }

    AsyncFunction("execute") { scope: String, request: String ->
      require(scope.length == 64 && scope.all { it in '0'..'9' || it in 'a'..'f' })
      require(request.length <= 725_000)
      val operation = JSONObject(request).getString("kind")
      synchronized(commands) {
        if (!loaded) error("Torrent plugin unavailable")
        if (operation == "resolve" || operation == "start") {
          val react = appContext.reactContext as? ReactContext
          check(foreground && !retiring && !pendingRemoval() &&
            react?.lifecycleState == LifecycleState.RESUMED)
          check(torrentScope == null || torrentScope == scope)
          torrentScope = scope
        }
        if (torrentScope != scope) {
          """{"kind":"stopped"}"""
        } else {
          val response = execute(scope, request)
          if (operation == "shutdown") torrentScope = null
          response
        }
      }
    }
  }

  private fun execute(scope: String, request: String): String {
    val root = File(requireNotNull(filesDirectory), "torrent-downloads")
    return try {
      TorrentNative.execute(root.absolutePath, scope, request)
    } catch (_: LinkageError) {
      """{"kind":"failed","code":"unavailable"}"""
    }
  }

  private fun retireRuntime() {
    foreground = false
    if (!loaded) return
    retiring = true
    val generation = retirementGeneration.incrementAndGet()
    retirement.execute {
      synchronized(commands) {
        try {
          torrentScope?.let { execute(it, """{"kind":"shutdown"}""") }
          torrentScope = null
        } finally {
          if (retirementGeneration.get() == generation) retiring = false
        }
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
