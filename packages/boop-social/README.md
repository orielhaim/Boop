# Boop Social SDK

Boop Social is a GPL-3.0 Rust library. It builds without Boop or MDK, owns its Tokio runtime and databases, and exports generated Kotlin and Swift interfaces. The Boop native host composes it with MarmotKit through the asynchronous `HostSigner` interface. [Architecture](arch.md)

## Phase 1 contract

- Create a `SocialEngine` with an app-private storage root. The engine takes an exclusive lock on that root. Activate an account using its canonical lowercase public key, a native signer and a random 32-byte device storage key.
- Activation retires the previous generation and returns an inactive `SocialSession`. Bind the native signer to that session's account and generation. Set its enabled, foreground and unlocked policy before admitting work. Each session admits one operation at a time, with a deadline on each operation. Policy changes cancel the previous admission immediately. Terminal invalidation is irreversible.
- `sign_note` prepares a kind-1 text note without tags and verifies the returned Schnorr signature against the exact event ID and active account. The v1 request contains the author, generation, signing purpose and unsigned event JSON. The host returns only the signature. Boop checks native MDK account eligibility around each signing call.
- `publish_note` adds a single bounded relay exchange. It records the exact verified event in encrypted storage, reauthorizes and sends it, requires a relay acknowledgement, fetches it by ID, verifies it again and waits for a fresh NostrDB transaction to observe the commit. Cancellation stops further work. A relay may have received bytes before cancellation took effect.
- `retire`, account replacement and shutdown drain admitted work and close the native database handles. A protected host that detects sign-out or unlink can call `invalidate` immediately. A private account's files can be removed independently. Reset a corrupt closed-account cache without opening its NostrDB or removing encrypted records.

The Boop host keeps Social off until a native feature owner opts in. The owner supplies App Lock authorization for the exact session handle returned by activation. Platform foreground transitions also update the session policy. Phase 1 exposes native entry points. Navigation and account settings belong to Phase 5.

## Dependency choices

The lockfile pins direct and transitive versions. Selected libraries and the behavior used in Phase 1 are listed below.

