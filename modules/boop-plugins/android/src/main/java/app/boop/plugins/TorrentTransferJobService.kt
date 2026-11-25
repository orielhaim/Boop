package app.boop.plugins

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.job.JobParameters
import android.app.job.JobService
import android.app.PendingIntent
import android.content.Intent
import android.graphics.drawable.Icon
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/** Keeps an already admitted native torrent request alive while Android permits it. */
class TorrentTransferJobService : JobService() {
  private val executor = Executors.newFixedThreadPool(2)
  private val jobs = ConcurrentHashMap<Int, RunningJob>()

  override fun onStartJob(params: JobParameters): Boolean {
    val token = params.extras.getString(TorrentTransferJobs.EXTRA_TOKEN)
    val transfer = token?.let(TorrentTransferJobs::transfer)
    if (transfer == null || transfer.jobId != params.jobId) {
      // The process-local authorization record is deliberately not restored after process death.
      return false
    }

    if (jobs.containsKey(params.jobId)) return true
    ensureNotificationChannel()
    try {
      setNotification(
        params,
        TorrentTransferJobs.notificationId(params.jobId),
        notification(0, transfer),
        JOB_END_NOTIFICATION_POLICY_REMOVE,
      )
    } catch (_: SecurityException) {
      TorrentTransferJobs.stoppedBySystem(params.jobId, userStopped = false)
      return false
    }
    val running = RunningJob(params, transfer)
    jobs[params.jobId] = running
    executor.execute {
      try {
        monitor(running)
      } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
      }
    }
    return true
  }

  override fun onStopJob(params: JobParameters): Boolean {
    TorrentTransferJobs.stoppedBySystem(
      params.jobId,
      params.stopReason == JobParameters.STOP_REASON_USER,
    )
    val running = jobs.remove(params.jobId)
    running?.stopped = true
    getSystemService(NotificationManager::class.java)
      .cancel(TorrentTransferJobs.notificationId(params.jobId))
    return false
  }

  override fun onDestroy() {
    for (running in jobs.values) {
      running.stopped = true
      TorrentTransferJobs.stoppedBySystem(running.params.jobId, userStopped = false)
    }
    jobs.clear()
    executor.shutdownNow()
    super.onDestroy()
  }

  private fun monitor(running: RunningJob) {
    var lastReceived = 0L
    while (!running.stopped && jobs[running.transfer.jobId] === running) {
      val result = try {
        JSONObject(running.transfer.execute("poll"))
      } catch (_: Exception) {
        TorrentTransferJobs.stoppedBySystem(running.params.jobId, userStopped = false)
        complete(running)
        return
      }

      when (result.optString("kind")) {
        "progress" -> {
          lastReceived = result.optLong("received", lastReceived).coerceAtLeast(0)
          updateNotification(running, lastReceived)
        }
        "completed", "failed", "stopped" -> {
          complete(running)
          return
        }
      }
      Thread.sleep(POLL_INTERVAL_MS)
    }
  }

  private fun updateNotification(running: RunningJob, received: Long) {
    if (running.stopped || jobs[running.transfer.jobId] !== running) return
    runCatching {
      setNotification(
        running.params,
        TorrentTransferJobs.notificationId(running.transfer.jobId),
        notification(received, running.transfer),
        JOB_END_NOTIFICATION_POLICY_REMOVE,
      )
    }
  }

  private fun complete(running: RunningJob) {
    if (!jobs.remove(running.transfer.jobId, running)) return
    running.stopped = true
    TorrentTransferJobs.completed(running.transfer.jobId)
    jobFinished(running.params, false)
  }

  private fun notification(
    received: Long,
    transfer: TorrentTransferJobs.TransferHandle,
  ): Notification {
    val builder = Notification.Builder(this, CHANNEL_ID)
    val total = transfer.totalBytes
    val progress = if (total > 0) {
      ((received.coerceAtMost(total).toDouble() / total.toDouble()) * PROGRESS_MAX)
        .toInt()
        .coerceIn(0, PROGRESS_MAX)
    } else 0
    builder
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setContentTitle(getString(R.string.torrent_transfer_title))
      .setContentText(getString(R.string.torrent_transfer_active))
      .setProgress(PROGRESS_MAX, progress, total <= 0)
      .setOnlyAlertOnce(true)
      .setOngoing(true)
      .setCategory(Notification.CATEGORY_PROGRESS)
    builder.addAction(
        Notification.Action.Builder(
          Icon.createWithResource(this, android.R.drawable.ic_media_pause),
          getString(R.string.torrent_transfer_pause),
          pausePendingIntent(transfer),
        ).build(),
      )
    return builder.build()
  }

  private fun ensureNotificationChannel() {
    getSystemService(NotificationManager::class.java).createNotificationChannel(
      NotificationChannel(
        CHANNEL_ID,
        getString(R.string.torrent_transfer_channel),
        NotificationManager.IMPORTANCE_LOW,
      ),
    )
  }

  private fun pausePendingIntent(transfer: TorrentTransferJobs.TransferHandle): PendingIntent {
    val intent = Intent(this, TorrentTransferActionReceiver::class.java).apply {
      action = TorrentTransferJobs.ACTION_PAUSE
      putExtra(TorrentTransferJobs.EXTRA_TOKEN, transfer.token)
    }
    return PendingIntent.getBroadcast(
      this,
      transfer.jobId,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  private class RunningJob(
    val params: JobParameters,
    val transfer: TorrentTransferJobs.TransferHandle,
    @Volatile var stopped: Boolean = false,
  )

  companion object {
    private const val CHANNEL_ID = "torrent-transfers"
    private const val PROGRESS_MAX = 1000
    private const val POLL_INTERVAL_MS = 1000L
  }
}
