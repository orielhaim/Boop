package app.boop.marmot

import android.graphics.Bitmap
import androidx.test.platform.app.InstrumentationRegistry
import dev.ipf.marmotkit.*
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URI
import java.util.UUID
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test

class MarmotRelayTest {
  @Test fun directAndGroupUseIndependentDurableAccounts() = runBlocking {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val context = instrumentation.targetContext
    val relay = InstrumentationRegistry.getArguments().getString("relay")
      ?: error("Pass the fixture WebSocket URL as the relay instrumentation argument")
    val blossom = InstrumentationRegistry.getArguments().getString("blossom")
    val fixture = URI(relay)
    Socket().use { it.connect(InetSocketAddress(fixture.host, fixture.port), 4_000) }
    MarmotAndroid.initialize(context)
    val root = File(context.noBackupFilesDir, "fixture-${UUID.randomUUID()}")
    try {
      val alice = Client(File(root, "alice"), relay, blossom)
      val bob = Client(File(root, "bob"), relay, blossom)
      val carol = Client(File(root, "carol"), relay, blossom)
      try {
        alice.start()
        bob.start()
        carol.start()
        for (client in listOf(alice, bob, carol)) {
          try {
            await("${client.directory.name} KeyPackage publication") {
              client.kit.accountSetupReadiness(client.key) == AccountSetupReadinessFfi.NETWORK_READY
            }
          } catch (error: AssertionError) {
            throw AssertionError("Account readiness: ${client.kit.accountSetupReadiness(client.key)}; relay health: ${client.kit.relayHealth()}", error)
          }
        }

        val available = alice.kit.prewarmGroupMemberKeyPackages(alice.key, listOf(bob.key))
        assertEquals(1uL, available.uniqueMembers)
        val direct = alice.kit.startDirectConversation(alice.key, bob.key)
        assertEquals(direct, alice.kit.startDirectConversation(alice.key, bob.key))
        bob.accept(direct)
        val first = alice.kit.sendTextWithClientToken(alice.key, direct, "hello from Alice", "first-direct-message")
        bob.receives(direct, alice.key, "hello from Alice")
        bob.kit.replyToMessageWithClientToken(bob.key, direct, first.messageIdHex, "reply from Bob", "first-direct-reply")
        alice.receives(direct, bob.key, "reply from Bob")
        alice.kit.reactToMessage(alice.key, direct, first.messageIdHex, "👍")
        await("authenticated reaction") {
          bob.kit.messages(bob.key, direct, 30u, listOf(7uL)).any { it.sender == alice.key && it.plaintext == "👍" }
        }
        alice.kit.editMessage(alice.key, direct, first.messageIdHex, "edited by Alice")
        await("edit history") { bob.kit.messageEditHistory(bob.key, direct, first.messageIdHex, null, null, 20u).versions.isNotEmpty() }
        val applicationEvent = """{"latitude":0,"longitude":0}"""
        alice.kit.sendCustomEvent(alice.key, direct, 24883uL, emptyList(), applicationEvent)
        bob.receives(direct, alice.key, applicationEvent)
        bob.kit.openConversationWindow(bob.key, direct, ConversationOpenModeFfi.AUTOMATIC, null, 30u, 15_000u).use { window ->
          await("application event in conversation projection") {
            window.snapshot()?.messages?.any { it.timeline.kind == 24883uL && it.timeline.plaintext == applicationEvent } == true
          }
        }
        assertEquals(EncryptedMediaVersionFfi.V2, alice.kit.groupDetails(alice.key, direct).group.encryptedMedia.version)
        verifyWindowDelta(alice, bob, direct)
        if (blossom != null) mediaRoundTrip(alice, bob, direct, blossom)

        alice.close()
        bob.close()
        alice.start()
        bob.start()
        bob.kit.openConversationWindow(bob.key, direct, ConversationOpenModeFfi.AUTOMATIC, null, 30u, 15_000u).use { window ->
          assertNotNull(window.snapshot())
        }
        bob.receives(direct, alice.key, "hello from Alice")
        val afterRestart = "after process-independent runtime restart"
        alice.kit.sendTextWithClientToken(alice.key, direct, afterRestart, "after-restart")
        bob.kit.catchUpAccounts()
        try {
          bob.receives(direct, alice.key, afterRestart)
        } catch (error: AssertionError) {
          val sender = alice.kit.groupDetails(alice.key, direct).mlsState
          val recipient = bob.kit.groupDetails(bob.key, direct).mlsState
          val status = alice.kit.localSendStatus(alice.key, direct, "after-restart")
          throw AssertionError("Restart sender ${sender.lifecycleState} epoch ${sender.epoch}; recipient ${recipient.lifecycleState} epoch ${recipient.epoch}; send status $status", error)
        }

        val group = alice.kit.createGroupDetailed(alice.key, "Fixture group", listOf(bob.key, carol.key), "Integration fixture")
          .created?.groupIdHex ?: error("Group creation failed")
        bob.accept(group)
        carol.accept(group)
        assertEquals("encrypted-media-v2", alice.kit.groupDetails(alice.key, group).group.encryptedMedia.mediaFormat)
        alice.kit.sendTextWithClientToken(alice.key, group, "hello group", "first-group-message")
        bob.receives(group, alice.key, "hello group")
        carol.receives(group, alice.key, "hello group")
        val target = bob.kit.messages(bob.key, group, 30u, null)
          .single { it.plaintext == "hello group" }.messageIdHex
        bob.kit.reportMessage(bob.key, group, target, ReportReasonFfi.SPAM, "")
        await("group report with authenticated reporter") {
          alice.kit.contentReports(alice.key, group, target, null, 10u).reports.any {
            it.reason == ReportReasonFfi.SPAM && it.reporter == bob.key
          }
        }
        if (blossom != null) groupPhotoRoundTrip(alice, bob, group)

        alice.kit.updateGroupProfile(alice.key, group, "Renamed group", "New description")
        await("canonical group profile") { bob.kit.groupDetails(bob.key, group).group.name == "Renamed group" }
        alice.kit.promoteAdmin(alice.key, group, bob.key)
        await("canonical admin promotion") { bob.kit.groupManagementState(bob.key, group).isSelfAdmin }
        concurrentProfileUpdates(alice, bob, group)
        alice.kit.demoteAdmin(alice.key, group, bob.key)
        await("canonical admin demotion") { !bob.kit.groupManagementState(bob.key, group).isSelfAdmin }
        alice.kit.removeMembers(alice.key, group, listOf(carol.key))
        await("removed membership") { carol.kit.groupDetails(carol.key, group).group.selfMembership == SelfMembershipFfi.REMOVED }
        alice.kit.sendTextWithClientToken(alice.key, group, "after removal", "after-removal")
        bob.receives(group, alice.key, "after removal")
        assertFalse(carol.kit.messages(carol.key, group, 30u, null).any { it.plaintext == "after removal" })
        groupPoll(alice, bob, group)
        val secondAlice = Client(File(root, "alice-linked"), relay, blossom)
        try {
          secondAlice.start(alice.kit.revealNsec(alice.key))
          assertEquals(alice.key, secondAlice.key)
          linkDevice(alice, secondAlice)
        } finally {
          secondAlice.close()
        }
        bob.close()
        alice.kit.sendTextWithClientToken(alice.key, direct, "delivered after offline interval", "offline-recipient")
        bob.start()
        bob.kit.catchUpAccounts()
        bob.receives(direct, alice.key, "delivered after offline interval")

        val declined = alice.kit.createGroupDetailed(alice.key, "Declined fixture", listOf(bob.key), null)
          .created?.groupIdHex ?: error("Could not create decline fixture")
        await("declinable Welcome") {
          bob.kit.chatList(bob.key, false).any { it.groupIdHex == declined && it.pendingConfirmation }
        }
        bob.kit.declineGroupInvite(bob.key, declined)
        await("declined invitation left the inbox") {
          bob.kit.chatList(bob.key, false).none { it.groupIdHex == declined && it.pendingConfirmation }
        }

        bob.kit.leaveGroup(bob.key, group)
        await("authenticated leave") {
          alice.kit.groupDetails(alice.key, group).members.none { it.memberIdHex == bob.key }
        }
        alice.kit.enableGroupDisbanding(alice.key, group)
        await("authenticated disbanding policy") { alice.kit.groupManagementState(alice.key, group).canDisband }
        alice.kit.disbandGroup(alice.key, group)
        await("disbanded group state") {
          alice.kit.groupDetails(alice.key, group).mlsState.lifecycleState == GroupLifecycleStateFfi.DISBANDED
        }
      } finally {
        for (client in listOf(carol, bob, alice)) client.close()
      }
    } finally {
      root.deleteRecursively()
    }
  }

