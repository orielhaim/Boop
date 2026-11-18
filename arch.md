# Architecture — P2P Phone

> **Status:** Active architecture specification  
> **Last updated:** 2026-11-18  
> **Stack:** Expo, React Native, TypeScript, Bun, Nostr, Trystero

## 1. Project Overview

A modern, decentralized phone and messaging application built with Expo and React Native.

The application combines three familiar experiences:

- **Phone:** Calling, incoming calls, call history, and an in-call interface.
- **Messages:** Private conversations resembling iMessage, WhatsApp, and Telegram.
- **Contacts:** A personal address book with profiles, search, and direct calling/messaging.

The application uses Nostr for identity, encrypted messaging, and call invitations, while Trystero and WebRTC establish direct peer-to-peer audio connections.

There is no proprietary backend or centralized account service.

The interface should feel like a premium, modern native phone application, with an iOS-inspired Liquid Glass design language and refined, fluid animations.

## 2. Core Principles

### Decentralized by design

- No application backend, centralized API, or hosted database.
- No Firebase, Supabase, proprietary signaling services, or application-managed Push infrastructure.
- Public, replaceable Nostr relays provide message transport and signaling.
- Audio travels directly between peers using WebRTC whenever direct connectivity is possible.
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

| Package                               | Responsibility                               |
| ------------------------------------- | -------------------------------------------- |
| `@nostr-dev-kit/ndk`                  | Nostr connections, identities, subscriptions |
| `@nostr-dev-kit/messages`             | NIP-17 messaging and conversations           |
| `@nostr-dev-kit/mobile`               | React Native integration, if compatible      |
| `@nostr-dev-kit/react`                | Optional React integrations when useful      |
| `trystero`                            | P2P connection management and audio streams  |
| `react-native-webrtc`                 | Native WebRTC                                |
| `@config-plugins/react-native-webrtc` | Expo native WebRTC configuration             |
| `react-native-incall-manager`         | Audio routing, ringtone, proximity handling  |

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

- `@shopify/flash-list` — efficient conversation and message lists.
- `expo-image` — optimized avatars and images.
- `expo-contacts` — optional access to device contacts.
- `expo-camera` — scanning contact QR codes.
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

A device address-book entry can be linked to a Nostr identity, but ordinary phone numbers are not automatically convertible to `npub`.

Do not upload the device address book.

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

### Initial messaging features

- Private one-to-one conversations.
- Conversation list and previews.
- Sending and receiving text.
- Local message history.
- Timestamps and message grouping.
- Replying to messages.
- Copy and local delete.
- Search and unread counts.
- Loading, connection, and failure states.

Do not falsely display delivery or read receipts. Relay acknowledgment is not recipient delivery.

Group chats, media attachments, voice messages, and advanced synchronization are future features.

## 7. Calling Architecture

Calls use two separate mechanisms:

**Nostr:** An encrypted, authenticated call invitation and signaling channel.

**Trystero:** Peer connection establishment and WebRTC audio transport.

Only one-to-one audio calls are required initially.

### Calling sequence

1. The caller creates a random call ID and a high-entropy, one-time room secret.
2. The caller sends an encrypted call invitation through Nostr.
3. The recipient receives and validates the invitation while the application is active.
4. The recipient can answer or reject.
5. Upon acceptance, both devices establish the Trystero session.
6. The peers authenticate the relationship between their WebRTC session and their Nostr identities.
7. The audio stream starts.
8. Either peer can end the call.
9. All audio tracks, peer connections, subscriptions, and timers are cleaned up.

### Security requirements

Trystero and Nostr use different cryptographic identity systems.

A Trystero peer ID must **never** automatically be treated as proof of ownership of a Nostr public key.

An authenticated handshake must bind the call ID, expected Nostr identity, and the actual session peer/connection to a verified signature.

Do not accept an unknown participant merely because they know the room ID.

Treat signaling payloads as untrusted input. Validate their schemas, expiry, call IDs, and participants.

Call invitations must be short-lived, replay-resistant, and isolated per call.

### Call state machine

Use an explicit lifecycle:

`idle → outgoing/incoming → ringing → connecting → active → ended/failed`

Support cancellation and cleanup from every relevant state.

Handle timeouts, rejected calls, remote disconnects, denied microphone permissions, and failed direct connectivity.

### Background limitations

The initial version supports calls only while the application is running and sufficiently active to receive Nostr events.

Do not implement:

- Push notifications
- PushKit
- Firebase Cloud Messaging
- Background VoIP wake-up
- OS-level incoming call registration

No guaranteed incoming calls while the application is suspended or terminated.

### Network limitations

Prefer direct peer-to-peer connections.

Do not deploy proprietary STUN/TURN services.

Public STUN services may be used for ICE discovery. A TURN relay is not part of the initial architecture.

If direct connectivity cannot be established, fail gracefully and show a useful explanation.

Never claim that every pair of mobile networks can establish a direct connection.

## 8. Local Database

The initial schema should include:

| Table            | Responsibility                         |
| ---------------- | -------------------------------------- |
| `contacts`       | Local address book and metadata        |
| `conversations`  | Conversation summaries and local state |
| `messages`       | Persisted messages and Nostr event IDs |
| `call_history`   | Local call records                     |
| `relay_settings` | Relay configuration                    |
| `settings`       | Application preferences                |

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
- New contact / scan QR.
- Identity profile.
- Settings and relay configuration.

The dialer must work with real application identities. A numeric keypad must not imply interoperability with ordinary telephone numbers unless such an addressing system is actually implemented.

## 11. Privacy and Security

- Never log private keys, plaintext secrets, or decrypted message contents.
- Never expose private keys through URLs, analytics, crash reports, or navigation parameters.
- Never silently upload contacts.
- Validate every network-originated payload.
- Verify identity before trusting an incoming call.
- Do not embed private credentials in the application bundle.
- Require explicit permission only when a feature needs microphone, camera, or device contacts.
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
