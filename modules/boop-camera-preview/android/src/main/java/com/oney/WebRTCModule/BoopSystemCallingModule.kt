
package com.oney.WebRTCModule

import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import android.telecom.DisconnectCause
import androidx.core.graphics.drawable.IconCompat
import androidx.core.telecom.CallAttributesCompat
import androidx.core.telecom.CallControlResult
import androidx.core.telecom.CallControlScope
import androidx.core.telecom.CallEndpointCompat
import androidx.core.telecom.CallsManager
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.records.Required
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import java.io.File

internal class CallLabels : Record {
  @Field @Required val channel: String = ""
  @Field @Required val privateCaller: String = ""
  @Field @Required val connecting: String = ""
  @Field @Required val ongoing: String = ""
}

class BoopSystemCallingModule : Module() {
  private var callToRestore: String? = null

  override fun definition() = ModuleDefinition {
    Name("BoopSystemCalling")
    Events("onCallEvent", "onCallRoutes")

    OnCreate {
      SystemCallSession.event = { sendEvent("onCallEvent", it) }
      SystemCallSession.routing = { sendEvent("onCallRoutes", it) }
      SystemCallPip.newView = { BoopCameraPreviewView(it, appContext, rounded = false) }
    }
    OnDestroy {
      SystemCallSession.runOnMain {
        SystemCallSession.reset()
        SystemCallPip.newView = null
      }
    }
    OnNewIntent { intent -> openFromIntent(intent) }
    OnActivityEntersForeground {
      appContext.currentActivity?.let {
        SystemCallPip.refresh(it)
        callToRestore?.let(SystemCallSession::open)
        callToRestore = null
        openFromIntent(it.intent)
      }
    }
    OnActivityDestroys {
      callToRestore = SystemCallSession.current?.id
      SystemCallPip.detach()
    }

    AsyncFunction("start") Coroutine { id: String, name: String, incoming: Boolean, privateMode: Boolean, labels: CallLabels ->
      withContext(Dispatchers.Main.immediate) {
        val activity = appContext.currentActivity ?: return@withContext false
        if (activity.isFinishing) return@withContext false
        SystemCallSession.start(activity.applicationContext, id, name, incoming, privateMode, labels)
      }
    }
    AsyncFunction("update") { id: String, answeredAt: Double, privateMode: Boolean ->
      SystemCallSession.update(id, answeredAt.toLong(), privateMode)
    }.runOnQueue(expo.modules.kotlin.functions.Queues.MAIN)
    AsyncFunction("updateGroup") { id: String, title: String?, participants: String? ->
      SystemCallSession.updateGroup(id, title, participants)
    }.runOnQueue(expo.modules.kotlin.functions.Queues.MAIN)
    AsyncFunction("setRemoteVideo") { id: String, stream: String? ->
      if (SystemCallSession.current?.id == id) {
        SystemCallPip.stream = stream
        appContext.currentActivity?.let { SystemCallPip.refresh(it) }
      }
    }.runOnQueue(expo.modules.kotlin.functions.Queues.MAIN)
    AsyncFunction("setAvatar") Coroutine { id: String, file: String ->
      SystemCallSession.setAvatar(id, file)
    }
    AsyncFunction("route") Coroutine { id: String, route: String ->
      withContext(Dispatchers.Main.immediate) {
        SystemCallSession.route(id, route)
      }
    }
    AsyncFunction("end") { id: String ->
      SystemCallSession.end(id)
    }.runOnQueue(expo.modules.kotlin.functions.Queues.MAIN)
  }

  private fun openFromIntent(intent: Intent?) {
    val id = intent?.getStringExtra(OngoingCallService.CALL_ID) ?: return
    intent.removeExtra(OngoingCallService.CALL_ID)
    SystemCallSession.open(id)
  }
}

