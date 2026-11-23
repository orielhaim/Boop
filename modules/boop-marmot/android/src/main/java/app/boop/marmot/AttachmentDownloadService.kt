package app.boop.marmot

import android.app.ActivityManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.os.SystemClock

class AttachmentDownloadService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    synchronized(Companion) {
      val manager = getSystemService(NotificationManager::class.java)
      manager.createNotificationChannel(NotificationChannel(
        CHANNEL, getString(R.string.boop_download_channel), NotificationManager.IMPORTANCE_LOW,
      ))
      try {
        startForeground(NOTIFICATION, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        service = this
        if (transfers.isEmpty()) stopSelf(startId)
      } catch (_: IllegalStateException) {
        stopSelf(startId)
      } catch (_: SecurityException) {
        stopSelf(startId)
      }
    }
    return START_NOT_STICKY
  }

  override fun onTimeout(startId: Int, fgsType: Int) {
    synchronized(Companion) { if (service === this) service = null }
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf(startId)
  }

  override fun onDestroy() {
    synchronized(Companion) { if (service === this) service = null }
    super.onDestroy()
  }

  private fun launchIntent() = packageManager.getLaunchIntentForPackage(packageName)?.let {
    PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  private fun notification(): Notification {
    val values = transfers.values.toList()
    val total = values.mapNotNull { it.total?.takeIf { bytes -> bytes > 0 } }.takeIf { it.size == values.size }?.sum()
    val percent = if (total != null && total > 0) {
      (values.sumOf { it.received } / total * 100).toInt().coerceIn(0, 100)
    } else 0
    return Notification.Builder(this, CHANNEL)
      .setContentTitle(getString(R.string.boop_download_running))
      .setContentIntent(launchIntent())
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setVisibility(Notification.VISIBILITY_PRIVATE)
      .setOnlyAlertOnce(true)
      .setOngoing(true)
      .setProgress(100, percent, total == null || total <= 0)
      .build()
  }

  companion object {
    private const val CHANNEL = "boop.downloads"
    private const val NOTIFICATION = 9031
    private const val COMPLETED = 9032
    private data class Transfer(val received: Double = 0.0, val total: Double? = null)
    private val transfers = LinkedHashMap<String, Transfer>()
    private var service: AttachmentDownloadService? = null
    private var lastUpdate = 0L
    private var finished = false

    @Synchronized
    fun acquire(context: Context, id: String) {
      if (transfers.isEmpty()) finished = false
      transfers[id] = Transfer()
      if (service != null || transfers.size != 1) return
      try {
        context.startForegroundService(Intent(context, AttachmentDownloadService::class.java))
      } catch (_: IllegalStateException) {
        // Android can refuse foreground starts if the app left the visible state.
      } catch (_: SecurityException) {
        // MDK can still transfer while the application process is running.
      }
    }

    @Synchronized
    fun progress(id: String, received: Double, total: Double?, ready: Boolean) {
      if (!transfers.containsKey(id)) return
      transfers[id] = Transfer(received, total)
      finished = finished || ready
      val active = service ?: return
      val now = SystemClock.elapsedRealtime()
      if (now - lastUpdate < 1_000) return
      lastUpdate = now
      active.getSystemService(NotificationManager::class.java).notify(NOTIFICATION, active.notification())
    }

    @Synchronized
    fun release(id: String) {
      if (transfers.remove(id) == null || transfers.isNotEmpty()) return
      val active = service ?: return
      service = null
      if (finished) {
        val process = ActivityManager.RunningAppProcessInfo()
        ActivityManager.getMyMemoryState(process)
        val manager = active.getSystemService(NotificationManager::class.java)
        if (process.importance > ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND &&
          manager.areNotificationsEnabled()
        ) {
          manager.notify(COMPLETED, Notification.Builder(active, CHANNEL)
            .setContentTitle(active.getString(R.string.boop_download_completed))
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentIntent(active.launchIntent())
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setAutoCancel(true)
            .build())
        }
      }
      active.stopForeground(STOP_FOREGROUND_REMOVE)
      active.stopSelf()
    }
  }
}
