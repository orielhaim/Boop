# Development

Start with `bun install --frozen-lockfile`. Run `bun run android` or, on macOS with Xcode, `bun run ios` to generate and build the native project. Start Metro with `bun start`. Open the active server from the Expo terminal or select it in the development launcher. Opening a development build from its icon takes you to the launcher so it cannot automatically retry a stale Metro bundle. Standalone builds open Boop directly.

## Reset a development database

Boop’s MDK-first account store starts fresh. Export a NIP-49 identity backup in the previous build to keep the same public address. Back up conversation history separately if you use Marmot Messaging Backup.

1. Clear the development app’s data on Android or delete the app on iOS. The app container holds the MDK account registry and Boop’s SQLite databases. iOS Keychain items can survive app deletion. Use Boop’s account removal before deleting the app when you need to remove a registered credential.
2. Install the new development build. At Welcome, choose **Create Account** or **Sign In**.
3. To restore your address, import the identity backup and finish the MDK checks. Verify the address in **Settings → Identity**.

## Check changes

```sh
bun fmt --check .
bun run lint
bun run typecheck
bun test
bunx expo-doctor
bun scripts/test-call-relay.ts
```

The call-signaling integration test uses OpenSSL on PATH and local TLS relays. It checks first-contact invitations, encrypted RTC replies, and group join replies between separate inboxes. It verifies that a usable authenticated reply route skips discovery and that a rejected route falls back to the recipient's published inbox.

### Android Marmot relay test

Start the MDK-compatible test relay with `bun scripts/marmot-test-relay.ts`. This requires Cargo. The relay prints its ephemeral port. With an Android emulator attached, forward that port and run the module's instrumentation suite from `android`. Replace `19310` with the printed port.

```sh
adb reverse tcp:19310 tcp:19310
./gradlew :boop-marmot:connectedDebugAndroidTest -PreactNativeArchitectures=x86_64 -Pandroid.testInstrumentationRunnerArguments.relay=ws://127.0.0.1:19310
```

For the media test, start `bun scripts/marmot-test-blossom.ts` and forward its printed port to the emulator. Pass that origin with `-Pandroid.testInstrumentationRunnerArguments.blossom=<origin>`. The loopback fixture counts binary requests and pauses an explicit download so the test can cancel and retry it. The suite also checks multi-attachment metadata after encrypted draft recovery and restart, and verifies that call announcements leave timeline page size, unread counts, and previews unchanged. Only the instrumentation account enables loopback blobs.

An authorized HTTPS Blossom endpoint also exercises the encrypted group-image round trip. Test identities, credentials, and native stores are independent of the app. On PowerShell, quote each `-Pandroid.testInstrumentationRunnerArguments.*` argument.

`src/db/schema.ts` defines the application tables and indexes. Run `bun run db:generate` to generate schema SQL and refresh the runtime bundle. Preserve the baseline's `PRAGMA user_version` when regenerating it.

## Onboarding and profiles

MarmotKit owns the identity key and account registry. Android uses the MDK Android Keystore-backed keyring. iOS uses MDK’s device-only Keychain entries with access after first unlock. Boop stores a public account selection and opens that account’s SQLite database after MDK reports local readiness. App Lock gates Boop’s signing and presentation.

**Create Account** passes the form’s initial profile to MDK. Chats can open from durable local state before relays accept the initial profile and KeyPackage. **Sign In** reviews the public address before persisting the imported key. The native bridge holds the credential during review. MDK persists import progress and requires confirmation before applying a proposed relay repair or continuing past the device check. The setup screen resumes unfinished imports after launch.

**Settings → Identity** can export a password-encrypted identity backup or reveal the raw key after device authentication. Replacing the account closes the previous session and opens the replacement’s setup. Once the replacement is ready, Boop removes the previous app database and encryption keys and asks MDK to remove the account from this device.

MarmotKit validates and caches public Nostr profiles. People and participant pickers read cached results and stream MDK directory search. The enabled NIP-50 discovery relays can also return keys outside the MDK social graph. MDK loads the profiles for those keys. Boop resolves NIP-05 through the checked native HTTPS transport and passes usable relay hints to MDK profile refresh. Local contact names and photo overrides are stored per Boop account.