internal object SystemCallSession {
  class Call(
    val context: Context,
    val id: String,
    val name: String,
    var privateMode: Boolean,
    val labels: CallLabels
  ) {
    val ready = CompletableDeferred<Boolean>()
    val foreground = CompletableDeferred<Boolean>()
    val ended = CompletableDeferred<Unit>()
    var answeredAt = 0L
    var endpoints = emptyList<CallEndpointCompat>()
    var endpoint: CallEndpointCompat? = null
    var control: CallControlScope? = null
    var service: OngoingCallService? = null
    var job: Job? = null
    var readyForAudio = false
    var platformDisconnecting = false
    var avatar: IconCompat? = null
    var groupTitle: String? = null
    var participants: String? = null
  }

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  private var ending: CompletableDeferred<Unit>? = null
  private var pendingStart: String? = null
  var current: Call? = null
    private set
  var event: ((Map<String, String>) -> Unit)? = null
  var routing: ((Map<String, Any?>) -> Unit)? = null

  fun runOnMain(action: () -> Unit) { scope.launch { action() } }

  suspend fun start(context: Context, id: String, name: String, incoming: Boolean, privateMode: Boolean, labels: CallLabels): Boolean {
    pendingStart = id
    try {
      ending?.await()
      if (pendingStart != id) return false
    } finally {
      if (pendingStart == id) pendingStart = null
    }
    if (current != null || event == null) return false
    val call = Call(context, id, name, privateMode, labels)
    current = call
    call.job = scope.launch {
      try {
        val telecom = CallsManager(context)
        telecom.registerAppWithTelecom(CallsManager.CAPABILITY_BASELINE)
        val attributes = CallAttributesCompat(
          // Telecom can share this metadata with connected devices and system surfaces.
          labels.privateCaller,
          Uri.fromParts("boop", "call", null),
          if (incoming) CallAttributesCompat.DIRECTION_INCOMING else CallAttributesCompat.DIRECTION_OUTGOING,
          CallAttributesCompat.CALL_TYPE_AUDIO_CALL,
          callCapabilities = 0
        )
        telecom.addCall(
          attributes,
          { _ -> },
          {
            call.platformDisconnecting = true
            requestEnd(id)
            withTimeout(4_000) { call.ended.await() }
          },
          { },
          { throw IllegalStateException("Hold is unavailable") }
        ) {
          val control = this
          call.control = control
          launch {
            try {
              if (current !== call) return@launch
              val service = Intent(context, OngoingCallService::class.java)
                .putExtra(OngoingCallService.CALL_ID, id)
              context.startForegroundService(service)
              if (!withTimeout(4_000) { call.foreground.await() })
                throw IllegalStateException("Could not start the call service")
              if (control.setActive() !is CallControlResult.Success)
                throw IllegalStateException("Could not activate the Telecom call")
              launch { control.availableEndpoints.collect { call.endpoints = it; publishRoutes(call) } }
              launch { control.currentCallEndpoint.collect { call.endpoint = it; publishRoutes(call) } }
              call.readyForAudio = true
              call.ready.complete(true)
            } catch (error: CancellationException) {
              if (current === call) fail(call)
              throw error
            } catch (_: Exception) {
              fail(call)
            }
          }
        }
        if (current === call) fail(call)
      } catch (error: CancellationException) {
        throw error
      } catch (_: Exception) {
        fail(call)
      }
    }
    val started = withTimeoutOrNull(8_000) { call.ready.await() } == true
    if (!started && current === call) end(id)
    if (!started) ending?.await()
    return started
  }

  fun update(id: String, answeredAt: Long, privateMode: Boolean) {
    val call = current?.takeIf { it.id == id } ?: return
    if (call.answeredAt == answeredAt && call.privateMode == privateMode) return
    call.answeredAt = answeredAt
    call.privateMode = privateMode
    refreshNotification(call)
  }

  fun updateGroup(id: String, title: String?, participants: String?) {
    val call = current?.takeIf { it.id == id } ?: return
    if (call.groupTitle == title && call.participants == participants) return
    call.groupTitle = title
    call.participants = participants
    refreshNotification(call)
  }

