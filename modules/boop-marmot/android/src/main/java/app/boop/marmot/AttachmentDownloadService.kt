package app.boop.marmot

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder

/** Keeps the MarmotKit worker process alive for admitted, verified media transfers. */
class AttachmentDownloadService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    synchronized(Companion) {
      getSystemService(NotificationManager::class.java).createNotificationChannel(
        NotificationChannel(CHANNEL, getString(R.string.boop_download_channel), NotificationManager.IMPORTANCE_LOW),
      )
      try {
        startForeground(
          NOTIFICATION,
          Notification.Builder(this, CHANNEL)
            .setContentTitle(getString(R.string.boop_download_running))
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setProgress(0, 0, true)
            .setOngoing(true)
            .build(),
          ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
        )
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
    val interrupt = synchronized(Companion) {
      if (service === this) service = null
      transfers.values.toList()
    }
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf(startId)
    interrupt.forEach { it() }
  }

  override fun onDestroy() {
    synchronized(Companion) { if (service === this) service = null }
    super.onDestroy()
  }

  companion object {
    private const val CHANNEL = "boop.downloads"
    private const val NOTIFICATION = 9031
    private val transfers = LinkedHashMap<String, () -> Unit>()
    private var service: AttachmentDownloadService? = null

    @Synchronized
    fun acquire(context: Context, id: String, interrupt: () -> Unit) {
      transfers[id] = interrupt
      if (service != null || transfers.size != 1) return
      try {
        context.startForegroundService(Intent(context, AttachmentDownloadService::class.java))
      } catch (_: IllegalStateException) {
        // An already-admitted transfer can continue while the process is alive.
      } catch (_: SecurityException) {
        // Android may deny foreground execution.
      }
    }

    @Synchronized
    fun release(id: String) {
      if (transfers.remove(id) == null || transfers.isNotEmpty()) return
      val active = service ?: return
      service = null
      active.stopForeground(STOP_FOREGROUND_REMOVE)
      active.stopSelf()
    }
  }
}
