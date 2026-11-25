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
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong
import org.json.JSONObject

private const val TORRENTS = "torrents"
private const val ABI = 1

private data class ActiveTorrentRequest(val scope: String, val requestId: String)
private data class TorrentStreamLease(val scope: String, val requestId: String)

private object TorrentRuntimeOwnership {
  @Volatile var scope: String? = null
  val commands = Any()
  val requests = ConcurrentHashMap<String, ActiveTorrentRequest>()
  val streams = ConcurrentHashMap<String, TorrentStreamLease>()
}

internal object TorrentNative {
  @JvmStatic external fun version(): Int
  @JvmStatic external fun execute(root: String, scope: String, request: String): String
  @JvmStatic external fun openTorrentStream(root: String, scope: String, requestId: String, size: Long): String?
  @JvmStatic external fun openReader(token: String, position: Long, length: Long): Long
  @JvmStatic external fun torrentStreamSize(token: String): Long
  @JvmStatic external fun torrentStreamCompleted(token: String): Boolean
  @JvmStatic external fun read(readerId: Long, destination: ByteArray, offset: Int, length: Int): Int
  @JvmStatic external fun cancelReader(readerId: Long)
  @JvmStatic external fun closeReader(readerId: Long)
  @JvmStatic external fun closeTorrentStream(uri: String)
}

