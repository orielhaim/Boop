# Boop Marmot rewrite

- Make MDK 0.18.0 the sole engine for persistent direct and group chats. Use pinned Swift and Kotlin bindings through a local Expo module. Build bounded chat-list and conversation windows around native identities, ordering, drafts, attention, and durable sends.
- Preserve the SecureStore-backed Nostr identity and Digital SIM flow. Keep MLS material and authoritative messages in MDK. Replace the legacy SQLite chat baseline without discarding identity credentials.
- Implement KeyPackage discovery, direct chat creation, group creation and details, explicit invitations, account-level membership and admin policy, retention, and group recovery.
- Keep Chat Kit, edits, replies, reactions, deletion, polls, pinning, search, forwarding, Open Later, translation, and link previews. Use encrypted-media-v2 and require an explicit download for every received attachment. Retain the existing recording, file, avatar, and Blossom controls where applicable.
- Keep encrypted kind `24880` calling independent of chat. Preserve first-contact calls, authenticated Trystero/WebRTC, conference capacity and selective video. Use current Marmot membership to authorize group-call invitations.
- Add native device linking, supported history recovery, and honest account, relay, and storage diagnostics. Preserve the separate contact, request, block, and call policies.
- Remove the legacy messaging engine, schemas, and unused dependencies. Refresh project documentation. Verify the real relay, recovery, persistence, media, calling, and native build paths. Record any environment restrictions on verification.

## PR #2 follow-up

- Let members start, discover, and join group calls through a separate MLS announcement stream. Keep kind `24880` as the call negotiation transport. Verify stale routes, coordinator handoff, group membership, and capacity.
- Keep attachment presentation metadata, caption, and reply in the original encrypted media event. Verify encrypted draft retries, restart recovery, and explicit-download privacy.
