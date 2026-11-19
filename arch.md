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
- `i18next` and `react-i18next` — bundled translation resources and typed React bindings.
- `expo-localization` — native locale configuration, RTL support, and device calendar preferences.
- `expo-local-authentication` — optional device authentication for App Lock.
- `expo-screen-capture` — operating-system app-switcher protection.
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

The Expo Router entry installs native secure randomness before NDK loads. The initial bundle includes the local messaging and call-control setup modules, so Boot can open the protected routes after local initialization. Relay subscriptions start after the gate opens. WebRTC, Trystero, and translation model work start when a feature needs them. Settings and the call and chat menus share the Identity & keys route for displaying the public address and QR code.

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

### Relay configuration and discovery

SQLite stores relay addresses, enabled state, and general, discovery, and inbox roles. On the first relay configuration startup, Boop seeds recommendations only when the table is empty. Existing addresses and enabled states survive migration. Previously enabled relays keep their original inbox and general roles. Removing the last entry does not cause defaults to reappear.

Defaults are `nos.lol` and `relay.primal.net` for general connections and private inboxes, plus `purplepag.es` for relay-list discovery. Public probes accepted and retrieved encrypted kind 1059 on both inbox defaults. Purple Pages accepted kind 10050 and rejected kind 1059. Relay policies and retention can change.

The existing NDK service keeps one pool. SQLite configuration changes add or remove the affected relay connections and inbox subscriptions. The relay screen reports socket state, authentication outcomes, and relay write acknowledgment when observed. NIP-65 kind 10002 author write relays can help discover an inbox list. The recipient's verified kind 10050 determines delivery destinations for private messages and call invitations. NIP-42 signs challenges on configured inbox connections. Trystero continues to use its independent signaling strategy.

A new identity can advertise its inbox automatically. Boop first checks for an existing signed kind 10050 and verifies each selected relay by publishing and reading back an expiring self-addressed encrypted envelope. An existing conflicting publication is preserved unless the user requests an inbox change. The app waits for a relay acknowledgment and reads the list back before recording the new publication. With at least one inbox still selected, it retains the previous published listeners during handoff and for three days after an acknowledged switch. Disabling every inbox stops local inbox listening and may leave previously published metadata visible.

### Chat persistence and presentation

- The protected application root starts one messaging lifecycle for its SQLite-pinned identity after migrations and the first App Lock unlock. Calls, Contacts, Settings, and Messages share it. Core NDK handles relay access. The runtime owns NIP-17 discovery, NIP-44 encryption, NIP-59 envelopes, signature verification, and the outbox. The current app supports one identity and refuses a mismatched signer.
- Each connected inbox relay sends historical and live events through the same subscription. End of stored events (EOSE) advances that identity and relay's checkpoint after queued writes succeed. A new relay initially requests its retained inbox. Later sessions overlap the previous checkpoint by three days to cover randomized envelope timestamps. On reconnect, a weekly audit looks back at least 30 days. Longer offline gaps retain the older checkpoint. Foreground reconnects back off to one probe per minute after the initial retry burst. Normal navigation keeps subscriptions open. Returning from OS background suspension reopens them and runs catch-up. Relay retention and refusal still limit recovery.
- Inbound envelopes enter one serial verification and persistence queue across relays. The queue yields between envelopes after a short work budget to leave time for input and rendering during catch-up. A bounded set skips recently handled outer envelope replays. SQLite deduplicates the inner rumor ID across different envelopes. One transaction inserts a message and updates conversation activity and unread state. The pending outbox preserves optimistic local IDs. Relay acknowledgment indicates acceptance by a relay.
- SQLite and Drizzle own messages, drafts, reactions, conversation flags, and read state. The root hydrates a compact conversation list with the latest indexed message and optional cached translation. Repository notifications run after commit and target summaries, the unread aggregate, or an affected peer's history. Summary and history refreshes coalesce bursts. SQLite change listeners cover contacts and translation settings and previews.
- Unread counts include muted and archived conversations and exclude deleted rows, outgoing copies, reactions, and call signals. The NativeTabs Messages badge subscribes to the persisted aggregate and displays up to `99+`. A focused, foreground, unlocked conversation clears only the unread message IDs that Chat Kit presents. Chat Kit opens at the first unread row when one exists and renders the unread separator.
- The session history loader keeps five recent pages of up to 50 messages. While the app is active and unlocked, the root refreshes up to three prefetch candidates as summaries change, with recently visited conversations ahead of recently active ones. Repeated refreshes keep the current timer. The foreground reader can reuse or fulfill a queued load. Relevant commits invalidate cached pages. Opening a chat needs only SQLite or a warm page. A small session cache remembers the previous reading position.
- History uses creation time and local ID as its cursor. Older rows prepend in 50-message pages. The displayed history caps at 300 rows and slides when the user pages beyond its edge. Chat Kit's AnimatedLegendList owns virtualization, scroll anchoring, and jump-to-message behavior. A quote outside the current window opens a page around its original message.
- Typed presentation adapters convert persisted rows into Chat Kit users, messages, quotes, reactions and conversation rows. `ChatList` presents conversations. `Chat` provides message rendering, composer, keyboard behavior, menus, and gestures. `ChatHeader` provides the detail header. Share the app's color and typography tokens through the library's appearance and theme APIs. Bubble timestamps use Chat Kit's separate metadata row so bidirectional or wrapped text cannot move into timestamp space.
- Shared edge-to-edge screens read the router's safe-area context when they render. The chat screen applies its top inset once before laying out ChatHeader and uses the root keyboard provider. Development diagnostics time local startup, recent page reads, and the first visible message rows without logging message content.
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

