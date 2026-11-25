package app.boop.plugins

import android.Manifest
import android.app.NotificationManager
import android.app.UiAutomation
import android.app.job.JobScheduler
import android.content.pm.PackageManager
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class TorrentTransferJobTest {
  @Test
  fun userInitiatedJobContinuesInBackgroundAndNotificationPauseStopsIt() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val context = instrumentation.targetContext.applicationContext
    val scheduler = context.getSystemService(JobScheduler::class.java)
    val notifications = context.getSystemService(NotificationManager::class.java)
    if (context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      instrumentation.getUiAutomation(UiAutomation.FLAG_DONT_USE_ACCESSIBILITY)
        .grantRuntimePermission(context.packageName, Manifest.permission.POST_NOTIFICATIONS)
    }
    val scope = "a".repeat(64)
    val requestId = UUID.randomUUID().toString()
    val firstPoll = CountDownLatch(1)
    val backgroundPoll = CountDownLatch(1)
    val paused = CountDownLatch(1)
    val backgrounded = AtomicBoolean(false)
    val polls = AtomicInteger(0)
    var jobId = 0
    val activity = ActivityScenario.launch(TorrentVideoRenderActivity::class.java)
    try {
      activity.onActivity {
        jobId = TorrentTransferJobs.begin(context, scope, requestId, 4096L) { command ->
          when (command) {
            "poll" -> {
              firstPoll.countDown()
              if (backgrounded.get()) backgroundPoll.countDown()
              JSONObject().put("kind", "progress").put("received", polls.incrementAndGet()).toString()
            }
            "cancel" -> {
              paused.countDown()
              """{"kind":"stopped"}"""
            }
            else -> error("Unexpected transfer command")
          }
        }
      }
      assertTrue(scheduler.getPendingJob(jobId)?.isUserInitiated == true)
      assertTrue("Android did not start the data transfer job", firstPoll.await(12, TimeUnit.SECONDS))
      activity.moveToState(Lifecycle.State.CREATED)
      backgrounded.set(true)
      assertTrue("The job stopped observing after its activity backgrounded", backgroundPoll.await(5, TimeUnit.SECONDS))

      val progressNotification = notifications.activeNotifications.singleOrNull {
        it.id == TorrentTransferJobs.notificationId(jobId)
      }
      assertNotNull("The background progress notification is missing", progressNotification)
      progressNotification!!.notification.actions.single().actionIntent.send()
      assertTrue("Pause did not reach the active transfer", paused.await(5, TimeUnit.SECONDS))
      val terminal = TorrentTransferJobs.pollOverride(scope, requestId)
      assertEquals("system_stopped", terminal?.let { JSONObject(it).getString("code") })
      assertNull(scheduler.getPendingJob(jobId))
    } finally {
      TorrentTransferJobs.finish(context, scope, requestId)
      activity.close()
    }
  }
}
