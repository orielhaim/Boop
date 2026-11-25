# Development

Use Bun and a native Expo development build. Android requires API 34 or later. Build with JDK 17, the Android SDK and NDK, rustup, `cargo-ndk` 4.1.2, and Rust targets for the selected ABIs.

```sh
bun install --frozen-lockfile
bun run android
bun start
```

Select the active Metro server in the development launcher. Rebuild after native dependency or configuration changes. Use `app.json` and Expo config plugins for changes that must survive prebuild.

## Validate changes

```sh
bun fmt .
bun run lint
bun run typecheck
bun test
bunx expo-doctor
```

For call signaling, run `bun scripts/test-call-relay.ts` with OpenSSL on PATH. For an Android account or native bridge change, also verify first launch in a minified release. MarmotKit needs the UniFFI API and checksum interfaces preserved by `marmot.pro`.

### Android relay and media fixtures

Start two instances of `bun scripts/marmot-test-relay.ts`. Forward each printed port and run the tests from `android`. Replace the example ports and ABI with your fixture and device values.

```sh
adb reverse tcp:19310 tcp:19310
adb reverse tcp:19311 tcp:19311
./gradlew :boop-marmot:connectedDebugAndroidTest -PreactNativeArchitectures=x86_64 -Pandroid.testInstrumentationRunnerArguments.relay=ws://127.0.0.1:19310 -Pandroid.testInstrumentationRunnerArguments.secondRelay=ws://127.0.0.1:19311
```

For attachments, run `bun scripts/marmot-test-blossom.ts`, forward its port, and add `-Pandroid.testInstrumentationRunnerArguments.blossom=<origin>`. The fixture checks explicit download, cancellation, and retry. Quote each instrumentation argument in PowerShell.

For Torrents, run the following from the project root. Run `:boop-plugins:connectedDebugAndroidTest` from `android` on the selected device.

```sh
cargo fmt --manifest-path extensions/torrents/rust/Cargo.toml --check
cargo clippy --locked --manifest-path extensions/torrents/rust/Cargo.toml -- -D warnings
cargo test --locked --manifest-path extensions/torrents/rust/Cargo.toml
cargo test --locked --manifest-path extensions/torrents/rust/Cargo.toml --lib --features torrent-test-fixture
```

The native suite covers cancellable verified reads, Media3 seeking, and Android transfer jobs. Use legal fixture media and a controlled seeder. Codec support depends on the device.

## Build a local Android release

1. Advance `expo.android.versionCode` in `app.json` past the highest code used in Play Console. Build all configured ABIs.
2. Run `bunx expo prebuild --clean --platform android --no-install` from the root.
3. Set `BOOP_ANDROID_UPLOAD_STORE_FILE`, `BOOP_ANDROID_UPLOAD_KEY_ALIAS`, and `BOOP_ANDROID_UPLOAD_STORE_PASSWORD` in the build shell. Use the existing Play upload PKCS#12 key and load the password privately. All three variables are required for upload signing. With them unset, Gradle uses the debug key.
4. From `android`, run `./gradlew :app:bundleRelease`. The output is `app/build/outputs/bundle/release/app-release.aab`.
5. Run `jarsigner -verify` and compare `keytool -printcert -jarfile <bundle>` with the Play upload certificate. Run `bundletool validate` and inspect the package, version, SDKs, and on-demand feature manifest. Check `PAGE_ALIGNMENT_16K` in `bundletool dump config`, ELF load alignment with `llvm-readelf -lW`, and split APK alignment with `zipalign -c -P 16 -v 4`. Verify the Torrents JNI methods survive R8.