Group chats, media attachments, and voice messages are future features.

### On-device chat translation

Settings → Chats → Translation controls automatic translation, the target language, downloaded models, and the translation cache. SQLite saves the initial target from the resolved app language and keeps subsequent target choices independent. Automatic translation starts off. The translation catalog comes from the available native engine and extends beyond the two interface languages.

The typed bridge in `src/core/translation` uses `@hzblj/expo-translation` 0.1.4. Android uses ML Kit for language identification and translation. iOS uses Apple Natural Language for identification and explicitly selects ML Kit for translation. The Expo plugin bundles ML Kit on iOS for consistent language support, including Hebrew. A native development build is required. The optional ML Kit pods lack an arm64 Simulator slice. An iPhone build and runtime check still need verification.

Only explicit model requests can initiate downloads. The download dialog defaults to Wi-Fi and offers per-download cellular permission. The native SDK reports availability, completion, and failure. Users can remove downloaded models. English is built in. Translation works with installed models offline. Uncertain or unsupported language, mixed Hebrew and Latin text, technical identifiers, and missing models keep the original visible.

`message_translations` stores an ML Kit result keyed by canonical local message ID, SHA-256 of the original body, and target language. Each row also stores source language, engine revision, and creation time. A migration trigger removes translations when a message changes or is locally deleted. A foreign key cascades physical deletes. Writes compare the source body and live-message status in the same transaction. Clear Cache removes derived text and preserves downloaded models. The message and outbox tables retain the original.

Chat Kit's existing Legend List viewability callback schedules only visible incoming messages, capped at 32 rows per window. A single worker verifies the stored direction and original body in SQLite and runs native translation sequentially. Scrolling, backgrounding, App Lock, target changes, and navigation cancel stale work. The native package retains up to three model pairs. Chat Kit keeps stable message IDs and shows an original/translation toggle alongside the timestamp. Replies use the original and the composer sends the typed text. Conversation previews read the same cache for incoming messages and never schedule translation.

Message content and translated results stay on-device. Boop uses no translation endpoint, API key, or fallback proxy. Google's ML Kit SDK can contact Google for models, updates, and usage or performance metrics. Settings discloses the SDK behavior and includes the translation attribution. See [ML Kit privacy terms](https://developers.google.com/ml-kit/terms) and [on-device translation usage guidelines](https://developers.google.com/ml-kit/language/translation/translation-terms).

