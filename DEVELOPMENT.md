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

Start two MDK-compatible relay fixtures with `bun scripts/marmot-test-relay.ts`. This requires Cargo. The fixtures print their ports. Forward both ports to the Android emulator and run the instrumentation suite from `android`. Replace `19310` and `19311` with the fixture ports.

```sh
adb reverse tcp:19310 tcp:19310
adb reverse tcp:19311 tcp:19311
./gradlew :boop-marmot:connectedDebugAndroidTest -PreactNativeArchitectures=x86_64 -Pandroid.testInstrumentationRunnerArguments.relay=ws://127.0.0.1:19310 -Pandroid.testInstrumentationRunnerArguments.secondRelay=ws://127.0.0.1:19311
```

For the media test, start `bun scripts/marmot-test-blossom.ts` and forward its printed port to the emulator. Pass that origin with `-Pandroid.testInstrumentationRunnerArguments.blossom=<origin>`. The loopback fixture counts binary requests and pauses an explicit download so the test can cancel and retry it. The suite also checks multi-attachment metadata after encrypted draft recovery and restart, and verifies that call announcements leave timeline page size, unread counts, and previews unchanged. Only the instrumentation account enables loopback blobs.

An authorized HTTPS Blossom endpoint also exercises the encrypted group-image round trip. Test identities, credentials, and native stores are independent of the app. On PowerShell, quote each `-Pandroid.testInstrumentationRunnerArguments.*` argument.

`src/db/schema.ts` defines the application tables and indexes. Run `bun run db:generate` after changing the schema. Drizzle Kit generates the SQL, migration metadata, and Expo migration module in `src/db/migrations`. The app applies that module at database startup with Drizzle’s Expo SQLite migrator. Run `bunx drizzle-kit check` to validate the migration history.

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

### Android plugin delivery

Boop requires Android 14 (API 34) and targets API 36. `app.json` configures Expo prebuild. The generated app, native modules, Torrents split, and `cargo ndk --platform` use that minimum. Leave the call and media playback foreground services registered.

The Expo config plugin registers the `torrents` on-demand feature and installs SplitCompat in the generated application and activity. The base application owns the Play installation bridge and JNI declarations. The feature owns the Rust library. Install `cargo-ndk` 4.1.2 and the Rust targets for the selected Android ABIs. Gradle uses the configured NDK and builds the feature with `Cargo.lock`.

Build from the project root and use bundletool to test the install flow locally. Substitute the bundletool JAR path and the connected emulator ID.

```sh
bunx expo prebuild --clean --platform android --no-install
cd android
./gradlew :app:bundleDebug -PreactNativeArchitectures=x86_64
java -jar bundletool.jar build-apks --bundle=app/build/outputs/bundle/debug/app-debug.aab --output=boop-local.apks --local-testing --connected-device --ks=app/debug.keystore --ks-key-alias=androiddebugkey --ks-pass=pass:android --key-pass=pass:android
java -jar bundletool.jar install-apks --apks=boop-local.apks
```

Inspect the AAB and APK set before installing. Only the torrents ABI split should contain `libboop_torrent.so`. Connect the development client to Metro and tap **Install** next to Torrents in **Settings → Plugins**. After delivery, open the Torrents row. The enable switch becomes available once Boop verifies the JNI ABI. Compare the application process ID before and after installation to check that delivery needed no restart. A debug APK sideload without the APK set has no local delivery source. A local APK set exercises SplitCompat and the install flow without testing production Play eligibility or deferred uninstall.

### Torrents

The Plugin Host registers first-party code shipped with Boop. Its scoped contracts limit what a provider receives. They do not isolate this code at the operating-system level. The host matches bounded, authenticated conversation content before it dispatches to a registered provider. Chat Kit composes the resulting cards with the normal attachment and preview views. The Android Markdown projection keeps magnet destinations out of ordinary link handling.

