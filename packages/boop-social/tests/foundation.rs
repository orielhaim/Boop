use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use boop_social::{
    HostError, HostSigner, SessionPolicy, SignEventRequest, SigningPurpose, SocialCancellation,
    SocialEngine, SocialError, SocialOptions, SocialSession,
};
use nostr::event::SignEvent;
use nostr::prelude::{Event, Keys, Kind, Timestamp, UnsignedEvent};
use nostr_sdk::prelude::{Client, LocalRelay};
use tempfile::TempDir;
use tokio::sync::Notify;

const ENABLED: SessionPolicy = SessionPolicy {
    enabled: true,
    foreground: true,
    unlocked: true,
};

#[derive(Clone, Copy)]
enum Signing {
    Correct,
    OtherKey,
    Substituted,
    Pending,
    PauseBeforePublication,
}

struct TestSigner {
    keys: Keys,
    account: String,
    scope: AtomicBool,
    signing: Signing,
    entered: Notify,
    authorizations: AtomicUsize,
}

impl TestSigner {
    fn new(signing: Signing) -> Arc<Self> {
        let keys = Keys::generate();
        Arc::new(Self {
            account: keys.public_key().to_hex(),
            keys,
            scope: AtomicBool::new(true),
            signing,
            entered: Notify::new(),
            authorizations: AtomicUsize::new(0),
        })
    }
}

#[async_trait::async_trait]
impl HostSigner for TestSigner {
    async fn authorize(&self, account: String, generation: u64) -> Result<(), HostError> {
        assert!(generation > 0);
        if account != self.account {
            return Err(HostError::IdentityMismatch);
        }
        if !self.scope.load(Ordering::Acquire) {
            return Err(HostError::Unauthorized);
        }
        let count = self.authorizations.fetch_add(1, Ordering::AcqRel);
        if matches!(self.signing, Signing::PauseBeforePublication) && count == 3 {
            self.entered.notify_one();
            return std::future::pending().await;
        }
        Ok(())
    }

    async fn public_key(&self) -> Result<String, HostError> {
        Ok(self.account.clone())
    }

    async fn sign_event(&self, request: SignEventRequest) -> Result<String, HostError> {
        assert_eq!(request.version, 1);
        assert_eq!(request.purpose, SigningPurpose::PublicTextNote);
        self.authorize(request.account, request.generation).await?;
        let mut unsigned = UnsignedEvent::from_json(request.unsigned_json).unwrap();
        assert_eq!(unsigned.id, Some(unsigned.compute_id()));
        assert_eq!(unsigned.pubkey, self.keys.public_key());
        assert_eq!(unsigned.kind, Kind::TextNote);
        assert!(unsigned.tags.is_empty());

        let event = match self.signing {
            Signing::Correct | Signing::PauseBeforePublication => {
                self.keys.sign_event(unsigned).unwrap()
            }
            Signing::OtherKey => {
                let other = Keys::generate();
                unsigned.pubkey = other.public_key();
                unsigned.id = None;
                other.sign_event(unsigned).unwrap()
            }
            Signing::Substituted => {
                unsigned.content.push_str(" replaced");
                unsigned.id = None;
                self.keys.sign_event(unsigned).unwrap()
            }
            Signing::Pending => {
                self.entered.notify_one();
                return std::future::pending().await;
            }
        };
        Ok(event.sig.to_hex())
    }
}

fn engine(root: &TempDir, timeout_ms: u32, allow_loopback_relay: bool) -> Arc<SocialEngine> {
    SocialEngine::new(SocialOptions {
        storage_root: root.path().to_str().unwrap().to_string(),
        cache_mib: 16,
        operation_timeout_ms: timeout_ms,
        allow_loopback_relay,
    })
    .unwrap()
}

async fn enable(engine: &Arc<SocialEngine>, signer: &Arc<TestSigner>) -> Arc<SocialSession> {
    let session = engine
        .clone()
        .activate(signer.account.clone(), signer.clone(), vec![0x5a; 32])
        .await
        .unwrap();
    session.set_policy(ENABLED).unwrap();
    session
}

async fn sign(session: &Arc<SocialSession>) -> Result<String, SocialError> {
    session
        .clone()
        .sign_note("standalone test".into(), SocialCancellation::new())
        .await
}

