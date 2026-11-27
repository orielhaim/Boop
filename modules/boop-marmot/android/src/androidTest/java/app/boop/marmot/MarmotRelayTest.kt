package app.boop.marmot

import android.graphics.Bitmap
import androidx.test.platform.app.InstrumentationRegistry
import dev.ipf.marmotkit.*
import app.boop.social.ffi.SocialCancellation
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.URI
import java.net.InetSocketAddress
import java.net.Socket
import java.net.HttpURLConnection
import java.util.UUID
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import org.junit.Assert.*
import org.junit.Test
import org.json.JSONObject

class MarmotRelayTest {
  @Test fun socialBindingsSignAndVerifyThroughTheMdkHostWithoutSharingRuntime() = runBlocking {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    BoopMarmotModule.initializeBindings(context)
    val root = File(context.noBackupFilesDir, "social-host-${UUID.randomUUID()}").apply { mkdirs() }
    val relay = InstrumentationRegistry.getArguments().getString("relay")?.let(::controlledLoopbackRelay)
    val setupRelays = listOf(relay ?: "ws://127.0.0.1:1")
    val kit = Marmot.newWithConfiguration(
      File(root, "mdk").canonicalPath,
      setupRelays,
      MarmotOptions(
        relayPolicy = RelayPolicyFfi.ALLOW_LOOPBACK,
        deployment = marmotDeploymentNeutral().copy(keychainService = "app.boop.test.${root.name}"),
      ),
    )
    val profile = UserProfileMetadataFfi("Social host fixture", "Social host fixture", null, null, null, null, null)
    var social: SocialNativeOwner? = null
    var account: String? = null
    var storageKey: ByteArray? = null
    try {
      kit.start()
      val createdAccount = kit.createIdentityWithInitialProfile(profile, setupRelays, setupRelays, setupRelays).account.accountIdHex
      account = createdAccount
      val key = SocialStorageKey.load(context, createdAccount)
      storageKey = key
      val roundTrip = SocialStorageKey.load(context, createdAccount)
      assertArrayEquals(key, roundTrip)
      roundTrip.fill(0)
      val owner = SocialNativeOwner(
        storageRoot = File(root, "social").canonicalPath,
        allowLoopbackRelay = relay != null,
        accountEligible = { requested ->
          kit.listAccounts().any { it.accountIdHex == requested && it.localSigning && !it.signedOut && !it.unlinked }
        },
        signWithMdk = { requested, event -> kit.signNostrEvent(requested, event) },
      )
      social = owner
      val session = owner.activate(createdAccount, key, foreground = true)
      assertTrue(runCatching { SocialCancellation().use { session.signNote("Denied while Social is disabled", it) } }.isFailure)
      owner.setAuthorization(session, enabled = true, unlocked = false)
      assertTrue(runCatching { SocialCancellation().use { session.signNote("Denied while the app is locked", it) } }.isFailure)
      owner.setAuthorization(session, enabled = true, unlocked = true)

      val signed = SocialCancellation().use { session.signNote("Signed by the active MDK identity", it) }
      val signedEvent = JSONObject(signed)
      assertEquals(createdAccount, signedEvent.getString("pubkey"))
      assertEquals(1, signedEvent.getInt("kind"))
      assertEquals(128, signedEvent.getString("sig").length)
      SocialCancellation().use { session.ingestEvent(signed, it) }
      assertTrue(session.recentNotes(10u).any { JSONObject(it).getString("id") == signedEvent.getString("id") })

      if (relay != null) {
        val published = SocialCancellation().use {
          session.publishNote(relay, "Published through the controlled local relay", it)
        }
        val publishedId = JSONObject(published).getString("id")
        val cached = checkNotNull(session.cachedEvent(publishedId))
        assertEquals(publishedId, JSONObject(cached).getString("id"))
        assertEquals(createdAccount, JSONObject(cached).getString("pubkey"))
        assertTrue(session.recentNotes(10u).any { JSONObject(it).getString("id") == publishedId })
      }

      owner.retire(createdAccount)
      assertTrue(runCatching { SocialCancellation().use { session.signNote("Denied after retirement", it) } }.isFailure)
      val later = JSONObject().put("pubkey", createdAccount).put("created_at", 1).put("kind", 1)
        .put("tags", org.json.JSONArray()).put("content", "MDK remains independently usable")
      assertEquals(128, kit.signNostrEvent(createdAccount, later.toString()).length)

      val replacement = owner.activate(createdAccount, key, foreground = true)
      owner.setAuthorization(session, enabled = true, unlocked = true)
      assertTrue(runCatching { SocialCancellation().use { replacement.signNote("Stale authorization", it) } }.isFailure)
    } finally {
      try { social?.shutdown() } finally {
        storageKey?.fill(0)
        account?.let { runCatching { SocialStorageKey.remove(context, it) } }
        try { kit.shutdownAndClose() } finally { root.deleteRecursively() }
      }
    }
  }

  private fun controlledLoopbackRelay(value: String): String {
    val uri = URI(value)
    val host = checkNotNull(uri.host) { "Invalid controlled relay URL" }
    val octets = host.split('.')
    val ipv4Loopback = octets.size == 4 && octets.first() == "127" &&
      octets.all { octet -> octet.toIntOrNull()?.let { it in 0..255 && it.toString() == octet } == true }
    assertTrue("relay runner argument must use a literal loopback address", ipv4Loopback || host == "[::1]" || host == "::1")
    assertTrue("relay runner argument must use ws on an explicit port", uri.scheme == "ws" && uri.port in 1..65535)
    assertNull(uri.userInfo)
    assertNull(uri.fragment)
    return value
  }