| Dependency                                       | Version                        | Use                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nostr` and `nostr-sdk`                          | 0.45.7 and 0.45.6              | NIP-01 hashing and verification, `AsyncSignEvent`, relay acknowledgements and bounded event requests. The same SDK supplies the in-process test relay. [SDK source](https://docs.rs/crate/nostr-sdk/0.45.6/source/)                                                                                            |
| `async-wsocket`, `tokio-tungstenite`, `url`      | 0.17.0, 0.28.0, 2.5.9          | SDK transport types, bounded WebSocket frames, and URL parsing. Connect directly to a checked IP while retaining the original TLS server name and Host header. [Transport source](https://docs.rs/crate/nostr-sdk/0.45.6/source/src/transport/websocket.rs)                                                    |
| `nostrdb`, `libsodium-sys-stable`                | 0.9.0, 1.24.6                  | Native LMDB indexes, public event ingestion, and transaction-scoped reads. The pinned 0.9.0 fork backports native cross-compilation and initialization cleanup fixes. Its Git submodule pins the C fix. [Pinned source](https://github.com/orielhaim/nostrdb-rs/tree/ebc991ec01fa7e24121d03a38b7ab795daf1b82d) |
| `rusqlite`, `libsqlite3-sys`, SQLCipher, OpenSSL | 0.43.0, 0.40.0, 4.20.0, 3.6.3  | Encrypted replayable state with a raw device key, transactional schema initialization and a page limit. The private database uses the bundled SQLCipher and statically linked OpenSSL. [SQLCipher API](https://www.zetetic.net/sqlcipher/sqlcipher-api/)                                                       |
| `uniffi`                                         | 0.33.0                         | Foreign-implemented asynchronous traits and metadata-generated Kotlin and Swift bindings. [UniFFI async guide](https://mozilla.github.io/uniffi-rs/latest/futures.html)                                                                                                                                        |
| `tokio`, `tokio-util`, `futures`, `async-trait`  | 1.54.1, 0.7.20, 0.3.34, 0.1.92 | Two runtime workers, two blocking threads, explicit cancellation and async trait support.                                                                                                                                                                                                                      |
| `fs2`, `zeroize`, `thiserror`, `tracing`         | 0.4.3, 1.9.2, 2.0.21, 0.1.44   | Cross-platform file locking, Rust storage-key buffer cleanup, typed errors and local diagnostics.                                                                                                                                                                                                              |

The 0.45 SDK line is actively released and has a native relay fixture and a custom transport hook. The stable `nostr-ndb` release targets 0.44 and returns from ingestion after queue admission. The direct NostrDB integration avoids a second SDK graph and confirms commits using fresh transactions. It allows one outstanding ingestion per account and refuses more until that write is observed or the cache is reset. Use the transaction API for bounded lookups and recent notes. Gossip and Negentropy appear transitively in the SDK. Graph, discovery and Blossom APIs enter the SDK when their product phases need them.

Nostr, the relay stack, rusqlite and the Rust support crates use permissive licenses. NostrDB's published crate declares GPL-3.0-or-later. The vendored C build includes LMDB under the OpenLDAP Public License, FlatCC under Apache-2.0 and secp256k1 under MIT. Libsodium uses ISC and SQLCipher Community uses BSD-3-Clause. OpenSSL 3 uses Apache-2.0 and UniFFI uses MPL-2.0. These are compatible with distribution under Boop's GPL-3.0 terms when the corresponding source and dependency notices are included.

## Storage and relay limits

The engine uses a directory per canonical public key and holds a root lock until database handles close. The NostrDB map is configurable from 16 to 512 MiB, with two ingestion workers. Map size is an address space limit and differs from physical disk and RAM use. Public events have a 32 KiB envelope limit, a supported-kind allowlist, a ten-minute future skew limit and independently verified IDs and signatures. Recent note reads return at most 100 entries. SQLCipher stores signed records under schema version 1 with a 16,384-page limit. Android wraps its independent storage key with Android Keystore and keeps the ciphertext in no-backup storage. iOS holds the key in the device-only, unlocked Keychain.

The relay path accepts explicit secure public endpoints. It rejects credentials, fragments and non-public addresses. Plaintext WebSockets work only for literal loopback addresses with explicit fixture configuration. The SDK pins resolution to the vetted socket address, keeps certificate validation on, caps the WebSocket frame and receive sizes and closes its dedicated client after each operation. Phase 1 has no relay discovery, background worker, retry scheduler, or NIP-42 authenticator.

NostrDB commits are checked by event ID. A timed-out write can still commit. At capacity, the cache requires a reset if the writer cannot commit. A reset preserves the private database. Revocation cannot retract a packet already sent to a relay.

## Verification

From this directory, run the independent checks.

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo tree --locked -e normal,build,dev
```

The Rust suite covers a controlled relay round trip, invalid and substituted signatures, account mismatch, cancellation before publication, deadlines, account switching, encrypted reopen, cache recovery and account removal. The Boop Android instrumentation test in `MarmotRelayTest.kt` couples the generated Kotlin bindings to a generated MDK test account and the existing native sign API. See [Boop development instructions](../../DEVELOPMENT.md) for the controlled relay fixture.

## Native build and bindings

Run these from the SDK directory. Android builds one shared object per requested ABI and writes Kotlin bindings from the resulting library's UniFFI metadata. The `bindings` command generates both languages on a development host. The iOS command prepares arm64 device and arm64 simulator slices of the separate `BoopSocialFFI` dynamic XCFramework.

```sh
bun scripts/build-native.ts android armeabi-v7a,arm64-v8a,x86,x86_64
bun scripts/build-native.ts bindings
bun scripts/build-native.ts ios
```

The scripts use a locked Cargo build and verify native artifact hashes against their build inputs. Android uses the configured NDK and Rust cross targets. Windows cross-compilation uses native Perl for host OpenSSL and MSYS2 make, Perl, pkgconf and diffutils for Android native dependencies. Set `BOOP_SOCIAL_TARGET_DIR` to a short, dedicated build path if Windows path limits apply. Set `BOOP_MSYS2_BIN` if the MSYS2 tools live outside the normal installation path.

Boop's Gradle build generates `app.boop.social.ffi` and packages `libboop_social.so` beside `libmarmot_uniffi.so`. It supplies JNA through the Android module. The iOS Podspecs compile the wrappers into separate `BoopSocial` and `BoopMarmot` modules. The C module and framework name for Social is `BoopSocialFFI`. The native packaging scripts audit defined exports so the Social binary exposes only its own UniFFI symbols. Keep each native binary paired with the bindings generated from it.