## 7. Calling architecture

Boop supports one call per device. Every call starts as a one-to-one audio call. An authenticated member can invite another identity from the active screen. New rooms allow six total participants, including the local device, and expand in place. The controller in `src/core/calling/controller.ts` owns the session and publishes its Zustand snapshot. Contacts, Recents, direct addresses, and Chat open the same call screen. The call indicator can reopen it after navigation. Setup requires an active app. Connected calls can continue in the background on supported devices.

### Private call control

`src/core/calling/signals.ts` defines relay signals for invite, ringing, accept, reject, cancel, busy, and setup termination. The wire name for setup termination is `call.end`. Each signal carries the call ID, both public keys, a nonce, a creation timestamp, and an expiration timestamp. Invites also carry a random room ID and a 256-bit room password. The maximum signal lifetime is 35 seconds.

The messaging service sends inner kind 24880 rumors through the existing NIP-17 inbox discovery and NIP-44/NIP-59 envelope code. The encrypted invitation includes up to three active inbox routes for its replies. The recipient uses them only after authenticating and validating the invitation. Inbox discovery handles invitations without usable reply routes and failed reply delivery. Setup signals for the same call and recipient share a short-lived discovery request and verified inbox result. A new relay connection waits for the socket's open event. Gift-wrap publication reports the first relay acknowledgment while other relay attempts can finish independently. The dispatcher verifies the outer event and seal, checks the inner event hash and signer, then validates the inner payload. Call events go to the call controller and make no chat rows or unread changes. Relay acknowledgment indicates relay acceptance. Only the peer's authenticated ringing signal starts ringback. Conference invitations carry the logical call ID, a distinct invitation ID, the inviter's current roster and the existing private room credentials. Responses include the invitation ID. Those relay messages negotiate the invitee's setup. Media and control between established participants remain on the direct channel.

### Direct media and identity

`src/core/calling/trystero.ts` uses Trystero 0.27's Nostr strategy with a stable application ID, separate signaling sockets, and a temporary identity. React Native WebRTC provides one direct connection per remote peer and one shared native microphone stream. Quick Crypto supplies WebCrypto. The adapter supplies the missing Promise and event registration APIs used by Trystero on React Native. The `expandable: 2` invitation capability selects the current connection proof RPC and six-seat configuration. A legacy incoming invitation keeps its original two-seat profile for the life of the room. New outgoing invitations require a client that understands the capability. There is no live room migration.

Each link challenges the other identity over the direct Trystero data channel. The signed Nostr proof binds the challenge, both identity keys, both Trystero peer IDs, the room and call IDs, and the actual WebRTC certificate fingerprints. The transport pins the verified connection and targets its microphone stream only after proof and admission. The caller attaches audio first on the initial link. Conference links order attachment by public key to avoid competing WebRTC offers. The controller starts elapsed time after the first link confirms audio in both directions.

An accepted call switches permanently to direct application control as soon as the transport verifies the peer. The controller ignores later relay control for that call. Hangup and microphone state use targeted Trystero actions. Connection status comes from the native peer connection. A disconnected data channel ends locally when recovery fails. Trystero can still use its own relay strategy internally. SQLite stores local call metadata only.

### Conference admission and presence

`src/core/calling/conference.ts` validates each seat reservation against the exact current authenticated roster, its inviter, the room's logical call ID, expiry, and the capacity. One pending seat per member keeps simultaneous attempts from overbooking any honest member. The inviter reserves that seat over direct RPC with every current member before publishing the invitation. The invitee's encrypted acceptance triggers direct grants to the reserving peers. The inviter opens its own access only after those grants succeed. The invitee verifies the inviter's identity before opening microphone audio to the other listed members. Each listed connection needs its own signed proof and can negotiate audio in parallel. After all listed links confirm audio, the invitee requests final admission from each link. An incomplete admission closes the invitee's links. A reservation can be revoked or expire and a peer applying it checks that its issuer is still present. A roster change or partial grant can cause an invitation to fail. The mesh has no durable consensus service or permanent owner. Peers that have authenticated and completed admission can continue once the original inviter leaves.