  @Test fun attachmentHandoffProviderOpensOnlyRegisteredReadOnlyLeases() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val directory = File(context.noBackupFilesDir, "handoff-test-${UUID.randomUUID()}").apply { mkdir() }
    val file = File(directory, "report 100%.pdf").apply { writeText("%PDF-1.7") }
    val lease = UUID.randomUUID().toString()
    val generation = UUID.randomUUID().toString()
    try {
      AttachmentHandoffProvider.activate("owner", generation)
      assertTrue(AttachmentHandoffProvider.register("owner", generation, lease, file.path, file.name, "application/pdf"))
      assertNull(AttachmentHandoffProvider.uri(context, "other", generation, lease))
      val (uri, _) = checkNotNull(AttachmentHandoffProvider.uri(context, "owner", generation, lease))
      val resolver = context.contentResolver
      assertEquals("application/pdf", resolver.getType(uri))
      assertEquals("%PDF-1.7", resolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() })
      resolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
        assertTrue(it.moveToFirst())
        assertEquals(file.name, it.getString(0))
      } ?: fail("Handoff file has no display name")
      assertTrue(runCatching { resolver.openFileDescriptor(uri, "w")?.close() }.isFailure)
      AttachmentHandoffProvider.release(lease)
      assertTrue(runCatching { resolver.openInputStream(uri)?.close() }.isFailure)
      assertTrue(AttachmentHandoffProvider.register("owner", generation, lease, file.path, file.name, "application/pdf"))
      AttachmentHandoffProvider.retire("owner", generation)
      assertNull(AttachmentHandoffProvider.uri(context, "owner", generation, lease))
      assertTrue(runCatching { resolver.openInputStream(uri)?.close() }.isFailure)
    } finally {
      AttachmentHandoffProvider.retire("owner", generation)
      AttachmentHandoffProvider.release(lease)
      directory.deleteRecursively()
    }
  }

  @Test fun sharedMediaUsesIndependentNativeHistoryCollections() = runBlocking {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val arguments = InstrumentationRegistry.getArguments()
    val relay = checkNotNull(arguments.getString("relay"))
    val blossom = checkNotNull(arguments.getString("blossom"))
    val context = instrumentation.targetContext
    BoopMarmotModule.initializeBindings(context)
    val root = File(context.noBackupFilesDir, "fixture-${UUID.randomUUID()}")
    val alice = Client(File(root, "alice"), relay, blossom)
    val bob = Client(File(root, "bob"), relay, blossom)
    try {
      alice.start()
      bob.start()
      for (client in listOf(alice, bob)) {
        await("${client.directory.name} ready for messaging") {
          client.kit.accountSetupReadiness(client.key) == AccountSetupReadinessFfi.NETWORK_READY
        }
      }
      assertNull(alice.kit.existingDirectConversation(alice.key, bob.key))
      assertTrue(alice.kit.chatList(alice.key, true).isEmpty())
      val direct = alice.kit.startDirectConversation(alice.key, bob.key)
      assertEquals(direct, alice.kit.existingDirectConversation(alice.key, bob.key)?.groupIdHex)
      bob.accept(direct)
      val reply = alice.kit.sendTextWithClientToken(alice.key, direct, "Shared media reply fixture", "shared-media-reply")
      bob.receives(direct, alice.key, "Shared media reply fixture")
      mediaRoundTrip(alice, bob, direct, blossom, reply.messageIdHex)
    } finally {
      alice.close()
      bob.close()
      root.deleteRecursively()
    }
  }

  @Test fun generatedIdentityKeepsItsProfileAndNativeSignerAcrossRestart() = runBlocking {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    BoopMarmotModule.initializeBindings(context)
    val directory = File(context.noBackupFilesDir, "fixture-${UUID.randomUUID()}")
    val relays = listOf("ws://127.0.0.1:1")
    var key: String? = null
    try {
      repeat(2) { attempt ->
        val kit = Marmot.newWithConfiguration(directory.canonicalPath, relays, MarmotOptions(
          relayPolicy = RelayPolicyFfi.ALLOW_LOOPBACK,
          deployment = marmotDeploymentNeutral().copy(keychainService = "app.boop.test.${directory.name}"),
        ))
        try {
          kit.start()
          if (attempt == 0) {
            val profile = UserProfileMetadataFfi("Offline fixture", "Offline fixture", null, null, null, null, null)
            val result = withTimeout(10_000) { kit.createIdentityWithInitialProfile(profile, relays, relays, relays) }
            key = result.account.accountIdHex
            assertEquals("Offline fixture", result.profile.name)
          }
          val account = checkNotNull(key)
          assertEquals(account, kit.listAccounts().single().accountIdHex)
          assertEquals("Offline fixture", kit.userProfile(account)?.name)
          val event = JSONObject().put("pubkey", account).put("created_at", 1).put("kind", 1)
            .put("tags", org.json.JSONArray()).put("content", "native signer")
          assertEquals(128, kit.signNostrEvent(account, event.toString()).length)
          val encrypted = kit.nostrCipher(account, account, "account payload", true, true)
          assertEquals("account payload", kit.nostrCipher(account, account, encrypted, true, false))
          val other = kit.prepareIdentityImport("1".padStart(64, '0'), "")
          other.use {
            event.put("pubkey", it.publicKey())
            assertTrue(runCatching { kit.signNostrEvent(account, event.toString()) }.isFailure)
          }
          if (attempt == 1) {
            kit.removeAccount(account)
            assertTrue(kit.listAccounts().isEmpty())
            assertTrue(runCatching { kit.revealNsec(account) }.isFailure)
          }
        } finally {
          try { kit.shutdownAndClose() } finally { kit.close() }
        }
      }
    } finally { directory.deleteRecursively() }
  }

  @Test fun rawAndEncryptedImportsKeepOneOfflineCheckpoint() = runBlocking {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    BoopMarmotModule.initializeBindings(context)
    val directory = File(context.noBackupFilesDir, "fixture-${UUID.randomUUID()}")
    val relays = listOf("ws://127.0.0.1:1")
    val raw = "3501454135014541350145413501453fefb02227e449e57cf4d3a3ce05378683"
    val vector = "ncryptsec1qgg9947rlpvqu76pj5ecreduf9jxhselq2nae2kghhvd5g7dgjtcxfqtd67p9m0w57lspw8gsq6yphnm8623nsl8xn9j4jdzz84zm3frztj3z7s35vpzmqf6ksu8r89qk5z2zxfmu5gv8th8wclt0h4p"
    val configuration = MarmotOptions(
      relayPolicy = RelayPolicyFfi.ALLOW_LOOPBACK,
      deployment = marmotDeploymentNeutral().copy(keychainService = "app.boop.test.${directory.name}"),
    )
    var imported: String? = null
    try {
      repeat(2) { attempt ->
        val kit = Marmot.newWithConfiguration(directory.canonicalPath, relays, configuration)
        try {
          kit.start()
          if (attempt == 0) {
            val publicKey = kit.prepareIdentityImport(raw, "").use { it.publicKey() }
            assertTrue(runCatching { kit.prepareIdentityImport(vector, "incorrect").close() }.isFailure)
            kit.prepareIdentityImport(vector, "nostr").use { prepared ->
              assertEquals(publicKey, prepared.publicKey())
              assertTrue(kit.listAccounts().isEmpty())
              val snapshot = kit.beginPreparedOnboarding(prepared, OnboardingOptionsFfi(relays, relays, relays))
              assertFalse(snapshot.ready)
              imported = snapshot.accountIdHex
            }
          }
          val key = checkNotNull(imported)
          assertEquals(key, kit.listAccounts().single().accountIdHex)
          assertFalse(checkNotNull(kit.onboardingSnapshot(key)).ready)
          if (attempt == 1) {
            kit.cancelOnboarding(key)
            assertTrue(kit.listAccounts().single().signedOut)
            kit.removeAccount(key)
            assertTrue(kit.listAccounts().isEmpty())
          }
        } finally {
          try { kit.shutdownAndClose() } finally { kit.close() }
        }
      }
    } finally { directory.deleteRecursively() }
  }

  @Test fun linkedDeviceRemovalStopsReopenedDeviceAndWipesNativeAccount() = runBlocking {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val arguments = InstrumentationRegistry.getArguments()
    val relay = checkNotNull(arguments.getString("relay"))
    val context = instrumentation.targetContext
    BoopMarmotModule.initializeBindings(context)
    val root = File(context.noBackupFilesDir, "device-unlink-${UUID.randomUUID()}")
    val primary = Client(File(root, "primary"), relay, null)
    val joining = Client(File(root, "joining"), relay, null)
    var events: EventsSubscription? = null
    var unlinkEvent: kotlinx.coroutines.Deferred<MarmotEventFfi.DeviceUnlinked>? = null
    try {
      primary.start()
      await("primary identity ready") {
        primary.kit.accountSetupReadiness(primary.key) == AccountSetupReadinessFfi.NETWORK_READY
      }
      assertTrue(primary.kit.linkedDevices(primary.key).none { !it.isThisDevice })
      assertTrue(primary.kit.deviceLinkSnapshot(primary.key).prompts.isEmpty())
      assertTrue(primary.kit.checkSignIns(primary.key).isEmpty())

      // Exercise native secret export and import in separate account databases.
      joining.start(primary.kit.revealNsec(primary.key))
      await("joining identity ready") {
        joining.kit.accountSetupReadiness(joining.key) == AccountSetupReadinessFfi.NETWORK_READY
      }
      assertEquals(primary.key, joining.key)
      assertTrue(joining.kit.linkedDevices(joining.key).none { !it.isThisDevice })
      assertTrue(joining.kit.deviceLinkSnapshot(joining.key).prompts.isEmpty())
      await("unrecognized sign-in found on an existing installation") {
        primary.kit.checkSignIns(primary.key).any { it.signedIn }
      }

      joining.kit.startDeviceLink(joining.key)
      await("real device pair comparison") {
        joining.kit.deviceLinkSnapshot(joining.key).newDevice is NewDeviceLinkStateFfi.Comparing &&
          primary.kit.deviceLinkSnapshot(primary.key).prompts.any { it.state is DeviceLinkPromptStateFfi.Comparing }
      }
      val joiningCode = (joining.kit.deviceLinkSnapshot(joining.key).newDevice as NewDeviceLinkStateFfi.Comparing).code
      val prompt = primary.kit.deviceLinkSnapshot(primary.key).prompts.single { it.state is DeviceLinkPromptStateFfi.Comparing }
      assertEquals(7, joiningCode.size)
      assertEquals(joiningCode, (prompt.state as DeviceLinkPromptStateFfi.Comparing).code)
      joining.kit.confirmDeviceLinkMatch(joining.key)
      primary.kit.linkDevice(primary.key, prompt.promptId, "Remote unlink fixture", false, false)
      await("paired device roster") {
        primary.kit.linkedDevices(primary.key).any { !it.isThisDevice && it.label == "Remote unlink fixture" } &&
          joining.kit.linkedDevices(joining.key).any { !it.isThisDevice }
      }

      val slot = primary.kit.linkedDevices(primary.key).single { !it.isThisDevice }.slotIdHex
      assertEquals(slot, joining.kit.linkedDevices(joining.key).single { it.isThisDevice }.slotIdHex)
      assertTrue(slot != primary.key)

      suspend fun commitRosterChange(stage: String, change: suspend () -> Unit) {
        await(stage) {
          try {
            change()
            true
          } catch (error: MarmotKitException.Runtime) {
            if (error.details != "device group refused: device_group_busy") throw error
            primary.kit.runDueMaintenance(primary.key)
            false
          }
        }
      }
      commitRosterChange("rename linked installation") {
        primary.kit.renameLinkedDevice(primary.key, slot, "Renamed device fixture")
      }
      await("native roster reports the new label") {
        primary.kit.linkedDevices(primary.key).any { it.slotIdHex == slot && it.label == "Renamed device fixture" }
      }
      commitRosterChange("patch one linked-device setting") {
        primary.kit.updateLinkedDeviceSettings(primary.key, slot, null, null, true)
      }
      await("native roster reports sparse settings change") {
        primary.kit.linkedDevices(primary.key).any {
          it.slotIdHex == slot && it.keepWhileInactive && !it.addToAllChats && !it.bringHistory
        }
      }
      // Match MDK's removal fixture: settle target maintenance before taking
      // it offline, so a later target update cannot supersede the removal.
      joining.kit.catchUpAccounts()
      joining.kit.runDueMaintenance(joining.key)
      joining.close()
      await("pairing settled before unlink") {
        try {
          primary.kit.removeLinkedDevice(primary.key, slot)
          true
        } catch (error: MarmotKitException.Runtime) {
          if (error.details != "device group refused: device_link_pending") throw error
          false
        }
      }
      // removeLinkedDevice records intent and may return while the device
      // group still needs a maintenance turn to commit it.
      await("removal committed on primary roster") {
        primary.kit.runDueMaintenance(primary.key)
        primary.kit.linkedDevices(primary.key).none { it.slotIdHex == slot }
      }
      // Reopen the same native account database after the removal is on the
      // relay. Subscribe before runtime start, which reconciles linked-device
      // removals before its account catch-up.
      joining.start(beforeStart = { kit -> events = kit.subscribeEvents() })
      val stream = checkNotNull(events)
      unlinkEvent = async {
        withTimeout(45_000) {
          while (true) {
            when (val event = stream.next() ?: error("MDK event stream ended before unlink")) {
              is MarmotEventFfi.DeviceUnlinked -> if (event.accountIdHex == joining.key) return@withTimeout event
              else -> Unit
            }
          }
          error("unreachable")
        }
      }
      await("persisted remote unlink status") {
        joining.kit.listAccounts().single { it.accountIdHex == joining.key }.unlinked
      }
      assertEquals(joining.key, withTimeout(45_000) { checkNotNull(unlinkEvent).await() }.accountIdHex)
      assertTrue(runCatching { joining.kit.signInAccount(joining.key) }.isFailure)
      val unsigned = JSONObject().put("pubkey", joining.key).put("created_at", 1).put("kind", 1)
        .put("tags", org.json.JSONArray()).put("content", "rejected after remote unlink")
      assertTrue(runCatching { joining.kit.signNostrEvent(joining.key, unsigned.toString()) }.isFailure)

      val outcome = joining.kit.signOutAndWipe(joining.key)
      assertTrue("local cleanup must be reported", outcome.localCleanup.completed)
      assertFalse(joining.kit.listAccounts().any { it.accountIdHex == joining.key })
      assertTrue(primary.kit.listAccounts().single { it.accountIdHex == primary.key }.localSigning)
    } finally {
      unlinkEvent?.cancel()
      events?.close()
      joining.close()
      primary.close()
      root.deleteRecursively()
    }
  }

  @Test fun sparseProfileEditsUseAccountRelaysAndSurviveReopen() = runBlocking {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val relay = InstrumentationRegistry.getArguments().getString("relay")
      ?: error("Pass the fixture WebSocket URL as the relay instrumentation argument")
    BoopMarmotModule.initializeBindings(context)
    val root = File(context.noBackupFilesDir, "fixture-${UUID.randomUUID()}")
    val owner = Client(File(root, "owner"), relay, null)
    val reader = Client(File(root, "reader"), relay, null)
    try {
      owner.start()
      await("profile account ready") {
        owner.kit.accountSetupReadiness(owner.key) == AccountSetupReadinessFfi.NETWORK_READY
      }
      val picture = "https://photos.example.com/avatar.jpg"
      owner.kit.publishUserProfileUsingAccountRelays(owner.key, UserProfileMetadataFfi(
        "original-handle", "Original", "Biography", picture, "https://photos.example.com/banner.jpg",
        "name@example.com", "wallet@example.com",
      ))
      val update = owner.kit.updateUserProfileUsingAccountRelays(owner.key, mapOf(
        "display_name" to "Updated", "banner" to "", "website" to "https://example.com/"
      ))
      assertEquals("original-handle", update.name)
      assertEquals("Updated", update.displayName)
      assertEquals("Biography", update.about)
      assertEquals(picture, update.picture)
      assertNull(update.banner)
      assertEquals("name@example.com", update.nip05)
      assertEquals("wallet@example.com", update.lud16)

      reader.start()
      assertNotEquals(owner.key, reader.key)
      reader.kit.refreshProfile(owner.key, listOf(relay))
      var projection = reader.kit.cachedIdentityProjections(listOf(owner.key)).single()
      assertEquals("Updated", projection.resolvedName)
      assertEquals("https://example.com/", projection.website)
      assertEquals(picture, projection.profile?.picture)
      reader.close()
      reader.start()
      projection = reader.kit.cachedIdentityProjections(listOf(owner.key)).single()
      assertEquals("Updated", projection.resolvedName)
      assertEquals("https://example.com/", projection.website)
    } finally {
      try {
        reader.close()
      } finally {
        owner.close()
        root.deleteRecursively()
      }
    }
  }

  @Test fun relayListEditsKeepAnOpenConversationAndLivenessSubscription() = runBlocking {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val relay = checkNotNull(InstrumentationRegistry.getArguments().getString("relay"))
    val second = checkNotNull(InstrumentationRegistry.getArguments().getString("secondRelay"))
    val root = File(instrumentation.targetContext.noBackupFilesDir, "fixture-${UUID.randomUUID()}")
    BoopMarmotModule.initializeBindings(instrumentation.targetContext)
    val alice = Client(File(root, "alice"), relay, null)
    val bob = Client(File(root, "bob"), relay, null)
    try {
      alice.start()
      bob.start()
      for (client in listOf(alice, bob)) {
        await("initial relay lists and KeyPackage") {
          client.kit.accountSetupReadiness(client.key) == AccountSetupReadinessFfi.NETWORK_READY &&
            client.kit.accountRelayLists(client.key).complete
        }
      }
      val direct = alice.kit.startDirectConversation(alice.key, bob.key)
      bob.accept(direct)
      bob.kit.subscribeRelayLiveness(bob.key).use { connection ->
        assertTrue(connection.snapshot().any { it.url.trimEnd('/') == relay.trimEnd('/') })
        bob.kit.openConversationWindow(bob.key, direct, ConversationOpenModeFfi.LATEST, null, 5u, 15_000u).use { window ->
          assertNotNull(window.snapshot())
          val inbox = bob.kit.setAccountInboxRelays(bob.key, listOf(second), listOf(relay))
          assertEquals(listOf(second.trimEnd('/')), inbox.inbox.relays.map { it.trimEnd('/') })
          val nip65 = bob.kit.setAccountNip65Relays(bob.key, listOf(relay, second), listOf(relay, second))
          assertEquals(setOf(relay.trimEnd('/'), second.trimEnd('/')), nip65.nip65.relays.map { it.trimEnd('/') }.toSet())
          withTimeout(20_000) {
            while (checkNotNull(connection.next()).none { it.url.trimEnd('/') == second.trimEnd('/') }) { }
          }
          bob.kit.reconnectRelay(bob.key, second)
          bob.kit.notifyConnectivityRestored()
          val message = "received through an existing conversation after relay edits"
          alice.kit.sendTextWithClientToken(alice.key, direct, message, "while-editing-relays")
          withTimeout(25_000) {
            while (checkNotNull(window.next()).messages.none { it.timeline.plaintext == message }) { }
          }
          window.cancel()
        }
        connection.cancel()
        assertNull(connection.next())
      }
    } finally {
      try { alice.close() } finally {
        bob.close()
        root.deleteRecursively()
      }
    }
  }

  @Test fun blockListPersistsWithoutMessagingAndUpdatesOpenWindows() = runBlocking {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val relay = checkNotNull(InstrumentationRegistry.getArguments().getString("relay"))
    val root = File(instrumentation.targetContext.noBackupFilesDir, "fixture-${UUID.randomUUID()}")
    BoopMarmotModule.initializeBindings(instrumentation.targetContext)
    val alice = Client(File(root, "alice"), relay, null)
    val bob = Client(File(root, "bob"), relay, null)
    try {
      alice.start()
      bob.start()
      for (client in listOf(alice, bob)) {
        await("initial account declarations") {
          client.kit.accountSetupReadiness(client.key) == AccountSetupReadinessFfi.NETWORK_READY
        }
      }
      val direct = alice.kit.startDirectConversation(alice.key, bob.key)
      bob.accept(direct)
      val text = "message received before blocking"
      alice.kit.sendTextWithClientToken(alice.key, direct, text, "before-block")
      bob.receives(direct, alice.key, text)
      bob.kit.subscribeBlockedUsers(bob.key).use { blocks ->
        val initial = checkNotNull(blocks.snapshot())
        assertTrue(initial.users.isEmpty())
        bob.kit.openConversationWindow(bob.key, direct, ConversationOpenModeFfi.LATEST, null, 5u, 15_000u).use { window ->
          assertTrue(checkNotNull(window.snapshot()).messages.any { it.timeline.plaintext == text })
          coroutineScope {
            val a = async { bob.kit.blockUser(bob.key, alice.key) }
            val b = async { bob.kit.blockUser(bob.key, alice.key) }
            a.await()
            b.await()
          }
          val updated = withTimeout(15_000) { checkNotNull(blocks.next()) }
          assertTrue(updated.revision > initial.revision)
          assertEquals(alice.key, updated.users.single().publicKey)
          assertTrue(updated.users.single().isPrivate)
          assertTrue(alice.kit.getBlockedUsers(alice.key).isEmpty())
          withTimeout(15_000) {
            while (checkNotNull(window.next()).messages.any { it.timeline.plaintext == text }) { }
          }
          window.cancel()
        }
        val receiver = launch { blocks.next() }
        yield()
        withTimeout(5_000) { receiver.cancelAndJoin() }
      }
      bob.close()
      bob.start(messaging = false)
      bob.kit.subscribeBlockedUsers(bob.key).use { blocks ->
        assertEquals(alice.key, checkNotNull(blocks.snapshot()).users.single().publicKey)
        assertTrue(bob.kit.isUserBlocked(bob.key, alice.key))
        bob.kit.unblockUser(bob.key, alice.key)
        assertTrue(withTimeout(15_000) { checkNotNull(blocks.next()) }.users.isEmpty())
      }
    } finally {
      try { alice.close() } finally {
        bob.close()
        root.deleteRecursively()
      }
    }
  }

  @Test fun directAndGroupUseIndependentDurableAccounts() = runBlocking {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val context = instrumentation.targetContext
    val relay = InstrumentationRegistry.getArguments().getString("relay")
      ?: error("Pass the fixture WebSocket URL as the relay instrumentation argument")
    val blossom = InstrumentationRegistry.getArguments().getString("blossom")
    val fixture = URI(relay)
    Socket().use { it.connect(InetSocketAddress(fixture.host, fixture.port), 4_000) }
    BoopMarmotModule.initializeBindings(context)
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
        val direct = coroutineScope {
          assertNull(alice.kit.existingDirectConversation(alice.key, bob.key))
          val first = async { alice.kit.startDirectConversation(alice.key, bob.key) }
          val second = async { alice.kit.startDirectConversation(alice.key, bob.key) }
          first.await().also { assertEquals(it, second.await()) }
        }
        assertEquals(direct, alice.kit.existingDirectConversation(alice.key, bob.key)?.groupIdHex)
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
        val location = alice.kit.submitCustomEventWithClientToken(
          alice.key, direct, 24883uL, emptyList(), applicationEvent, "location-1",
        )
        assertEquals(location, alice.kit.submitCustomEventWithClientToken(
          alice.key, direct, 24883uL, emptyList(), applicationEvent, "location-1",
        ))
        bob.receives(direct, alice.key, applicationEvent)
        await("location becomes the latest chat preview") {
          bob.kit.chatList(bob.key, false).single { it.groupIdHex == direct }
            .lastMessage?.kind == 24883uL
        }
        bob.kit.openConversationWindow(bob.key, direct, ConversationOpenModeFfi.AUTOMATIC, null, 30u, 15_000u).use { window ->
          await("application event in conversation projection") {
            window.snapshot()?.messages?.any { it.timeline.kind == 24883uL && it.timeline.plaintext == applicationEvent } == true
          }
        }
        assertEquals(EncryptedMediaVersionFfi.V2, alice.kit.groupDetails(alice.key, direct).group.encryptedMedia.version)
        verifyWindowDelta(alice, bob, direct)
        if (blossom != null) mediaRoundTrip(alice, bob, direct, blossom, first.messageIdHex)

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

        val created = checkNotNull(alice.kit.createGroupWithInitialImageDetailed(
          alice.key, "Fixture group", listOf(bob.key, carol.key), "Integration fixture", null,
        ).created)
        val group = created.groupIdHex
        assertTrue(created.chatListRow.conversationCreatedAt > 0uL)
        bob.accept(group)
        carol.accept(group)
        for (client in listOf(alice, bob, carol)) {
          assertFalse(client.kit.timelineMessages(client.key, latestTimeline(group)).messages.any {
            it.groupSystem?.systemType == "group_renamed"
          })
        }
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

        val chatPreview = ChatListWindow(bob.kit.openChatListQueryWindow(
          bob.key, ChatListViewQueryFfi(ChatListViewFfi.CHATS, emptyList()), 40u,
        ))
        try {
          assertNotNull(chatPreview.initial())
          alice.kit.updateGroupProfile(alice.key, group, "Renamed group", "New description")
          await("canonical group profile") { bob.kit.groupDetails(bob.key, group).group.name == "Renamed group" }
          withTimeout(15_000) {
            while (true) {
              val update = checkNotNull(chatPreview.next())
              val rows = update["rows"] as? List<*>
              val row = rows.orEmpty().filterIsInstance<Map<*, *>>().firstOrNull { it["id"] == group }
              val preview = row?.get("preview") as? Map<*, *>
              val system = preview?.get("system") as? Map<*, *>
              if (system?.get("type") == "group_renamed") {
                assertEquals("Renamed group", system["name"])
                break
              }
            }
          }
        } finally {
          chatPreview.stop()
        }
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
        val requestText = "Message before accepting"
        alice.kit.sendTextWithClientToken(alice.key, declined, requestText, "pending-invitation-message")
        bob.receives(declined, alice.key, requestText)
        val pending = ConversationWindow(bob.kit.openConversationWindow(
          bob.key, declined, ConversationOpenModeFfi.LATEST, null, 12u, 15_000u,
        ))
        try {
          val snapshot = checkNotNull(pending.initial())
          assertEquals(true, snapshot["invited"])
          assertEquals(false, snapshot["canSend"])
          val rows = snapshot["messages"] as List<*>
          assertTrue(rows.any { (it as? Map<*, *>)?.get("text") == requestText })
        } finally {
          pending.stop()
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

  @Test fun chatMutesAndManualPinOrderSurviveRestart() = runBlocking {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val relay = checkNotNull(InstrumentationRegistry.getArguments().getString("relay"))
    BoopMarmotModule.initializeBindings(context)
    val root = File(context.noBackupFilesDir, "chat-management-${UUID.randomUUID()}")
    val alice = Client(File(root, "alice"), relay, null)
    val bob = Client(File(root, "bob"), relay, null)
    try {
      for (client in listOf(alice, bob)) {
        client.start()
        await("${client.directory.name} KeyPackage publication") {
          client.kit.accountSetupReadiness(client.key) == AccountSetupReadinessFfi.NETWORK_READY
        }
      }
      val direct = alice.kit.startDirectConversation(alice.key, bob.key)
      bob.accept(direct)
      suspend fun create(name: String) = checkNotNull(
        alice.kit.createGroupDetailed(alice.key, name, listOf(bob.key), null).created,
      ).groupIdHex
      val first = create("First group")
      val hidden = create("Hidden from the visible order")
      val newPin = create("Newly pinned")
      val removed = create("Unpinned during drag")
      fun pins() = alice.kit.chatList(alice.key, true).filter { it.pinned }.map { it.groupIdHex }

      for (group in listOf(direct, hidden, first, removed)) alice.kit.setChatPinned(alice.key, group, true)
      assertEquals(listOf(removed, first, hidden, direct), pins())
      alice.kit.setChatPinned(alice.key, newPin, true)
      alice.kit.setChatPinned(alice.key, removed, false)
      reorderPinnedChats(alice.kit, alice.key, listOf(direct, removed, first))
      val expected = listOf(newPin, direct, hidden, first)
      assertEquals(expected, pins())
      assertTrue(runCatching { reorderPinnedChats(alice.kit, alice.key, listOf(first, first)) }.isFailure)
      assertEquals(expected, pins())

      val deadline = System.currentTimeMillis() + 3_000
      assertEquals(deadline, alice.kit.setChatMuted(alice.key, direct, deadline).mutedUntilMs)
      assertTrue(alice.kit.setChatMuted(alice.key, first, null).muted)
      assertEquals(deadline.toDouble(), groupDocument(alice.kit, alice.key, direct)["mutedUntilMs"])
      assertNull(groupDocument(alice.kit, alice.key, first)["mutedUntilMs"])
      val message = "Incoming message must preserve pinned order"
      bob.kit.sendTextWithClientToken(bob.key, direct, message, UUID.randomUUID().toString())
      alice.receives(direct, bob.key, message)
      assertEquals(expected, pins())

      alice.close()
      alice.start()
      assertEquals(expected, pins())
      await("timed mute expires") { !alice.kit.chatNotificationSettings(alice.key, direct).muted }
      assertEquals(false, groupDocument(alice.kit, alice.key, direct)["muted"])
      assertTrue(alice.kit.chatNotificationSettings(alice.key, first).muted)
      alice.kit.clearChatMuted(alice.key, first)
      assertFalse(alice.kit.chatNotificationSettings(alice.key, first).muted)
    } finally {
      bob.close()
      alice.close()
      root.deleteRecursively()
    }
    Unit
  }

  @Test fun openLaterDeliversOnceWithReplyContextInDirectAndGroupChats() = runBlocking {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val relay = checkNotNull(InstrumentationRegistry.getArguments().getString("relay"))
    BoopMarmotModule.initializeBindings(context)
    val root = File(context.noBackupFilesDir, "open-later-${UUID.randomUUID()}")
    val alice = Client(File(root, "alice"), relay, null)
    val bob = Client(File(root, "bob"), relay, null)
    val carol = Client(File(root, "carol"), relay, null)
    val clients = listOf(alice, bob, carol)
    try {
      for (client in clients) {
        client.start()
        await("${client.directory.name} KeyPackage publication") {
          client.kit.accountSetupReadiness(client.key) == AccountSetupReadinessFfi.NETWORK_READY
        }
      }
      val direct = alice.kit.startDirectConversation(alice.key, bob.key)
      bob.accept(direct)
      verifyOpenLaterDelivery(alice, listOf(bob), direct)

      val group = checkNotNull(alice.kit.createGroupDetailed(
        alice.key, "Open Later fixture", listOf(bob.key, carol.key), null,
      ).created).groupIdHex
      bob.accept(group)
      carol.accept(group)
      verifyOpenLaterDelivery(alice, listOf(bob, carol), group)
    } finally {
      for (client in clients.asReversed()) client.close()
      root.deleteRecursively()
    }
    Unit
  }

  private suspend fun verifyOpenLaterDelivery(sender: Client, recipients: List<Client>, group: String) {
    val parentText = "Open Later reply target"
    val parent = sender.kit.sendTextWithClientToken(sender.key, group, parentText, UUID.randomUUID().toString())
    for (recipient in recipients) recipient.receives(group, sender.key, parentText)
    val body = """{"v":1,"sealed":"opaque-open-later-fixture"}"""
    val token = UUID.randomUUID().toString()
    val tags = listOf(listOf("e", parent.messageIdHex, "", "reply"))
    val accepted = sender.kit.submitCustomEventWithClientToken(sender.key, group, 24881uL, tags, body, token)
    val retried = sender.kit.submitCustomEventWithClientToken(sender.key, group, 24881uL, tags, body, token)
    assertEquals(accepted.messageIdHex, retried.messageIdHex)
    for (recipient in recipients) {
      recipient.receivesApplicationEvent(group, sender.key, 24881uL, body, accepted.messageIdHex, parent.messageIdHex)
    }
  }

  private suspend fun verifyWindowDelta(sender: Client, recipient: Client, group: String) {
    val marker = "read marker fixture"
    sender.kit.sendTextWithClientToken(sender.key, group, marker, "read-marker-fixture")
    recipient.receives(group, sender.key, marker)
    val lastRead = recipient.kit.timelineMessages(recipient.key, latestTimeline(group, marker)).messages.single()
    val marked = recipient.kit.markTimelineMessageRead(recipient.key, group, lastRead.messageIdHex)
    assertEquals(lastRead.messageIdHex, marked?.lastReadMessageIdHex)
    // Keep the next send past the read marker even when the relay fixture can
    // deliver multiple messages within the same protocol timestamp second.
    val nextSecond = (lastRead.timelineAt.toLong() + 1) * 1_000
    delay((nextSecond - System.currentTimeMillis()).coerceAtLeast(0))
    val seed = "unread prefetch fixture"
    sender.kit.sendTextWithClientToken(sender.key, group, seed, "unread-prefetch-fixture")
    recipient.receives(group, sender.key, seed)
    await("projected unread marker before speculative open") {
      recipient.kit.chatListRow(recipient.key, group)?.firstUnreadMessageIdHex != null
    }
    val before = checkNotNull(recipient.kit.chatListRow(recipient.key, group))
    assertNotNull(before.firstUnreadMessageIdHex)
    val handle = recipient.kit.openConversationWindow(recipient.key, group, ConversationOpenModeFfi.LATEST, null, 3u, 15_000u)
    val window = ConversationWindow(handle)
    try {
      val initial = checkNotNull(window.initial())
      assertEquals(sender.key, initial["peer"])
      assertEquals(true, initial["atTail"])
      assertEquals(before.firstUnreadMessageIdHex, initial["firstUnread"])
      val afterOpen = checkNotNull(recipient.kit.chatListRow(recipient.key, group))
      assertEquals(before.lastReadMessageIdHex, afterOpen.lastReadMessageIdHex)
      assertEquals(before.unreadCount, afterOpen.unreadCount)
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
      assertNotNull(next["firstUnread"])
      val afterArrival = checkNotNull(recipient.kit.chatListRow(recipient.key, group))
      assertEquals(before.lastReadMessageIdHex, afterArrival.lastReadMessageIdHex)
      assertEquals(before.unreadCount + 1uL, afterArrival.unreadCount)
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
      val kit = admin.kit
      val account = admin.key
      // Warm both read paths before sampling the local worker and projection cost.
      groupDocument(kit, account, group)
      rosterDocument(kit, account, group)
      val rosterTimes = mutableListOf<Long>()
      val priorTimes = mutableListOf<Long>()
      repeat(15) {
        val before = System.nanoTime()
        groupDocument(kit, account, group)
        groupDiagnostics(kit, account, group)
        kit.groupCommitDelivery(account, group)
        priorTimes += System.nanoTime() - before
        val after = System.nanoTime()
        rosterDocument(kit, account, group)
        rosterTimes += System.nanoTime() - after
      }
      android.util.Log.i("BoopGroupProjection", "previous five reads: ${priorTimes.sorted()[7] / 1000} us; roster read: ${rosterTimes.sorted()[7] / 1000} us (median, n=15)")
      val read = suspend { rosterDocument(admin.kit, admin.key, group) }
      val state = GroupStateWindow("group-test", admin.kit.subscribeGroupState(admin.key, group), read(), "groupRoster", read)
      fun roster(snapshot: Document): Set<Any?> {
        val details = snapshot["details"] as Map<*, *>
        return (details["members"] as List<*>).filterIsInstance<Map<*, *>>().map { it["id"] }.toSet()
      }
      val initial = checkNotNull(state.initial())
      assertEquals("0", initial["sequence"])
      assertFalse(roster(initial).contains(invitee.key))
      val initialRevision = ((initial["details"] as Map<*, *>)["revision"] as String).toULong()
      try {
        val result = admin.kit.inviteMembersDetailed(admin.key, group, listOf(invitee.key))
        val outcome = result.invite.memberOutcomes.single { it.accountIdHex == invitee.key }
        assertEquals(MemberResolutionStatusFfi.SELECTED, outcome.status)
        invitee.accept(group)
        val message = "hello after joining the group"
        admin.kit.sendTextWithClientToken(admin.key, group, message, "late-member-message")
        invitee.receives(group, admin.key, message)
        withTimeout(15_000) {
          while (true) {
            val next = checkNotNull(state.next())
            assertEquals("group-test", next["generation"])
            if (roster(next).contains(invitee.key)) {
              assertTrue(((next["details"] as Map<*, *>)["revision"] as String).toULong() > initialRevision)
              val settings = groupDocument(admin.kit, admin.key, group)
              val member = (settings["members"] as List<*>).filterIsInstance<Map<*, *>>().single { it["id"] == invitee.key }
              assertEquals(true, member["canRemove"])
              assertEquals(false, member["admin"])
              break
            }
          }
        }
      } finally { state.stop() }
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

  private suspend fun mediaRoundTrip(sender: Client, recipient: Client, group: String, blossom: String, directReply: String) {
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
    val preview = checkNotNull(recipient.kit.chatList(recipient.key, false)
      .single { it.groupIdHex == group }.lastMessage)
    assertEquals(row.messageIdHex, preview.messageIdHex)
    assertEquals(ChatListAttachmentKindFfi.FILE, preview.attachmentKind)
    assertEquals(1u, preview.attachmentCount)
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
    val historyGets = if (fixture) fixtureCall("stats") else 0
    recipient.kit.attachmentHistoryPage(recipient.key, group, 1u, null).use { initial ->
      val first = (initial as AttachmentPageReadFfi.Page).page
      recipient.kit.attachmentHistoryPage(recipient.key, group, 1u, checkNotNull(first.nextCursor)).use { following ->
        val second = (following as AttachmentPageReadFfi.Page).page
        val entries = listOf(first.entries.single(), second.entries.single())
        assertEquals(listOf(AttachmentCategoryFfi.AUDIO, AttachmentCategoryFfi.VIDEO), entries.map { it.category })
        assertEquals(listOf(0u, 1u), entries.map { (it.attachment as MediaAttachmentOutcomeFfi.Accepted).attachmentIndex })
        assertTrue(entries.all { it.messageIdHex == persisted.messageIdHex && it.sourceMessageIdHex == persisted.sourceMessageIdHex })
      }
    }
    val history = SharedMediaHistory()
    val conversation = SharedMediaHistory.Query(group, null, null, null, null)
    val account = SharedMediaHistory.Query(group, sender.key, persisted.timelineAt, persisted.timelineAt, null)
    suspend fun read(query: SharedMediaHistory.Query, cursor: String? = null, baseline: String? = null) =
      history.page(recipient.kit, recipient.key, query, cursor, baseline, 1u)
    try {
      val groupHead = read(conversation)
      val secondGroupHead = read(conversation)
      val groupBase = checkNotNull(groupHead["baseline"] as? String)
      val secondGroupBase = checkNotNull(secondGroupHead["baseline"] as? String)
      val groupNext = checkNotNull(groupHead["next"] as? String)
      assertNotEquals(groupBase, secondGroupBase)
      assertEquals("unchanged", history.changes(recipient.kit, recipient.key, groupBase))
      assertEquals(true, read(conversation, groupNext, secondGroupBase)["restart"])
      val groupTail = read(conversation, groupNext, groupBase)
      assertEquals(groupBase, groupTail["baseline"])
      val groupItems = (listOf(groupHead, groupTail).flatMap { it["rows"] as List<*> }).filterIsInstance<Map<*, *>>()
      assertEquals(listOf(0.0, 1.0), groupItems.map { (it["item"] as Map<*, *>)["index"] })
      assertTrue(groupItems.all { it["group"] == group && it["source"] == persisted.sourceMessageIdHex && it["sender"] == sender.key })

      val accountItems = mutableListOf<Map<*, *>>()
      var page = read(account)
      val accountBase = checkNotNull(page["baseline"] as? String)
      for (step in 0 until 32) {
        accountItems += (page["rows"] as List<*>).filterIsInstance<Map<*, *>>()
        val next = page["next"] as? String ?: break
        page = read(account, next, accountBase)
      }
      assertEquals(listOf(0.0, 1.0), accountItems.map { (it["item"] as Map<*, *>)["index"] })
      assertTrue(accountItems.all { it["group"] == group && it["sender"] == sender.key })
      assertEquals("unchanged", history.changes(recipient.kit, recipient.key, accountBase))
      history.release(groupBase)
      assertEquals("restart", history.changes(recipient.kit, recipient.key, groupBase))
      assertEquals("unchanged", history.changes(recipient.kit, recipient.key, secondGroupBase))
    } finally {
      history.close()
    }
    if (fixture) assertEquals(historyGets, fixtureCall("stats"))
    val anchored = ConversationWindow(recipient.kit.openConversationWindow(
      recipient.key, group, ConversationOpenModeFfi.MESSAGE, accepted.messageIdHex, 3u, 15_000u,
    ))
    try {
      val messages = checkNotNull(anchored.initial())["messages"] as List<*>
      val message = messages.filterIsInstance<Map<*, *>>().single { it["id"] == accepted.messageIdHex }
      val attachments = (message["attachments"] as List<*>).filterIsInstance<Map<*, *>>()
      assertEquals(listOf("accepted", "accepted"), attachments.map { it["outcome"] })
      assertEquals(listOf(0.0, 1.0), attachments.map { it["index"] })
      assertEquals(listOf("13", "3.5", "0,15,31", "voice"), attachments[0]["metadata"])
      assertEquals(listOf("13", "5.0", "", "round"), attachments[1]["metadata"])
      val content = checkNotNull(message["content"] as? Document)
      assertEquals(
        listOf(mapOf("kind" to "paragraph", "children" to listOf(mapOf("kind" to "text", "text" to "Resumed upload")))),
        content["blocks"],
      )
      assertEquals(row.messageIdHex, (message["replyPreview"] as? Map<*, *>)?.get("id"))
      assertEquals(false, message["recipientConfirmed"])
      assertNotNull(persisted.sourceMessageIdHex)
      assertEquals(persisted.sourceMessageIdHex, message["sourceId"])
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

    suspend fun start(
      identity: String? = null,
      messaging: Boolean = true,
      beforeStart: ((Marmot) -> Unit)? = null,
    ) {
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
      beforeStart?.invoke(opened)
      if (messaging) opened.start()
      if (!::key.isInitialized) {
        val relays = listOf(relay)
        key = when {
          identity == null -> opened.createIdentityWithProfile(relays, relays, relays).account.accountIdHex
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

    suspend fun receivesApplicationEvent(
      group: String, sender: String, kind: ULong, body: String, messageId: String, replyTo: String? = null,
    ) {
      val query = TimelineMessageQueryFfi(group, null, null, null, null, cursorGroupId = null,
        before = null, beforeMessageId = null, after = null, afterMessageId = null, limit = 40u)
      await("application event kind $kind on ${directory.name}") {
        val received = kit.timelineMessages(key, query).messages.singleOrNull {
          it.sender == sender && it.kind == kind && it.plaintext == body
        }
        if (received == null) false else {
          assertEquals(messageId, received.messageIdHex)
          if (replyTo != null) assertEquals(
            listOf(listOf("e", replyTo, "", "reply")),
            received.tags.filter { it.values.firstOrNull() == "e" }.map { it.values },
          )
          true
        }
      }
      val window = ConversationWindow(kit.openConversationWindow(
        key, group, ConversationOpenModeFfi.LATEST, null, 40u, 15_000u,
      ))
      try {
        val projected = (window.initial()?.get("messages") as List<*>).filterIsInstance<Map<*, *>>()
          .single { it["id"] == messageId }
        assertEquals(body, projected["text"])
        assertEquals(replyTo, projected["replyTo"])
      } finally { window.stop() }
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
