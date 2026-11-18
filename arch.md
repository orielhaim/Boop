# Architecture — P2P Phone

> **Status:** Active architecture specification  
> **Last updated:** 2026-11-19
>
> **Stack:** Expo, React Native, TypeScript, Bun, Nostr, Trystero

## 1. Project Overview

A modern, decentralized phone and messaging application built with Expo and React Native.

The application combines three familiar experiences:

- **Phone:** Calling, incoming calls, call history, and an in-call interface.
- **Messages:** Private conversations resembling iMessage, WhatsApp, and Telegram.
- **Contacts:** A personal address book with profiles, search, and direct calling/messaging.

The application uses Nostr for identity, encrypted messaging, and call setup. Trystero and WebRTC carry direct audio and optional camera sharing.

There is no proprietary backend or centralized account service.

The interface should feel like a premium, modern native phone application, with an iOS-inspired Liquid Glass design language and refined, fluid animations.

## 2. Core Principles

### Decentralized by design

- No application backend, centralized API, or hosted database.
- No Firebase, Supabase, proprietary signaling services, or application-managed Push infrastructure.
- Public, replaceable Nostr relays provide message transport and signaling.
- Audio and video travel directly between peers using WebRTC.
- No mandatory TURN infrastructure. Failed direct connectivity is an accepted limitation of the initial product.
- The application must remain independent of any specific Nostr relay.

### Cryptographic identity

- Each user owns one Nostr `secp256k1` keypair.
- The public key (`npub`) is the user's permanent address.
- The private key is generated locally and never transmitted.
- No email, password, phone-number verification, or account registration.
- No account recovery mechanism. Losing the private key permanently loses access to that identity.
- An exportable private-key backup may be supported, but must never be uploaded automatically.
- Display names and avatars are not trusted identity proofs.

### Keep it simple

- Prefer established, maintained libraries over custom implementations.
- Do not build custom encryption algorithms, WebRTC signaling frameworks, or UI rendering engines when a suitable library exists.
- Avoid unnecessary abstraction, excessive provider nesting, duplicate state stores, and premature generalization.
- No monorepo, microservices, or unnecessary internal packages.
- Introduce abstractions only where they isolate meaningful responsibilities.
- Prefer platform-native behavior over recreating native interactions manually.

### Product quality

- Smooth, responsive interactions and transitions.
- Excellent support for dark and light themes.
- Accessible controls and typography.
- Respect Reduced Motion and Reduced Transparency.
- Support RTL layouts and localization.
- Offline-first local data.
- Strong error handling and predictable lifecycle management.

## 3. Platform and Runtime

Target:

- Expo SDK 58, React Native 0.88, and the compatible React version.
- TypeScript with strict type checking.
- Bun as the package manager and script runner.
- Expo Router for navigation.
- Android and iOS.

Use the actual installed SDK and official compatibility documentation when installing packages.

Use Expo Development Builds for native WebRTC integration. Expo Go is not sufficient for the complete application.

Prefer Expo Continuous Native Generation and config plugins over manually maintaining native projects.

Do not introduce Node.js-only dependencies into the React Native runtime without verifying their compatibility.

## 4. Technology Stack

### Navigation and native UI

| Package                | Responsibility                                 |
| ---------------------- | ---------------------------------------------- |
| `expo-router`          | File-based navigation, stacks, and native tabs |
| `@expo/ui`             | Native SwiftUI and Jetpack Compose components  |
| `expo-glass-effect`    | System Liquid Glass on supported iOS versions  |
| `expo-blur`            | Cross-platform glass fallbacks                 |
| `expo-symbols`         | Native platform symbols                        |
| `expo-linear-gradient` | Backgrounds and subtle visual layers           |

Use `expo-router/native-tabs` on SDK 58 or later.

### Motion and interaction

| Package                            | Responsibility                          |
| ---------------------------------- | --------------------------------------- |
| `react-native-reanimated`          | Springs, transitions, layout animations |
| `react-native-worklets`            | Worklet runtime                         |
| `react-native-gesture-handler`     | Swipe, pan, press, drag                 |
| `react-native-keyboard-controller` | Interactive keyboard handling           |
| `expo-haptics`                     | Native tactile feedback                 |

### UI components

Use **Glassy UI Native**:

https://glassyui.com/mobile

https://glassyui.com/guides/expo

Glassy UI components are installed through its shadcn-compatible registry and copied into the repository.

Initial candidates:

- Glass Surface
- Glass Button
- Glass Panel
- Glass Input
- Glass Segmented Control
- Glass Sheet
- Glass Menu
- Glass Swipe Row
- Glass Avatar
- Glass Dialog

