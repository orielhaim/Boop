package app.boop.marmot

import androidx.test.platform.app.InstrumentationRegistry
import dev.ipf.marmotkit.*
import java.io.File
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URI
import java.util.UUID
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

        alice.kit.updateGroupProfile(alice.key, group, "Renamed group", "New description")
        await("canonical group profile") { bob.kit.groupDetails(bob.key, group).group.name == "Renamed group" }
        alice.kit.promoteAdmin(alice.key, group, bob.key)
        await("canonical admin promotion") { bob.kit.groupManagementState(bob.key, group).isSelfAdmin }
        alice.kit.demoteAdmin(alice.key, group, bob.key)
        await("canonical admin demotion") { !bob.kit.groupManagementState(bob.key, group).isSelfAdmin }
        alice.kit.removeMembers(alice.key, group, listOf(carol.key))
        await("removed membership") { carol.kit.groupDetails(carol.key, group).group.selfMembership == SelfMembershipFfi.REMOVED }
        alice.kit.sendTextWithClientToken(alice.key, group, "after removal", "after-removal")
        bob.receives(group, alice.key, "after removal")
        assertFalse(carol.kit.messages(carol.key, group, 30u, null).any { it.plaintext == "after removal" })
        val secondAlice = Client(File(root, "alice-linked"), relay, blossom)
        try {
          secondAlice.start(alice.kit.revealNsec(alice.key))
          assertEquals(alice.key, secondAlice.key)
          linkDevice(alice, secondAlice)
        } finally {
          secondAlice.close()
        }
      } finally {
        for (client in listOf(carol, bob, alice)) client.close()
      }
    } finally {
      root.deleteRecursively()
    }
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
          deployment = marmotDeploymentNeutral().copy(newGroupMediaEndpoints = listOf(blossom ?: "https://blossom.example.com")),
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