The profile editor stores unpublished field edits and cropped files. MDK merges those edits into the current signed kind 0 document and publishes through the account's relay configuration. Boop preserves the draft until MDK reports a relay acknowledgement. A completed image upload can be reused on publication retry. Photo and banner upload keeps Boop's configured Blossom servers, verification, and optional mirroring.

Boop disables MDK's autonomous fetches for public profile photos. Its checked image transport starts a public image request only while the image is visible and the current account's privacy policy or an explicit visit permits it. Blocking, locking, or revoking permission cancels work and discards late bytes. The bounded public image file cache is keyed by the source URL. MDK owns encrypted group avatar acquisition, local bytes, and invalidation. Chat windows expose opaque references, and Boop renders bounded in-memory reads.

**Settings → Storage** measures logical file bytes inside Boop’s private storage on a native background queue. The total excludes the installed app binary. Android and iOS system settings may report different totals because they account for disk allocation and app assets separately. The attachment slice uses the current Marmot account’s storage report and is taken out of the measured Marmot directory total. Clear actions use the Marmot download and group-avatar caches, plus the local profile-image and link-preview caches.

Android reports per-app transmitted and received bytes across all interfaces since the last boot through [TrafficStats](https://developer.android.com/reference/android/net/TrafficStats). Both platforms report the current connection type. iOS does not expose a public per-app traffic total.

The interactive donut uses [Gifted Charts 1.4.83](https://www.npmjs.com/package/react-native-gifted-charts/v/1.4.83) with Boop’s existing SVG and Expo gradient dependencies. [Victory Native](https://github.com/FormidableLabs/victory-native-xl) also supports pie charts and requires adding Skia.

### Downloads

Rebuild the development client after native transport changes. Android has a minimum API level of 33. Add a public Blossom link in Downloads or tap the download action for a Blossom link in an accepted chat. The SDK parses BUD-10 URIs. Boop checks HTTPS URLs and discovers BUD-03 servers with the existing signed Nostr list lookup. Each native connection uses checked public DNS, including up to three HTTPS redirect hops. The checked transfer writes a resumable partial in account-scoped private storage, verifies SHA-256 incrementally, and publishes the file only after verification. This path supports resources up to 1 GiB and sends no authorization header. Authenticated encrypted attachments stay with MarmotKit.

The protected React Native session owns one encrypted SQLite queue. Transfers run while Boop is active and unlocked, including during navigation. AppState changes and App Lock stop admission and interrupt running transfers while preserving their checkpoints. Interrupted rows remain eligible for automatic resume. Reopening waits for in-flight attempts to stop, checks retained files and MarmotKit snapshots, then resumes pending jobs in queue order. Cold startup uses the same reconciliation for jobs left active by process termination.

Pause, Cancel and Remove use persisted user intents until native acknowledgment. Paused jobs require explicit Resume. Cancelled and failed jobs require explicit Retry. MarmotKit keeps a verified ciphertext checkpoint after interruption until expiry or pruning. Public Blossom Pause and lifecycle suspension keep a private partial. Resume uses a validated Range response or starts the file again when the origin serves a full response. A public Blossom Cancel discards the partial. Remove clears the retained file. The scheduler admits up to two transfers, with one on cellular and a native disk-headroom check for encrypted attachments.

Downloads history is reachable from Settings → Storage. With the Marmot test fixture, confirm zero binary requests before Download and verify resumed ciphertext and retained plaintext after retry. Sortables owns drag and edge scrolling for pending rows. Run `bun test tests/downloads.test.ts tests/blossom-downloads.test.ts` for queue, persistence, protocol validation and fallback regressions.

### Voice transcription

Rebuild the development client after installing `@hzblj/expo-speech`. The config plugin registers the older iOS speech recognition description and leaves microphone configuration to Boop's recording and calling modules. Android 13 can return estimated word timings. Android 14 and later can use the installed recognizer's language detection and switching. Before iOS 26, Boop uses SFSpeechRecognizer with speech authorization. iOS 26 and later use SpeechAnalyzer and system-managed language models on supported devices. Verify recognition and model installation on physical iOS hardware.

The protected session owns one transcription worker. It admits verified retained voice notes and leases each file only for local processing. SQLite migration `0001_speech_jobs` adds durable jobs to existing baseline v2 databases. Final text, segments and word timings are sealed with AES-GCM using a device-only SecureStore key for the current identity. Clearing all transcriptions deletes that key. The app omits the native transcript cache key for message audio.

Queued work continues across screens while the app is active and unlocked. It pauses for calls, recording, App Lock or app suspension, then resumes from SQLite when eligible. The OS does not schedule recognition while the app is suspended. Check a fresh received voice note by enabling Automatic mode, verifying it stays remote until Download, then waiting for the transcript after leaving the chat. Reopen it and check playback, seeking, speed changes, empty audio and the Storage clear actions. Exercise Hebrew and English transcripts separately.

## Navigation and motion

Check opening motion in a native release build so the Expo development launcher does not interrupt the native splash handoff. Use a clean emulator profile for account creation and import. The native splash and React Native opening share `assets/images/opening-mark.png` and the system light and dark backgrounds. The opening cover waits for the actual startup destination, which can be Welcome, App Lock, Chats, or a recoverable error.

The root native stack owns the call screen and camera scanner. The pathless `(messenger)` group keeps public paths such as `/chat/[key]`, `/person/[key]`, and `/settings`. It uses Screen Transitions 4.2.0 through Expo Router's standard navigator API. Settings uses a nested BlankStack with the same horizontal motion and edge gestures.

The glass dock uses the Expo Router headless tab state. Its Reanimated adapter slides the previous tab and the selected tab using the dock's displayed order, including the optional Calls tab and Hebrew RTL. A tab keeps its mounted state after its first visit. Back gestures belong to the stack, so horizontal gestures inside Chat Kit stay available.

Keep transition presets in `src/components/navigation/motion.ts`. People rows and chat headers can supply measured avatar bounds to profile and group details. A missing source falls back to the standard push. The fullscreen profile photo uses the existing local avatar resolver without starting a download. New Conversation and identity QR use the protected GlassSheet host. The Chat Kit attachment viewer has its own presentation. App Lock covers the entire navigator and its overlays.

## Messaging and identity

The local Expo module hosts one MarmotKit runtime and binds Boop’s Nostr signer to the selected MDK account. MDK owns MLS keys, invitations, group state, delivery, timeline projections, and retained attachments. Chat Kit reads windows through `src/core/marmot/native.ts`. Boop uses separate SecureStore keys for encrypted app data.

The enabled discovery relays are configured as MarmotKit directory indexers as well as account bootstrap relays. The 0.19.0 UniFFI directory lookup also reads the constructor's relay pool, which includes enabled general and discovery relays. The account's published relay lists still use the configured general and inbox selections. Inbox records can be available on the indexers while KeyPackages are served from the account's general relays.

The protected session gives MarmotKit the relay selections and preferred attachment origin. The Nostr relay service owns inbox publication intent. Media server health and local chat presentation preferences do not reconfigure the Marmot account.

Check first-account startup in a minified Android release. JNA resolves the generated UniFFI API and checksum interfaces by method name, so `marmot.pro` preserves both interfaces in the release. MarmotKit owns KeyPackage generation and publication. If attaching Boop’s chat services fails, the foreground session retries on reconnect. The chat screen also offers an explicit retry. MDK handles retries for initial account publication.

Received message attachments use MarmotKit's host-managed acquisition policy. Chat Kit renders local ThumbHash previews and leases verified files for playback or export. Download and Cancel drive the native attachment job. A gallery may open retained files from its loaded window.

The composer stages attachments in MDK's encrypted draft store. Retry uses the staged files and original client token, including after a restart. MDK builds the Marmot encrypted-media-v2 `imeta` entries in attachment order. An application tag for each entry adds size, duration, waveform, and the voice or round-video presentation type when applicable. The caption and reply stay in the same encrypted event. Forwarding uses the same configured servers and reads retained files from the source message.

Boop checks enabled attachment origins in order with a signed BUD-06 request. Unsupported preflight permits an upload attempt. A confirmed upload-stage failure can advance to the next origin. An uncertain admission stops the attempt and leaves retry to the saved draft and its token. The optional BUD-04 mirror copies the published ciphertext after admission and checks the returned hash and size. MDK's 0.19.0 references contain the primary locator, so the mirror is a backup copy. Profile photo upload and link previews use the separate Boop media path.

Group members can start a call from Group Details before anyone else joins. The coordinator publishes group-encrypted updates at start, on routing changes, and at end. A long call renews its 30-minute lease after 25 minutes. Members see the call in the conversation and Group Details through a separate MDK subscription. **Join** checks current membership and requests a seat through encrypted kind `24880` signaling, trying another announced participant if needed. A sole remaining participant keeps the same call open for others to join. Trystero authenticates peers and checks membership before sending microphone audio. First-contact calls use the same independent signaling path.

Pairing devices allows MarmotKit to synchronize supported state under the same Nostr account. Preserve the native account storage when preserving a development installation. An identity key backup carries the Nostr key alone. Messaging Backup is opt-in and restores available history only into conversations the device already belongs to.

MDK signs the preferred attachment Blossom origin into newly created conversations. If the attachment server list is empty, MDK creates a text-only group. Encrypted group images use the configured group-image endpoint. Members need a common image server because the group state carries no origin. Normal attachment references carry their own encrypted blob locators.

Group invitee checks use the SDK's single-account prewarm command. The completed lookup reflects a usable package and inbox route at that time. Creating a group or adding members revalidates them. In-chat reporting sends a group-encrypted report linked to the authenticated target message. The mention picker inserts a Nostr account link into the draft, which MDK recognizes on send.

## Delayed-message dependency

Opening a conversation or loading an older page checks its Open Later messages. The resolver reads SQLite first, then verifies due drand rounds in a bounded queue. Failed verification can be retried from the bubble. Messages that are still locked can be checked again on reopen or retry.

Open Later uses the vendored `tlock-js` 1.0.0 build from [upstream PR #52](https://github.com/drand/tlock-js/pull/52). The archive is from commit `b311ee25c26dcf86f347049e37d05fed0394889e` and has SHA-256 `25fd6819942da96832adc8c6470e2c253783e7c6d8b1c0bd96e5082adf0b159d`. Keep Quicknet chain and beacon validation in `src/core/messaging/special-messages/timelock.ts`.

## MarmotKit release inputs

Boop builds MarmotKit from the pinned MDK 0.19.0 commit. The patch extends tagged durable media submissions and keeps Boop call control events out of timeline projections. Its account changes expose native Nostr signing, bounded import review for raw and encrypted backups, and generated-setup recovery on reconnect. Sparse profile edits preserve the fetched kind 0 document and use MDK signing, relay selection, acknowledgement, and caching. Boop opts out of autonomous public avatar HTTP at runtime construction. Account databases use MDK schema 218. Use a fresh app install or the reset procedure above if you need a clean prototype store. The build generates matching UniFFI bindings and caches the outputs by patch digest under `modules/boop-marmot/sdk`. Gradle builds the selected ABIs. CocoaPods prepares the XCFramework and bundles the SDK privacy manifest.

Install Rust through rustup and the platform's native toolchain. The source checkout selects Rust 1.97.1 and requires Odin dev-2026-10 at `84bc3fc`. On Windows, use Visual Studio C++ build tools and put native Windows Perl on PATH before MSYS2. Install MSYS2 `make` and `perl` for the Android SQLCipher cross-build. Set `ODIN` to the Odin executable and `ANDROID_NDK_HOME` to the installed NDK if needed. On macOS and Linux, the build script can install Odin using MDK's checksum-verified installer.

To prepare the SDK directly, run `bun scripts/fetch-marmotkit.ts android x86_64` for an x86_64 emulator, or omit the ABI to build all Android ABIs. On macOS with Xcode, run `bun scripts/fetch-marmotkit.ts ios`. See the [0.19.0 distribution guide](https://github.com/marmot-protocol/mdk/blob/v0.19.0/crates/marmot-uniffi/DISTRIBUTION.md).