Install only the necessary components and their dependencies.

Prefer the official Expo implementation when it provides superior native behavior.

All glass usage should go through consistent application-level design primitives, avoiding unrelated visual implementations.

### Messaging and network

| Package                               | Responsibility                                    |
| ------------------------------------- | ------------------------------------------------- |
| `@nostr-dev-kit/ndk`                  | Nostr connections, identities, subscriptions      |
| `@kesha-antonov/react-native-chat`    | ChatList, Chat, ChatHeader, and chat interactions |
| `@nostr-dev-kit/mobile`               | React Native integration, if compatible           |
| `@nostr-dev-kit/react`                | Optional React integrations when useful           |
| `trystero`                            | P2P connections, data channels, and media         |
| `react-native-webrtc`                 | Native WebRTC                                     |
| `@config-plugins/react-native-webrtc` | Expo native WebRTC configuration                  |
| `react-native-incall-manager`         | Audio routing, ringtone, proximity handling       |

Avoid installing competing Nostr SDK implementations unless a documented compatibility problem requires changing the selected stack.

Treat native WebRTC and Trystero integration as a compatibility risk that must be validated on real devices.

### Storage and data

| Package             | Responsibility                         |
| ------------------- | -------------------------------------- |
| `expo-sqlite`       | Local SQLite persistence               |
| `drizzle-orm`       | Typed database access and migrations   |
| `drizzle-kit`       | Development-time schema tooling        |
| `expo-secure-store` | Private-key storage                    |
| `zustand`           | Transient application state            |
| `zod`               | Validation at external data boundaries |

Use SQLite for durable data and Zustand for transient application state. Do not create multiple competing sources of truth.

### Additional device and presentation utilities

- `@shopify/flash-list` — efficient contact lists.
- `expo-image` — optimized avatars and images.
- `expo-camera` — scanning public addresses for chats, calls, and contacts.
- `react-native-qrcode-svg` — displaying identity QR codes.
- `expo-clipboard` — copying keys, addresses, and messages.
- `expo-localization` — language and RTL awareness.
- `expo-splash-screen` — polished startup experience.
- `expo-dev-client` — native development builds.

Use Biome for linting and formatting where compatible with the project.

Avoid NativeWind, custom Skia rendering, and additional animation frameworks unless a demonstrated requirement justifies them.

## 5. Identity Architecture

A user's Nostr public key is their canonical identity.

### Creation

On first launch:

1. Generate a cryptographically secure Nostr keypair locally.
2. Store the private key using SecureStore.
3. Derive the public key and its `npub` representation.
4. Initialize the local database.
5. Initialize Nostr connectivity using the existing identity.
6. Display the user's address and QR code.

Do not silently replace an existing identity if storage becomes unavailable or corrupted.

Do not generate keys using `Math.random()` or other non-cryptographic randomness.

### Contacts

Contacts are local application records containing:

- Nostr public key (canonical identifier)
- Display name
- Optional avatar URL
- Optional profile metadata
- Favorites and local preferences

The contact name is controlled locally and takes precedence over externally published names.

Contacts are Boop identities saved by public address. Calls and chats accept typed or scanned addresses directly. An unsaved caller can be added from Recents.

## 6. Messaging Architecture

Use the existing Nostr private messaging standards:

- NIP-17 for private direct messages.
- NIP-44 for encrypted payloads.
- NIP-59 for gift-wrapped events.
- NIP-17-compatible inbox relay discovery.

Do not implement custom public-key encryption or invent a separate messaging protocol.

### Message flow

1. The sender selects a recipient by Nostr public key.
2. The messaging service constructs and encrypts a private message.
3. The event is published to the recipient's configured inbox relays.
4. A sender-side encrypted copy may be published for history synchronization.
5. The receiving client fetches, validates, decrypts, deduplicates, and persists the message.
6. The local database updates the UI.

Nostr relays are untrusted transport and storage providers.

Messages may arrive late, more than once, or out of order. Storage and synchronization must handle these conditions.

Messages can be retrieved after the recipient reconnects, subject to relay retention and availability.

### Chat persistence and presentation

