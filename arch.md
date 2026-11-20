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
- Android 12 (API 31) and later, and iOS.

Use the actual installed SDK and official compatibility documentation when installing packages.

Use Expo Development Builds for native WebRTC integration. Expo Go is not sufficient for the complete application.

Prefer Expo Continuous Native Generation and config plugins over manually maintaining native projects.

Do not introduce Node.js-only dependencies into the React Native runtime without verifying their compatibility.

## 4. Technology Stack

### Navigation and native UI

| Package                | Responsibility                                   |
| ---------------------- | ------------------------------------------------ |
| `expo-router`          | File-based navigation, stacks, and headless tabs |
| `@expo/ui`             | Native SwiftUI and Jetpack Compose components    |
| `expo-glass-effect`    | System Liquid Glass on supported iOS versions    |
| `expo-blur`            | Cross-platform glass fallbacks                   |
| `expo-symbols`         | Native platform symbols                          |
| `expo-linear-gradient` | Backgrounds and subtle visual layers             |

The protected tab layout uses `expo-router/ui` with `expo-glass-tabs` for Calls, Messages, Contacts, and Profile. Inactive screens stay mounted. The dock uses native glass where available and a solid fallback elsewhere. It moves one indicator on the UI thread and navigates on tap or scrub release. In Hebrew the visual order and physical index mapping reverse together. Calls can minimize the dock on scroll. Messages keeps Chat Kit’s reorder scroll handler. App Lock, the shared messaging runtime, and the ongoing-call indicator live above the tab navigator. Chat, request, call, and settings detail routes are outside the dock.

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
| `@trystero-p2p/core`                  | P2P connections, data channels, and media         |
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

Use Bun 1.4.4 or later for `bun fmt`. Run `bun run check` to check formatting, Expo lint, and TypeScript.

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

The existing NDK service keeps one pool. SQLite configuration changes add or remove the affected relay connections and inbox subscriptions. The relay screen reports socket state, authentication outcomes, and relay write acknowledgment when observed. NIP-65 kind 10002 author write relays can help discover an inbox list. The recipient's verified kind 10050 determines delivery destinations for private messages and call invitations. NIP-42 signs challenges on configured inbox connections. Boop routes Trystero setup messages through the same NDK pool and authenticated inbox pipeline.

A new identity can advertise its inbox automatically. Boop first checks for an existing signed kind 10050 and verifies each selected relay by publishing and reading back an expiring self-addressed encrypted envelope. An existing conflicting publication is preserved unless the user requests an inbox change. The app waits for a relay acknowledgment and reads the list back before recording the new publication. With at least one inbox still selected, it retains the previous published listeners during handoff and for three days after an acknowledged switch. Disabling every inbox stops local inbox listening and may leave previously published metadata visible.

### Chat persistence and presentation