class PluginDeliveryModule : Module() {
  private val context: Context get() = requireNotNull(appContext.reactContext).applicationContext
  private val manager by lazy { SplitInstallManagerFactory.create(context) }
  private val preferences by lazy { context.getSharedPreferences("boop_plugin_delivery", Context.MODE_PRIVATE) }
  @Volatile private var latest: SplitInstallSessionState? = null
  private val commands = TorrentRuntimeOwnership.commands
  private val retirement = Executors.newSingleThreadExecutor()
  private val retirementGeneration = AtomicLong()
  @Volatile private var loaded = false
  @Volatile private var foreground = true
  @Volatile private var retiring = false
  @Volatile private var filesDirectory: File? = null
  @Volatile private var loadedContext: Context? = null
  private var torrentScope: String?
    get() = TorrentRuntimeOwnership.scope
    set(value) { TorrentRuntimeOwnership.scope = value }
  private val activeRequests = TorrentRuntimeOwnership.requests
  private val streamLeases = TorrentRuntimeOwnership.streams
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
      retireRuntime(force = true)
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
      torrentScope?.let { revokeScope(it) }
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
            val application = context
            loadedContext = application
            filesDirectory = application.filesDir
            loaded = true
          }
        }
        expo.modules.video.ManagedDataSourceRegistry.register(
          "boop-media",
          TorrentManagedMediaDataSourceFactory(),
        )
        ABI
      } catch (_: LinkageError) {
        error("Native plugin could not load")
      }
    }

    AsyncFunction("execute") { scope: String, request: String ->
      require(scope.length == 64 && scope.all { it in '0'..'9' || it in 'a'..'f' })
      require(request.length <= 725_000)
      val command = JSONObject(request)
      val operation = command.getString("kind")
      val requestId = command.optString("requestId")
      val allowBackground = operation == "start" && command.optBoolean("allowBackground", false)
      synchronized(commands) {
        if (!loaded) {
          if (operation == "cancel" || operation == "stop") {
            TorrentTransferJobs.finish(context, scope, requestId)
            activeRequests.remove(requestKey(scope, requestId))
            return@synchronized """{"kind":"stopped"}"""
          }
          error("Torrent plugin unavailable")
        }
        if (operation == "resolve" || operation == "start") {
          val react = appContext.reactContext as? ReactContext
          check(foreground && !retiring && !pendingRemoval() &&
            react?.lifecycleState == LifecycleState.RESUMED)
          check(torrentScope == null || torrentScope == scope)
          torrentScope = scope
        }
        if (operation == "poll") {
          TorrentTransferJobs.pollOverride(scope, requestId)?.let {
            activeRequests.remove(requestKey(scope, requestId))
            return@synchronized it
          }
        }
        if (operation == "shutdown") {
          revokeScope(scope)
          if (torrentScope != scope) return@synchronized """{"kind":"stopped"}"""
        }
        if (operation == "cancel" || operation == "stop") {
          TorrentTransferJobs.finish(context, scope, requestId)
        }

        if (torrentScope != scope) {
          if (operation == "cancel" || operation == "stop") {
            activeRequests.remove(requestKey(scope, requestId))
          }
          """{"kind":"stopped"}"""
        } else {
          val response = execute(scope, request)
          val resultKind = JSONObject(response).optString("kind")
          if (operation == "start" && allowBackground && !secureWindow() &&
            resultKind in setOf("pending", "progress")
          ) {
            try {
              val root = File(requireNotNull(filesDirectory), "torrent-downloads").absolutePath
              TorrentTransferJobs.begin(context, scope, requestId, command.optLong("size", 0L)) { kind ->
                val control = JSONObject().put("kind", kind).put("requestId", requestId)
                TorrentNative.execute(root, scope, control.toString())
              }
            } catch (_: Exception) {
              // The accepted foreground transfer remains usable. It will be stopped if Boop
              // backgrounds before the user-initiated system job is admitted.
            }
          }

          when {
            operation in setOf("start", "resolve") && resultKind in setOf("pending", "progress") ->
              activeRequests[requestKey(scope, requestId)] = ActiveTorrentRequest(scope, requestId)
            operation in setOf("cancel", "stop", "shutdown") ||
              (operation in setOf("poll", "start", "resolve") && resultKind !in setOf("pending", "progress")) -> {
              if (requestId.isNotEmpty()) activeRequests.remove(requestKey(scope, requestId))
            }
          }

          if (
            ((operation == "poll" || operation == "start") && resultKind !in setOf("pending", "progress"))
          ) {
            TorrentTransferJobs.finish(context, scope, requestId)
          }
          if (operation == "shutdown") {
            torrentScope = null
          }
          response
        }
      }
    }

    AsyncFunction("openTorrentStream") { scope: String, requestId: String, size: Long ->
      require(scope.length == 64 && scope.all { it in '0'..'9' || it in 'a'..'f' })
      require(requestId.length in 1..128 && requestId.all {
        it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' || it == '-' || it == '_'
      })
      require(size > 0)
      synchronized(commands) {
        val react = appContext.reactContext as? ReactContext
        if (!loaded || torrentScope != scope || !foreground || retiring || pendingRemoval() ||
          react?.lifecycleState != LifecycleState.RESUMED
        ) return@synchronized null
        val root = File(requireNotNull(filesDirectory), "torrent-downloads")
        val uri = TorrentNative.openTorrentStream(root.absolutePath, scope, requestId, size)
          ?.takeIf { it.startsWith("boop-media://") }
          ?: return@synchronized null
        streamLeases[uri] = TorrentStreamLease(scope, requestId)
        uri
      }
    }

    AsyncFunction("closeTorrentStream") { uri: String ->
      val parsed = android.net.Uri.parse(uri)
      require(parsed.scheme == "boop-media" && !parsed.host.isNullOrBlank() && parsed.path.orEmpty() in listOf("", "/"))
      if (loaded) TorrentNative.closeTorrentStream(uri)
      streamLeases.remove(uri)
      Unit
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

  private fun requestKey(scope: String, requestId: String) = "$scope:$requestId"

  private fun revokeScope(scope: String) {
    loadedContext?.let { TorrentTransferJobs.revokeScope(it, scope) }
    activeRequests.values.filter { it.scope == scope }.forEach { request ->
      runCatching {
        execute(scope, """{"kind":"cancel","requestId":"${request.requestId}"}""")
      }
      activeRequests.remove(requestKey(scope, request.requestId))
    }
    streamLeases.entries.filter { it.value.scope == scope }.forEach { (uri, _) ->
      runCatching { TorrentNative.closeTorrentStream(uri) }
      streamLeases.remove(uri)
    }
  }

  private fun secureWindow(): Boolean {
    val flags = appContext.currentActivity?.window?.attributes?.flags ?: return true
    return (flags and android.view.WindowManager.LayoutParams.FLAG_SECURE) != 0
  }

  private fun retireRuntime(force: Boolean = false) {
    foreground = false
    if (!loaded) return
    retiring = true
    val protect = force || secureWindow()
    val generation = retirementGeneration.incrementAndGet()
    retirement.execute {
      synchronized(commands) {
        try {
          val scope = torrentScope
          if (scope != null) {
            if (protect) {
              revokeScope(scope)
            } else {
              activeRequests.values.filter {
                it.scope == scope && !TorrentTransferJobs.isAdmitted(scope, it.requestId)
              }.forEach { request ->
                runCatching {
                  execute(scope, """{"kind":"cancel","requestId":"${request.requestId}"}""")
                }
                activeRequests.remove(requestKey(scope, request.requestId))
              }

              streamLeases.entries.filter { it.value.scope == scope }.forEach { (uri, lease) ->
                val completed = runCatching { TorrentNative.torrentStreamCompleted(uri) }.getOrDefault(false)
                val admitted = TorrentTransferJobs.isAdmitted(scope, lease.requestId)
                if (!completed && !admitted) {
                  runCatching { TorrentNative.closeTorrentStream(uri) }
                  streamLeases.remove(uri)
                }
              }
            }

            val keepNativeSession = !protect && (
              TorrentTransferJobs.hasActiveScope(scope) ||
                streamLeases.values.any { it.scope == scope }
              )
            if (!keepNativeSession) {
              execute(scope, """{"kind":"shutdown"}""")
              torrentScope = null
            }
          }
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
