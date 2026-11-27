use std::future::Future;
use std::sync::{Arc, Mutex};

use nostr::event::AsyncSignEvent;
use nostr::prelude::{Event, EventId, Kind, Timestamp, UnsignedEvent};
use tokio::runtime::Handle;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use crate::config::MAX_NOTE_BYTES;
use crate::host::AccountSigner;
use crate::relay;
use crate::runtime::{Operation, spawn};
use crate::storage::{AccountStore, admit_event};
use crate::{SessionPolicy, SocialCancellation, SocialError, SocialOptions};

#[derive(uniffi::Object)]
pub struct SocialSession {
    pub(crate) signer: Mutex<Option<Arc<AccountSigner>>>,
    pub(crate) store: Mutex<Option<AccountStore>>,
    pub(crate) account: String,
    pub(crate) generation: u64,
    pub(crate) runtime: Handle,
    pub(crate) options: SocialOptions,
    pub(crate) authorization: Mutex<Authorization>,
    pub(crate) permit: Arc<Semaphore>,
    pub(crate) dns: Arc<Semaphore>,
}

#[derive(Default)]
pub(crate) struct Authorization {
    pub(crate) retired: bool,
    pub(crate) active: Option<CancellationToken>,
}

#[uniffi::export]
impl SocialSession {
    pub fn account(&self) -> String {
        self.account.clone()
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn set_policy(&self, policy: SessionPolicy) -> Result<(), SocialError> {
        let mut authorization = self.authorization.lock().unwrap();
        if authorization.retired {
            return Err(SocialError::Retired);
        }
        if policy.permits_operations() {
            authorization
                .active
                .get_or_insert_with(CancellationToken::new);
        } else if let Some(active) = authorization.active.take() {
            active.cancel();
        }
        Ok(())
    }

    /// Immediately revoke admission and cancel ongoing work. Retirement is terminal.
    pub fn invalidate(&self) {
        let mut authorization = self.authorization.lock().unwrap();
        authorization.retired = true;
        if let Some(active) = authorization.active.take() {
            active.cancel();
        }
    }

    pub async fn sign_note(
        self: Arc<Self>,
        content: String,
        cancellation: Arc<SocialCancellation>,
    ) -> Result<String, SocialError> {
        self.run(cancellation, |session, operation| async move {
            let (_, event) = session.sign(content, &operation).await?;
            Ok(event.as_json())
        })
        .await
    }

    pub async fn publish_note(
        self: Arc<Self>,
        relay_url: String,
        content: String,
        cancellation: Arc<SocialCancellation>,
    ) -> Result<String, SocialError> {
        self.run(cancellation, |session, operation| async move {
            let endpoint =
                relay::RelayEndpoint::parse(&relay_url, session.options.allow_loopback_relay)?;
            let (signer, signed) = session.sign(content, &operation).await?;
            let event = session.with_store(&operation, |store| store.persist_signed(&signed))?;
            let received =
                relay::publish_and_read(endpoint, session.dns.clone(), &event, &signer, &operation)
                    .await?;
            let verified = admit_event(&received.as_json())?;
            session.commit(verified, &operation).await
        })
        .await
    }

    pub async fn ingest_event(
        self: Arc<Self>,
        event_json: String,
        cancellation: Arc<SocialCancellation>,
    ) -> Result<String, SocialError> {
        self.run(cancellation, |session, operation| async move {
            session.commit(admit_event(&event_json)?, &operation).await
        })
        .await
    }

    pub async fn cached_event(self: Arc<Self>, id: String) -> Result<Option<String>, SocialError> {
        self.run(
            SocialCancellation::new(),
            move |session, operation| async move {
                let id = parse_id(&id)?;
                session.with_store(&operation, |store| store.public()?.event(id))
            },
        )
        .await
    }

    pub async fn recent_notes(self: Arc<Self>, limit: u32) -> Result<Vec<String>, SocialError> {
        self.run(
            SocialCancellation::new(),
            move |session, operation| async move {
                session.with_store(&operation, |store| store.public()?.recent(limit))
            },
        )
        .await
    }

    pub async fn retained_signed_event(
        self: Arc<Self>,
        id: String,
    ) -> Result<Option<String>, SocialError> {
        self.run(
            SocialCancellation::new(),
            move |session, operation| async move {
                let id = parse_id(&id)?;
                session.with_store(&operation, |store| store.signed(id))
            },
        )
        .await
    }

    pub async fn reset_cache(self: Arc<Self>) -> Result<(), SocialError> {
        self.run(
            SocialCancellation::new(),
            move |session, operation| async move {
                session.with_store(&operation, |store| {
                    store.reset_cache(session.options.cache_mib)
                })
            },
        )
        .await
    }
}

impl SocialSession {
    pub(crate) async fn close(&self) {
        self.invalidate();
        // The permit spans the worker, including relay shutdown and the last storage read.
        let _permit = self
            .permit
            .acquire()
            .await
            .expect("session semaphore is never closed");
        drop(self.signer.lock().unwrap().take());
        let store = self.store.lock().unwrap().take();
        if store.is_some() {
            let _ = tokio::task::spawn_blocking(move || drop(store)).await;
        }
    }