Google Play installs the feature for the device. Boop stores activation and magnet resolution preferences per identity. On tap is the default. Automatic resolution applies to eligible visible messages in a focused, foreground, unlocked conversation. Metadata resolution never admits a file transfer. Resolutions share a request by v1 infohash. Boop seals validated metadata in account SQLite and keeps up to 64 entries and 8 MiB of sealed data, including metadata pinned by retained download records.

The shared DownloadManager persists an explicit download or Play & download action before admitting native work. The provider keys one job per account, infohash, and file index. It admits one file per torrent at a time. Play on a queued file promotes it while it waits and can suspend an unplayed sibling transfer to free that torrent's slot. The sibling keeps its checkpoint and original queue order.

A provider can offer `openProgressive` for an already admitted job. Media sources expose a progressive handle with a byte size, MIME type, and revocable URI. Android URLs contain only an opaque native token. Expo Video routes the `boop-media` scheme through a Media3 `DataSource` registry. Media3 byte ranges open cancellable librqbit file readers on the transfer's existing managed torrent. Reads wait for verified pieces, including an extractor seek to a trailing index. The player uses Media3's buffered playback time for the timeline and separately displays verified download bytes. Scrubbing incomplete media skips thumbnail extraction. Closing the player releases its reader lease while the DownloadManager job continues.

Android schedules authorized transfers as `JobScheduler` user-initiated data transfer jobs. The job service observes native execution and maintains a generic progress notification without starting another torrent or needing a JavaScript poll. Only explicitly admitted transfers can run in the background, and App Lock must be off. Metadata resolution remains foreground-only. Lock, identity replacement, and plugin revocation retire affected readers and native work. An Android user stop leaves the job paused. On an unclean process exit the manager reconciles any completed file first, then requires Resume for previously active incomplete torrent jobs. A stopped Android process does not restore its native jobs independently. Marmot and Blossom keep their existing foreground admission policy.

The torrent engine's verified piece tracker controls reads. Resume hashes staged disk data again before serving it. This scan costs time on large files but avoids trusting a piece map written before the corresponding data reached durable storage. The `.engine` workspace shares staged pieces between requests for the same torrent. Cancel clears that workspace when no sibling job needs it. Publication uses a hard link and atomic rename in the account's retained directory. If the filesystem denies hard links, the verified file moves into place with an atomic same-volume rename. Both paths preserve the inode and avoid a payload copy. Existing readers switch to the retained file at their current offsets, then the engine releases its handle. New playback sessions use the retained file directly. Expo Video handles MP4, Matroska, WebM, and other formats supported by the installed Media3 extractors and device decoders. Individual codec support depends on the device.

Blossom's whole-file hash verifies only after the whole blob is available. A streaming Blossom provider would need authenticated range hashes or an equivalent trusted proof for each exposed range. A Marmot implementation would need MDK to expose seekable, authenticated plaintext ranges and enforce the original message authority and lease revocation on every reader.