Presence follows ready authenticated Trystero links. Each member publishes its own microphone setting through targeted direct messages, including to new peers. Received audio tracks can be disabled locally or set to one of three gains using the installed native WebRTC track API. Speaking highlights use inbound audio-level statistics when native WebRTC supplies them. Membership changes affect the relevant connections and the same call screen, duration, system audio lease, and history row remain in use. The history migration adds verified participant keys and recent invitation IDs to the logical call record. Retries use a fresh invitation ID and update the same history row. Legacy history remains readable.

### Camera sharing

`src/core/calling/video.ts` owns camera and consent state for the authenticated session. A local camera tap requests OS permission and opens a native preview. A targeted version 1 Trystero RPC carries the call ID and a monotonically increasing camera attempt number. A matching approval permits the sender to attach the track. A stop action invalidates that attempt, and the receiver rejects duplicate offers and stale approvals. Consent requests expire after 30 seconds.

The receiving user can deny video, approve video for the current call, or save approval for a verified contact. The contact row stores the permanent decision under the peer's Nostr public key. Contact Details can change that preference. Incoming requests and approvals never open the recipient's camera.

Camera capture uses React Native WebRTC at a target of 640 × 480 and 24 frames per second. The camera stream carries matching call and attempt metadata. The authenticated peer receives it in the existing room and connection. The caller coordinates bounded turns for track changes to avoid simultaneous SDP offers. Trystero manages the offer and answer. Camera stop disables capture immediately and removes the stream through Trystero. Front and rear camera switching applies constraints to the existing track. The native transport binding is in `src/core/calling/trystero-video.ts`.

The receiver displays video after the native receiver reports decoded frames. A direct acknowledgment confirms that the sender's video reached the receiver. A stalled video feed leaves the stage while audio can continue. The call screen shows one feed fullscreen or shows the remote feed with a draggable local preview by default. Tapping the preview swaps the feeds. Stage choice and preview corner live in the call session. Video overlays hide after inactivity and stay visible during dialogs, errors, or screen-reader use.

The initial pair uses the one-to-one camera consent flow. On expansion, the app stops the previous camera sharing and asks users to enable their cameras for the conference. `conference-video.ts` captures a single camera and announces availability over authenticated direct actions. Watch grants consent for that viewer and sends a targeted RPC with the camera generation and watch token. Only that peer receives the stream, and the receiver checks the token before rendering decoded frames. Stop Watching removes that peer's stream. The subscription is scoped to the authenticated connection, so it can survive JS timer suspension in system PiP. Stop Watching retries over the direct channel. Camera stop and peer departure release the corresponding media. Each link serializes media changes independently. Saved Always Allow preferences apply to one-to-one requests. Conferencing requires explicit Watch, with up to four watched feeds. The existing call route presents the audio avatar grid, participant picker and roster, video Focus View with a filmstrip, and Grid View. Display changes reuse the existing tracks and issue no media signaling. System PiP uses the focused watched remote feed, or another watched feed if that one disappears. It does not subscribe on the user's behalf.

The fullscreen stage uses `RTCView`. iOS also uses `RTCView` for the floating preview. Android's `RTCView` uses a separately composited `SurfaceView`. The local Expo module in `modules/boop-camera-preview` uses a `TextureView` to clip floating video to its rounded outline. It attaches a renderer to the existing WebRTC track and shares the library's EGL context. The module uses React Native WebRTC 155's package-level stream lookup and executor. Verify these two interfaces when upgrading WebRTC. Android development clients need a native rebuild to include the module.

### Lifecycle and audio

The controller tracks calling, ringing, incoming, connecting, connected, and terminal states. It bounds waits, ignores late responses, and suppresses duplicate and reordered invitations within their validity window. When both people call at the same time, the lower public key keeps its outgoing call. The other client takes the incoming call. Navigation and system presentation changes preserve a connected session.

