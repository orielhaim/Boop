# Development

Start with `bun install --frozen-lockfile`. Run `bun run android` or, on macOS with Xcode, `bun run ios` to generate and build the native project. Start Metro with `bun start`.

## Reset a development database

The current build opens a fresh SQLite database and refuses databases from earlier prototype builds. It never erases an existing identity during startup.

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
bun scripts/test-chat-relay.ts --timelock
bun scripts/test-media-files.ts
```

The relay integration test uses OpenSSL on PATH and connects to Quicknet when run with `--timelock`. The media integration test uses temporary files on the host.

`src/db/schema.ts` defines tables and indexes. The initial SQL also defines the SQLite triggers for delivery grants, translation invalidation, and tombstone cleanup. Run `bun run db:generate` to generate schema SQL and refresh the runtime bundle. If you change trigger SQL in the baseline, run `bun scripts/bundle-migrations.ts` again.

## Delayed-message dependency

Open Later uses the vendored `tlock-js` 1.0.0 build from [upstream PR #52](https://github.com/drand/tlock-js/pull/52). The archive is from commit `b311ee25c26dcf86f347049e37d05fed0394889e` and has SHA-256 `25fd6819942da96832adc8c6470e2c253783e7c6d8b1c0bd96e5082adf0b159d`. Keep Quicknet chain and beacon validation in `src/core/messaging/special-messages/timelock.ts`.
