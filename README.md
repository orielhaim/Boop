# Boop

Boop is an open-source messenger for Android and iOS. Create an account with a public name, or sign in with an existing Nostr private key or encrypted identity key backup. Account setup requires neither a phone number nor an email address.

- **Chats** opens your MLS-encrypted direct conversations and groups. Send voice notes, photos, videos, files, and locations. Use Open Later to choose when a message can be opened.
- **People** finds public identities by address, QR code, Nostr identifier, or supported relay search. Saving someone is optional. Nicknames and local photo overrides stay on your device.
- **Profile** shows your public Nostr identity. Edit your name, bio, photo, banner, website, and Nostr identifier. Open Settings from the profile header.
- Start a voice or video call from someone's profile or chat. Start or join group calls from the group conversation.
- Use Boop in English or Hebrew. Control message requests, block people, and protect the app with App Lock.
- Transcribe saved voice notes on supported devices. Open **Settings → Language → Voice Transcription** to choose On Demand or Automatic and manage language models. Transcripts and word timings stay in encrypted storage on your device.

A profile is a signed public Nostr event. Boop saves unpublished changes locally and shows when they are waiting for a relay. Profile photos and banners use the same privacy setting, which defaults to **My Contacts**. You can grant temporary image access while visiting a profile.

Independent Nostr relays carry encrypted messages. A separate encrypted signaling service uses the same Nostr identity to set up peer-to-peer calls, including first-contact calls. Current members can discover and join a group call from the chat. Chat Kit plays and displays verified local media. Configured Blossom servers store encrypted attachments, and received files download only when you ask. Open Later checks due messages when you open a chat or load older messages. Relays and media servers can observe connection metadata. Direct calls can reveal network addresses to peers.

Boop runs on Android 13 or later and iOS 18 or later. Keep the app open to receive a call. Some networks prevent direct calls, and delivery depends on relay availability. An identity key backup restores your Nostr address. Recovering MLS conversations or history requires separate Marmot device state and the history available to that device.

[Boop website](https://boop.orielhaim.com) · [Build from source](DEVELOPMENT.md) · [GPL-3.0 license](LICENSE)