`src/core/calling/native-audio.ts` owns ringtone and ringback. Android uses Core-Telecom for active audio focus and route selection, including speaker and available wired and Bluetooth endpoints. A device where registration fails uses the existing InCallManager foreground audio path. iOS uses the existing InCallManager play-and-record voice chat session with native WebRTC capture and playback. AVAudioSession manages accessory routing. Muting disables the actual local audio tracks.

Hangup stops local capture and sends an authenticated notice to current peers over the data channel. Remaining peers remove the departing member and retain their other connections. Losing the last live link ends local participation. Terminal cleanup aborts pending invitations and camera operations, dismisses consent, stops tracks and tones, leaves the room, and releases the audio session. SQLite stores one final history entry per call ID with start, answer, end, outcome, and connected duration.

### Background and network limits

Clients must be open and able to reach a compatible inbox relay during call setup. Suspended and terminated clients have no call wake-up mechanism. A terminated process cannot recover an existing call. Direct ICE uses Trystero's supported recovery and public STUN. Networks that require a TURN relay can fail to connect. A full six-person mesh has five links per device. Upload scales with the number of audio peers and video viewers. There is no SFU. A peer whose connection has left the authenticated roster needs another invitation to join again.

Backgrounding stops inbox subscriptions and cancels unfinished calls, with an exception while the app owns its microphone permission prompt. Connected audio continues after Home or lock where the platform permits it. Boop stops outgoing camera capture on backgrounding, tells the peer over the existing direct data channel, and shows why camera sharing stopped on return. The user can restart the camera from the call screen. A video offer received while backgrounded requires foreground confirmation unless the verified contact has a saved Always Allow policy. A pending request can expire while the user is away.

#### Android ongoing calls and system PiP

The local Expo module in `modules/boop-camera-preview` shares the existing WebRTC TextureView renderer with the Android system call integration. `plugins/with-system-calling.js` supplies manifest permissions and Activity PiP callbacks through Expo Continuous Native Generation. AndroidX Core-Telecom 1.1 registers a self-managed call after peer authentication and microphone authorization. The app starts a `phoneCall|microphone` foreground service while visible, then starts media capture. Available route and current route changes come from Telecom. Boop supports this integration on Android 8 and later.

The service posts one AndroidX CallStyle notification for the lifetime of the native registration. It uses an existing cached avatar for a one-to-one call and starts its chronometer at the controller's connected timestamp. A conference updates that notification with the localized group title and count. App Lock keeps its identity and roster private. The Open intent queues the matching call route through App Lock. Hang Up is an immutable broadcast scoped to the current call ID and invokes the normal direct hangup and teardown. Notification and service lifetimes end with the controller's media lease. Android 16 and later may promote the same notification when system and OEM policy allow it. Core 1.17 supplies CallStyle and the promotion API and matches the Expo SDK dependency baseline.

System PiP uses stable Android framework APIs. Core PiP alpha04 can consolidate activity callbacks and add a fallback for some navigation gestures. Automatic entry, the source rectangle, and transition callbacks are available through the platform for Boop's single Activity. The module uses those APIs directly. PiP eligibility requires authenticated, authorized, decoded remote video and a connected native call. The PiP layer draws only that remote track using the existing decoder. On Android 12 and later, eligible calls allow automatic entry. On older PiP-capable devices the user-leave callback requests entry. Closing PiP or losing the last remote frames removes its presentation. Android may finish the Activity when closing PiP. The foreground service and controller preserve audio and the call can be reopened from the notification.

#### iOS background audio and system PiP

The config plugin enables the `audio` background mode for the existing AVAudioSession voice-call policy. The in-call screen opts the remote `RTCView` into react-native-webrtc's native AVKit video-call PiP on iOS 15 and later. The installed renderer attaches directly to the remote `RTCVideoTrack` and displays native frames through `AVSampleBufferDisplayLayer`. The remote view automatically requests PiP when leaving the fullscreen call and restores its inline presentation on foreground. Availability, restoration, lock-screen audio, and native interruption behavior require iPhone verification. Navigating away from the inline remote view on iOS removes its PiP entry point.