    async fn run<T, F, Fut>(
        self: Arc<Self>,
        cancellation: Arc<SocialCancellation>,
        action: F,
    ) -> Result<T, SocialError>
    where
        T: Send + 'static,
        F: FnOnce(Arc<Self>, Operation) -> Fut + Send + 'static,
        Fut: Future<Output = Result<T, SocialError>> + Send + 'static,
    {
        let dropped = CancellationToken::new();
        let _on_drop = dropped.clone().drop_guard();
        let runtime = self.runtime.clone();
        spawn(&runtime, async move {
            let (permit, token) = {
                let authorization = self.authorization.lock().unwrap();
                if authorization.retired {
                    return Err(SocialError::Retired);
                }
                let token = authorization
                    .active
                    .clone()
                    .ok_or(SocialError::Unauthorized)?;
                let permit = self
                    .permit
                    .clone()
                    .try_acquire_owned()
                    .map_err(|_| SocialError::Busy)?;
                (permit, token)
            };
            let _permit = permit;
            let operation = Operation::new(token, cancellation, dropped, self.options.deadline());
            operation.check()?;
            let result = action(self, operation.clone()).await?;
            operation.check()?;
            Ok(result)
        })
        .await
    }

    fn with_store<T>(
        &self,
        operation: &Operation,
        action: impl FnOnce(&mut AccountStore) -> Result<T, SocialError>,
    ) -> Result<T, SocialError> {
        let mut store = self.store.lock().unwrap();
        operation.check()?;
        action(store.as_mut().ok_or(SocialError::Retired)?)
    }

    async fn sign(
        &self,
        content: String,
        operation: &Operation,
    ) -> Result<(Arc<AccountSigner>, Event), SocialError> {
        if content.trim().is_empty() || content.len() > MAX_NOTE_BYTES || content.contains('\0') {
            return Err(SocialError::InvalidEvent);
        }
        let signer = self
            .signer
            .lock()
            .unwrap()
            .clone()
            .ok_or(SocialError::Retired)?;
        let unsigned = UnsignedEvent::new(
            signer.account,
            Timestamp::now(),
            Kind::TextNote,
            [],
            content,
        );
        let event = operation.wait(signer.sign_event_async(unsigned)).await?;
        admit_event(&event.as_json())?;
        Ok((signer, event))
    }

    async fn commit(&self, event: Event, operation: &Operation) -> Result<String, SocialError> {
        let id = event.id;
        self.with_store(operation, |store| {
            if let Some(previous) = store.unconfirmed {
                if store.public()?.event(previous)?.is_none() {
                    return Err(SocialError::CommitUnconfirmed);
                }
                store.unconfirmed = None;
            }
            if store.public()?.event(id)?.is_none() {
                store.public()?.enqueue(&event)?;
                store.unconfirmed = Some(id);
            }
            Ok(())
        })?;
        // Queue admission does not imply a successful LMDB commit. Read a new transaction
        // on each observation, and stop new admissions if a writer never commits.
        let mut probe = tokio::time::interval(std::time::Duration::from_millis(15));
        operation
            .wait(async {
                loop {
                    probe.tick().await;
                    if let Some(committed) = self.with_store(operation, |store| {
                        let committed = store.public()?.event(id)?;
                        if committed.is_some() {
                            store.unconfirmed = None;
                        }
                        Ok(committed)
                    })? {
                        if admit_event(&committed)?.id != id {
                            return Err(SocialError::PublicStorage);
                        }
                        return Ok(committed);
                    }
                }
            })
            .await
            .map_err(|error| match error {
                SocialError::Deadline => SocialError::CommitUnconfirmed,
                error => error,
            })
    }
}

fn parse_id(id: &str) -> Result<EventId, SocialError> {
    EventId::from_hex(id).map_err(|_| SocialError::InvalidEvent)
}
