# Boop Social Architecture

## 1. Vision

`boop-social` is a standalone, native Rust SDK for decentralized social networking over Nostr.

Its purpose is to provide a complete social networking engine comparable in architectural scope to what MarmotKit provides for private messaging.

Boop will be its first consumer, offering an integrated social experience similar to Twitter/X while preserving Boop's principles of decentralization, self-custody, privacy, interoperability, and user control.

The SDK should handle the complexity of Nostr social networking internally. Consumers should interact with high-level APIs for feeds, threads, profiles, publishing, social relationships, search, notifications, and moderation rather than implementing these systems themselves.

The library must be suitable for consumption by applications other than Boop.

## 2. Architectural principles

- Rust is the authoritative implementation language.
- `boop-social` is a completely independent library.
- UniFFI provides native bindings for Kotlin and Swift.
- The SDK must not depend on MarmotKit or MDK at the Rust, Cargo, or native linking level.
- MDK and `boop-social` must be compiled, versioned, and maintained independently.
- Applications supply account signing capabilities through asynchronous host interfaces.
- Private identity keys never enter `boop-social`.
- Existing, maintained libraries should be used wherever they provide reliable implementations.
- Prefer extending or patching existing libraries over unnecessarily reimplementing their functionality.
- Do not introduce abstractions without a concrete purpose.
- Do not depend on upstream maintainers accepting our patches.
- Follow established Nostr standards rather than introducing proprietary protocols.
- No mandatory centralized infrastructure.
- No developer-operated account, feed, analytics, or recommendation backend.
- Offline-first operation with incremental synchronization.
- Explicit ownership of resources, subscriptions, and account sessions.
- Bounded memory, network, CPU, and storage consumption.
- Public social networking and private messaging remain separate security domains.

The SDK must be able to operate independently using any compatible implementation of its host interfaces. MarmotKit is one possible identity provider, not a required dependency.

## 3. Product requirements

Boop Social should eventually support:

- Chronological following feeds.
- Discover feeds based on the user's social graph.
- User profiles, posts, replies, and media.
- Threaded conversations.
- Post composition and media attachments.
- Reposts and quote posts.
- Reactions and custom emoji.
- Follows and unfollows.
- Follow sets and custom feeds.
- Bookmarks.
- Hashtags and mentions.
- Local and remote search.
- Social notifications.
- Muting, blocking, reporting, and local content hiding.
- Public event links and previews.
- Long-form content, polls, and additional established Nostr event types.

Social networking must be completely optional in Boop.

Disabling Social must stop its network connections, subscriptions, synchronization, publication retries, discovery, notifications, and background workers.

It must not interfere with private messaging, account management, or WebRTC calls.

Likewise, disabling private messaging must not prevent Social from operating.

## 4. Identity and native integration

### 4.1 Independent native libraries

The application loads two independently compiled native libraries:

```text
                  Boop / React Native
                          |
                 Native application host
                    Kotlin / Swift
                    /            \
                   /              \
          UniFFI bindings     UniFFI bindings
                 |                  |
           boop-social          MarmotKit
                 |                  |
           Public Nostr         Private MLS
           social engine        messaging
```

There must be no Rust-level dependency between the two libraries.

Do not inject `boop-social` into the MDK workspace, link it into `marmot-uniffi`, share Rust object pointers, or attempt to pass native Rust types directly between their binaries.

Each library owns its own runtime, dependencies, storage, networking resources, and generated bindings.

The native application host coordinates their interaction.

### 4.2 Shared identity

Boop must use the same Nostr identity for Social, private messaging, and calls.

MDK remains the authoritative identity and account manager in Boop.

The social SDK must never:

- Generate a second identity for an existing Boop account.
- Import or persist the user's Nostr private key.
- Access the MDK keyring directly.
- Request an `nsec` export.
- Perform account recovery or device management.
- Assume a specific implementation of the underlying signer.

The SDK receives a public key and an account-scoped signing interface.

This design also permits future integration with external signers, hardware-backed signing, remote signers, and other identity providers.

### 4.3 UniFFI asynchronous host interfaces

Use UniFFI's foreign-implemented asynchronous traits for operations that require application-owned capabilities.

Prefer the current `with_foreign` trait mechanism over the legacy callback-interface mechanism when supported by the selected UniFFI version.

An illustrative signing interface:

```rust
#[uniffi::export(with_foreign)]
#[async_trait::async_trait]
pub trait HostSigner: Send + Sync {
    async fn public_key(
        &self,
    ) -> Result<String, HostError>;

    async fn sign_event(
        &self,
        request: SignEventRequest,
    ) -> Result<SignEventResponse, HostError>;
}
```

The final signatures should follow the selected UniFFI release and the SDK's actual requirements.

The SDK adapts this interface to the signing traits required by its selected Rust Nostr dependencies.

The signing flow is:

```text
boop-social
    |
    | Construct unsigned Nostr event
    | Compute canonical event ID
    |
    v
UniFFI async host interface
    |
    v
Kotlin / Swift HostSigner
    |
    | Validate account and session authorization
    |
    v
MarmotKit.sign_nostr_event(...)
    |
    | Return signature
    |
    v
boop-social
    |
    | Assemble and verify signed event
    | Persist signed event
    | Recheck publication authorization
    |
    v
Nostr relays
```

