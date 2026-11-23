# Development

Start with `bun install --frozen-lockfile`. Run `bun run android` or, on macOS with Xcode, `bun run ios` to generate and build the native project. Start Metro with `bun start`. Open the active server from the Expo terminal or select it in the development launcher. Opening a development build from its icon takes you to the launcher so it cannot automatically retry a stale Metro bundle. Standalone builds open Boop directly.

## Reset a development database

SQLite baseline v2 contains Boop application data and call history. The app refuses earlier baselines before it reads the SecureStore identity.

1. To keep an existing address, open the **previous build** and export an encrypted **identity key backup**. Record the public address and keep the backup and its passphrase.
2. Clear Boop's app data on Android, or delete the app on iOS, then install the development build. This removes local history, settings, and caches. Android app-data clearing also removes SecureStore entries. iOS Keychain entries can survive app deletion.
3. At Welcome, choose **Sign In** and import the encrypted identity key backup. If iOS retained a different identity, use **Settings → Identity keys** to stage a replacement. After startup, check the address against the original.

Keep the SQLite files and SecureStore state together when preserving an installation. Removing only the SQLite files can discard the pointer to a replacement identity's SecureStore slot.

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

Startup opens the SQLite baseline and checks the pinned SecureStore slot. A missing key and pin opens Welcome. A missing or mismatched pinned key stops startup. Existing valid keys bypass Welcome, including legacy keys stored before pinning.

**Create Account** writes the initial profile draft and securely stores the generated key before pinning the address. MarmotKit opens Chats for that address from durable local state while relay setup runs in the background. Boop publishes the profile separately. Relay acknowledgment, or a matching signed event read back from a relay, clears the pending draft. **Sign In** validates and confirms the imported address before saving it. It never publishes an initial profile. The Identity keys settings screen still handles staged replacements.

Chats is the root route. People and Profile complete the dock. The shared person route accepts saved and unsaved identities. The `contacts.name` column holds a local nickname. An empty value means the user has no nickname. Existing saved rows, overrides, favorites, call preferences, and call history stay in the existing baseline. Public metadata stays in `nostr_profiles`.

The profile cache accepts signed kind 0 events and keeps the most recent replaceable event. Save writes profile text locally. Confirming a photo or banner crop saves it locally too. Boop displays saved changes while its protected session retries publication. Edits merge with the latest observed fields, including fields Boop does not present. People resolves exact keys locally. NIP-05 checks HTTPS mappings through the native public-network transport, and text searches use enabled discovery relays that support NIP-50. Results reflect those relays. MarmotKit's directory and KeyPackage lookup remain responsible for starting an MLS conversation.

Profile photo and banner URLs go through the same native destination, download, decode, and cache limits. The **My Contacts** default applies before downloading. **Load profile images** grants temporary access while the profile is open and unlocked. Blocking revokes access. Only checked local files reach the image component.

### Storage and network usage

**Settings → Storage** measures logical file bytes inside Boop’s private storage on a native background queue. The total excludes the installed app binary. Android and iOS system settings may report different totals because they account for disk allocation and app assets separately. The attachment slice uses the current Marmot account’s storage report and is taken out of the measured Marmot directory total. Clear actions use the existing Marmot download and profile-image caches, plus the local link-preview cache.

