package app.boop.plugins

import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Context
import android.os.PersistableBundle
import android.util.LruCache
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/** Owns UIDT jobs for transfers already admitted by the protected DownloadManager. */
internal object TorrentTransferJobs {
  private val nextJobId = AtomicInteger((System.nanoTime() and 0x3fffffff).toInt().coerceAtLeast(1))
  private val transfers = ConcurrentHashMap<String, Transfer>()
  private val stopped = LruCache<String, String>(64)
  private val nativeControls = Executors.newFixedThreadPool(2)

  private data class Transfer(
    val token: String,
    val jobId: Int,
    val scope: String,
    val requestId: String,
    val totalBytes: Long,
    val execute: (String) -> String,
  )

  private fun key(scope: String, requestId: String) = "$scope:$requestId"

  /**
   * Schedule only after the foreground native start request has been admitted.
   * The token is process-local and is the only transfer data in JobScheduler extras.
   */
  @Synchronized
  fun begin(
    context: Context,
    scope: String,
    requestId: String,
    totalBytes: Long,
    execute: (String) -> String,
  ): Int {
    require(scope.matches(Regex("[a-f0-9]{64}")))
    require(requestId.matches(Regex("[A-Za-z0-9-]{1,128}")))
    require(totalBytes >= 0)

    val transferKey = key(scope, requestId)
    transfers.values.firstOrNull { it.scope == scope && it.requestId == requestId }?.let {
      return it.jobId
    }

    val scheduler = context.getSystemService(JobScheduler::class.java)
      ?: error("JobScheduler unavailable")
    val token = UUID.randomUUID().toString()
    var jobId = nextJobId.updateAndGet { current -> if (current >= 0x3fffffff) 1 else current + 1 }
    while (transfers.values.any { it.jobId == jobId } || scheduler.getPendingJob(jobId) != null) {
      jobId = nextJobId.updateAndGet { current -> if (current >= 0x3fffffff) 1 else current + 1 }
    }
    val transfer = Transfer(token, jobId, scope, requestId, totalBytes, execute)
    transfers[token] = transfer

    try {
      val extras = PersistableBundle().apply { putString(EXTRA_TOKEN, token) }
      val builder = JobInfo.Builder(
        jobId,
        ComponentName(context, TorrentTransferJobService::class.java),
      )
        .setUserInitiated(true)
        .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
        .setExtras(extras)
      if (totalBytes > 0) builder.setEstimatedNetworkBytes(totalBytes, 0L)
      check(scheduler.schedule(builder.build()) == JobScheduler.RESULT_SUCCESS) {
        "Could not schedule torrent transfer"
      }
    } catch (error: Exception) {
      transfers.remove(token)
      throw error
    }
    stopped.remove(transferKey)
    return jobId
  }

  @Synchronized
  fun finish(context: Context, scope: String, requestId: String) {
    val key = key(scope, requestId)
    stopped.remove(key)
    val transfer = transfers.values.firstOrNull {
      it.scope == scope && it.requestId == requestId
    } ?: return
    transfers.remove(transfer.token)
    context.getSystemService(JobScheduler::class.java)?.cancel(transfer.jobId)
  }

  @Synchronized
  fun revokeScope(context: Context, scope: String) {
    val affected = transfers.values.filter { it.scope == scope }
    for (transfer in affected) {
      transfers.remove(transfer.token)
      context.getSystemService(JobScheduler::class.java)?.cancel(transfer.jobId)
    }
  }

  @Synchronized
  fun pauseByToken(context: Context, token: String): Int? {
    val transfer = transfers.remove(token) ?: return null
    stopped.put(key(transfer.scope, transfer.requestId), SYSTEM_STOPPED)
    context.getSystemService(JobScheduler::class.java)?.cancel(transfer.jobId)
    cancelNative(transfer)
    return transfer.jobId
  }

  fun pollOverride(scope: String, requestId: String): String? =
    when (stopped[key(scope, requestId)]) {
      SYSTEM_STOPPED -> SYSTEM_STOP_RESPONSE
      SYSTEM_INTERRUPTED -> SYSTEM_INTERRUPTED_RESPONSE
      else -> null
    }

  fun hasActiveScope(scope: String): Boolean =
    transfers.values.any { it.scope == scope }

  fun isAdmitted(scope: String, requestId: String): Boolean =
    transfers.values.any { it.scope == scope && it.requestId == requestId }

  internal fun transfer(token: String): TransferHandle? {
    val transfer = transfers[token] ?: return null
    if (transfer.token != token) return null
    return TransferHandle(transfer.totalBytes, transfer.jobId, transfer.token, transfer.execute)
  }

  @Synchronized
  internal fun completed(jobId: Int) {
    val transfer = transfers.values.firstOrNull { it.jobId == jobId } ?: return
    transfers.remove(transfer.token)
  }

  @Synchronized
  internal fun stoppedBySystem(jobId: Int, userStopped: Boolean) {
    val transfer = transfers.values.firstOrNull { it.jobId == jobId } ?: return
    stopped.put(
      key(transfer.scope, transfer.requestId),
      if (userStopped) SYSTEM_STOPPED else SYSTEM_INTERRUPTED,
    )
    transfers.remove(transfer.token)
    cancelNative(transfer)
  }

  internal data class TransferHandle(
    val totalBytes: Long,
    val jobId: Int,
    val token: String,
    val execute: (String) -> String,
  )

  internal fun notificationId(jobId: Int) = jobId xor 0x40000000

  internal const val EXTRA_TOKEN = "boop_transfer_token"
  internal const val ACTION_PAUSE = "app.boop.plugins.action.PAUSE_TRANSFER"
  internal const val SYSTEM_STOPPED = "system_stopped"
  internal const val SYSTEM_INTERRUPTED = "system_interrupted"

  private fun cancelNative(transfer: Transfer) {
    nativeControls.execute {
      runCatching { transfer.execute("cancel") }
    }
  }

  private val SYSTEM_STOP_RESPONSE =
    """{"kind":"failed","code":"$SYSTEM_STOPPED"}"""
  private val SYSTEM_INTERRUPTED_RESPONSE =
    """{"kind":"failed","code":"$SYSTEM_INTERRUPTED"}"""
}
