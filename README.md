# Boop

Boop is an open-source phone and messenger for Android and iOS. Share your Boop address or scan a QR code to connect. Your address is a Nostr public key, and your device holds the private key. There is no Boop account or phone-number signup.

- Make direct voice calls, start or join a group call, and share video with people who choose to watch.
- Use Marmot for MLS-encrypted direct conversations and persistent groups. Send voice notes, photos, videos, files, and locations. Use Open Later to choose when a message can be opened.
- Manage contacts, block unwanted callers, review message requests, and protect the app with your device lock.
- Translate messages on your device with installed language models. Use Boop in English or Hebrew.

Independent Nostr relays carry encrypted messages. A separate encrypted signaling service uses the same Nostr identity to set up peer-to-peer calls, including first-contact calls. Current members can discover and join a group call from the chat. Chat Kit plays and displays verified local media. Configured Blossom servers store encrypted attachments, and received files download only when you ask. Open Later checks due messages when you open a chat or load older messages. Relays and media servers can observe connection metadata. Direct calls can reveal network addresses to peers.

Boop runs on Android 12 or later and iOS 18 or later. Keep the app open to receive a call. Some networks prevent direct calls, and delivery depends on relay availability. A Digital SIM restores your Nostr address. Recovering MLS conversations or history requires separate Marmot device state and the history available to that device.

[Boop website](https://boop.orielhaim.com) · [Build from source](DEVELOPMENT.md) · [GPL-3.0 license](LICENSE)
