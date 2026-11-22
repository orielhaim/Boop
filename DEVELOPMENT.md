# Development

Start with `bun install --frozen-lockfile`. Run `bun run android` or, on macOS with Xcode, `bun run ios` to generate and build the native project. Start Metro with `bun start`.

## Reset a development database

SQLite baseline v2 contains Boop application data and call history. The app refuses earlier baselines before it opens or generates a SecureStore identity.

1. To keep an existing address, open the **previous build** and export an encrypted **Digital SIM** backup. Record the public address and keep the backup and its passphrase.
2. Clear Boop's app data on Android, or delete the app on iOS, then install the development build. This removes local history, settings, and caches. Android app-data clearing also removes SecureStore entries. iOS Keychain entries can survive app deletion.
3. Compare the address in the new build with the recorded address. If the address differs, import the encrypted Digital SIM, confirm the replacement, restart, and verify the address again.

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

The call-signaling integration test uses OpenSSL on PATH and a local TLS relay. It checks first-contact invitations, replay suppression, and encrypted RTC replies without starting Marmot.

`src/db/schema.ts` defines the application tables and indexes. Run `bun run db:generate` to generate schema SQL and refresh the runtime bundle. Preserve the baseline's `PRAGMA user_version` when regenerating it.

## Messaging and identity

The local Expo module opens the SQLCipher-backed MarmotKit account for the active Nostr address. The SecureStore identity remains the only persistent copy of the Nostr signing key. The native credential adapter supplies that key in memory and checks the account binding before opening the device database. MDK owns MLS keys, invitations, group state, timeline projections, delivery, and retained attachments. Chat Kit reads prepared windows through `src/core/marmot/native.ts`.

Received message attachments use MarmotKit's host-managed acquisition policy. The attachment action explicitly requests the download and leases the verified local file for presentation. The selected attachment Blossom origin is passed to MarmotKit. Profile photo upload and link previews use the separate Boop media path. First-contact WebRTC signaling uses authenticated kind `24880` control messages through the dedicated Nostr transport.

Pairing devices allows MarmotKit to synchronize supported state under the same Nostr account. Preserve the native account storage when preserving a development installation. A Digital SIM carries the Nostr key alone.

## Delayed-message dependency

Open Later uses the vendored `tlock-js` 1.0.0 build from [upstream PR #52](https://github.com/drand/tlock-js/pull/52). The archive is from commit `b311ee25c26dcf86f347049e37d05fed0394889e` and has SHA-256 `25fd6819942da96832adc8c6470e2c253783e7c6d8b1c0bd96e5082adf0b159d`. Keep Quicknet chain and beacon validation in `src/core/messaging/special-messages/timelock.ts`.

## MarmotKit release inputs

The Android and iOS builds fetch the pinned MarmotKit 0.18.0 archive into `modules/boop-marmot/sdk`. The fetch script verifies the archive checksum and source commit. To prepare the inputs manually, run `bun scripts/fetch-marmotkit.ts android` or `bun scripts/fetch-marmotkit.ts ios`. The CocoaPods integration bundles the SDK privacy manifest and requires iOS 18 or later. See the [0.18.0 distribution guide](https://github.com/marmot-protocol/mdk/blob/v0.18.0/crates/marmot-uniffi/DISTRIBUTION.md).
