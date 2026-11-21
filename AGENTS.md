# Working on Boop

- Run `bun install --frozen-lockfile`, `bun fmt .`, `bun run lint`, `bun run typecheck`, and `bun test`.
- Read the installed Expo major version in `package.json`. Check the [matching SDK reference](https://docs.expo.dev/versions/v58.0.0/) and [Expo documentation index](https://docs.expo.dev/llms.txt) before changing Expo or React Native APIs. Use `bunx expo install` for Expo packages.
- Use Expo Router for routes in `src/app`. Put shared UI in `src/components`. Configure generated native projects in `app.json` and `plugins`. Use a development build for native modules.
- Use `src/services/local.ts` as the composition root for the protected session. It creates one messaging runtime, call controller, SQLite connection, and media SDK. Keep durable state in `src/db`.
- Use the installed Chat Kit APIs for chat presentation and the shared repository for history and outbox operations. Keep local message IDs and original timestamps stable through relay acknowledgments and edits. Commit revision or unlock state with the visible body.
- Verify the NIP-59 Seal before testing the blocked sender. Recheck authorization at dispatch. Keep saved contacts, message approvals, successful local initiation, and video consent independent. Promote requests and grant approval in one transaction.
- Keep private keys in SecureStore. Encrypt exports with NIP-49. Verify a staged replacement before switching the SQLite pin and clearing identity-owned state. Fail closed on a key mismatch.
- Gate microphone access on the authenticated call connection and bind identity proof to its DTLS fingerprints. Reuse one audio lease and capture per call. Send conference video only to viewers who explicitly opted in.
- Route binary transfers through `src/core/media`. Keep attachment encryption, verification, playback, and transport file-backed. Check network destinations, byte limits, and integrity before exposing a local file.
- A received attachment may fetch only when the user taps Download on a live accepted message. Apply the avatar policy separately. On Demand link previews need a tap. Automatic previews and translation are limited to eligible visible messages in a focused, foreground, unlocked chat.
- Use typed i18next resources in English and Hebrew for app-owned copy. Check LTR and RTL. Keep original message bytes and local-only derived text separate.
- Use the current SQLite baseline on a fresh database. See [Development](DEVELOPMENT.md) for explicit reset and verification commands.
- Use Luna as a sub-agent for exploration.