Use a small, explicit, versioned boundary between libraries. Canonical Nostr event JSON is appropriate for the signing operation. Other operations should use typed UniFFI records where practical.

Do not route signing through React Native or JavaScript.

The Kotlin and Swift implementations must support asynchronous calls without blocking the UI thread.

### 4.4 Existing MDK signing support

Boop's current MDK patch already exposes:

- `MarmotAppRuntime::account_nostr_signer`
- `Marmot::sign_nostr_event`
- `Marmot::nostr_cipher`

The existing signing method accepts unsigned Nostr event JSON and returns the resulting signature.

Reuse these capabilities. Improve them through local patches where necessary.

The host may also expose NIP-44 encryption and decryption for supported private social data, such as encrypted lists. Introduce these capabilities when required rather than granting unrestricted access to identity operations.

### 4.5 Signing security

Bind every host signer to one account, one session generation, and an explicit authorization scope.

Before signing, the SDK and host must verify that:

- The requested public key matches the active account.
- The account has not been signed out or remotely unlinked.
- The session has not been retired.
- Social remains enabled.
- The operation is permitted by the current application security state.
- The event kind and purpose are authorized.

The SDK must independently verify the returned signature, event ID, public key, and signed event contents.

A signer must not be able to substitute a different event.

Recheck authorization after asynchronous operations and immediately before publication.

Use explicit cancellation, deadlines, and session invalidation. Do not rely exclusively on foreign future cancellation.

Never hold internal database transactions or runtime locks while awaiting host callbacks.

### 4.6 Additional host capabilities

The SDK may accept optional interfaces for:

- Shared profile directory access.
- Account relay configuration.
- Follow-list reads and mutations.
- Shared block-list access.
- Secure local storage key provisioning.
- Application lifecycle integration.
- Public media transfer.
- Local notification delivery.

These interfaces must remain independent of MDK types.

Where practical, the SDK should provide standalone implementations or defaults. Consumers may supply an authoritative provider when another component already owns the relevant state.

Do not create multiple competing writers for the same replaceable Nostr event.

For Boop, MDK may remain the authoritative writer for profiles, relay declarations, and follow lists. Social should consume updates and delegate mutations through the native host.

## 5. Dependency strategy

Use the best maintained Rust implementations available at implementation time.

The following libraries are the preferred starting points. Their exact versions must be selected, pinned, and validated during Phase 1.

| Dependency                | Purpose                                                                      |
| ------------------------- | ---------------------------------------------------------------------------- |
| `nostr`                   | Nostr protocol types, event construction, validation, cryptography, and NIPs |
| `nostr-sdk`               | Relay clients, subscriptions, publication, and synchronization               |
| `nostr-gossip`            | NIP-65 routing and relay discovery                                           |
| `nostr-gossip-memory`     | In-memory gossip state                                                       |
| `nostrdb`                 | Embedded, indexed Nostr event database                                       |
| `nostr-ndb`               | Nostr SDK database integration                                               |
| `nostr-social-graph`      | Follow relationships, graph traversal, and social distance                   |
| `negentropy`              | Efficient event reconciliation through NIP-77                                |
| `nostr-blossom`           | Blossom media operations where needed                                        |
| `rusqlite` / SQLCipher    | Encrypted, durable application state                                         |
| `tokio`                   | Asynchronous runtime                                                         |
| `tokio-util`              | Cancellation and runtime utilities                                           |
| `futures`                 | Streams and asynchronous composition                                         |
| `async-trait`             | Object-safe asynchronous interfaces                                          |
| `serde` / `serde_json`    | Serialization                                                                |
| `thiserror`               | Structured errors                                                            |
| `tracing`                 | Local diagnostics                                                            |
| `uniffi`                  | Native bindings                                                              |
| Nostr local relay tooling | Integration and protocol tests                                               |

Use minimal required dependency features.

Within `boop-social`, all crates belonging to the Rust Nostr SDK family should use compatible versions and a consistent source.

Because the libraries are compiled independently, `boop-social` does not need to use MDK's exact Rust Nostr, Tokio, SQLCipher, or UniFFI versions. Compatibility at the host boundary is what matters.

Nevertheless, independently compiled dependencies must coexist safely inside the same application process. Validate native symbols, library loading, platform packaging, and duplicated native dependencies.

### 5.1 Dependency evaluation

Evaluate libraries against:

- Protocol correctness.
- Maintenance activity.
- Mobile compatibility.
- Runtime and memory overhead.
- API quality.
- Licensing.
- Native build complexity.
- Existing functionality that can eliminate custom code.
- Cancellation and lifecycle behavior.

Do not add a dependency solely because it appears in this document. Equally, do not implement an inferior custom alternative when a suitable maintained implementation already exists.

Document deviations from the proposed dependencies and the technical reasons for them.

### 5.2 Useful reference implementations

Study these projects for implementation details, algorithms, and interoperability:

- Applesauce, especially its timeline loaders and relay coverage tracking.
- Damus and Notedeck, especially their use of NostrDB.
- Iris and `nostr-social-graph`.
- Amethyst and Quartz.
- Existing MDK directory, publication, subscription, and conversation-window implementations.