## 8. Local Database

The initial schema should include:

| Table                  | Responsibility                                                       |
| ---------------------- | -------------------------------------------------------------------- |
| `contacts`             | Local address book and metadata                                      |
| `conversations`        | Conversation summaries and local state                               |
| `messages`             | Persisted messages and Nostr event IDs                               |
| `message_reactions`    | Private reaction records and local removal state                     |
| `message_translations` | Device-local translations keyed by message, content hash, and target |
| `call_history`         | Local call records                                                   |
| `relay_settings`       | Relay configuration                                                  |
| `settings`             | Application preferences                                              |

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
- Settings with a native nested stack for Identity & keys, Chats, Appearance, Language, Calls & sounds, Privacy & security, Connections, and About. Chats contains Translation. Privacy & security contains App Lock, Device permissions, and Incoming video. Connections manages Nostr relays.

The dialer must work with real application identities. A numeric keypad must not imply interoperability with ordinary telephone numbers unless such an addressing system is actually implemented.

### Language and layout direction

The app supports English and Hebrew. Settings → Language lists Auto-detect first, then English and Hebrew. SQLite stores the user's choice. Auto-detect is the default when no supported choice is saved. It uses the primary locale reported by Expo Localization and falls back to English for unsupported languages. Startup resolves the language before the router and App Lock content mount.

`src/i18n` owns the single i18next instance, initialized with react-i18next and bundled English and Hebrew resources. Namespaces cover common controls, navigation, contacts, messages, calls, video, settings, security, connections, errors, and Chat Kit. The English bundle defines the TypeScript keys and interpolation parameters. Translation tests check shape, placeholders, and locale-specific plural forms.

The selected language determines content and Expo Router `LocaleProvider` direction. React Native needs a reload when its native layout direction changes. Settings confirms the change before saving. The root defers a requested reload until the app is active, unlocked, and any call has ended. Startup bounds automatic direction repair to one attempt per preference. Expo Localization declares both native locales and enables RTL support. OS-owned UI such as system permission buttons follows the platform's language.

The Chat Kit adapter supplies locale and typed label overrides from the same resources to the list, header, and conversation. The detail view opts into Chat Kit's RTL handling and mirrors its reply gesture. Day.js provides the library's localized calendar labels. App dates and durations use the shared formatting helpers. The call list honors the device's hour-cycle preference. Keep user content, keys, and relay URLs unchanged. Use bidirectional isolation for identifiers interpolated into localized copy and LTR text styles for technical input.

Translate stable service errors at the presentation boundary. Android's system call bridge takes app-owned notification labels from the active i18next language at call start. Expo prebuild supplies English and Hebrew iOS permission descriptions for the native localizations. Glassy UI reads theme and accessibility from its single root provider. The app's saved theme remains the source for that provider.

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

### App Lock

The root checks the SQLite App Lock policy before mounting protected routes or starting inbox subscriptions on a fresh launch. App Lock is off by default. Enabling, disabling, and unlocking each require the native authentication prompt. Android uses Class 3 biometrics and supports device credentials where Android permits the combined policy. iOS uses device-owner authentication with the configured Face ID usage description and system fallback.

The lock controller tracks foreground transitions and supports immediate, one-minute, five-minute, and thirty-minute timeouts. A solid lock screen covers the router and hides its accessibility tree while locked or inactive. It opens the system prompt once per lock, with a centered Unlock action for retry after cancellation. Native app-switcher protection adds an iOS privacy blur. Android blocks window capture while App Lock is enabled. Warm deep links are dropped while protected content is obscured. The gate retains the mounted navigation and call controller after first unlock. An ongoing audio call can continue under the gate. App Lock disables system video PiP and uses a generic identity in the Android notification. Opening the notification restores the call screen after unlock.

App Lock controls access through the app interface. SecureStore still owns private key storage under the same key and accessibility policy. Biometric changes do not change the stored key. App Lock leaves the local database encryption policy unchanged. Boop has no private-key viewing or export route.

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