  private suspend fun verifyWindowDelta(sender: Client, recipient: Client, group: String) {
    val handle = recipient.kit.openConversationWindow(recipient.key, group, ConversationOpenModeFfi.LATEST, null, 3u, 15_000u)
    val window = ConversationWindow(handle)
    try {
      val initial = checkNotNull(window.initial())
      val initialRows = initial["messages"] as List<*>
      assertEquals(3, initialRows.size)
      val body = "new message for the bounded window"
      sender.kit.sendTextWithClientToken(sender.key, group, body, "window-delta-proof")
      val next = withTimeout(35_000) {
        var projected = checkNotNull(window.next())
        while ((projected["messages"] as List<*>).filterIsInstance<Map<*, *>>().none { it["text"] == body }) {
          projected = checkNotNull(window.next())
        }
        projected
      }
      assertEquals(3, (next["messages"] as List<*>).size)
      val delta = checkNotNull(windowDelta(initial, next))
      assertEquals(listOf(body), (delta["changed"] as List<*>).filterIsInstance<Map<*, *>>().map { it["text"] })
      assertEquals(3, (delta["order"] as List<*>).size)
    } finally {
      window.stop()
    }
  }

  private suspend fun concurrentProfileUpdates(alice: Client, bob: Client, group: String) = coroutineScope {
    await("both group views stabilized before concurrent changes") {
      listOf(alice, bob).all { it.kit.groupDetails(it.key, group).mlsState.lifecycleState == GroupLifecycleStateFfi.STABLE }
    }
    val first = async { runCatching { alice.kit.updateGroupProfile(alice.key, group, "Alice update", null) } }
    val second = async { runCatching { bob.kit.updateGroupProfile(bob.key, group, "Bob update", null) } }
    val outcomes = listOf(first.await(), second.await())
    assertTrue(outcomes.any { it.isSuccess })
    await("group converged after competing mutations") {
      val a = alice.kit.groupDetails(alice.key, group)
      val b = bob.kit.groupDetails(bob.key, group)
      a.mlsState.lifecycleState == GroupLifecycleStateFfi.STABLE &&
        b.mlsState.lifecycleState == GroupLifecycleStateFfi.STABLE &&
        a.mlsState.epoch == b.mlsState.epoch &&
        a.group.name == b.group.name &&
        a.group.name in listOf("Alice update", "Bob update")
    }
  }

