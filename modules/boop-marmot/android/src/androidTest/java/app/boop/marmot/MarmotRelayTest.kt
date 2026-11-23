package app.boop.marmot

import android.graphics.Bitmap
import androidx.test.platform.app.InstrumentationRegistry
import dev.ipf.marmotkit.*
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URI
import java.net.HttpURLConnection
import java.util.UUID
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test
import org.json.JSONObject

class MarmotRelayTest {
  private val hostSecret = "1".padStart(64, '0')

  @Test fun freshHostIdentityOpensChatsWithoutAReachableRelay() = runBlocking {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    MarmotAndroid.initialize(context)
    val directory = File(context.noBackupFilesDir, "fixture-${UUID.randomUUID()}")
    val relays = listOf("ws://127.0.0.1:1")
    val store = MemorySecretStore()
    val key = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
    try {
      repeat(2) { attempt ->
        val kit = Marmot.newWithConfiguration(directory.canonicalPath, relays, MarmotOptions(
          relayPolicy = RelayPolicyFfi.ALLOW_LOOPBACK,
          secretStore = store,
          deployment = marmotDeploymentNeutral(),
        ))
        try {
          kit.start()
          if (attempt == 0) {
            val account = withTimeout(10_000) { kit.createHostIdentity(hostSecret, relays, relays, relays) }
            assertEquals(key, account.accountIdHex)
          }
          assertEquals(key, kit.listAccounts().single().accountIdHex)
          val filter = listOf(ChatListFilterNodeFfi.Not(1u), ChatListFilterNodeFfi.Condition(ChatListConditionFfi.PENDING_INVITE))
          val handle = kit.openChatListQueryWindow(key, ChatListViewQueryFfi(ChatListViewFfi.CHATS, filter), 40u)
          try {
            assertEquals(emptyList<Any>(), checkNotNull(handle.snapshot()).rows)
          } finally { handle.close() }
        } finally {
          try { kit.shutdownAndClose() } finally { kit.close() }
        }
      }
    } finally { directory.deleteRecursively() }
  }

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
        alice.start(hostSecret, generated = true)
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
        val announcement = """{"version":2,"call":"fixture-call"}"""
        val kinds = listOf(24884uL)
        val previewBefore = carol.kit.chatList(carol.key, false).single { it.groupIdHex == group }
        val presenceWindow = GroupCallWindow("fixture", carol.kit.subscribeMessages(carol.key, group, 64u, kinds)) {
          carol.kit.messages(carol.key, group, 64u, kinds)
        }
        try {
          assertEquals(emptyList<Any>(), presenceWindow.initial()["announcements"])
          alice.kit.sendCustomEvent(alice.key, group, 24884uL, emptyList(), announcement)
          val update = withTimeout(15_000) { presenceWindow.next() }
          val rows = update?.get("announcements") as? List<*>
          assertTrue(rows.orEmpty().filterIsInstance<Map<*, *>>().any {
            it["sender"] == alice.key && it["text"] == announcement
          })
          val latest = carol.kit.timelineMessages(carol.key, latestTimeline(group))
          assertEquals("hello group", latest.messages.single().plaintext)
          val previewAfter = carol.kit.chatList(carol.key, false).single { it.groupIdHex == group }
          assertEquals(previewBefore.lastMessage?.messageIdHex, previewAfter.lastMessage?.messageIdHex)
          assertEquals(previewBefore.unreadCount, previewAfter.unreadCount)
        } finally {
          presenceWindow.stop()
        }
        val mention = "Hello nostr:${checkNotNull(alice.kit.npub(bob.key))}"
        alice.kit.sendTextWithClientToken(alice.key, group, mention, "group-mention")
        bob.receives(group, alice.key, mention)
        val mentioned = bob.kit.messages(bob.key, group, 30u, null)
          .single { it.plaintext == mention }
        assertTrue(mentioned.tags.any { it.values.take(2) == listOf("p", bob.key) })
        val target = bob.kit.messages(bob.key, group, 30u, null)
          .single { it.plaintext == "hello group" }.messageIdHex
        bob.kit.reportMessage(bob.key, group, target, ReportReasonFfi.SPAM, "")
        await("group report with authenticated reporter") {
          alice.kit.contentReports(alice.key, group, target, null, 10u).reports.any {
            it.reason == ReportReasonFfi.SPAM && it.reporter == bob.key
          }
        }
        if (blossom?.startsWith("https://") == true) groupPhotoRoundTrip(alice, bob, group)

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
        carol.close()
        verifyNewGroupMember(alice, group, File(root, "david"), relay, blossom)
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
        val smallGroup = ConversationWindow(alice.kit.openConversationWindow(
          alice.key, declined, ConversationOpenModeFfi.LATEST, null, 3u, 15_000u,
        ))
        try {
          val header = checkNotNull(smallGroup.initial())
          assertEquals("Declined fixture", header["title"])
          assertNull(header["peer"])
        } finally {
          smallGroup.stop()
        }
        await("declinable Welcome") {
          bob.kit.chatList(bob.key, false).any { it.groupIdHex == declined && it.pendingConfirmation }
        }
        bob.kit.declineGroupInvite(bob.key, declined)
        await("declined invitation left the inbox") {
          bob.kit.chatList(bob.key, false).none { it.groupIdHex == declined && it.pendingConfirmation }
        }

