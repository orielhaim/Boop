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

also use `bun fmt` to format. instead of prettier/biome etc.

## Navigation & Routing

- Use **Expo Router** for all navigation. Routes live in `src/app/` — every file there is a screen, `_layout.tsx` files define navigators. Keep non-route code (components, hooks, utils) outside `src/app/`.
- For changes to Messages, read the messaging section of `arch.md` and the installed Chat Kit API types. Use `ChatList`, `Chat`, and `ChatHeader` for presentation and keep durable state in SQLite.
- Keep inbox subscriptions, catch-up, and outbound delivery in the protected app session's messaging runtime. Screens consume the repository, conversation feed, and shared history loader.
- Derive unread counts from committed SQLite records. Mark only visible IDs in a focused, foreground, unlocked chat. Use the native tab badge and keep prefetch and history windows bounded.
- Translate only visible incoming chat messages. Keep translations on the device, preserve original Nostr messages byte for byte, and keep translated text out of messaging, networking, and logs.
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

## Building with EAS

Use EAS to build, sign, and submit the app in the cloud (`eas build`, `eas submit`) and to ship over-the-air updates (`eas update`) — no local Xcode or Android Studio required. Run EAS CLI as `bunx eas-cli <command>` in Bun projects, or `npx eas-cli@latest <command>` otherwise; substitute that for bare `eas` in docs examples.
Docs: https://docs.expo.dev/eas/index.md

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:ios|android` locally, or `eas build --profile development`.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md