- The messaging service owns NIP-17 inbox discovery, NIP-44 encryption, NIP-59 envelopes, signing, relay acknowledgments, and foreground synchronization. It uses core NDK for relay access and established Nostr cryptography.
- SQLite and Drizzle own messages, the pending outbox, replies, reactions, unread counts, drafts, and conversation preferences. An outgoing message keeps its local ID when publication is acknowledged. Synchronization deduplicates the inner rumor ID across relays and gift wraps.
- Message history uses a cursor ordered by creation time and local ID. The latest page loads first, and earlier pages prepend in chronological order. Chat Kit's built-in AnimatedLegendList owns virtualization, scroll anchoring, and jump-to-message behavior.
- Typed presentation adapters convert persisted rows into Chat Kit users, messages, quotes, reactions and conversation rows. `ChatList` presents conversations. `Chat` provides message rendering, composer, keyboard behavior, menus, and gestures. `ChatHeader` provides the detail header. Share the app's color and typography tokens through the library's appearance and theme APIs.
- The app enables text and emoji. Private reaction additions use encrypted kind 7 rumors when the target and inbox are available. Reaction removal, deletion, read state, pinning, mute, and archive are device-local. Media requires an encrypted transfer and retrieval flow before it can be enabled.

### Initial messaging features

- Private one-to-one conversations.
- Conversation list and previews.
- Sending and receiving text.
- Local message history.
- Timestamps and message grouping.
- Quoted replies and emoji reactions.
- Copy and local delete.
- Conversation search, unread counts, persistent drafts, pin ordering, and archive.
- Loading, connection, and failure states.

Do not falsely display delivery or read receipts. Relay acknowledgment is not recipient delivery.

Group chats, media attachments, voice messages, and advanced synchronization are future features.

## 7. Calling architecture

Boop supports one foreground call per device. Every call starts with audio. Both participants can share or stop their own camera independently during that call. The controller in `src/core/calling/controller.ts` owns the session and publishes a Zustand snapshot. Contacts, Recents, direct addresses, and Chat open the same call screen. The call indicator can reopen it after navigation.

### Private call control

`src/core/calling/signals.ts` defines relay signals for invite, ringing, accept, reject, cancel, busy, and setup termination. The wire name for setup termination is `call.end`. Each signal carries the call ID, both public keys, a nonce, a creation timestamp, and an expiration timestamp. Invites also carry a random room ID and a 256-bit room password. The maximum signal lifetime is 35 seconds.

The messaging service sends inner kind 24880 rumors through the existing NIP-17 inbox discovery and NIP-44/NIP-59 envelope code. The dispatcher verifies the outer event and seal, checks the inner event hash and signer, then validates the inner payload. Call events go to the call controller and make no chat rows or unread changes. Relay acknowledgment indicates relay acceptance. Only the peer's authenticated ringing signal starts ringback.

### Direct media and identity

`src/core/calling/trystero.ts` uses Trystero 0.27's Nostr strategy with a stable application ID, separate signaling sockets, a temporary identity, and a two-user room. React Native WebRTC provides peer connections, microphone capture, and native playback. Quick Crypto supplies WebCrypto. The adapter supplies the missing Promise and event registration APIs used by Trystero on React Native.

Each peer challenges the other over the direct Trystero data channel. The signed Nostr proof binds the challenge, both identity keys, both Trystero peer IDs, the room and call IDs, and the actual WebRTC certificate fingerprints. The transport requires the expected signature before capturing or sending microphone audio. The caller attaches audio first to avoid overlapping WebRTC offers. The controller starts elapsed time after both peers confirm receiving an audio track.

An accepted call switches permanently to direct application control as soon as the transport verifies the peer. The controller ignores later relay control for that call. Hangup and microphone state use targeted Trystero actions. Connection status comes from the native peer connection. A disconnected data channel ends locally when recovery fails. Trystero can still use its own relay strategy internally. SQLite stores local call metadata only.

### Camera sharing

`src/core/calling/video.ts` owns camera and consent state for the authenticated session. A local camera tap requests OS permission and opens a native preview. A targeted version 1 Trystero RPC carries the call ID and a monotonically increasing camera attempt number. A matching approval permits the sender to attach the track. A stop action invalidates that attempt, and the receiver rejects duplicate offers and stale approvals. Consent requests expire after 30 seconds.

The receiving user can deny video, approve video for the current call, or save approval for a verified contact. The contact row stores the permanent decision under the peer's Nostr public key. Contact Details can change that preference. Incoming requests and approvals never open the recipient's camera.

Camera capture uses React Native WebRTC at a target of 640 × 480 and 24 frames per second. The camera stream carries matching call and attempt metadata. The authenticated peer receives it in the existing room and connection. The caller coordinates bounded turns for track changes to avoid simultaneous SDP offers. Trystero manages the offer and answer. Camera stop disables capture immediately and removes the stream through Trystero. Front and rear camera switching applies constraints to the existing track. The native transport binding is in `src/core/calling/trystero-video.ts`.

