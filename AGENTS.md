# Project architecture

Read `arch.md` at the repository root in full before making structural changes. It is the source of truth for the project.

This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

Use `bunx` instead of `npx`.

```bash
bunx expo install <package>  # ALWAYS use instead of npm/yarn/pnpm/bun add — resolves SDK-compatible versions
bunx expo start              # start the dev server
bunx expo lint               # lint
bunx tsc --noEmit            # typecheck
bunx expo-doctor             # diagnose dependency and config issues
bunx expo install --fix      # fix incompatible package versions
```

Run lint and typecheck before declaring any task done.

Use Bun 1.4.4 or later and run `bun fmt` for formatting.

## Navigation & Routing

- Use **Expo Router** for all navigation. Routes live in `src/app/` — every file there is a screen, `_layout.tsx` files define navigators. Keep non-route code (components, hooks, utils) outside `src/app/`.
- For changes to Messages, read the messaging section of `arch.md` and the installed Chat Kit API types. Use `ChatList`, `Chat`, and `ChatHeader` for presentation and keep durable state in SQLite.
- Keep inbox subscriptions, catch-up, and outbound delivery in the protected app session's messaging runtime. Screens consume the repository, conversation feed, and shared history loader.
- Derive unread counts from committed SQLite records. Mark only visible IDs in a focused, foreground, unlocked chat. Keep the glass dock badge separate from pending requests and keep prefetch and history windows bounded.
- Keep the floating dock on Expo Router headless tabs. Keep App Lock, the runtime, and the call indicator above the tab navigator. Preserve physical highlight and gesture mapping in RTL.
- Translate only visible incoming chat messages. Keep translations on the device, preserve original Nostr messages byte for byte, and keep translated text out of messaging, networking, and logs.
- For Special Messages, read the Open Later section of `arch.md`. Keep special sends in the Chat Kit composer and the shared encrypted outbox. Validate the Quicknet schedule and AGE recipient before persistence, and verify beacons with the pinned drand-client before opening. Keep sealed content out of translation, previews, and copy. Commit the unlocked body and opening state together in SQLite.
- Run `bun test tests/timelock.test.ts` for protocol and persistence changes. Run `bun scripts/test-chat-relay.ts --timelock` when checking the live Quicknet and relay path.
- Import `Link`, `router`, and `useLocalSearchParams` from `expo-router`.
- Docs: https://docs.expo.dev/router/introduction.md

## Localization

- Use the existing i18next instance for every app-owned string, including errors, accessibility labels, and native bridge labels. Add typed values in English and Hebrew together in `src/i18n/locales`.
- Use Auto-detect by default and English when the device language is unsupported. Honor saved manual preferences for translation and layout direction. Check new screens in LTR and Hebrew RTL.
- Use `src/i18n/format.ts` for shared formatting. Preserve user-generated text and identifiers as entered.
- Keep presentation copy out of persistence and transport. Use stable error codes and translate at the UI boundary. Reuse the existing Chat Kit adapter and UI components.
- Run `bun test tests/i18n.test.ts` after changing translation resources.

## Calling

- Read the calling section of `arch.md` before changing invitations, admission, or media. Keep one Call Controller, room, microphone, and native audio lease per logical call.
- Bind each connection to the admitted Nostr identity before attaching microphone audio. Require explicit Watch before targeting conference video and remove that target when consent ends.

## Communication privacy and identity

- Use the protected session’s central privacy service. Test the blocked set after verifying the NIP-59 Seal, then recheck at dispatch. Do not add per-peer relay sockets or treat a temporary outer author as the sender.
- Keep contacts, blocks, approvals, successful local initiation, and video consent distinct. Do not grant Initiated Only access from an inbound message, synced sender copy, or unanswered call.
- Keep pending requests out of normal messages and unread, translation, and unlock processing. Promote the original message and grant approval in one SQLite transaction.
- Use NIP-49 for exports. Never share or write plaintext private-key documents. Stage and verify a new SecureStore slot before changing the SQLite identity pin or resetting identity-owned data. Resolve the switch before constructing signer-bound services, and never generate a replacement key on a mismatch.

## Media

- Use the shared internal Media SDK in `src/core/media` for new HTTP media transfers, Blossom authorization and server selection, and persistent binary cache mechanics. Keep profile and attachment authorization with their owning feature. Use only enabled, explicitly configured origins or the recommended defaults the user can see in Media Servers.
- Keep BUD-03 imports local until enabled and publish server origins only after explicit confirmation. Keep encryption and NIP-17 publication outside the binary transport.

## Received attachments

- No received attachment may trigger an HTTP media request without explicit user action. This includes GET, HEAD, prefetch, probes, and remote player initialization from any background, history, preview, request, quote, or visible-message path.
- Only the explicit Download control for a live, accepted attachment may dispatch a media GET. Validate the HTTPS socket destination, size, hash, authentication tag, and format before saving it. Give Chat Kit only approved local audio files. Keep profile photos under their separate policy.
- Keep voice recording and playback within the focused, foreground, unlocked conversation. Yield audio to the call controller. Keep plaintext playback files in private, non-backed-up temporary storage.

## Profile photos

- Resolve profile photos through the protected session's avatar service. Render only an approved local file or a generated avatar. Pass local files only to native notification and background artwork APIs.
- Enforce the current download policy and saved-contact membership before network access. Blocked identities have no automatic image access. Recheck authorization before persisting and presenting a download.
- Validate URLs, redirects, socket destinations, file signatures, dimensions, and byte limits at the image transport boundary. Keep attachment downloads on their own media path.
- Upload only confirmed, cropped and verified exports with source metadata stripped. Sign scoped Blossom authorization with the existing NDK signer and preserve unrelated kind 0 fields.
- Scope the image cache, local overrides and publication drafts to the pinned identity. Identity replacement retires the prior owner's pending work and storage references.

## Building with EAS

Use EAS to build, sign, and submit the app in the cloud (`eas build`, `eas submit`) and to ship over-the-air updates (`eas update`) — no local Xcode or Android Studio required. Run EAS CLI as `bunx eas-cli <command>` in Bun projects, or `npx eas-cli@latest <command>` otherwise; substitute that for bare `eas` in docs examples.
Docs: https://docs.expo.dev/eas/index.md

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:ios|android` locally, or `eas build --profile development`.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md