- The protected application root starts one messaging lifecycle for its SQLite-pinned identity after migrations and the first App Lock unlock. Calls, Contacts, Settings, and Messages share it. Core NDK handles relay access. The runtime owns NIP-17 discovery, NIP-44 encryption, NIP-59 envelopes, signature verification, and the outbox. The current app supports one identity and refuses a mismatched signer.
- Each connected inbox relay sends historical and live events through the same subscription. End of stored events (EOSE) advances that identity and relay's checkpoint after queued writes succeed. A new relay initially requests its retained inbox. Later sessions overlap the previous checkpoint by three days to cover randomized envelope timestamps. On reconnect, a weekly audit looks back at least 30 days. Longer offline gaps retain the older checkpoint. Foreground reconnects back off to one probe per minute after the initial retry burst. Normal navigation keeps subscriptions open. Returning from OS background suspension reopens them and runs catch-up. Relay retention and refusal still limit recovery.
- Inbound envelopes enter one serial verification and persistence queue across relays. The queue yields between envelopes after a short work budget to leave time for input and rendering during catch-up. A relay marks subsequent envelopes as live after EOSE, and the queue serves up to four live envelopes before one stored envelope. Catch-up checkpoints still wait for all work already queued at EOSE. Call acknowledgments and ordinary live messages get the same priority without an outer call marker. A bounded set skips recently handled outer envelope replays. SQLite deduplicates the inner rumor ID across different envelopes. One transaction inserts a message and updates conversation activity and unread state. The pending outbox preserves optimistic local IDs. Relay acknowledgment indicates acceptance by a relay.
- SQLite and Drizzle own messages, drafts, reactions, conversation flags, and read state. The root hydrates a compact conversation list with the latest indexed message and optional cached translation. Repository notifications run after commit and target summaries, the unread aggregate, or an affected peer's history. Summary and history refreshes coalesce bursts. SQLite change listeners cover contacts and translation settings and previews.
- Unread counts include muted and archived conversations and exclude deleted rows, outgoing copies, reactions, call signals, blocked peers, and pending requests. The glass dock’s Messages badge subscribes to the persisted aggregate and displays up to `99+`. A focused, foreground, unlocked conversation clears only the unread message IDs that Chat Kit presents. Chat Kit opens at the first unread row when one exists and renders the unread separator.

### Communication privacy and requests

Privacy & Security owns the Chats and Message Requests switches. With Chats off, the protected session stops the conversation feed, outbox, and time-lock scheduler. Chat routes and translation settings are disabled. The shared relay inbox keeps a live-only subscription for call signaling. The encrypted envelope carries no public message type, so the client still opens live envelopes to identify calls and discards other rumors. The chat checkpoint stays at its last successful catch-up. Re-enabling resumes catch-up and pending sends. Recovery depends on relay retention.

The protected session owns one policy service. SQLite stores `blocked_identities`, `communication_grants`, `message_requests`, and privacy preferences. A verified kind 13 Seal gives the first authenticated sender key in NIP-17. The inbox tests its in-memory blocked set at that boundary, before decrypting the Rumor, and rechecks the peer at dispatch to cover queued work and self-authored copies. Relays still deliver the encrypted kind 1059 envelope and can observe transport metadata. This is local enforcement, not relay-level blocking.

Calls default to Everyone. Contacts limits new invitations to saved public keys; Nobody drops all new invitations. Neither setting ends an existing call. Blocking prevents outbound messages and invitations, filters late signaling, rejects conference reservations and peer admission, and closes the local session if a blocked participant is already connected. Boop leaves the entire local room instead of assuming it can safely remove someone from another participant’s mesh. Message grants never authorize calls or video.

Messages default to Everyone with requests off. With requests on, new unknown senders enter Requests; previously received history remains established in Everyone. Contacts allows saved contacts and explicitly approved or locally initiated relationships, with other senders routed to Requests only if enabled. Initiated Only accepts identities with successful local outbound delivery or an answered, completed outbound call; contact membership and request approval alone do not qualify. Migration backfills local `sent` rows and completed or answered outbound call records, not sender-copy `synced` rows or inbound history. SQLite grants delivery authorization in the same statement as the outbox status change.

Each pending peer can retain up to 16 distinct messages and 20,000 JSON characters, with at most 64 pending peers. Existing single-message records remain readable. Messages shows the Pending Requests row only when at least one sender is pending. The separate list opens read-only Chat Kit conversations with Accept and Block. Pending data stays out of regular chat history, unread, translation, and the time-lock scheduler. Accept records approval and promotes the retained original messages and time-lock metadata in one transaction. The shared inbox queue handles one short best-effort replay against connected inboxes. NIP-17 outer events cannot be queried by actual sender, so some discarded events may not be recoverable. Existing decline cutoffs still suppress old replays. Strict mode pauses existing approvals in the request UI and rejects new unauthorized senders. Blocking removes requests, retains previous chat history, and suspends the peer’s contributions to unread and automatic processing until unblocked.