[Android app signing](https://developer.android.com/studio/publish/app-signing) · [16 KiB page sizes](https://developer.android.com/guide/practices/page-sizes)

### Windows build troubleshooting

Use a short checkout. If Ninja or Cargo hits a path limit, shorten the app CMake staging directory and MarmotKit Cargo target path. Choose paths dedicated to the checkout and use an installed SDK CMake version.

```powershell
$env:CARGO_TARGET_DIR = 'D:\tmp\boop-mdk'
.\gradlew.bat :app:bundleRelease '-Pboop.cmakeStagingDir=D:/boop-cxx' '-Pboop.cmakeVersion=3.31.6'
```

- Install Visual Studio C++ tools, native Windows Perl, and MSYS2 `make` and `perl`. Put native Perl before MSYS2 on PATH. The Android OpenSSL build uses the Perl next to `make`. Set `_CL_=/FS` for shared MSVC program databases.
- Set `ODIN` to the pinned compiler required by the MarmotKit checkout. Set `ANDROID_NDK_HOME` if SDK discovery selects the wrong NDK. Compile the SDK directly with `bun scripts/fetch-marmotkit.ts android x86_64` or omit the ABI to prepare all four.
- Reuse the same short Cargo directory across attempts. Matching bindings and ABI outputs are cached by source and patch digest. OpenSSL and Rust optimization can keep the log quiet for minutes. Check the compiler before interrupting and wait for an active Cargo build to release its lock.
- Cross-drive hard-link warnings fall back to copies. Keep SDK backups outside the SDK directory to avoid duplicate-package warnings.

### Test local feature delivery

From `android`, build `:app:bundleDebug` for the emulator ABI. Generate and install a local split set using bundletool. Substitute the JAR path and select the intended device before building the split set.

```sh
./gradlew :app:bundleDebug -PreactNativeArchitectures=x86_64
java -jar bundletool.jar build-apks --bundle=app/build/outputs/bundle/debug/app-debug.aab --output=boop-local.apks --local-testing --connected-device --ks=app/debug.keystore --ks-key-alias=androiddebugkey --ks-pass=pass:android --key-pass=pass:android
java -jar bundletool.jar install-apks --apks=boop-local.apks
```

Confirm `libboop_torrent.so` lives only in the feature ABI split. In **Settings → Plugins**, install Torrents and verify the JNI handshake allows activation in the same app process. Play eligibility, confirmation, and deferred removal require a Play-installed build.

## Reset a development database

Export a NIP-49 identity backup and back up conversation history separately before clearing app data. Take care on iOS, where Keychain items can survive uninstall. Use Boop's account removal if you need to retire a registered credential.

Clear the development app's storage, start at Welcome, then create an account or restore the identity. Verify the public address in **Settings → Identity**. An identity backup restores the key. Conversation recovery depends on Marmot device state and available history.

Generate schema changes with `bun run db:generate` and check them with `bunx drizzle-kit check`. The initial SQL and journal live in `src/db/migrations`. Keep `PRAGMA user_version` consistent with the baseline guard in `src/db/index.ts`.

## Account and transfer boundaries

MarmotKit owns the account keyring, MLS membership, relay declarations, timeline, encrypted drafts, and attachment retention. Build bindings and libraries from the same pinned MDK source and patch in `scripts/fetch-marmotkit.ts`. Preserve MDK client tokens on send retries. Probe new inbox relays before publishing them and keep the expiring handoff for callers with cached routes.

Check attachment origins with signed BUD-06 preflight. Advance to another origin after a confirmed upload-stage failure, and keep uncertain sends tied to the saved draft and token. BUD-04 mirrors hold backup ciphertext. Attachment references keep their primary locator.

The protected session owns the encrypted download queue. Marmot and public Blossom require explicit acquisition and foreground, unlocked admission. Blossom verifies a whole-file SHA-256 before publication. Its checked HTTPS transport caps files at 1 GiB. Pause preserves checkpoints, and Cancel follows the provider's cleanup policy. Remove releases retained files after playback leases retire.

Torrents uses a device-installed feature and per-identity activation. Resolve metadata only for authorized content, default to On tap, and require explicit file acquisition. The host scopes first-party providers and runs them in the app process. The [pinned rqbit fork](https://github.com/orielhaim/rqbit/tree/boop/9.1.0) handles v1 and the v1 half of hybrid torrents. Preserve its checked public network policy, metadata and path limits, and disabled payload uploads.

DownloadManager admits one file per torrent at a time. Media3's `boop-media` source uses revocable native readers on the same download. It serves verified pieces, rechecks staged data after a restart, and preserves reader positions when the verified file is published. Closing playback releases its reader and leaves the explicit transfer running. Completed files use the local path. Progressive support for Blossom or Marmot requires authenticated byte ranges before playback.

Android user-initiated data transfer jobs observe existing native work and show a generic notification. Background continuation requires explicit admission and App Lock off. User-stopped or interrupted incomplete Torrents jobs require Resume after reconciliation. Lock, account replacement, and plugin revocation retire affected readers and work. Keep call and media playback foreground services registered.

Voice transcription runs on-device against verified local voice-note leases. Store sealed text and timings per identity. Exercise English and Hebrew, playback, and the storage clear action.

Open Later verifies due Quicknet beacons when a conversation opens or pages older history. The vendored tlock archive comes from [upstream PR #52](https://github.com/drand/tlock-js/pull/52), commit `b311ee25c26dcf86f347049e37d05fed0394889e`. Its SHA-256 is `25fd6819942da96832adc8c6470e2c253783e7c6d8b1c0bd96e5082adf0b159d`. Keep the archive and beacon verification compatible.

## Website

Run `bun run types:check` and `bun run build` from `website`. Follow [website/AGENTS.md](website/AGENTS.md) for content and deployment.