These are references, not mandatory runtime dependencies.

`marmot-markdown` is worth evaluating for content parsing, but it must not introduce a dependency on MDK. If it cannot be consumed independently, select a suitable standalone parser and combine it with Nostr-specific content parsing.

## 6. Repository structure

Initially, keep the implementation in one primary Rust crate with clearly separated internal modules.

```text
packages/boop-social/
    Cargo.toml
    Cargo.lock
    README.md
    arch.md
    uniffi.toml

    src/
        lib.rs
        config.rs
        error.rs
        host.rs
        runtime.rs
        session.rs
        policy.rs

        ffi/
        protocol/
        storage/
        relay/
        sync/
        feed/
        threads/
        publishing/
        profiles/
        graph/
        notifications/
        search/
        moderation/
        media/
        presentation/

    tests/
    benches/
    scripts/
```

Introduce additional crates only when there is a demonstrated need for a separate compilation or dependency boundary.

Keep Boop-specific host implementations outside the Rust SDK.

```text
modules/boop-social/
    android/
    ios/
    src/

src/core/social/
src/components/social/
```

The exact integration paths may be adjusted to fit Boop's existing conventions.

The library must build and run its Rust tests without the Boop application or an MDK checkout.

## 7. Storage architecture

### 7.1 NostrDB

NostrDB is the preferred public event database.

It is an embedded Nostr-specific database built on LMDB, with compact event representation, indexed queries, subscriptions, profile indexing, and full-text search.

Use its native capabilities rather than creating a generic SQL-based Nostr event store from scratch.

Store verified, supported public Nostr events, including:

- Notes and replies.
- Reactions and reposts.
- Public profile metadata.
- Follow and relay declarations.
- Public lists.
- Articles, polls, and other supported event types.

Do not feed arbitrary private messaging events, MLS payloads, gift wraps, or private credentials into NostrDB.

Use account-isolated storage by default.

Public events are public, but a person's local collection of events may reveal their reading habits and interests.

### 7.2 NostrDB integration

Use `nostr-ndb` where it provides a correct integration with `nostr-sdk`.

Also use the underlying NostrDB API directly where its capabilities are needed, particularly indexed queries, local subscriptions, transaction-scoped reads, and full-text search.

The previously inspected `nostr-ndb` implementation has limitations that must be checked against the selected version:

- Event ingestion is asynchronous.
- A successful enqueue operation does not necessarily mean the event is committed.
- Some query paths impose result-count limits.
- Individual deletion and database wiping may not be supported through the generic database trait.

Do not mistake successful ingestion admission for durable persistence.

Observe committed events through database subscriptions or another verified completion mechanism.

Do not advance synchronization checkpoints before the relevant events are safely stored.

Ensure query limits cannot silently corrupt pagination, aggregate counts, or Negentropy reconciliation.

Patch the integration locally if required.

### 7.3 Private and durable state

Use a separate encrypted application database for state that must survive cache resets and that does not belong in the public event store.

This includes:

- Drafts.
- Pending and signed publication jobs.
- Per-relay publication acknowledgements.
- Account preferences.
- Private bookmarks.
- Local hidden-content state.
- Notification read state.
- Synchronization metadata.
- Cache management information.
- Private search history, if retained.

Use an independent, account-scoped storage key supplied through the appropriate secure storage mechanism.

Never derive storage encryption directly from the Nostr identity key.

Keep private state out of public event indexes.

The public event database should be rebuildable. Pending publications and private user state must not be lost when clearing the public cache.

### 7.4 Storage limits and recovery

Support bounded database growth, corruption recovery, local cache reset, and account retirement.

NostrDB's LMDB map size is not equivalent to physical RAM usage or actual disk consumption. Measure these independently.

If selective eviction is unavailable, use a safe cache-rebuild strategy.

Close all database handles, transactions, subscriptions, and ingestion workers before removing an account's database directory.

If NostrDB cannot meet mobile compatibility or correctness requirements, evaluate `nostr-lmdb` as the preferred alternative before considering a custom implementation.

## 8. Content permanence and deletion policy

Boop operates on the assumption that anything sent to another party or published to a decentralized network may remain available indefinitely.

The SDK must not promise that previously published content can be erased from other devices, relays, or clients.

Do not implement:

- Delete-for-everyone guarantees.
- Disappearing posts.
- Automatic expiration of our published content as a privacy feature.
- Outgoing remote-deletion requests in the initial product.

Support local operations such as:

- Discarding unpublished drafts.
- Cancelling publication before external exposure.
- Hiding posts.
- Muting and blocking.
- Clearing cached data.
- Removing account-local data.

Incoming NIP-09 deletion requests may be recognized for interoperability. Validate the author's authority before applying a local withdrawal or visibility policy.

The SDK may retain the underlying event in its cache while no longer displaying it.

Treat incoming expiration metadata according to an explicit visibility policy. This must never become a promise of remote erasure.

The inability to physically delete an individual event from NostrDB is not a blocker for this architecture.

Reaction and repost reversal requires special care. If a protocol-level reversal would require a deletion request that Boop does not send, do not present a local reversal as a globally synchronized undo.