  suspend fun setAvatar(id: String, path: String) = withContext(Dispatchers.Main.immediate) {
    val call = current?.takeIf { it.id == id && !it.privateMode } ?: return@withContext
    val icon = withContext(Dispatchers.IO) {
      runCatching {
        val cache = call.context.cacheDir.canonicalFile
        val file = File(path).canonicalFile
        if (!file.path.startsWith(cache.path + File.separator)) return@runCatching null
        val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, options)
        val largestDimension = maxOf(options.outWidth, options.outHeight)
        if (largestDimension <= 0) return@runCatching null
        options.inSampleSize = Integer.highestOneBit(maxOf(1, largestDimension / 128))
        options.inJustDecodeBounds = false
        BitmapFactory.decodeFile(file.path, options)?.let(IconCompat::createWithBitmap)
      }.getOrNull()
    } ?: return@withContext
    if (current === call && !call.privateMode) {
      call.avatar = icon
      refreshNotification(call)
    }
  }

  private fun refreshNotification(call: Call) {
    try {
      call.service?.refresh(call)
    } catch (_: RuntimeException) {
      fail(call)
    }
  }

  fun serviceStarted(id: String, service: OngoingCallService) {
    val call = current?.takeIf { it.id == id } ?: return
    call.service = service
    call.foreground.complete(true)
  }

  fun serviceFailed(id: String) {
    current?.takeIf { it.id == id }?.let(::fail)
  }

  fun serviceDestroyed(id: String, service: OngoingCallService) {
    val call = current?.takeIf { it.id == id && it.service === service } ?: return
    fail(call)
  }

  private fun fail(call: Call) {
    if (current !== call) return
    val wasReady = call.readyForAudio
    end(call.id)
    if (wasReady) emit("failure", call.id)
  }

  fun requestEnd(id: String) {
    if (current?.id == id) emit("end", id)
  }

  fun open(id: String) {
    if (current?.id == id) emit("open", id)
  }

  fun emit(kind: String, id: String) {
    event?.invoke(mapOf("kind" to kind, "callId" to id))
  }

  fun end(id: String) {
    if (pendingStart == id) pendingStart = null
    val call = current?.takeIf { it.id == id } ?: return
    current = null
    call.ready.complete(false)
    call.foreground.complete(false)
    call.ended.complete(Unit)
    SystemCallPip.clear()
    call.context.stopService(Intent(call.context, OngoingCallService::class.java))
    val done = CompletableDeferred<Unit>()
    ending = done
    scope.launch {
      try {
        withTimeoutOrNull(2_000) {
          if (!call.platformDisconnecting)
            call.control?.disconnect(DisconnectCause(DisconnectCause.LOCAL))
        }
      } finally {
        call.job?.cancel()
        done.complete(Unit)
        if (ending === done) ending = null
      }
    }
  }

  fun reset() {
    pendingStart = null
    event = null
    routing = null
    current?.let { end(it.id) }
  }

  suspend fun route(id: String, route: String): Boolean {
    val call = current?.takeIf { it.id == id } ?: return false
    val endpoint = call.endpoints.firstOrNull { routeName(it) == route } ?: return false
    return call.control?.requestEndpointChange(endpoint) is CallControlResult.Success
  }

  private fun publishRoutes(call: Call) {
    if (current !== call) return
    routing?.invoke(mapOf(
      "callId" to call.id,
      "available" to call.endpoints.mapNotNull(::routeName).distinct(),
      "selected" to call.endpoint?.let(::routeName)
    ))
  }

  private fun routeName(endpoint: CallEndpointCompat): String? = when (endpoint.type) {
    CallEndpointCompat.TYPE_EARPIECE -> "EARPIECE"
    CallEndpointCompat.TYPE_SPEAKER -> "SPEAKER_PHONE"
    CallEndpointCompat.TYPE_BLUETOOTH -> "BLUETOOTH"
    CallEndpointCompat.TYPE_WIRED_HEADSET -> "WIRED_HEADSET"
    else -> null
  }
}
