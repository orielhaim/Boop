# Working on Boop

- Run `bun install --frozen-lockfile`, `bun fmt .`, `bun run lint`, `bun run typecheck`, and `bun test`.
- Read the installed Expo major version in `package.json`. Check the [matching SDK reference](https://docs.expo.dev/versions/v58.0.0/) and [Expo documentation index](https://docs.expo.dev/llms.txt) before changing Expo or React Native APIs. Use `bunx expo install` for Expo packages.
- Use Expo Router for routes in `src/app`. Put shared UI in `src/components`. Configure generated native projects in `app.json` and `plugins`. Use a development build for native modules.
- Use `src/services/local.ts` as the composition root for the protected session. It owns the Marmot account lifecycle separately from the relay and call-signaling lifecycle. Keep Boop-specific durable state in `src/db`.
- Keep call signaling in `src/core/calling/signaling-service.ts`. Encrypt kind `24880` control events with NIP-44/NIP-59 using the active Nostr identity. Subscribe to expiring MLS group-call announcements independently of the timeline. Recheck membership before admission and peer authentication. First-contact calls use relay inbox discovery.
- Use the installed Chat Kit APIs for chat presentation. Read membership, delivery, and message history through MarmotKit windows using opaque group and message IDs. Use MDK client tokens for durable local sends.
- Verify the NIP-59 Seal before testing the blocked caller. Recheck authorization at dispatch. Keep saved contacts, invitation approvals, successful local initiation, and video consent independent.
- Keep private keys in SecureStore. Encrypt exports with NIP-49. Verify a staged replacement before switching the SQLite pin and clearing identity-owned state. Fail closed on a key mismatch.
- Gate microphone access on the authenticated call connection and bind identity proof to its DTLS fingerprints. Reuse one audio lease and capture per call. Send conference video only to viewers who explicitly opted in.
- Use MarmotKit for encrypted attachment drafts, transfer, verification, and retention. Keep attachment metadata in the original encrypted event. Feed Chat Kit verified local leases and authenticated preview metadata. Use `src/core/media` for Blossom settings, preflight, optional ciphertext mirroring, profile media, and link previews.
- A received attachment may fetch only when the user taps Download on a live accepted message. Apply the avatar policy separately. On Demand link previews need a tap. Automatic previews and translation are limited to eligible visible messages in a focused, foreground, unlocked chat.
- Check Open Later against the loaded conversation window on open and paging. Store verified plaintext in the active account's SQLite cache. Keep decryption off the background schedule.
- Use typed i18next resources in English and Hebrew for app-owned copy. Check LTR and RTL. Keep original message bytes and local-only derived text separate.
- Use the current SQLite baseline on a fresh database. See [Development](DEVELOPMENT.md) for explicit reset and verification commands.
- Use Luna as a sub-agent for exploration.
