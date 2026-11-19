
package com.oney.WebRTCModule

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.app.ServiceCompat
import app.boop.camerapreview.R

class EndCallReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val id = intent.getStringExtra(OngoingCallService.CALL_ID) ?: return
    SystemCallSession.requestEnd(id)
  }
}

class OngoingCallService : Service() {
  companion object {
    const val CALL_ID = "app.boop.ongoingCall"
    private const val CHANNEL_ID = "ongoing_calls"
    private const val NOTIFICATION_ID = 3401
  }

  private var activeId: String? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val id = intent?.getStringExtra(CALL_ID)
    val call = SystemCallSession.current
    if (call == null || call.id != id) {
      if (activeId == null) stopSelfResult(startId)
      return START_NOT_STICKY
    }
    activeId = call.id
    try {
      val manager = getSystemService(NotificationManager::class.java)
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, call.labels.channel, NotificationManager.IMPORTANCE_DEFAULT)
          .apply { setSound(null, null) }
      )
      val types = when {
        Build.VERSION.SDK_INT >= 30 ->
          ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        Build.VERSION.SDK_INT >= 29 -> ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL
        else -> 0
      }
      ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(call), types)
      SystemCallSession.serviceStarted(call.id, this)
    } catch (_: RuntimeException) {
      SystemCallSession.serviceFailed(call.id)
      stopSelfResult(startId)
    }
    return START_NOT_STICKY
  }

  internal fun refresh(call: SystemCallSession.Call) {
    if (call.id == activeId)
      getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(call))
  }

  override fun onDestroy() {
    stopForeground(STOP_FOREGROUND_REMOVE)
    activeId?.let { SystemCallSession.serviceDestroyed(it, this) }
    super.onDestroy()
  }

  private fun notification(call: SystemCallSession.Call): Notification {
    val name = if (call.privateMode) call.labels.privateCaller else call.name
    val person = Person.Builder().setName(name)
      .setIcon(if (call.privateMode) null else call.avatar).build()
    val content = packageManager.getLaunchIntentForPackage(packageName)?.apply {
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
      putExtra(CALL_ID, call.id)
    }
    val open = content?.let {
      PendingIntent.getActivity(this, 1, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
    val end = Intent(this, EndCallReceiver::class.java).apply {
      data = android.net.Uri.fromParts("boop-end", call.id, null)
      putExtra(CALL_ID, call.id)
    }
    val disconnect = PendingIntent.getBroadcast(this, 2, end, PendingIntent.FLAG_IMMUTABLE)
    val builder = NotificationCompat.Builder(this, CHANNEL_ID)
      .setStyle(NotificationCompat.CallStyle.forOngoingCall(person, disconnect))
      .setContentTitle(name)
      .setContentText(if (call.answeredAt == 0L) call.labels.connecting else call.labels.ongoing)
      .setSmallIcon(R.drawable.boop_call_status)
      .setContentIntent(open)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
    if (call.answeredAt != 0L) {
      builder.setWhen(call.answeredAt).setShowWhen(true).setUsesChronometer(true)
      if (Build.VERSION.SDK_INT >= 36 &&
          getSystemService(NotificationManager::class.java).canPostPromotedNotifications()) {
        builder.setRequestPromotedOngoing(true)
      }
    }
    return builder.build()
  }
}