#[tokio::test]
async fn local_relay_round_trip_retains_private_state_across_reset_and_reopens() {
    let root = tempfile::tempdir().unwrap();
    let signer = TestSigner::new(Signing::Correct);
    let engine = engine(&root, 10_000, true);
    let session = enable(&engine, &signer).await;
    let relay = LocalRelay::builder().build();
    relay.run().await.unwrap();
    let relay_url = relay.url().await;

    let returned = session
        .clone()
        .publish_note(
            relay_url.to_string(),
            "local relay round trip".into(),
            SocialCancellation::new(),
        )
        .await
        .unwrap();
    let event = Event::from_json(&returned).unwrap();
    event.verify().unwrap();
    assert_eq!(event.pubkey, signer.keys.public_key());
    assert_eq!(event.content, "local relay round trip");

    let id = event.id.to_hex();
    assert_eq!(
        session.clone().cached_event(id.clone()).await.unwrap(),
        Some(returned.clone())
    );
    assert_eq!(
        session.clone().recent_notes(10).await.unwrap(),
        vec![returned]
    );
    let private = session
        .clone()
        .retained_signed_event(id.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(Event::from_json(private).unwrap(), event);
    let file = root.path().join(&signer.account).join("private.sqlite3");
    let bytes = std::fs::read(&file).unwrap();
    assert!(!bytes.starts_with(b"SQLite format 3\0"));
    assert!(
        !bytes
            .windows(event.content.len())
            .any(|bytes| bytes == event.content.as_bytes())
    );

    session.clone().reset_cache().await.unwrap();
    assert_eq!(
        session.clone().cached_event(id.clone()).await.unwrap(),
        None
    );
    assert!(
        session
            .clone()
            .retained_signed_event(id.clone())
            .await
            .unwrap()
            .is_some()
    );
    engine.clone().retire(session.generation()).await.unwrap();

    assert!(matches!(
        engine
            .clone()
            .activate(signer.account.clone(), signer.clone(), vec![0x6b; 32])
            .await,
        Err(SocialError::PrivateStorage)
    ));
    let reopened = enable(&engine, &signer).await;
    assert!(
        reopened
            .clone()
            .retained_signed_event(id)
            .await
            .unwrap()
            .is_some()
    );
    engine
        .clone()
        .remove_account(signer.account.clone())
        .await
        .unwrap();
    assert!(!file.exists());
    assert!(matches!(sign(&reopened).await, Err(SocialError::Retired)));
    engine.shutdown().await.unwrap();
    relay.shutdown();
}

#[tokio::test]
async fn refuses_invalid_signatures_and_mismatched_identity() {
    let root = tempfile::tempdir().unwrap();
    let engine = engine(&root, 5000, false);
    for signing in [Signing::OtherKey, Signing::Substituted] {
        let session = enable(&engine, &TestSigner::new(signing)).await;
        assert!(matches!(
            sign(&session).await,
            Err(SocialError::InvalidSignature)
        ));
    }
    let account = TestSigner::new(Signing::Correct);
    let other = TestSigner::new(Signing::Correct);
    let session = engine
        .clone()
        .activate(account.account.clone(), other, vec![0x5a; 32])
        .await
        .unwrap();
    assert!(matches!(
        sign(&session).await,
        Err(SocialError::Unauthorized)
    ));
    session.set_policy(ENABLED).unwrap();
    assert!(matches!(
        sign(&session).await,
        Err(SocialError::IdentityMismatch)
    ));
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn cancellation_lock_and_switch_revoke_in_flight_signing() {
    let root = tempfile::tempdir().unwrap();
    let engine = engine(&root, 5000, false);
    let old_signer = TestSigner::new(Signing::Pending);
    let old = enable(&engine, &old_signer).await;
    let cancel = SocialCancellation::new();
    let operation = tokio::spawn(old.clone().sign_note("cancel".into(), cancel.clone()));
    old_signer.entered.notified().await;
    assert!(matches!(sign(&old).await, Err(SocialError::Busy)));
    cancel.cancel();
    assert!(matches!(
        operation.await.unwrap(),
        Err(SocialError::Cancelled)
    ));

    let operation = tokio::spawn(
        old.clone()
            .sign_note("lock".into(), SocialCancellation::new()),
    );
    old_signer.entered.notified().await;
    old.set_policy(SessionPolicy {
        unlocked: false,
        ..ENABLED
    })
    .unwrap();
    old.set_policy(ENABLED).unwrap();
    assert!(matches!(
        operation.await.unwrap(),
        Err(SocialError::Cancelled)
    ));

    let operation = tokio::spawn(
        old.clone()
            .sign_note("switch".into(), SocialCancellation::new()),
    );
    old_signer.entered.notified().await;
    let new_signer = TestSigner::new(Signing::Correct);
    let active = enable(&engine, &new_signer).await;
    assert!(matches!(
        operation.await.unwrap(),
        Err(SocialError::Cancelled)
    ));
    assert!(matches!(old.set_policy(ENABLED), Err(SocialError::Retired)));
    engine.clone().retire(old.generation()).await.unwrap();
    assert_eq!(
        Event::from_json(sign(&active).await.unwrap())
            .unwrap()
            .pubkey,
        new_signer.keys.public_key()
    );

    active.invalidate();
    assert!(matches!(sign(&active).await, Err(SocialError::Retired)));
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn host_deadline_and_mdk_style_authorization_revocation() {
    let root = tempfile::tempdir().unwrap();
    let engine = engine(&root, 300, false);
    let blocked = TestSigner::new(Signing::Pending);
    let session = enable(&engine, &blocked).await;
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(2), sign(&session))
            .await
            .unwrap(),
        Err(SocialError::Deadline)
    ));
    let signer = TestSigner::new(Signing::Correct);
    let session = enable(&engine, &signer).await;
    signer.scope.store(false, Ordering::Release);
    assert!(matches!(
        sign(&session).await,
        Err(SocialError::Unauthorized)
    ));
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn rejects_private_events_and_requires_opt_in_for_loopback() {
    let root = tempfile::tempdir().unwrap();
    let engine = engine(&root, 5000, false);
    let signer = TestSigner::new(Signing::Correct);
    let session = enable(&engine, &signer).await;
    let event = signer
        .keys
        .sign_event(UnsignedEvent::new(
            signer.keys.public_key(),
            Timestamp::now(),
            Kind::GiftWrap,
            [],
            "private",
        ))
        .unwrap();
    assert!(matches!(
        session
            .clone()
            .ingest_event(event.as_json(), SocialCancellation::new())
            .await,
        Err(SocialError::InvalidEvent)
    ));
    assert!(matches!(
        session
            .clone()
            .publish_note(
                "ws://127.0.0.1:80".into(),
                "rejected".into(),
                SocialCancellation::new()
            )
            .await,
        Err(SocialError::UnsafeRelay)
    ));
    assert!(session.recent_notes(5).await.unwrap().is_empty());
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn corrupt_cache_can_be_reset_and_root_lock_releases_after_shutdown() {
    let root = tempfile::tempdir().unwrap();
    let signer = TestSigner::new(Signing::Correct);
    let engine = engine(&root, 5000, false);
    let duplicate = SocialEngine::new(SocialOptions {
        storage_root: root.path().to_str().unwrap().to_owned(),
        cache_mib: 16,
        operation_timeout_ms: 5000,
        allow_loopback_relay: false,
    });
    assert!(matches!(duplicate, Err(SocialError::Busy)));

    let session = enable(&engine, &signer).await;
    engine.clone().retire(session.generation()).await.unwrap();
    let account_dir = root.path().join(&signer.account);
    std::fs::write(account_dir.join("public/data.mdb"), [0x5a; 4096]).unwrap();
    assert!(matches!(
        engine
            .clone()
            .activate(signer.account.clone(), signer.clone(), vec![0x5a; 32])
            .await,
        Err(SocialError::PublicStorage)
    ));
    engine
        .clone()
        .reset_closed_account_cache(signer.account.clone())
        .await
        .unwrap();
    assert!(account_dir.join("private.sqlite3").exists());
    let session = enable(&engine, &signer).await;
    assert!(session.recent_notes(20).await.unwrap().is_empty());

    engine.clone().shutdown().await.unwrap();
    engine.clone().shutdown().await.unwrap();
    drop(engine);
    let replacement = self::engine(&root, 5000, false);
    let restored = enable(&replacement, &signer).await;
    assert!(restored.recent_notes(20).await.unwrap().is_empty());
    replacement.shutdown().await.unwrap();
}

#[tokio::test]
async fn invalidating_the_session_before_publication_sends_no_event() {
    let root = tempfile::tempdir().unwrap();
    let engine = engine(&root, 5000, true);
    let signer = TestSigner::new(Signing::PauseBeforePublication);
    let session = enable(&engine, &signer).await;
    let relay = LocalRelay::builder().build();
    relay.run().await.unwrap();
    let url = relay.url().await.to_string();

    let publication = tokio::spawn(session.clone().publish_note(
        url.clone(),
        "revoked before publication".into(),
        SocialCancellation::new(),
    ));
    tokio::time::timeout(Duration::from_secs(3), signer.entered.notified())
        .await
        .unwrap();
    session.invalidate();
    assert!(matches!(
        publication.await.unwrap(),
        Err(SocialError::Cancelled)
    ));

    let reader = Client::new();
    reader.add_relay(url.as_str()).await.unwrap();
    reader
        .try_connect_relay(url.as_str(), Duration::from_secs(2))
        .await
        .unwrap();
    let reader_relay = reader.relay(url.as_str()).await.unwrap().unwrap();
    let events = reader_relay
        .fetch_events(nostr::prelude::Filter::new().author(signer.keys.public_key()))
        .timeout(Duration::from_secs(2))
        .await
        .unwrap();
    assert!(events.is_empty());
    reader.shutdown().await;
    engine.shutdown().await.unwrap();
    relay.shutdown();
}