        val threadText = "Thread reply fixture"
        alice.kit.sendThreadMessage(alice.key, group, target, threadText, emptyList(), emptyList())
        bob.receives(group, alice.key, threadText)
        val thread = bob.kit.timelineMessages(bob.key, latestTimeline(group, threadText)).messages.single()
        assertEquals(target, thread.replyToMessageIdHex)
        assertEquals(target, thread.thread?.rootMessageIdHex)
        assertEquals(target, thread.thread?.parentMessageIdHex)

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
      assertEquals(sender.key, initial["peer"])
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

  private suspend fun verifyNewGroupMember(admin: Client, group: String, directory: File, relay: String, blossom: String?) {
    val invitee = Client(directory, relay, blossom)
    try {
      invitee.start()
      await("late invitee KeyPackage publication") {
        invitee.kit.accountSetupReadiness(invitee.key) == AccountSetupReadinessFfi.NETWORK_READY
      }
      val result = admin.kit.inviteMembersDetailed(admin.key, group, listOf(invitee.key))
      val outcome = result.invite.memberOutcomes.single { it.accountIdHex == invitee.key }
      assertEquals(MemberResolutionStatusFfi.SELECTED, outcome.status)
      invitee.accept(group)
      val message = "hello after joining the group"
      admin.kit.sendTextWithClientToken(admin.key, group, message, "late-member-message")
      invitee.receives(group, admin.key, message)
    } finally {
      invitee.close()
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
    val fixture = URI(blossom).let { it.scheme == "http" && it.host == "127.0.0.1" }
    fun fixtureCall(path: String, method: String = "GET"): Int {
      val connection = URI("$blossom/_fixture/$path").toURL().openConnection() as HttpURLConnection
      try {
        connection.connectTimeout = 3_000
        connection.readTimeout = 3_000
        connection.requestMethod = method
        if (path != "stats") {
          assertEquals(204, connection.responseCode)
          return 0
        }
        return JSONObject(connection.inputStream.bufferedReader().use { it.readText() }).getInt("gets")
      } finally { connection.disconnect() }
    }
    val before = if (fixture) fixtureCall("stats") else 0
    val payload = "Synthetic Boop fixture ${UUID.randomUUID()}".toByteArray()
    val path = File(sender.directory, "fixture.txt").apply { writeBytes(payload) }
    val caption = "Encrypted document fixture"
    val directReply = recipient.kit.timelineMessages(recipient.key, latestTimeline(group, "hello group")).messages.single().messageIdHex
    val request = MediaFileUploadRequestFfi(
      listOf(MediaFileUploadAttachmentRequestFfi(path.canonicalPath, path.length().toULong(), path.name, "text/plain", null, null)),
      caption, true, blossom, listOf(
        mediaMetadata(0, path.length().toULong(), null, emptyList(), "file"),
        listOf("e", directReply, "", "reply"),
      ),
    )
    val sent = MediaFileTransferControlFfi().use {
      sender.kit.uploadMediaFilesWithClientToken(sender.key, group, request, it, "fixture-media")
    }
    assertNotNull(sent.acceptance)
    recipient.receives(group, sender.key, caption)
    val row = recipient.kit.timelineMessages(recipient.key, TimelineMessageQueryFfi(group, caption, null, null, null,
      cursorGroupId = null, before = null, beforeMessageId = null, after = null, afterMessageId = null, limit = 30u)).messages.single()
    assertEquals(directReply, row.replyToMessageIdHex)
    val attachment = row.media.single() as MediaAttachmentOutcomeFfi.Accepted
    assertEquals(listOf("boop-media", "0", payload.size.toString(), "", "", "file"),
      row.tags.single { it.values.first() == "boop-media" }.values)
    assertEquals(EncryptedMediaVersionFfi.V2, attachment.reference.version)
    assertNotEquals(attachment.reference.plaintextSha256, attachment.reference.ciphertextSha256)
    val target = AttachmentLocalTargetFfi(row.messageIdHex, checkNotNull(row.sourceMessageIdHex), attachment.attachmentIndex)
    repeat(5) {
      assertEquals(AttachmentTransferStateFfi.NOT_REQUESTED,
        recipient.kit.attachmentTransferSnapshot(recipient.key, group, listOf(target)).items.single().state)
      delay(250)
    }
    MediaFileTransferControlFfi().use { control ->
      assertNull(recipient.kit.attachmentLocalAssets(recipient.key, group, listOf(target)).single().reference)
      assertNull(recipient.kit.openAttachmentHandoff(recipient.key, group, target, control))
      if (fixture) {
        assertEquals(before, fixtureCall("stats"))
        fixtureCall("pause", "POST")
        try {
          val reference = checkNotNull(recipient.kit.requestExplicitAttachment(recipient.key, group, target))
          await("HTTP starts after the explicit request") { fixtureCall("stats") > before }
          assertTrue(recipient.kit.controlAttachment(recipient.key, reference, AttachmentControlFfi.CANCEL))
          await("native attachment cancellation") {
            recipient.kit.attachmentTransferSnapshot(recipient.key, group, listOf(target)).items.single().state == AttachmentTransferStateFfi.CANCELLED
          }
          assertTrue(recipient.kit.controlAttachment(recipient.key, reference, AttachmentControlFfi.RETRY))
        } finally { fixtureCall("resume", "POST") }
      } else assertNotNull(recipient.kit.requestExplicitAttachment(recipient.key, group, target))
      await("manual encrypted media download") {
        recipient.kit.attachmentTransferSnapshot(recipient.key, group, listOf(target)).items.single().state == AttachmentTransferStateFfi.READY
      }
      val retained = recipient.kit.attachmentLocalAssets(recipient.key, group, listOf(target)).single()
      assertNotNull(retained.reference)
      assertEquals(payload.size.toULong(), retained.byteCount)
      val opened = checkNotNull(recipient.kit.openAttachmentHandoff(recipient.key, group, target, control))
      try { assertArrayEquals(payload, File(opened.path).readBytes()) }
      finally { recipient.kit.releaseAttachmentHandoff(opened.lease) }
    }
    val afterDownload = if (fixture) fixtureCall("stats") else 0
    recipient.close()
    recipient.start()
    MediaFileTransferControlFfi().use { control ->
      val reopened = checkNotNull(recipient.kit.openAttachmentHandoff(recipient.key, group, target, control))
      try { assertArrayEquals(payload, File(reopened.path).readBytes()) }
      finally { recipient.kit.releaseAttachmentHandoff(reopened.lease) }
    }
    if (fixture) assertEquals(afterDownload, fixtureCall("stats"))
    // Four native slots reserve up to two 900 MiB copies each. Devices
    // below the reserve exercise the serial path above.
    if (fixture && android.os.StatFs(recipient.directory.path).availableBytes > 8_000_000_000L) {
      val parallelCaption = "Parallel download fixture"
      val paths = (0..1).map { index ->
        File(sender.directory, "parallel-$index.txt").apply { writeText("Parallel fixture ${UUID.randomUUID()}") }
      }
      val parallelRequest = MediaFileUploadRequestFfi(
        paths.map { file ->
          MediaFileUploadAttachmentRequestFfi(file.canonicalPath, file.length().toULong(), file.name, "text/plain", null, null)
        },
        parallelCaption, true, blossom, emptyList(),
      )
      MediaFileTransferControlFfi().use {
        assertNotNull(sender.kit.uploadMediaFilesWithClientToken(sender.key, group, parallelRequest, it, "fixture-parallel").acceptance)
      }
      recipient.receives(group, sender.key, parallelCaption)
      val parallelRow = recipient.kit.timelineMessages(recipient.key, TimelineMessageQueryFfi(group, parallelCaption, null, null, null,
        cursorGroupId = null, before = null, beforeMessageId = null, after = null, afterMessageId = null, limit = 30u)).messages.single()
      val targets = paths.indices.map { index ->
        AttachmentLocalTargetFfi(parallelRow.messageIdHex, checkNotNull(parallelRow.sourceMessageIdHex), index.toUInt())
      }
      val parallelStart = fixtureCall("stats")
      fixtureCall("pause", "POST")
      try {
        for (target in targets) {
          assertNotNull(recipient.kit.requestExplicitAttachment(recipient.key, group, target))
        }
        await("both explicit Blossom HTTP requests start before either response finishes") {
          fixtureCall("stats") == parallelStart + targets.size
        }
      } finally {
        fixtureCall("resume", "POST")
      }
      await("parallel attachments are both verified and retained") {
        recipient.kit.attachmentTransferSnapshot(recipient.key, group, targets).items.all { it.state == AttachmentTransferStateFfi.READY }
      }
    }
    val draftToken = "fixture-resumed-upload"
    val voice = File(sender.directory, "fixture-voice.m4a").apply { writeBytes("voice fixture".toByteArray()) }
    val video = File(sender.directory, "arbitrary-filename.mp4").apply { writeBytes("round fixture".toByteArray()) }
    val draftIds = listOf("$draftToken:2:0:voice", "$draftToken:2:1:round")
    val duration = 3.5
    val waveform = listOf(0.0, 15.0 / 31, 1.0)
    val selected = sender.kit.selectedMessageDraft(sender.key, group)
    val updated = try {
      sender.kit.saveMessageDraftInputsIfRevision(sender.key, selected.revision, "Staging upload", row.messageIdHex, emptyList())
    } finally { selected.destroy() }
    try {
      MediaFileTransferControlFfi().use { control ->
        val first = sender.kit.stageMessageDraftAttachmentFile(sender.key, updated.revision,
          MessageDraftAttachmentFileRequestFfi(draftIds[0], voice.canonicalPath, voice.length().toULong(),
            voice.name, "audio/mp4", null, null, duration, waveform), control)
        try {
          val staleSave = runCatching {
            sender.kit.saveMessageDraftInputsIfRevision(sender.key, updated.revision, "Stale", null, emptyList()).destroy()
          }
          assertTrue(staleSave.exceptionOrNull() is MarmotKitException.MessageDraftRevisionConflict)
          val edited = sender.kit.saveMessageDraftInputsIfRevision(sender.key, first.revision, "Resumed upload", row.messageIdHex, emptyList())
          try {
            assertEquals(draftIds.take(1), edited.draft?.mediaAttachments?.map { it.id })
            val staged = sender.kit.stageMessageDraftAttachmentFile(sender.key, edited.revision,
              MessageDraftAttachmentFileRequestFfi(draftIds[1], video.canonicalPath, video.length().toULong(),
                video.name, "video/mp4", "720x720", null, 5.0, emptyList()), control)
            try {
              val disposable = sender.kit.stageMessageDraftAttachmentFile(sender.key, staged.revision,
                MessageDraftAttachmentFileRequestFfi("remove-me", path.canonicalPath, path.length().toULong(),
                  path.name, "text/plain", null, null, null, emptyList()), control)
              try {
                val removed = sender.kit.saveMessageDraftInputsIfRevision(sender.key, disposable.revision,
                  "Resumed upload", row.messageIdHex, listOf(MessageDraftAttachmentInputFfi.Removed("remove-me")))
                try { assertEquals(draftIds, removed.draft?.mediaAttachments?.map { it.id }) }
                finally { removed.destroy() }
              } finally { disposable.destroy() }
            } finally { staged.destroy() }
          } finally { edited.destroy() }
        } finally { first.destroy() }
      }
    } finally { updated.destroy() }
    assertTrue(path.delete())
    assertTrue(voice.delete())
    assertTrue(video.delete())
    sender.close()
    sender.start()
    val resumed = sender.kit.selectedMessageDraft(sender.key, group)
    val accepted = try {
      val files = checkNotNull(resumed.draft?.mediaAttachments)
      assertEquals(draftIds, files.map { it.id })
      MediaFileTransferControlFfi().use { cancelled ->
        cancelled.cancel()
        val cancelledUpload = runCatching {
          sender.kit.uploadMessageDraftAttachments(sender.key, resumed.revision, draftIds, blossom, cancelled)
        }
        assertTrue(cancelledUpload.isFailure)
      }
      val prepared = MediaFileTransferControlFfi().use { control ->
        sender.kit.uploadMessageDraftAttachments(sender.key, resumed.revision, draftIds, blossom, control)
      }
      val tags = files.mapIndexed { index, file ->
        mediaMetadata(index, file.plaintextSize, file.durationSeconds, file.waveformSamples, file.id.substringAfterLast(":"))
      }
      val references = prepared.attachments.map { it.reference }
      val first = sender.kit.sendMessageDraftWithClientToken(sender.key, resumed.revision, references, tags, draftToken)
      val retry = sender.kit.sendMessageDraftWithClientToken(sender.key, resumed.revision, references, tags, draftToken)
      assertEquals(first.messageIdHex, retry.messageIdHex)
      assertEquals(draftToken, retry.clientToken)
      assertTrue(runCatching {
        sender.kit.sendMessageDraftWithClientToken(sender.key, resumed.revision, references, tags.reversed(), draftToken)
      }.isFailure)
      first
    } finally { resumed.destroy() }
    assertNotNull(sender.kit.localSendStatus(sender.key, group, draftToken))
    val consumed = sender.kit.selectedMessageDraft(sender.key, group)
    try { assertNull(consumed.draft) } finally { consumed.destroy() }
    recipient.receives(group, sender.key, "Resumed upload")
    val delivered = recipient.kit.messages(recipient.key, group, 25u, null).filter { it.plaintext == "Resumed upload" }
    assertEquals(listOf(accepted.messageIdHex), delivered.map { it.messageIdHex })
    recipient.close()
    recipient.start()
    val persisted = recipient.kit.timelineMessages(recipient.key,
      latestTimeline(group, "Resumed upload")).messages.single()
    assertEquals(listOf(
      listOf("boop-media", "0", "13", "3.5", "0,15,31", "voice"),
      listOf("boop-media", "1", "13", "5.0", "", "round"),
    ), persisted.tags.filter { it.values.first() == "boop-media" }.map { it.values })
    assertEquals(row.messageIdHex, persisted.replyToMessageIdHex)
    assertEquals("arbitrary-filename.mp4", (persisted.media[1] as MediaAttachmentOutcomeFfi.Accepted).reference.fileName)
    val anchored = ConversationWindow(recipient.kit.openConversationWindow(
      recipient.key, group, ConversationOpenModeFfi.MESSAGE, accepted.messageIdHex, 3u, 15_000u,
    ))
    try {
      val messages = checkNotNull(anchored.initial())["messages"] as List<*>
      val message = messages.filterIsInstance<Map<*, *>>().single { it["id"] == accepted.messageIdHex }
      val attachments = (message["attachments"] as List<*>).filterIsInstance<Map<*, *>>()
      assertEquals(true, attachments[0]["voice"])
      assertEquals(3.5, attachments[0]["duration"])
      assertEquals(listOf(0, 15, 31), attachments[0]["waveform"])
      assertEquals(true, attachments[1]["round"])
    } finally { anchored.stop() }
  }

  private fun latestTimeline(group: String, search: String? = null) =
    TimelineMessageQueryFfi(group, search, null, null, null,
      cursorGroupId = null, before = null, beforeMessageId = null, after = null, afterMessageId = null, limit = 1u)

  private class Client(val directory: File, private val relay: String, private val blossom: String?) {
    private val store = MemorySecretStore()
    private var running: Marmot? = null
    val kit: Marmot get() = checkNotNull(running)
    lateinit var key: String
      private set

    suspend fun start(identity: String? = null, generated: Boolean = false) {
      val opened = Marmot.newWithConfiguration(
        rootPath = directory.canonicalPath,
        relayUrls = listOf(relay),
        options = MarmotOptions(
          relayPolicy = if (blossom?.startsWith("http://127.0.0.1:") == true)
            RelayPolicyFfi.ALLOW_LOOPBACK_RELAYS_AND_BLOBS else RelayPolicyFfi.ALLOW_LOOPBACK,
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
        val relays = listOf(relay)
        key = when {
          identity == null -> opened.createIdentityWithProfile(relays, relays, relays).account.accountIdHex
          generated -> opened.createHostIdentity(identity, relays, relays, relays).accountIdHex
          else -> opened.login(identity, relays, relays, relays).accountIdHex
        }
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