The feature uses librqbit 9.1.0 with Rust TLS and upload disabled at compile time and runtime. It supports v1 magnets and the v1 part of hybrid torrents. It uses public DHT, trackers and TCP peer connections. LAN discovery and peer listeners are disabled. Cargo pins the [Boop rqbit integration branch](https://github.com/orielhaim/rqbit/tree/boop/9.1.0) to an immutable revision based on [the published 9.1.0 source](https://github.com/ikatson/rqbit/commit/4309d38769ef93f6ee4f01a1ab147009a197fa8f). The fork enforces the address policy at the actual connection boundary and keeps the metadata caps, the debug-only loopback fixture feature and the public FileStream export. Boop builds with default features disabled, so optional rqbit tooling stays out of the Android split. Tracker redirects and DNS lookups use the same policy. The engine validates metadata and filesystem paths before opening its private staging area. It publishes verified files atomically without copying the payload, and Boop can open completed files after the plugin is disabled.

From the repository root, run the native checks and the relevant JavaScript tests:

```sh
cargo fmt --manifest-path extensions/torrents/rust/Cargo.toml --check
cargo clippy --locked --manifest-path extensions/torrents/rust/Cargo.toml -- -D warnings
cargo test --locked --manifest-path extensions/torrents/rust/Cargo.toml
cargo test --locked --manifest-path extensions/torrents/rust/Cargo.toml --lib --features torrent-test-fixture
bun test tests/plugins.test.ts tests/downloads.test.ts tests/blossom-downloads.test.ts
```

Run `./gradlew :boop-plugins:connectedDebugAndroidTest -PreactNativeArchitectures=x86_64` from `android` with the intended Android 14, 15, or 16 test device selected. The Rust loopback fixture checks a blocked read, cancels the reader while keeping the transfer, and reads at a byte offset through the same lease before and after publication. All 11 instrumentation tests passed on each of the three x86_64 emulators. They cover 64-bit offsets, range and EOF semantics, interrupted loaders, and Media3 decoding and seeking through the managed data source with a trailing-index MP4, Matroska, and WebM. The decoder tests use generated fixture bytes. The UIDT test uses Android's real JobScheduler and notification action with an instrumented transfer. It verifies that observation continues after the activity backgrounds and the notification's Pause action stops the registered transfer.

On the Windows host, the PR #9 loopback test took 2.50 seconds. The progressive fixture deliberately paused and resumed the seeder. On Windows, one run observed 0.205 ms for blocked-read cancellation, 14.785 seconds for the first 8 KiB offset read, 0.311 ms for a 4 KiB read after publication, and 14.992 seconds to finish the transfer. On the three Android emulators, the same Rust fixture passed all four tests on each device. Blocked-read cancellation took 0.296 to 0.412 ms, the first offset read took 13.56 to 18.22 seconds, and the read after publication took 0.089 to 0.146 ms. The seeder pause changes the workload relative to the baseline. The Android shell fixture also verified atomic publication on a filesystem that denies hard links.

The emulator timings below each record one run. The first measurement starts at Media3 preparation. The second includes the seek to 80 seconds and at least 100 ms of resumed playback. These tests ran with all three emulators active and used local fixture bytes, so the timings exclude torrent acquisition.

| Emulator   | MP4 first frame / seek + playback | Matroska first frame / seek + playback | WebM first frame / seek + playback |
| ---------- | --------------------------------: | -------------------------------------: | ---------------------------------: |
| Android 14 |                    829 / 1,497 ms |                         1,447 / 962 ms |                       676 / 457 ms |
| Android 15 |                  1,007 / 1,557 ms |                       2,797 / 1,168 ms |                       640 / 354 ms |
| Android 16 |                    966 / 1,783 ms |                       2,546 / 2,636 ms |                       454 / 301 ms |

Use `:app:bundleRelease` to check the minified release AAB. Check the R8 seeds for the `TorrentNative` JNI methods and run the NDK's `llvm-readelf -lW` on the feature library for each 64-bit ABI. Verify that its load segments have 16 KiB alignment. Use `zipalign -c -P 16 -v 4` on the generated feature APK. Production install, confirmation and physical removal require a Play-installed build. Local delivery does not exercise those Play Store decisions.

The x86_64 debug and minified release bundles built successfully. The local R8 build used a 6 GiB Gradle heap override. Bundletool confirmed on-demand delivery and found the torrent library only in the feature module. The x86_64 torrent ELF and feature APK passed 16 KiB alignment checks. Against the PR #9 x86_64 release APK set, the base master was 38.43 MB versus 38.45 MB, the base native split was 195.70 MB in both sets, and the torrent ABI split was 13.30 MB versus 13.05 MB. An offline Android 15 emulator installed that split through Plugins and completed the JNI handshake in the same app process.

On `Boop_Task16_Fresh` (Android 17, API 37), the debug app received a Marmot message from a separate fixture identity containing a [WebTorrent Sintel magnet](https://webtorrent.io/free-torrents). Resolve loaded all 11 file entries from the public swarm. The card was verified below the received text. Play & download rendered the MP4 while the same transfer displayed 129.1 MB of 129.2 MB downloaded. The video subsequently completed. An individual subtitle and the nine other files selected as a batch also reached Open file in the same chat. A second video download exercised the icon and live percentage ring.

On that emulator, the four Rust fixture tests, seven Media3 data-source tests, and UIDT test passed. The three synthetic decoder tests failed at first-frame rendering. Logcat reported Codec2 buffer-pool failures in the emulator's H.264 and VP9 decoders during that run.

Multi-gigabyte throughput and physical-device memory, battery, and thermal measurements remain unverified.

### Voice transcription

Rebuild the development client after installing `@hzblj/expo-speech`. The config plugin registers the older iOS speech recognition description and leaves microphone configuration to Boop's recording and calling modules. On Android, the installed recognizer determines whether language detection and switching are available. Before iOS 26, Boop uses SFSpeechRecognizer with speech authorization. iOS 26 and later use SpeechAnalyzer and system-managed language models on supported devices. Verify recognition and model installation on physical iOS hardware.

The protected session owns one transcription worker. It admits verified retained voice notes and leases each file only for local processing. Final text, segments and word timings are sealed with AES-GCM using a device-only SecureStore key for the current identity. Clearing all transcriptions deletes that key. The app omits the native transcript cache key for message audio.

Queued work continues across screens while the app is active and unlocked. It pauses for calls, recording, App Lock or app suspension, then resumes from SQLite when eligible. The OS does not schedule recognition while the app is suspended. Check a fresh received voice note by enabling Automatic mode, verifying it stays remote until Download, then waiting for the transcript after leaving the chat. Reopen it and check playback, seeking, speed changes, empty audio and the Storage clear actions. Exercise Hebrew and English transcripts separately.

## Navigation and motion

Check opening motion in a native release build so the Expo development launcher does not interrupt the native splash handoff. Use a clean emulator profile for account creation and import. The native splash and React Native opening share `assets/images/opening-mark.png` and the system light and dark backgrounds. The opening cover waits for the actual startup destination, which can be Welcome, App Lock, Chats, or a recoverable error.

The root native stack owns the call screen and camera scanner. The pathless `(messenger)` group keeps public paths such as `/chat/[key]`, `/person/[key]`, and `/settings`. It uses Screen Transitions 4.2.0 through Expo Router's standard navigator API. Settings uses a nested BlankStack with the same horizontal motion and edge gestures.

The glass dock uses the Expo Router headless tab state. Its Reanimated adapter slides the previous tab and the selected tab using the dock's displayed order, including the optional Calls tab and Hebrew RTL. A tab keeps its mounted state after its first visit. Back gestures belong to the stack, so horizontal gestures inside Chat Kit stay available.

Keep transition presets in `src/components/navigation/motion.ts`. People rows and chat headers can supply measured avatar bounds to profile and group details. A missing source falls back to the standard push. The fullscreen profile photo uses the existing local avatar resolver without starting a download. New Conversation and identity QR use the protected GlassSheet host. The Chat Kit attachment viewer has its own presentation. App Lock covers the entire navigator and its overlays.

## Messaging and identity

The local Expo module hosts one MarmotKit runtime and binds Boop’s Nostr signer to the selected MDK account. MDK owns MLS keys, invitations, group state, delivery, timeline projections, and retained attachments. Chat Kit reads windows through `src/core/marmot/native.ts`. Boop uses separate SecureStore keys for encrypted app data.

MDK owns the account’s NIP-65 and NIP-17 declarations, publication, Marmot relay connections, and KeyPackage maintenance. Settings edits publish through the native account setters. Account relay edits leave the running session open. Discovery relays are local preferences and constructor-time directory indexers. Changing them uses the same protected-session replacement as changing the attachment origin.

Boop reads the account’s live declarations from MDK to route NDK calls, Blossom lists, and NIP-50 search. New inbox relays must accept and return an encrypted test envelope before Boop asks MDK to advertise them. Boop stores expiring handoff routes and watches previous inboxes for up to three days so callers with cached declarations can still reach the account. The incoming-calls switch controls listening on this device. The Connections screen reports Marmot and NDK connectivity independently.

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