Local data removal is separate from network deletion.

## 9. Implementation roadmap

The project is divided into five major phases.

Each phase must leave the library in a working, tested state. Do not defer correctness issues in foundational components to later phases.

---

# Phase 1: Independent native foundation

## Objective

Establish a production-quality standalone Rust library, independent native builds, secure asynchronous signing through the host, account lifecycle management, and validated foundational dependencies.

This phase must prove that Boop can use `boop-social` and MarmotKit as separate native libraries while sharing the same account identity.

## 1.1 Research and dependency validation

Inspect the current Boop repository, its MDK integration, build scripts, security model, and repository instructions.

Evaluate and select the actual dependency versions.

Investigate NostrDB's current APIs and native build requirements, including its C implementation and transitive native dependencies.

Verify that the selected libraries can be compiled for Boop's supported Android targets.

Check dependency licensing and compatibility with Boop's GPL-3.0 licensing.

Document all selected dependencies and significant deviations from this architecture.

## 1.2 Standalone Rust project

Create `packages/boop-social`.

Establish:

- An independent Cargo project or workspace.
- Its own `Cargo.lock`.
- Formatting and linting configuration.
- Structured error handling.
- Local diagnostics.
- Configuration and resource policies.
- Unit and integration test infrastructure.
- Reproducible native build scripts.

There must be no MDK dependency in the Cargo dependency graph.

The SDK must compile independently on a supported development host.

## 1.3 UniFFI and native packaging

Configure UniFFI using the selected release.

Create a separate native library, such as `libboop_social.so` on Android, with its own generated Kotlin and Swift bindings.

Integrate its build and packaging into Boop without modifying MDK's compilation architecture.

Ensure:

- Distinct library and binding namespaces.
- Correct target architectures.
- Reproducible generation of bindings.
- Correct incremental build invalidation.
- No reliance on a shared native runtime.
- Safe coexistence of both native libraries.
- No manual editing of generated bindings.

Include SDK source files, dependency lockfiles, build configuration, and patches in build provenance.

Respect the repository's platform-specific verification restrictions. Prepare the Swift integration without initiating prohibited iOS build, simulator, or host-discovery workflows.

## 1.4 Host signing contract

Implement the asynchronous `HostSigner` interface.

Provide:

- A Rust-native test signer.
- A Kotlin host adapter using the existing MarmotKit signing API.
- The corresponding Swift host adapter.
- An adapter to the selected Rust Nostr SDK's signing traits.
- Structured host errors.
- Account identity verification.
- Explicit operation cancellation and deadlines.

Demonstrate that `boop-social` can construct a Nostr event, request signing through the native host, receive the signature, and independently verify the event.

The event must have the same public key as the active Boop identity.

The test signer is for standalone testing. Do not introduce a second production key store.

## 1.5 Account and runtime lifecycle

Implement the foundational types:

- `SocialEngine`
- `SocialSession`
- `SocialOptions`
- `HostSigner`
- `SocialError`
- Session authorization state.
- Cancellation and retirement handles.

The SDK must own a bounded Tokio runtime and explicitly manage its worker tasks.

UniFFI exports must execute Tokio-dependent work on the intended runtime. Do not accidentally rely on a fallback single-thread executor.

Design for:

- Account activation.
- Account switching.
- Application foreground and background transitions.
- Application locking and unlocking.
- Social enablement and disablement.
- Sign-out.
- Remote device unlink.
- Local account removal.
- Terminal shutdown.

Use account generations and cancellation tokens to prevent stale results from modifying a new or retired session.

The host must be able to invalidate a session independently of any in-flight callback.

Do not allow a retired signer or session to resume publication.

## 1.6 Foundational storage

Validate NostrDB integration on the selected mobile targets.

Implement:

- Account-scoped database directories.
- Public event admission and verification.
- Event lookup and bounded queries.
- Committed-event observation.
- Database initialization and shutdown.
- Cache reset and local account removal.
- Storage configuration.
- Structured storage errors.

Validate the selected encrypted private-state database and its independent storage-key mechanism.

Establish schema migration support.

Prove that both storage systems can coexist with MDK's native dependencies.

## 1.7 Foundational network integration

Integrate the selected `nostr-sdk` version.

Establish a minimal relay client with:

- Explicit connection ownership.
- Bounded resource configuration.
- Safe relay admission.
- Connection and request cancellation.
- Event validation.
- Clean shutdown.

Use a controlled local relay to demonstrate an end-to-end event flow:

1. Construct an unsigned public test event.
2. Sign it through the host interface.
3. Verify the returned signature.
4. Publish it to the local test relay.
5. Receive the event.
6. Persist it in NostrDB.
7. Query and verify the committed event.

Production publication and synchronization policies will be completed in Phase 2.

## 1.8 Phase 1 acceptance criteria

Phase 1 is complete only when:

- The SDK builds independently of MDK.
- Its dependency graph contains no MDK crates.
- The Android native library builds and loads alongside MarmotKit.
- Generated Kotlin bindings are integrated and exercised.
- Swift bindings and host integration are prepared within repository restrictions.
- The asynchronous host signer is functional.
- Signing uses the existing Boop account identity.
- No production private identity key enters the SDK.
- Invalid signatures and mismatched identities are rejected.
- Cancellation, retirement, and account switching are tested.
- NostrDB can ingest, observe, and retrieve committed events.
- Private state storage is initialized and tested.
- Account-local storage can be safely closed and removed.
- The controlled local-relay end-to-end flow passes.
- Social resources can be stopped without stopping MDK.
- Formatting, linting, tests, and permitted native build verification pass.
- Architectural decisions, dependency versions, and known limitations are documented.

Do not consider a mock-only signing implementation or a successful desktop-only build sufficient.

---

# Phase 2: Network, synchronization, and publication

## Objective

Build the complete, reliable Nostr data plane on top of the validated foundation.

## 2.1 Relay management and Gossip

Use Rust Nostr SDK's existing relay management and Gossip capabilities.

Implement NIP-65 outbox routing, relay discovery, relay hints, and appropriate fallback relays.

Group authors by relay and batch filters rather than opening one subscription per followed account.

Bound:

- Active connections.
- Concurrent requests.
- Authors per filter.
- Subscription count.
- Event sizes.
- Tag counts and sizes.
- Ingestion queues.
- Relay discovery depth.
- Retry frequency.

Use explicit request priorities so that visible feeds and user-initiated actions take precedence over speculative work.

Reuse the SDK's reconnect, timeout, and subscription functionality wherever possible.

Social must own its relay client independently of MarmotKit. Sharing physical connections is not a requirement.

## 2.2 Relay safety and privacy

Treat relay URLs and network-provided hints as untrusted input.

Reject unsafe schemes, local network destinations, invalid URLs, and disallowed endpoints.

Address DNS resolution, DNS rebinding, redirects, and connection-time destination validation.

Allow loopback relays only through explicit development and test configuration.

Use anonymous public reads where possible.

Do not automatically perform NIP-42 authentication against arbitrary relays. Authentication must follow an explicit policy because it discloses the account identity.

Do not reuse private messaging routing information for unrelated public social requests.

## 2.3 Synchronization

Implement incremental historical synchronization and live subscriptions.

Use NIP-77 Negentropy where supported.

Feed reconciliation should be download-only. Do not automatically upload other people's cached events to relays.

Fallback to bounded REQ queries with overlapping time windows when Negentropy is unavailable.

Track coverage per relay and query scope.

Differentiate:

- Complete relay responses.
- Partial responses.
- Limit-truncated responses.
- Unavailable relays.
- Interrupted requests.
- Uncommitted local ingestion.
- Previously observed events.

EOSE means that a relay has finished sending the stored results for a particular request. It does not prove that the complete global history has been retrieved.

Ensure checkpoints cannot advance past events that were not successfully persisted.

## 2.4 Protocol processing

Build typed processing for supported Nostr event kinds.

Use established event builders, parsers, and verification utilities.

Handle:

- Signature and event ID verification.
- Replaceable and addressable events.
- Deterministic replacement rules.
- Duplicate events.
- Out-of-order delivery.
- Future timestamp limits.
- Malformed and oversized events.
- Validated event references.
- Unknown event kinds.

Preserve original events rather than converting them into proprietary protocol formats.

Only verified events may update the graph, notification state, feeds, or derived indexes.

## 2.5 Durable publication

Implement an independent publication subsystem.

Use client-generated operation tokens for idempotency.

Publication states should represent meaningful distinctions such as:

```text
Draft
Queued
Signing
Signed
Publishing
Acknowledged
PartiallyReplicated
Replicated
RetryPending
Rejected
PossiblyPublished
Cancelled
```

Persist the signed event before network transmission.

Retries must reuse the exact signed event and event ID.

Track acknowledgements per relay.

Distinguish a definitive rejection from an unknown outcome. A relay may have accepted an event even when the acknowledgement was lost.

Cancellation must prevent future transmission where possible without claiming to reverse previous exposure.

The publication worker must stop when its account session is retired or Social is disabled.

## 2.6 Replaceable identity state

Support safe reads and mutations of follow lists, profiles, relay declarations, mute lists, and other supported replaceable events.

Preserve unknown tags and fields.

Do not overwrite existing lists with an empty list when the current authoritative event cannot be retrieved.

Handle genuine first-time initialization separately from network failure.

Serialize local mutations and detect conflicts where practical.

Do not claim cross-device atomicity. Other Nostr clients may concurrently publish replacement events.

When the host provides an authoritative writer, delegate the mutation instead of introducing a competing publication path.

## 2.7 Phase 2 acceptance criteria

The SDK can reliably retrieve, validate, persist, synchronize, and publish public Nostr events across multiple relays.

Tests cover disconnects, duplicate events, incomplete responses, ingestion failures, publication retries, process interruption, replaceable-event conflicts, stale sessions, and relay safety.

The network and publication engine must operate without a UI.

---

# Phase 3: Feeds, threads, and presentation

## Objective

Create the high-level social content engine that turns decentralized Nostr events into efficient, consistent, application-ready views.

## 3.1 Feed engine

Implement a reusable feed engine rather than separate unrelated implementations for each feed screen.

Supported feed sources should include:

- Following.
- User profile.
- Discover.
- Follow set.
- Hashtag.
- Bookmarks.
- Selected relay.
- Search results.

Each source defines its query scope, ranking or ordering policy, visibility filters, and synchronization requirements.

The following feed should default to deterministic chronological ordering.

## 3.2 Feed windows

Use bounded, observable feed windows inspired by MarmotKit's conversation windows.

A feed window should expose operations such as:

```text
snapshot()
load_older()
load_newer()
refresh()
jump_to_latest()
observe()
close()
```

Support stable ordering using event timestamps and event IDs.

Use local keyset pagination where possible.

Network pagination must account for timestamp collisions, relay limits, overlapping results, and late-arriving events.

Do not silently lose events at page boundaries.

Keep newly arriving content separate from the currently visible scroll position when necessary.

Opening a feed should immediately return available cached content and continue synchronization asynchronously.

## 3.3 Window updates

Expose versioned snapshots and incremental updates through UniFFI.

Updates should include:

- Insertions.
- Content changes.
- Removals from the visible window.
- Ordering changes.
- New-content availability.
- Synchronization state.
- Window generation and sequence numbers.

Bound subscription queues.

If a consumer falls behind or detects a sequence gap, provide a fresh snapshot.

Subscription cancellation must not silently consume an update that the consumer never receives.

Do not send entire timelines or large collections of raw Nostr events across UniFFI.

## 3.4 Thread engine

Implement thread reconstruction and context resolution.

Support:

- Root posts.
- Parent replies.
- Nested replies.
- Missing parent events.
- Quote references.
- Reposts.
- Referenced articles and other addressable content.

Use NIP-10 for kind-1 threads and NIP-22 for comments on appropriate event types.

Resolve missing references with bounded relay requests.

Handle malformed references, inconsistent thread structures, cycles, and deleted or unavailable content.

## 3.5 Presentation models

Produce high-level, typed view models in Rust.

An illustrative post model:

```rust
pub struct PostView {
    pub id: EventId,
    pub author: ProfileSummary,
    pub created_at: u64,
    pub content: ContentDocument,
    pub attachments: Vec<MediaAttachment>,
    pub reply_to: Option<EventReference>,
    pub quote: Option<QuotedEvent>,
    pub engagement: EngagementSummary,
    pub relationship: AuthorRelationship,
    pub publication: PublicationState,
    pub visibility: PostVisibility,
}
```

The SDK should resolve:

- Profile summaries.
- Content references.
- Author relationships.
- Reaction summaries.
- Known reply and repost counts.
- The current user's reactions.
- Publication state.
- Moderation decisions.
- Media metadata.
- Quoted-event previews.

Aggregates derived from incomplete relay data must not be represented as authoritative global counts.

## 3.6 Content parsing

Use reliable existing parsers for content appropriate to each Nostr event kind.

Support Nostr identifiers and references, URLs, mentions, hashtags, emoji, media descriptors, and structured rich content.

Preserve the original content.

Do not assume that ordinary kind-1 notes universally use Markdown semantics.

Prevent unsafe HTML rendering, dangerous URI handling, and accidental exposure of secret identifiers.

## 3.7 Media

Support NIP-92 metadata and Blossom public media operations.

Separate:

- Public social media.
- Private Marmot attachments.
- Unpublished local draft media.

Do not automatically publish private chat media or grant social code access to private attachment authorization.

Sharing private media publicly must require explicit user intent.

Use existing Boop media players, downloads, and rendering capabilities through appropriate integration contracts rather than duplicating them inside the social SDK.

Verify content hashes where available. Apply size limits, safe URL policies, cancellation, and bounded downloads.

## 3.8 Phase 3 acceptance criteria

The SDK provides functional, observable following feeds, profile feeds, thread views, cached content, historical pagination, live updates, and typed presentation models.

The consumer does not need to implement Nostr protocol handling, feed merging, deduplication, thread reconstruction, or engagement aggregation in JavaScript.

---

# Phase 4: Social graph, discovery, search, and moderation

## Objective

Complete the social networking capabilities required for a useful decentralized social client.

## 4.1 Social graph

Integrate the Rust implementation of `nostr-social-graph`, subject to dependency validation.

Use it for:

- Follow relationships.
- Followers discovered from available data.
- Social distance.
- Mutual relationships.
- Follow-of-follow discovery.
- Graph-based filtering.
- Recommendation signals.

Supply verified follow and mute events.

Prefer the library's existing graph storage and incremental update mechanisms.

Do not build a redundant custom graph engine unless a demonstrated limitation requires it.

Use bounded graph expansion and persistence.

Avoid mandatory external graph snapshots or centralized ranking providers.

The initial Discover implementation should focus on the user's second-degree social network rather than an unrestricted global firehose.

## 4.2 Discovery and ranking

Develop transparent, locally controlled ranking policies.

Possible signals include:

- Social distance.
- Mutual connections.
- Recency.
- Author diversity.
- Relevant engagement.
- User-selected interests.
- Muting and spam signals.

Keep ranking deterministic where practical and avoid feedback loops that require centralized behavioral tracking.

Do not equate social distance with factual credibility.

Do not introduce engagement-maximizing recommendation behavior as a product requirement.