- The session history loader keeps five recent pages of up to 50 messages. While the app is active and unlocked, the root refreshes up to three prefetch candidates as summaries change, with recently visited conversations ahead of recently active ones. Repeated refreshes keep the current timer. The foreground reader can reuse or fulfill a queued load. Relevant commits invalidate cached pages. Opening a chat needs only SQLite or a warm page. A small session cache remembers the previous reading position.
- History uses creation time and local ID as its cursor. Older rows prepend in 50-message pages. The displayed history caps at 300 rows and slides when the user pages beyond its edge. Chat Kit's AnimatedLegendList owns virtualization, scroll anchoring, and jump-to-message behavior. A quote outside the current window opens a page around its original message.
- Typed presentation adapters convert persisted rows into Chat Kit users, messages, quotes, reactions and conversation rows. `ChatList` presents conversations. `Chat` provides message rendering, composer, keyboard behavior, menus, and gestures. `ChatHeader` provides the detail header. Share the app's color and typography tokens through the library's appearance and theme APIs. Bubble timestamps use Chat Kit's separate metadata row so bidirectional or wrapped text cannot move into timestamp space.
- Shared edge-to-edge screens read the router's safe-area context when they render. The chat screen applies its top inset once before laying out ChatHeader and uses the root keyboard provider. Short histories stay aligned to the top while the keyboard moves the composer. Development diagnostics time local startup, recent page reads, and the first visible message rows without logging message content.
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

### Special messages and Open Later

Open Later is the first Special Message. Long-press the existing Chat Kit Send button to open an anchored Glassy UI menu. The Glass Sheet shows the selected local time and the exact Quicknet round time when they differ. Android uses consecutive date and time dialogs. iOS uses an inline date and time picker. The composer retains the draft and quote until the outgoing SQLite transaction succeeds.

Boop encrypts the UTF-8 text on the device with the `tlock-js` 1.0.0 implementation from upstream PR #52 of AGE and drand identity-based encryption. The app sends the resulting ciphertext immediately through the existing outbox. It sends a kind `24881` unsigned rumor inside the same kind `13` NIP-44 seal and kind `1059` NIP-59 gift wrap used for private chat. Recipient and sender copies independently wrap the same rumor ID. The usual inner `p` and optional reply `e` tags apply. The version 1 JSON content has `type: "timelock"`, `v: 1`, `ciphertext`, `chainHash`, `unlockRound`, `requestedAt`, and `roundTime`. The ciphertext is one armored AGE file with a single `tlock` recipient. Zod and the AGE header parser check the field bounds, schedule, and embedded chain and round before the inbox accepts it. Boop accepts up to 4,000 UTF-16 code units, 17,000 characters of armor, 18,000 characters of encoded content, and 48,000 bytes per serialized gift wrap for this kind.

The production Quicknet chain uses hash `52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971`, scheme `bls-unchained-g1-rfc9380`, 3-second periods, and genesis `1692803367` Unix seconds. Its pinned public key is `83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a`. Schedule fields use UTC epoch milliseconds. The client starts at `roundAt(requestedAt)` and advances one round if its publication time precedes the requested time. The round ID determines the cryptographic release.

`drand-client` 1.4.2 verifies the exact round and signature against the pinned chain. The HTTP adapter uses Quicknet's v1 `/{chainHash}/public/{round}` endpoint with deadlines and fallbacks across `api.drand.sh`, `api2.drand.sh`, `api3.drand.sh`, and `drand.cloudflare.com`. Encryption uses the pinned info without an HTTP request. The ESM tlock-js build uses Boop's existing secure WebCrypto randomness and the same drand-client version. Boop checks the AGE stanza before persistence and passes a beacon that drand-client has verified to tlock-js. The library independently verifies the prefetched signature against the pinned chain and round before decrypting.