  private suspend fun groupPoll(alice: Client, bob: Client, group: String) {
    val question = "Which option?"
    alice.kit.createPoll(alice.key, group, question, listOf("First", "Second"), PollTypeFfi.SINGLE_CHOICE, null)
    val query = TimelineMessageQueryFfi(group, null, null, null, null, cursorGroupId = null,
      before = null, beforeMessageId = null, after = null, afterMessageId = null, limit = 40u)
    await("encrypted poll projection") {
      bob.kit.timelineMessages(bob.key, query).messages.any { it.poll?.question == question }
    }
    val pollRow = bob.kit.timelineMessages(bob.key, query).messages.single { it.poll?.question == question }
    val option = checkNotNull(pollRow.poll).options.first()
    bob.kit.castPollVote(bob.key, group, pollRow.messageIdHex, listOf(option.id))
    await("encrypted poll result") {
      alice.kit.timelineMessages(alice.key, query).messages.single { it.poll?.question == question }
        .poll?.options?.any { it.id == option.id && it.votes == 1uL } == true
    }
  }

  private suspend fun groupPhotoRoundTrip(admin: Client, member: Client, group: String) {
    val bitmap = Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888)
    val jpeg = try {
      bitmap.eraseColor(0xff3050b0.toInt())
      ByteArrayOutputStream().use { bytes ->
        assertTrue(bitmap.compress(Bitmap.CompressFormat.JPEG, 85, bytes))
        bytes.toByteArray()
      }
    } finally {
      bitmap.recycle()
    }
    admin.kit.updateGroupImage(admin.key, group, jpeg, "image/jpeg")
    await("authenticated group photo change") {
      member.kit.groupDetails(member.key, group).group.imageHashHex != null
    }
    assertArrayEquals(jpeg, member.kit.downloadGroupBlossomImage(member.key, group))
  }

  private suspend fun linkDevice(primary: Client, joining: Client) {
    joining.kit.startDeviceLink(joining.key)
    await("device emoji verification") {
      joining.kit.deviceLinkSnapshot(joining.key).newDevice is NewDeviceLinkStateFfi.Comparing &&
        primary.kit.deviceLinkSnapshot(primary.key).prompts.any { it.state is DeviceLinkPromptStateFfi.Comparing }
    }
    val joiningCode = (joining.kit.deviceLinkSnapshot(joining.key).newDevice as NewDeviceLinkStateFfi.Comparing).code
    val prompt = primary.kit.deviceLinkSnapshot(primary.key).prompts.single { it.state is DeviceLinkPromptStateFfi.Comparing }
    assertEquals(joiningCode, (prompt.state as DeviceLinkPromptStateFfi.Comparing).code)
    joining.kit.confirmDeviceLinkMatch(joining.key)
    primary.kit.linkDevice(primary.key, prompt.promptId, "Second fixture device", false, false)
    await("linked devices visible") {
      primary.kit.linkedDevices(primary.key).any { !it.isThisDevice && it.label == "Second fixture device" } &&
        joining.kit.linkedDevices(joining.key).any { !it.isThisDevice }
    }
    val slot = primary.kit.linkedDevices(primary.key).single { !it.isThisDevice }.slotIdHex
    await("device link settled before removal") {
      try {
        primary.kit.removeLinkedDevice(primary.key, slot)
        true
      } catch (error: MarmotKitException.Runtime) {
        if (error.details != "device group refused: device_link_pending") throw error
        false
      }
    }
    await("linked device removed") {
      primary.kit.linkedDevices(primary.key).none { it.slotIdHex == slot }
    }
  }

  private suspend fun mediaRoundTrip(sender: Client, recipient: Client, group: String, blossom: String) {
    val payload = "Synthetic Boop fixture ${UUID.randomUUID()}".toByteArray()
    val path = File(sender.directory, "fixture.txt").apply { writeBytes(payload) }
    val caption = "Encrypted document fixture"
    val request = MediaFileUploadRequestFfi(
      listOf(MediaFileUploadAttachmentRequestFfi(path.canonicalPath, path.length().toULong(), path.name, "text/plain", null, null)),
      caption, true, blossom,
    )
    val sent = MediaFileTransferControlFfi().use {
      sender.kit.uploadMediaFilesWithClientToken(sender.key, group, request, it, "fixture-media")
    }
    assertNotNull(sent.acceptance)
    recipient.receives(group, sender.key, caption)
    val row = recipient.kit.timelineMessages(recipient.key, TimelineMessageQueryFfi(group, caption, null, null, null,
      cursorGroupId = null, before = null, beforeMessageId = null, after = null, afterMessageId = null, limit = 30u)).messages.single()
    val attachment = row.media.single() as MediaAttachmentOutcomeFfi.Accepted
    assertEquals(EncryptedMediaVersionFfi.V2, attachment.reference.version)
    assertNotEquals(attachment.reference.plaintextSha256, attachment.reference.ciphertextSha256)
    val target = AttachmentLocalTargetFfi(row.messageIdHex, checkNotNull(row.sourceMessageIdHex), attachment.attachmentIndex)
    repeat(5) {
      assertEquals(AttachmentTransferStateFfi.NOT_REQUESTED,
        recipient.kit.attachmentTransferSnapshot(recipient.key, group, listOf(target)).items.single().state)
      delay(250)
    }
    MediaFileTransferControlFfi().use { control ->
      assertNull(recipient.kit.openAttachmentHandoff(recipient.key, group, target, control))
      assertNotNull(recipient.kit.requestExplicitAttachment(recipient.key, group, target))
      await("manual encrypted media download") {
        recipient.kit.attachmentTransferSnapshot(recipient.key, group, listOf(target)).items.single().state == AttachmentTransferStateFfi.READY
      }
      val opened = checkNotNull(recipient.kit.openAttachmentHandoff(recipient.key, group, target, control))
      try { assertArrayEquals(payload, File(opened.path).readBytes()) }
      finally { recipient.kit.releaseAttachmentHandoff(opened.lease) }
    }
    recipient.close()
    recipient.start()
    MediaFileTransferControlFfi().use { control ->
      val reopened = checkNotNull(recipient.kit.openAttachmentHandoff(recipient.key, group, target, control))
      try { assertArrayEquals(payload, File(reopened.path).readBytes()) }
      finally { recipient.kit.releaseAttachmentHandoff(reopened.lease) }
    }
  }

  private class Client(val directory: File, private val relay: String, private val blossom: String?) {
    private val store = MemorySecretStore()
    private var running: Marmot? = null
    val kit: Marmot get() = checkNotNull(running)
    lateinit var key: String
      private set

    suspend fun start(identity: String? = null) {
      val opened = Marmot.newWithConfiguration(
        rootPath = directory.canonicalPath,
        relayUrls = listOf(relay),
        options = MarmotOptions(
          relayPolicy = RelayPolicyFfi.ALLOW_LOOPBACK,
          secretStore = store,
          deployment = marmotDeploymentNeutral().copy(
            newGroupMediaEndpoints = listOf(blossom ?: "https://blossom.example.com"),
            groupImageEndpoint = blossom,
          ),
          attachmentAcquisitionMode = AttachmentAcquisitionModeFfi.HOST_MANAGED,
        ),
      )
      running = opened
      opened.start()
      if (!::key.isInitialized) {
        key = if (identity == null)
          opened.createIdentityWithProfile(listOf(relay), listOf(relay), listOf(relay)).account.accountIdHex
        else opened.login(identity, listOf(relay), listOf(relay), listOf(relay)).accountIdHex
      } else {
        assertEquals(key, opened.listAccounts().single().accountIdHex)
      }
    }

    suspend fun close() {
      val opened = running ?: return
      running = null
      try { opened.shutdownAndClose() } finally { opened.close() }
    }

    suspend fun accept(group: String) {
      await("Welcome for ${directory.name}") { kit.chatList(key, false).any { it.groupIdHex == group && it.pendingConfirmation } }
      kit.acceptGroupInvite(key, group)
    }

    suspend fun receives(group: String, sender: String, text: String) {
      await("decryption on ${directory.name} for fixture message '$text'") {
        kit.messages(key, group, 40u, null).any { it.sender == sender && it.plaintext == text }
      }
    }
  }

  private class MemorySecretStore : SecretStore {
    private val keys = mutableMapOf<String, Pair<String, String>>()

    @Synchronized override fun hasSecretForLabel(label: String) = keys.values.any { it.first == label }
    @Synchronized override fun hasSecretForAccountId(accountIdHex: String) = keys.containsKey(accountIdHex)
    @Synchronized override fun writeSecret(label: String, accountIdHex: String, secretKeyHex: String) { keys[accountIdHex] = label to secretKeyHex }
    @Synchronized override fun loadSecret(label: String, accountIdHex: String): String =
      keys[accountIdHex]?.takeIf { it.first == label }?.second
        ?: throw MarmotKitException.SecretNotFound("Fixture credential missing")
    @Synchronized override fun removeSecret(label: String, accountIdHex: String) { keys.remove(accountIdHex) }
  }

  companion object {
    private suspend fun await(stage: String, predicate: suspend () -> Boolean) {
      try {
        withTimeout(35_000) {
          while (!predicate()) delay(100)
        }
      } catch (timeout: kotlinx.coroutines.TimeoutCancellationException) {
        throw AssertionError("Timed out at $stage", timeout)
      }
    }
  }
}