The receiver displays video after the native receiver reports decoded frames. A direct acknowledgment confirms that the sender's video reached the receiver. A stalled video feed leaves the stage while audio can continue. The call screen shows one feed fullscreen or shows the remote feed with a draggable local preview by default. Tapping the preview swaps the feeds. Stage choice and preview corner live in the call session. Video overlays hide after inactivity and stay visible during dialogs, errors, or screen-reader use.

The fullscreen stage uses `RTCView`. iOS also uses `RTCView` for the floating preview. Android's `RTCView` uses a separately composited `SurfaceView`. The local Expo module in `modules/boop-camera-preview` uses a `TextureView` to clip floating video to its rounded outline. It attaches a renderer to the existing WebRTC track and shares the library's EGL context. The module uses React Native WebRTC 155's package-level stream lookup and executor. Verify these two interfaces when upgrading WebRTC. Android development clients need a native rebuild to include the module.

### Lifecycle and audio

The controller tracks calling, ringing, incoming, connecting, connected, and terminal states. It bounds waits, ignores late responses, and suppresses duplicate and reordered invitations within their validity window. When both people call at the same time, the lower public key keeps its outgoing call. The other client takes the incoming call. Leaving the call screen preserves the session. Moving the app to the background stops the call.

`src/core/calling/native-audio.ts` owns ringtone, ringback, audio focus, and route selection. On Android the selector uses InCallManager's native device list and current route events. On iOS the speaker override can be enabled or released, and AVAudioSession manages accessory routing. InCallManager controls proximity where the OS supports it. Muting disables the actual local audio tracks.

Hangup stops local capture and sends an authenticated notice over the data channel. Terminal cleanup aborts camera operations, dismisses consent, stops tracks and tones, leaves the room, and releases the audio session. SQLite stores one final history entry per call ID with start, answer, end, outcome, and connected duration.

### Background and network limits

Both clients must be open and able to reach a compatible inbox relay. Suspended and terminated clients have no call wake-up mechanism. Direct ICE uses Trystero's supported recovery and public STUN. Networks that require a TURN relay can fail to connect. The call does not retry indefinitely.

Boop pauses the background teardown check while the app owns a native microphone or camera permission prompt. After that prompt, backgrounding the app ends the call and releases both capture devices. Navigating to another Boop screen preserves the call and removes the fullscreen video views until the user returns. The floating preview is inside Boop's call screen.

## 8. Local Database

The initial schema should include:

| Table               | Responsibility                                   |
| ------------------- | ------------------------------------------------ |
| `contacts`          | Local address book and metadata                  |
| `conversations`     | Conversation summaries and local state           |
| `messages`          | Persisted messages and Nostr event IDs           |
| `message_reactions` | Private reaction records and local removal state |
| `call_history`      | Local call records                               |
| `relay_settings`    | Relay configuration                              |
| `settings`          | Application preferences                          |

Use typed migrations.

Enforce appropriate uniqueness constraints, particularly for contact public keys and Nostr event identifiers.

Persist Nostr sync cursors or equivalent reconciliation state where useful.

Store secrets separately in secure device storage.

## 9. Application Structure

Use a single Expo application and keep the structure compact.

Recommended organization:

```text
app/
  (tabs)/
    _layout.tsx
    calls/
    messages/
    contacts/
  chat/
  call/
  settings/
  _layout.tsx

src/
  components/
    ui/
    glass/
    contacts/
    messages/
    calls/
  core/
    identity/
    nostr/
    messaging/
    calling/
  db/
    schema.ts
    migrations/
    index.ts
  hooks/
  stores/
  theme/
  lib/

assets/
arch.md
AGENTS.md
```

If the existing Expo template uses `src/app`, preserve that structure rather than introducing a competing route tree.

### Responsibilities