The Bun lockfile pins `vendor/tlock-js-1.0.0-pr52-b311ee2.tgz`. The package was built from commit `b311ee25c26dcf86f347049e37d05fed0394889e` in the PR author's fork. To build that package, check out the commit and run `bun install --frozen-lockfile`, `bun run build`, and `bun pm pack --ignore-scripts`. The checked-in archive has SHA-256 `25fd6819942da96832adc8c6470e2c253783e7c6d8b1c0bd96e5082adf0b159d`. [tlock-js PR #52](https://github.com/drand/tlock-js/pull/52)

SQLite keeps one canonical `messages` row and one related `message_timelocks` row. The related row holds ciphertext, metadata, retry time, failure, and opening state. A successful unlock writes the plaintext to `messages.body` and marks the matching ciphertext opened in one transaction. The row keeps its ID and original position. The scheduler excludes opened rows and later reads use the persisted body. Local deletion removes the ciphertext and plaintext and retains the usual deduplication tombstone.

One scheduler runs in the protected, foreground messaging session. It reads an index for the next pending retry and processes bounded batches. It shares verified beacons across messages and keeps up to 32 in memory and 32 in SQLite. It verifies a stored beacon again on cold read. Foreground resume and relay reconnection reconcile pending work. Temporary failures use backoff and can be retried from the message menu. Permanently invalid payloads retain their ciphertext for local deletion. After the scheduled time, a device without internet can open a message if its verified beacon is cached. Otherwise the message waits for network access. Suspended and terminated apps reconcile on the next foreground session.

Chat Kit displays a locked bubble in the same history row. Conversation and reply previews use localized locked labels. A locked incoming message remains unread until it has opened and its row is visible in a focused, foreground, unlocked chat. Link previews, copy, and on-device translation receive no sealed text or ciphertext. After unlock, the stored body can enter the existing visible-message translation pipeline. Both sender and recipient display the sealed state until the beacon is verified. The sender already knows the original text, and a restored sender copy follows the same unlock rule.

The drand threshold operators can undermine delayed opening if they collude or disclose future beacon material. Delayed publication or network shutdown can prevent timely decryption. The scheme has no post-quantum guarantee. Anyone holding the AGE ciphertext can open it after release. The existing Nostr encryption limits access to that ciphertext to the recipient and the sender's copy. Cached plaintext follows Boop's local message storage protections.

