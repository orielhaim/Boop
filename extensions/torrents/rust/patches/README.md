# librqbit 9.1.0 network policy fork

These four directories are the crates.io source packages pinned at 9.1.0:

- `librqbit`
- `librqbit-core`
- `librqbit-dht`
- `librqbit-tracker-comms`

`extensions/torrents/rust/Cargo.toml` patches crates.io to these local copies.
The package Cargo manifests and Apache-2.0 license files are retained. The
upstream Web UI and optional example/demo sources are omitted because Boop does
not build those features.

The local changes enforce a public-unicast policy at the peer connector, DHT
datagram sender, UDP tracker resolver/sender, and Reqwest DNS/redirect path.
Reqwest ignores ambient proxy environment variables, follows at most four
redirects, and times out each request after 30 seconds. Remote-DNS `socks5h`
proxies are rejected because their destination resolution cannot be checked
locally. Torrent metadata responses are capped at 1 MiB, the `info` dictionary
and peer-sourced metadata at 512 KiB, and torrents at 1,024 files.

`test-loopback` is a non-default feature for local network fixtures. It only
allows loopback/private addresses in debug builds. Production release builds
retain the public-address checks even if that feature is accidentally enabled.