## 4.3 Lists and bookmarks

Support NIP-51 lists, follow sets, muted content, and bookmarks.

Private lists require host-provided encryption capabilities when applicable.

Keep private bookmarks and preferences separate from public publications.

Never expose private list contents through public event projections, diagnostics, or public database indexes.

## 4.4 Moderation

Implement local moderation using:

- User blocks.
- Muted authors.
- Muted words and hashtags.
- Hidden posts.
- Social graph restrictions.
- Event-kind restrictions.
- Media sensitivity settings.
- Spam and resource-abuse limits.

In Boop, consume the existing authoritative block-list state through the host.

Public reports may use NIP-56 after explicit user confirmation.

Do not automatically publish reports or disclose private moderation information.

Handle incoming deletion and withdrawal requests according to the content permanence policy.

## 4.5 Search

Use NostrDB's full-text search for locally available content.

Support profile, post, hashtag, identifier, and event-reference search.

Use NIP-50-capable relays for optional remote search.

Merge local and remote results while preserving source and coverage information.

Cancel stale searches and avoid sending every keystroke to external relays.

Rank results using explicit policies and available social context.

Evaluate search quality for multilingual content, including Hebrew and English.

## 4.6 Notifications

Build an event-driven social notification engine.

Support:

- Mentions.
- Replies.
- Reactions.
- Reposts.
- Quote posts.
- Discovered follows.
- Other supported social activity.

Deduplicate notifications and persist private read state.

Apply moderation before notification delivery.

Provide local notification delivery through a host interface.

Do not require a centralized push notification service.

Be explicit about the limits of background notification availability on mobile operating systems.

## 4.7 Protocol support

Prioritize interoperable standards.

| Standard         | Purpose                                    |
| ---------------- | ------------------------------------------ |
| NIP-01           | Basic events and protocol                  |
| NIP-02           | Follow lists                               |
| NIP-10           | Text-note threads                          |
| NIP-18           | Reposts                                    |
| NIP-19 / 21 / 27 | Identifiers, links, and references         |
| NIP-22           | Comments                                   |
| NIP-25           | Reactions                                  |
| NIP-30           | Custom emoji                               |
| NIP-42           | Controlled relay authentication            |
| NIP-44           | Encryption through the host when required  |
| NIP-50           | Search                                     |
| NIP-51           | Lists and bookmarks                        |
| NIP-56           | Reporting                                  |
| NIP-65           | Relay routing                              |
| NIP-77           | Negentropy                                 |
| NIP-92           | Media attachments                          |
| Blossom          | Public media storage and transfer          |
| NIP-09           | Incoming deletion-request interoperability |

Evaluate NIP-23 articles, NIP-68 picture events, NIP-71 video events, NIP-88 polls, and other established social standards.

Zaps and external ranking assertions may be added later through explicit architectural extensions.

Verify the current specifications before implementing each feature.

## 4.8 Phase 4 acceptance criteria

The SDK provides complete high-level APIs for social relationships, Discover, lists, moderation, notifications, and local and remote search.

Graph expansion, search, and notification processing remain bounded and independently cancellable.

All functionality operates without a mandatory centralized provider.

---

# Phase 5: Boop integration, optimization, and production readiness

## Objective

Integrate the completed SDK into Boop as a first-class optional feature, validate its behavior under realistic workloads, and prepare it for production use.

## 5.1 Application integration

Create the TypeScript integration layer and native application module.

Keep the TypeScript layer focused on:

- Session coordination.
- UI subscriptions.
- State presentation.
- Navigation.
- User interactions.
- Existing media and application services.

Do not move protocol handling or core social algorithms back into JavaScript.

Use Boop's existing account, profile, theme, accessibility, localization, navigation, and media infrastructure.

Provide a cohesive experience for following feeds, Discover, profiles, threads, search, notifications, bookmarks, and post composition.

Support RTL and LTR layouts.

## 5.2 Optional feature lifecycle

Integrate a persistent account-level Social preference.

When disabled:

- Remove Social navigation and feature-specific actions.
- Close social windows and subscriptions.
- Stop synchronization and discovery.
- Stop publication retries.
- Stop notification collection.
- Cancel pending social network requests.
- Release unused Social resources.

Do not stop MDK, private messaging, account management, or call signaling.

Public events that were previously published remain unaffected.

Existing user state should be retained unless the user explicitly requests local removal.

## 5.3 Performance and resource management

Measure the implementation on real Android devices.

Initial engineering targets, subject to benchmarking:

| Resource                            | Initial target             |
| ----------------------------------- | -------------------------- |
| Feed page size                      | Approximately 30 posts     |
| Active feed window                  | Approximately 90–150 posts |
| Long-lived social relay connections | Up to 12                   |
| Automatic graph expansion           | Two degrees                |
| Public event cache budget           | Approximately 512 MiB      |
| NostrDB ingestion threads           | Initially 2, then tune     |
| Cached feed page latency            | p95 below 100 ms           |
| First cached feed snapshot          | p95 below 300 ms           |

These are starting budgets, not existing benchmark results.

Measure:

- Cold and warm startup.
- Query latency.
- Feed update throughput.
- FFI overhead.
- Database growth.
- Memory usage and mapped memory.
- CPU and battery consumption.
- Relay traffic and reconnection behavior.
- Background and foreground transitions.
- Concurrent messaging and calling.
- Shutdown and account retirement latency.

Use bounded caches, batching, backpressure, and cancellation.

Optimize based on profiling rather than speculation.

## 5.4 Interoperability testing

Validate real events and behavior from established Nostr clients, including:

- Damus.
- Amethyst.
- Primal.
- Iris.
- noStrudel.
- Other relevant clients.

Use controlled local relays for reproducible tests.

Test multiple relay implementations and capability differences.

Test malformed events, incomplete relay history, conflicting replaceable events, unsupported NIPs, missing references, duplicate deliveries, and unexpected server behavior.

## 5.5 Security testing

Explicitly test:

- Account identity mismatches.
- Invalid and substituted signatures.
- Stale signing callbacks.
- Logout during signing or publication.
- Remote device unlink.
- Account switching under load.
- Application lock during active requests.
- Unauthorized relay authentication.
- Unsafe relay and media URLs.
- DNS rebinding and private-network destinations.
- Excessive event sizes and malicious tags.
- Database corruption and disk exhaustion.
- Cross-account data leakage.
- Accidental public sharing of private attachments.
- Private storage and diagnostics leakage.
- Cancellation and shutdown races.

The SDK must not weaken Boop's existing identity, privacy, or messaging security guarantees.

## 5.6 Documentation and release readiness

Maintain independent documentation for:

- Public Rust APIs.
- UniFFI APIs.
- Host integration.
- Supported NIPs.
- Storage behavior.
- Lifecycle and cancellation.
- Configuration.
- Security assumptions.
- Build procedures.
- Dependency updates.
- Known limitations.

Document public API compatibility and migration requirements.

Ensure generated bindings match the exact native binary.

Maintain reproducible builds, automated tests, and dependency lockfiles.

## 5.7 Phase 5 acceptance criteria

Boop offers a complete, optional social experience powered by `boop-social`.

The SDK remains independently buildable and usable outside Boop.

Identity sharing works exclusively through the native host contract.

Performance and resource usage are measured, security-critical lifecycle scenarios pass, and the integration does not regress existing private messaging or calling behavior.

---

## 10. Rules for implementing this architecture

Use this document as the architectural direction, not as a reason to preserve an inferior implementation when better evidence becomes available.

Read the actual source code of dependencies before building wrappers around them.

Use native library capabilities wherever they satisfy the requirements.

Avoid duplicate implementations of protocol handling, cryptography, database indexing, graph traversal, relay management, and reconciliation.

Prefer small, well-tested local patches when existing dependencies lack necessary capabilities.

Keep patches focused and maintainable. Document their purpose and include regression tests.

Never make project progress conditional on upstream acceptance.

Do not introduce temporary architecture that violates the independent library boundary.

Do not merge `boop-social` and MDK into one native library as a shortcut.

Do not route identity operations through JavaScript.

Do not copy private identity keys into Social.

Preserve existing Boop functionality throughout development.

Complete each phase in full, including verification and documentation, before moving to the next phase.

## 11. Technical references

### UniFFI

- [UniFFI repository](https://github.com/mozilla/uniffi-rs)
- [Async and future support](https://mozilla.github.io/uniffi-rs/latest/futures.html)
- [Callback interfaces](https://mozilla.github.io/uniffi-rs/latest/types/callback_interfaces.html)
- [Async FFI internals](https://mozilla.github.io/uniffi-rs/next/internals/async-ffi.html)

### Nostr

- [Rust Nostr SDK](https://github.com/nostrdevkit/nostr)
- [Nostr protocol specifications](https://github.com/nostr-protocol/nips)
- [NostrDB](https://github.com/damus-io/nostrdb)
- [NostrDB Rust bindings](https://github.com/damus-io/nostrdb-rs)
- [Nostr Social Graph](https://github.com/mmalmi/nostr-social-graph)
- [Negentropy](https://github.com/hoytech/negentropy)
- [Blossom](https://github.com/hzrd149/blossom)

### Reference clients and implementations

- [Applesauce](https://github.com/hzrd149/applesauce)
- [Notedeck](https://github.com/damus-io/notedeck)
- [Damus](https://github.com/damus-io/damus)
- [Amethyst](https://github.com/vitorpamplona/amethyst)

### Boop and MDK

- [Boop](https://github.com/orielhaim/Boop)
- [Marmot Development Kit](https://github.com/marmot-protocol/mdk)
- [Boop's existing MDK patch](https://github.com/orielhaim/Boop/blob/main/modules/boop-marmot/mdk-0.19.0.patch)

## 12. Final architectural decision

`boop-social` is an independent, headless Rust social networking SDK with its own storage, runtime, protocol implementation, relay management, and UniFFI bindings.

It relies on established Nostr libraries wherever possible and implements the missing high-level social networking functionality.

Boop integrates it through Kotlin and Swift, using asynchronous UniFFI host interfaces to share the existing account identity and other application-owned capabilities.

MarmotKit remains an independent messaging and identity engine.

Neither library depends on the other.

The application composes them into one coherent user experience without compromising their independence.