The deterministic tests in `tests/timelock.test.ts` verify a Go-generated Quicknet fixture and invalid beacon cases. `bun scripts/test-chat-relay.ts --timelock` exercises delivery and catch-up through an authenticated loopback relay with a live Quicknet round. [drand timelock documentation](https://docs.drand.love/docs/timelock-encryption/) · [tlock-js](https://github.com/drand/tlock-js) · [tlock Go](https://github.com/drand/tlock) · [drand-client](https://github.com/drand/drand-client)

### On-device chat translation

Settings → Chats → Translation controls automatic translation, the target language, downloaded models, and the translation cache. SQLite saves the initial target from the resolved app language and keeps subsequent target choices independent. Automatic translation starts off. The translation catalog comes from the available native engine and extends beyond the two interface languages.

The typed bridge in `src/core/translation` uses `@hzblj/expo-translation` 0.1.4. Android uses ML Kit for language identification and translation. iOS uses Apple Natural Language for identification and explicitly selects ML Kit for translation. The Expo plugin bundles ML Kit on iOS for consistent language support, including Hebrew. A native development build is required. The optional ML Kit pods lack an arm64 Simulator slice. An iPhone build and runtime check still need verification.

Only explicit model requests can initiate downloads. The download dialog defaults to Wi-Fi and offers per-download cellular permission. The native SDK reports availability, completion, and failure. Users can remove downloaded models. English is built in. Translation works with installed models offline. Uncertain or unsupported language, mixed Hebrew and Latin text, technical identifiers, and missing models keep the original visible.

`message_translations` stores an ML Kit result keyed by canonical local message ID, SHA-256 of the original body, and target language. Each row also stores source language, engine revision, and creation time. A migration trigger removes translations when a message changes or is locally deleted. A foreign key cascades physical deletes. Writes compare the source body and live-message status in the same transaction. Clear Cache removes derived text and preserves downloaded models. The message and outbox tables retain the original.

Chat Kit's existing Legend List viewability callback schedules only visible incoming messages, capped at 32 rows per window. A single worker verifies the stored direction and original body in SQLite and runs native translation sequentially. Scrolling, backgrounding, App Lock, target changes, and navigation cancel stale work. The native package retains up to three model pairs. Chat Kit keeps stable message IDs and shows an original/translation toggle alongside the timestamp. Replies use the original and the composer sends the typed text. Conversation previews read the same cache for incoming messages and never schedule translation.

Message content and translated results stay on-device. Boop uses no translation endpoint, API key, or fallback proxy. Google's ML Kit SDK can contact Google for models, updates, and usage or performance metrics. Settings discloses the SDK behavior and includes the translation attribution. See [ML Kit privacy terms](https://developers.google.com/ml-kit/terms) and [on-device translation usage guidelines](https://developers.google.com/ml-kit/language/translation/translation-terms).

## 7. Calling architecture

Boop supports one call per device. Every call starts as a one-to-one audio call. An authenticated member can invite another identity from the active screen. New rooms allow six total participants, including the local device, and expand in place. The controller in `src/core/calling/controller.ts` owns the session and publishes its Zustand snapshot. Contacts, Recents, direct addresses, and Chat open the same call screen. The call indicator can reopen it after navigation. Setup requires an active app. Connected calls can continue in the background on supported devices.

### Direct call signaling

Boop's controller sends encrypted invites, ringing acknowledgments, acceptances, rejections, cancellations, busy responses, and setup ends through the existing NDK client. The application-specific kind 24880 rumor stays inside the recipient's NIP-44/NIP-59 envelope. Call signals carry both Nostr keys, a call ID, a nonce, and a maximum lifetime of 35 seconds. They create no chat rows or unread changes. Only a valid ringing acknowledgment starts ringback. The caller enters private setup as soon as the recipient's authenticated acceptance arrives.

While recipient inbox lookup runs, `direct-signaling.ts` opens a passive Trystero Core room and leases an offer for the specific invitee. The invite delivers that encrypted SDP, its offer ID, and the caller's Trystero endpoint. An incoming call leaves its microphone and connection unopened until Answer. Answer publishes the acceptance and starts applying the prepared offer concurrently. The callee's RTC answer returns through the same NDK inbox. The adapter matches its verified Nostr sender, call, invitation, and offer ID before passing the original in-memory peer handle to Core. Unused leases are reclaimed on cancellation or room teardown.

The custom strategy uses `createStrategy` with targeted messages and no room announcements. `call.rtc` carries an offer, an answer, or a bounded batch of encrypted ICE candidates. A scoped setup record pins the remote endpoint to the authenticated Nostr key. Early candidates wait for a matching endpoint and offer. The adapter deduplicates candidates, caps the per-link queues, and retries unsuccessful publication within the setup deadline. Once identity is verified, the link retires that setup generation. Calls share NDK connections and require no Trystero relay sockets. Encrypted invites and RTC messages carry up to three connected inbox endpoints for reply routing. Existing kind 10050 discovery is the fallback. The first relay acknowledgment lets publishing proceed while redundant sends finish independently.

### WebRTC and media

The secret room identifier has 256 bits of secure randomness and travels only in encrypted invitations. Trystero Core derives its AES-GCM room key from this capability using its no-password SHA-256 path. The room capability limits access to encrypted signaling. Admission also requires the intended Nostr key and proof of the actual native connection. Trystero keeps its temporary identity handshake. Boop's signed challenge binds the authenticated endpoint and both identities to the call, room, and actual negotiated DTLS fingerprints. Keeping both checks prevents a peer with the room secret alone from gaining media access.

The lockfile pins Trystero Core 0.27.0. Its Bun patch exposes encrypted candidate callbacks for leased offers and hooks to configure the initial native peer and answer. It also waits for both native SDP descriptions before starting the identity handshake. Android can report the data channel open before React Native WebRTC has made those descriptions available. The offer reserves a bidirectional audio transceiver. The answer selects the same audio direction before generating its SDP. These steps open no capture devices. Boop checks microphone authorization during connection setup and starts native audio and one microphone capture after acceptance and identity proof. Each authorized link attaches the shared microphone with the prepared sender's `replaceTrack()`, checks native attachment, and acknowledges media readiness over its direct channel. Camera consent and its existing targeted Trystero stream renegotiation remain separate.

The controller permanently switches that call's application control to direct Trystero actions after peer authentication. Hangup, mute, consent, admission, and media readiness stay on those actions. Development timings use each device's monotonic clock. Logs contain stage names, state, packet counts, ICE candidate types, and aggregate quality measurements. They leave SDP, endpoint addresses, room capabilities, and keys out.

### Conference admission and presence

`src/core/calling/conference.ts` validates each seat reservation against the exact current authenticated roster, its inviter, the room's logical call ID, expiry, and the capacity. One pending seat per member keeps simultaneous attempts from overbooking any honest member. The inviter reserves that seat over direct RPC with every current member before publishing the invitation. The invitee's encrypted acceptance triggers direct grants to the reserving peers. The inviter opens its own access only after those grants succeed. The invitee verifies the inviter's identity before opening microphone audio to the other listed members. After the inviter is authenticated, the invitee leases and sends a targeted offer to each other authorized member. Each link still needs its own signed proof. The same microphone can attach to those links in parallel. After all listed links confirm audio, the invitee requests final admission from each link. An incomplete admission closes the invitee's links. A reservation can be revoked or expire and a peer applying it checks that its issuer is still present. A roster change or partial grant can cause an invitation to fail. The mesh has no durable consensus service or permanent owner. Peers that have authenticated and completed admission can continue once the original inviter leaves.

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

Hangup stops local capture and sends an authenticated notice to current peers over the data channel. Remaining peers remove the departing member and retain their other connections. When the last link is lost, the controller holds the existing session during the bounded recovery window. Terminal cleanup aborts pending invitations and camera operations, dismisses consent, stops tracks and tones, leaves the room, and releases the audio session. SQLite stores one final history entry per call ID with start, answer, end, outcome, and connected duration.

### Background and network limits

Clients must be open and able to reach a compatible inbox relay during call setup. Suspended and terminated clients have no call wake-up mechanism. A terminated process cannot recover an existing call. Direct ICE uses public STUN. A transient disconnect can request an ICE restart while Trystero can still exchange negotiation messages on the existing data channel. A previously active link that stays disconnected or checking for eight seconds closes so recovery can proceed. If a connection closes without an authenticated hangup, the room can hold the previously authenticated participant for up to 18 seconds. The lower Nostr key leases a replacement connection and sends only encrypted RTC recovery signals over NDK. A live connection ignores replacement offers. Recovery requires a new offer ID and signed proof against the replacement connection before it reattaches the current microphone. The room, system audio lease, and call timer continue. Recovery needs both applications to be running and their inboxes reachable. Networks that require a TURN relay can fail to connect. A full six-person mesh has five links per device. Upload scales with the number of audio peers and video viewers. There is no SFU. A participant whose recovery window has expired needs a new invitation.

Backgrounding stops inbox subscriptions and cancels unfinished calls, with an exception while the app owns its microphone permission prompt. Connected audio continues after Home or lock where the platform permits it. Boop stops outgoing camera capture on backgrounding, tells the peer over the existing direct data channel, and shows why camera sharing stopped on return. The user can restart the camera from the call screen. A video offer received while backgrounded requires foreground confirmation unless the verified contact has a saved Always Allow policy. A pending request can expire while the user is away.

#### Android ongoing calls and system PiP

The local Expo module in `modules/boop-camera-preview` shares the existing WebRTC TextureView renderer with the Android system call integration. `plugins/with-system-calling.js` supplies manifest permissions and Activity PiP callbacks through Expo Continuous Native Generation. AndroidX Core-Telecom 1.1 registers a self-managed call after peer authentication and microphone authorization. The app starts a `phoneCall|microphone` foreground service while visible, then starts media capture. Available route and current route changes come from Telecom.

The service posts one AndroidX CallStyle notification for the lifetime of the native registration. It uses an existing cached avatar for a one-to-one call and starts its chronometer at the controller's connected timestamp. A conference updates that notification with the localized group title and count. App Lock keeps its identity and roster private. The Open intent queues the matching call route through App Lock. Hang Up is an immutable broadcast scoped to the current call ID and invokes the normal direct hangup and teardown. Notification and service lifetimes end with the controller's media lease. Android 16 and later may promote the same notification when system and OEM policy allow it. Core 1.17 supplies CallStyle and the promotion API and matches the Expo SDK dependency baseline.

System PiP uses stable Android framework APIs. Core PiP alpha04 can consolidate activity callbacks and add a fallback for some navigation gestures. Automatic entry, the source rectangle, and transition callbacks are available through the platform for Boop's single Activity. The module uses those APIs directly. PiP eligibility requires authenticated, authorized, decoded remote video and a connected native call. The PiP layer draws only that remote track using the existing decoder. Eligible calls on PiP-capable devices allow automatic entry. Closing PiP or losing the last remote frames removes its presentation. Android may finish the Activity when closing PiP. The foreground service and controller preserve audio and the call can be reopened from the notification.

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
| `message_timelocks`    | Ciphertext, Quicknet schedule, retry state, and opening status       |
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

Four primary tabs:

1. **Calls** — recent calls, favorites, dialer/contact selection.
2. **Messages** — conversation list and chat detail.
3. **Contacts** — searchable personal address book.
4. **Profile** — identity and preferences.

Additional screens:

- Incoming call.
- Active call.
- Contact details.
- Add contact, enter an address, or scan an address.
- Profile opens a native settings stack for Identity & keys, Chats, Appearance, Language, Calls & sounds, Privacy & security, Connections, and About. Chats contains Translation. Privacy & security contains App Lock, Device permissions, and Incoming video. Connections manages Nostr relays.

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

App Lock controls access through the app interface. SecureStore owns private key storage under the device-only accessibility policy. Biometric changes do not change the stored key. App Lock leaves the local database encryption policy unchanged.

### Digital SIM portability

Digital SIM exports only the private key as standard NIP-49 `ncryptsec`, with `nostr-tools` and cost 16. Export requests fresh device authentication when configured, requires a confirmed passphrase, and shares only an encrypted temporary document. Import accepts `ncryptsec`, `nsec`, or 32-byte hexadecimal text from paste, file, or QR. The import screen shows the derived `npub` before replacement. The screen requests capture and switcher protection and clears inputs on leaving. The current JS NIP-49 API runs scrypt synchronously; it rejects imports above cost 16 to bound memory, and device responsiveness still needs measurement.

A matching import checks the SecureStore value and leaves local data unchanged. For a different identity, the user must consent to reset local chats, contacts, calls, and privacy data. Boop verifies a separate SecureStore slot before recording the pending switch. At startup, before constructing a signer, Boop checks that slot again. A single SQLite transaction removes identity-owned data, moves the public-key pin and slot pointer together, and records the old slot for retirement. A missing or invalid candidate leaves the old identity in place; a transient read or rolled-back transaction preserves the old identity and can retry on another restart. After commit, failed old-slot cleanup can retry without affecting the new pin. This is a logical local reset, not secure erasure or relay deletion. No mismatch path generates a new identity.

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