- **app/** — Expo Router screens, layouts, navigation.
- **components/** — reusable visual components.
- **core/identity/** — identity creation, signing, key management.
- **core/nostr/** — relay connections, subscriptions, transport.
- **core/messaging/** — private messaging and synchronization.
- **core/calling/** — call lifecycle, signaling, WebRTC, audio.
- **db/** — schema, migrations, queries.
- **stores/** — transient UI and call state.
- **theme/** — design tokens and cross-platform styling.
- **lib/** — small shared utilities.

Feature components should consume public service interfaces, not directly depend on Nostr event internals or Trystero room objects.

Avoid trivial one-function abstractions that add complexity without benefit.

## 10. UI and Design Language

### Visual direction

A premium native phone application inspired by modern iOS Liquid Glass.

The interface should be:

- Elegant and minimal.
- Visually cohesive.
- Rich in subtle depth, translucency, lighting, and motion.
- Highly readable.
- Comfortable for everyday use.
- Appropriate for Android and iOS.

Use system-native Liquid Glass on supported iOS versions.

Use tasteful blur, tint, and fallback surfaces on Android.

Do not attempt to make every surface transparent.

### Design system

Centralize:

- Color tokens for light and dark themes.
- Typography scale and weights.
- Spacing and radius tokens.
- Glass styles and material intensity.
- Motion duration and spring presets.
- Haptic feedback conventions.
- Contrast and accessibility behavior.

Prefer native platform typography and iconography.

Use consistent visual components rather than styling each screen independently.

### Animation principles

Use Reanimated and Gesture Handler.

Prioritize:

- Fluid tab navigation.
- Spring-based button feedback.
- Smooth modal and sheet transitions.
- Natural message appearance.
- Swipe-to-reply interactions.
- Interactive keyboard transitions.
- Incoming and active call transitions.

Avoid decorative animation that interferes with readability or performance.

### Navigation

Three primary tabs:

1. **Calls** — recent calls, favorites, dialer/contact selection.
2. **Messages** — conversation list and chat detail.
3. **Contacts** — searchable personal address book.

Additional screens:

- Incoming call.
- Active call.
- Contact details.
- Add contact, enter an address, or scan an address.
- Settings with identity, preferences, and relay configuration.

The dialer must work with real application identities. A numeric keypad must not imply interoperability with ordinary telephone numbers unless such an addressing system is actually implemented.

## 11. Privacy and Security

- Never log private keys, plaintext secrets, or decrypted message contents.
- Never expose private keys through URLs, analytics, crash reports, or navigation parameters.
- Keep contacts local to the device.
- Validate every network-originated payload.
- Verify identity before trusting an incoming call.
- Do not embed private credentials in the application bundle.
- Require explicit permission when a feature needs the microphone or camera.
- Provide clear errors for missing connectivity and unavailable permissions.
- Use established cryptographic implementations.

Threat boundaries must be explicit:

- Relays can observe some metadata and may refuse or delay delivery.
- Direct WebRTC peers can generally discover one another's network addresses.
- Public keys authenticate cryptographic identities, not human names.
- A compromised private key compromises the corresponding identity.

## 12. Development Rules

- Use Bun.
- Prefer modern TypeScript and React patterns.
- Follow the installed Expo SDK's documentation.
- Use `expo install --bun` for Expo-managed dependencies.
- Validate versions with Expo's compatibility tools.
- Avoid unnecessary custom Metro, Babel, and native patches.
- Preserve the generated Expo project unless a concrete improvement is required.
- Keep dependency additions intentional and documented.
- Never silently replace an incompatible library with a different architecture.
- Do not leave unused template screens or sample assets.
- Keep the application buildable after each milestone.
- Add focused tests for identity, protocol validation, persistence, and call state transitions.
- Never claim a native integration works without actual native verification.

## 13. Implementation Roadmap

### Phase 1 — Foundation

- Verify Expo SDK and dependency compatibility.
- Install and configure the selected libraries.
- Configure development builds.
- Establish project structure.
- Implement the design system.
- Build native tab navigation.
- Create polished Calls, Messages, and Contacts screens.
- Set up SQLite and migrations.
- Implement basic local identity creation and persistence.
- Create service boundaries for messaging and calling.
- Verify TypeScript, linting, and application startup.

### Phase 2 — Contacts and Messaging

- Implement Nostr relay connectivity.
- Connect encrypted messaging through NIP-17.
- Implement contact management.
- Persist and render real conversations.
- Add synchronization and reconnection behavior.
- Complete message interactions.

### Phase 3 — Calling

- Validate Trystero on React Native.
- Implement secure call invitations.
- Build WebRTC connection and audio management.
- Implement call authentication.
- Support incoming, outgoing, active, and failed calls.
- Add call history and cleanup.

### Phase 4 — Polish and Reliability

- Refine animations.
- Handle lifecycle and connectivity edge cases.
- Test on real Android and iOS devices.
- Optimize message lists and transitions.
- Add accessibility and RTL testing.
- Finalize privacy and security review.

## 14. Architecture Maintenance

This file is the canonical architecture specification.

Every development agent must read `arch.md` before making structural changes.

Update this document when an architectural decision changes. Do not treat an implementation convenience as an implicit change to the design.

All changes must preserve the core project goals:

**One application. One cryptographic identity per user. Nostr for messages and signaling. Trystero for direct calls. No proprietary backend. A polished native phone experience.**
