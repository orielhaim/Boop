package app.boop.plugins

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.app.NotificationManager

class TorrentTransferActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != TorrentTransferJobs.ACTION_PAUSE) return
    val token = intent.getStringExtra(TorrentTransferJobs.EXTRA_TOKEN) ?: return
    val jobId = TorrentTransferJobs.pauseByToken(context, token) ?: return
    context.getSystemService(NotificationManager::class.java)
      .cancel(TorrentTransferJobs.notificationId(jobId))
  }
}