Android reports per-app transmitted and received bytes across all interfaces since the last boot through [TrafficStats](https://developer.android.com/reference/android/net/TrafficStats). Both platforms report the current connection type. iOS does not expose a public per-app traffic total.

The interactive donut uses [Gifted Charts 1.4.83](https://www.npmjs.com/package/react-native-gifted-charts/v/1.4.83) with Boop’s existing SVG and Expo gradient dependencies. [Victory Native](https://github.com/FormidableLabs/victory-native-xl) also supports pie charts and requires adding Skia.

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

The local Expo module opens the SQLCipher-backed MarmotKit account for the active Nostr address. The SecureStore identity remains the only persistent copy of the Nostr signing key. The native credential adapter supplies that key in memory and checks the account binding before opening the device database. MDK owns MLS keys, invitations, group state, timeline projections, delivery, and retained attachments. Chat Kit reads prepared windows through `src/core/marmot/native.ts`.

The enabled discovery relays are configured as MarmotKit directory indexers as well as account bootstrap relays. The 0.18.0 UniFFI directory lookup also reads the constructor's relay pool, which includes enabled general and discovery relays. The account's published relay lists still use the configured general and inbox selections. Inbox records can be available on the indexers while KeyPackages are served from the account's general relays.

The protected session gives MarmotKit the relay selections and preferred attachment origin. The Nostr relay service owns inbox publication intent. Media server health and local chat presentation preferences do not reconfigure the Marmot account.

Check first-account startup in a minified Android release. JNA resolves the generated UniFFI API and checksum interfaces by method name, so `marmot.pro` preserves both interfaces in the release. MarmotKit owns KeyPackage generation and publication. If local account open fails transiently, Chats keeps its syncing state while the protected session retries with backoff and wakes on reconnect. Automatic retries pause when the app is inactive or locked. Persistent failures use the existing retry action.

Received message attachments use MarmotKit's host-managed acquisition policy. Chat Kit renders local ThumbHash previews and leases verified files for playback or export. Download and Cancel drive the native attachment job. A gallery may open retained files from its loaded window.

The composer stages attachments in MDK's encrypted draft store. Retry uses the staged files and original client token, including after a restart. MDK builds the Marmot encrypted-media-v2 `imeta` entries in attachment order. An application tag for each entry adds size, duration, waveform, and the voice or round-video presentation type when applicable. The caption and reply stay in the same encrypted event. Forwarding uses the same configured servers and reads retained files from the source message.

Boop checks enabled attachment origins in order with a signed BUD-06 request. Unsupported preflight permits an upload attempt. A confirmed upload-stage failure can advance to the next origin. An uncertain admission stops the attempt and leaves retry to the saved draft and its token. The optional BUD-04 mirror copies the published ciphertext after admission and checks the returned hash and size. MDK's 0.18.0 references contain the primary locator, so the mirror is a backup copy. Profile photo upload and link previews use the separate Boop media path.

Group members can start a call from Group Details before anyone else joins. The coordinator publishes group-encrypted updates at start, on routing changes, and at end. A long call renews its 30-minute lease after 25 minutes. Members see the call in the conversation and Group Details through a separate MDK subscription. **Join** checks current membership and requests a seat through encrypted kind `24880` signaling, trying another announced participant if needed. A sole remaining participant keeps the same call open for others to join. Trystero authenticates peers and checks membership before sending microphone audio. First-contact calls use the same independent signaling path.

Pairing devices allows MarmotKit to synchronize supported state under the same Nostr account. Preserve the native account storage when preserving a development installation. An identity key backup carries the Nostr key alone. Messaging Backup is opt-in and restores available history only into conversations the device already belongs to.

MDK signs the preferred attachment Blossom origin into newly created conversations. If the attachment server list is empty, MDK creates a text-only group. Encrypted group images use the configured group-image endpoint. Members need a common image server because the group state carries no origin. Normal attachment references carry their own encrypted blob locators.

Group invitee checks use the SDK's single-account prewarm command. The completed lookup reflects a usable package and inbox route at that time. Creating a group or adding members revalidates them. In-chat reporting sends a group-encrypted report linked to the authenticated target message. The mention picker inserts a Nostr account link into the draft, which MDK recognizes on send.

## Delayed-message dependency

Opening a conversation or loading an older page checks its Open Later messages. The resolver reads SQLite first, then verifies due drand rounds in a bounded queue. Failed verification can be retried from the bubble. Messages that are still locked can be checked again on reopen or retry.

Open Later uses the vendored `tlock-js` 1.0.0 build from [upstream PR #52](https://github.com/drand/tlock-js/pull/52). The archive is from commit `b311ee25c26dcf86f347049e37d05fed0394889e` and has SHA-256 `25fd6819942da96832adc8c6470e2c253783e7c6d8b1c0bd96e5082adf0b159d`. Keep Quicknet chain and beacon validation in `src/core/messaging/special-messages/timelock.ts`.

## MarmotKit release inputs

Boop builds MarmotKit from the pinned MDK 0.18.0 commit. The local patch retains message tags on durable sends and keeps Boop call control events out of timeline queries. The build generates matching UniFFI bindings and caches the outputs under `modules/boop-marmot/sdk`. Gradle builds the selected ABIs. CocoaPods prepares the XCFramework and bundles the SDK privacy manifest.

Install Rust through rustup and the platform's native toolchain. The source checkout selects Rust 1.97.1 and requires Odin dev-2026-10 at `84bc3fc`. On Windows, use Visual Studio C++ build tools and add MSYS2 `make` and `perl` to PATH for SQLCipher. Set `ODIN` to the Odin executable and `ANDROID_NDK_HOME` to the installed NDK if needed. On macOS and Linux, the build script can install Odin using MDK's checksum-verified installer.

To prepare the SDK directly, run `bun scripts/fetch-marmotkit.ts android x86_64` for an x86_64 emulator, or omit the ABI to build all Android ABIs. On macOS with Xcode, run `bun scripts/fetch-marmotkit.ts ios`. See the [0.18.0 distribution guide](https://github.com/marmot-protocol/mdk/blob/v0.18.0/crates/marmot-uniffi/DISTRIBUTION.md).
