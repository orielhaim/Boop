# Boop

Boop is an Expo development-build project for Android and iOS. Read [arch.md](arch.md) before making structural changes.

## Development

```sh
bun install --frozen-lockfile
bunx expo run:android
bun run start
```

Use `bunx expo run:ios` on a Mac with Xcode, or `bunx eas-cli build --profile development --platform ios` for a cloud development build. Expo Go omits the WebRTC and InCallManager native modules. Expo generates the native projects from `app.json`.

```sh
bunx expo install --bun --check
bunx expo-doctor
bun run lint
bun run typecheck
bun run check
bun test
bun scripts/test-chat-relay.ts
```

After changing the SQLite schema, run `bun run db:generate`. Commit the Drizzle SQL, snapshots, journal and generated TypeScript bundle together. The bundle keeps SQL migration imports out of Metro and Babel configuration.

The relay integration test needs OpenSSL on PATH. It generates a temporary certificate and runs two Boop identities through a loopback TLS relay.

## Local data and identity

Contacts, favorites, drafts, relay settings, and appearance settings live in local SQLite. SecureStore holds the private key. SQLite records the public key so an unavailable or mismatched secure-store entry cannot silently replace an established identity. Settings displays and shares the public address. Start a chat or call by typing or scanning someone’s address. Save a contact separately from Contacts or call history. Boop asks for camera access when you open the scanner.

## Private messaging

Add at least one common discovery relay under **Network** in **Settings** before exchanging messages. Boop publishes a signed NIP-17 inbox list for the enabled relays and looks up the recipient's signed inbox list before sending. It receives and catches up while the app is active. Pending text is available offline and survives restart. Relay acceptance is the meaning of “sent.” After that acceptance, Boop attempts to publish a separate encrypted history copy to the sender's inbox.

Chat Kit owns the list, message layout, composer, emoji keyboard, and interaction menus. SQLite owns the history and conversation settings. Swipe to quote a message, or long-press it for quick reactions and local actions. Local deletion hides this device's copy and retains the message ID to prevent relay replay from restoring it. Emoji reaction additions can sync privately through NIP-17 when online. Offline additions, removals, and unread state stay local. Remote edits, forwarding, and read receipts are outside this version.

When encrypted media transfer and retrieval are available, persist the media reference in the canonical message model and map it to Chat Kit's attachment and media props. The current composer enables text and emoji.

In a development build, **Settings → Open 10,000-message test chat** loads varied local history and a second, shorter conversation. The test chat header can schedule an incoming local message without a relay. The history uses the same SQLite pagination as real conversations.

## Place a voice call

1. Install a current Boop development build on two devices. Keep Boop open on both.
2. Add the same compatible NIP-17 inbox relay in **Settings → Connections** on both devices. The Android call test used `wss://auth.nostr1.com`. The relay must accept signed inbox listings and private gift wraps.
3. On the receiving device, copy your address in Settings or show its QR code.
4. On the calling device, choose **Calls → +**. Enter the receiver's address or scan the QR code. Saved contacts and chat headers also have a Call action.
5. Tap **Answer** on the receiving device and grant microphone access on both devices when prompted. Wait for the connected timer before testing mute and audio output.
6. Tap **End call** on either device. Check Recents for the final outcome.

Use the same Wi-Fi network for the first test. If direct ICE fails on another network, the call ends with a connection error. Boop has no TURN relay or background incoming-call service.

On Android, incoming calls use the device's selected ringtone and follow its ringer mode and Do Not Disturb rules. iOS uses a bundled Boop ringtone that follows the Ring/Silent switch. Install a new development build after changing the bundled tones.

## Native compatibility

- The starter already used Expo SDK 58, React Native 0.88.1, and React 19.3.0. Expo resolved the managed libraries for this SDK. The official Glassy UI Native sources are in `src/components/glassyui`. The local edits adapt host ref types for RN 0.88 and use Expo Image for avatars. Android uses the SDK blur target on supported versions and tinted surfaces elsewhere. Glassy UI's optional SDK 57-specific Android blur optimization is excluded.
- `@nostr-dev-kit/mobile` 0.9.3 peers target Expo 53, React Native 0.71, and Reanimated 3. Boop uses core NDK with Expo Crypto randomness. The published `@nostr-dev-kit/messages` wrapper did not meet this app's inbox discovery and separate sender-copy requirements, so the protocol boundary uses NDK directly.
- Chat Kit 7.1.0 reuses the root Gesture Handler and Keyboard Controller setup. Expo Clipboard, Expo Haptics, Expo Blur, and SVG are reused. No extra attachment peers are required for text chat. Chat Kit provides the emoji picker and resolves copy and optional native capabilities at runtime.
- Chat Kit's built-in message-menu and reaction haptics are controlled by the library. Version 7.1.0 exposes no per-app switch. Metro also reports an NDK transitive Noble Hashes export warning and resolves it through its file fallback.
- The WebRTC plugin 15.0.2 accepts Expo 56 and later in its package metadata. Its published compatibility table stops at SDK 56. Android prebuild and an x86_64 development APK succeeded with WebRTC 155.0.1 and InCallManager 4.3.0. The Android emulator opened and closed a local peer connection and resolved the InCallManager bridge. Expo Doctor still flags InCallManager as untested on the New Architecture. Use native call tests to verify audio routing, microphone capture, and bidirectional playback.
- Trystero 0.27 uses native WebRTC, Quick Crypto WebCrypto, and small React Native runtime compatibility adapters. **Settings → Check calling runtime** verifies WebCrypto and local peer creation without opening the microphone. During a call it also reports ICE state, track state, the selected audio route, and audio packet counters.
- On this Windows host, CMake 3.22.1's bundled Ninja failed on RN codegen paths longer than 260 characters. The x86_64 check selected installed SDK CMake 3.31.6 through a temporary Gradle init script. On the Android 17 emulator, all three tabs opened, contacts and drafts survived relaunch, and the same Nostr address and theme were restored. The identity QR sheet and local relay management also worked. The iOS build, Liquid Glass rendering, and hardware integrations remain unverified.

[Expo SDK 58](https://docs.expo.dev/versions/v58.0.0/) · [Glassy UI Expo guide](https://glassyui.com/guides/expo) · [WebRTC config plugin](https://github.com/expo/config-plugins/tree/main/packages/react-native-webrtc) · [InCallManager](https://github.com/react-native-webrtc/react-native-incall-manager) · [Trystero](https://github.com/dmotz/trystero).
