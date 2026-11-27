use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tokio::runtime::{Handle, Runtime};
use tokio::sync::{Mutex as AsyncMutex, Semaphore};
use zeroize::Zeroizing;

use crate::host::{AccountSigner, parse_account};
use crate::runtime::{runtime, spawn};
use crate::storage::{AccountStore, lock_root, remove_directory};
use crate::{HostSigner, SocialError, SocialOptions, SocialSession};

#[derive(uniffi::Object)]
pub struct SocialEngine {
    runtime: Mutex<Option<Runtime>>,
    storage_lock: Mutex<Option<std::fs::File>>,
    handle: Handle,
    options: SocialOptions,
    state: AsyncMutex<State>,
    shutting_down: AsyncMutex<()>,
    dns: Arc<Semaphore>,
}

#[derive(Default)]
struct State {
    closed: bool,
    generation: u64,
    active: Option<Arc<SocialSession>>,
}

#[uniffi::export]
impl SocialEngine {
    #[uniffi::constructor]
    pub fn new(options: SocialOptions) -> Result<Arc<Self>, SocialError> {
        options.validate()?;
        let storage_lock = lock_root(std::path::Path::new(&options.storage_root))?;
        let runtime = runtime()?;
        Ok(Arc::new(Self {
            handle: runtime.handle().clone(),
            runtime: Mutex::new(Some(runtime)),
            storage_lock: Mutex::new(Some(storage_lock)),
            options,
            state: AsyncMutex::new(State::default()),
            shutting_down: AsyncMutex::new(()),
            dns: Arc::new(Semaphore::new(1)),
        }))
    }

    /// Activate a new, initially inactive generation. The host enables it after binding it.
    pub async fn activate(
        self: Arc<Self>,
        account: String,
        signer: Arc<dyn HostSigner>,
        storage_key: Vec<u8>,
    ) -> Result<Arc<SocialSession>, SocialError> {
        let key = Zeroizing::new(storage_key);
        if key.len() != 32 {
            return Err(SocialError::InvalidStorageKey);
        }
        let public_key = parse_account(&account)?;
        let handle = self.handle.clone();
        spawn(&handle, async move {
            let mut state = self.state.try_lock().map_err(|_| SocialError::Busy)?;
            if state.closed {
                return Err(SocialError::Closed);
            }
            state.retire().await;
            state.generation = state
                .generation
                .checked_add(1)
                .ok_or(SocialError::Runtime)?;
            let root = PathBuf::from(&self.options.storage_root);
            let directory = account.clone();
            let cache_mib = self.options.cache_mib;
            let store = tokio::task::spawn_blocking(move || {
                AccountStore::open(&root, &directory, key, cache_mib)
            })
            .await
            .map_err(|_| SocialError::Runtime)??;
            let session = Arc::new(SocialSession {
                account,
                generation: state.generation,
                signer: Mutex::new(Some(Arc::new(AccountSigner {
                    account: public_key,
                    generation: state.generation,
                    host: signer,
                }))),
                store: Mutex::new(Some(store)),
                runtime: self.handle.clone(),
                options: self.options.clone(),
                authorization: Mutex::default(),
                permit: Arc::new(Semaphore::new(1)),
                dns: self.dns.clone(),
            });
            state.active = Some(session.clone());
            Ok(session)
        })
        .await
    }

    pub async fn retire(self: Arc<Self>, generation: u64) -> Result<(), SocialError> {
        let handle = self.handle.clone();
        spawn(&handle, async move {
            let mut state = self.state.try_lock().map_err(|_| SocialError::Busy)?;
            if state
                .active
                .as_ref()
                .is_some_and(|session| session.generation == generation)
            {
                state.retire().await;
            }
            Ok(())
        })
        .await
    }

    pub async fn remove_account(self: Arc<Self>, account: String) -> Result<(), SocialError> {
        self.clear_account_files(account, false).await
    }

    /// Recover a closed account's cache independently of its encrypted database.
    pub async fn reset_closed_account_cache(
        self: Arc<Self>,
        account: String,
    ) -> Result<(), SocialError> {
        self.clear_account_files(account, true).await
    }

    pub async fn shutdown(self: Arc<Self>) -> Result<(), SocialError> {
        let _shutdown = self.shutting_down.lock().await;
        if self.runtime.lock().unwrap().is_none() {
            return Ok(());
        }
        let handle = self.handle.clone();
        let engine = self.clone();
        let result = spawn(&handle, async move {
            let mut state = engine.state.lock().await;
            state.closed = true;
            state.retire().await;
            Ok(())
        })
        .await;
        if let Some(runtime) = self.runtime.lock().unwrap().take() {
            runtime.shutdown_background();
        }
        drop(self.storage_lock.lock().unwrap().take());
        result
    }
}

impl SocialEngine {
    async fn clear_account_files(
        self: Arc<Self>,
        account: String,
        cache_only: bool,
    ) -> Result<(), SocialError> {
        parse_account(&account)?;
        let handle = self.handle.clone();
        spawn(&handle, async move {
            let mut state = self.state.try_lock().map_err(|_| SocialError::Busy)?;
            if state.closed {
                return Err(SocialError::Closed);
            }
            if state
                .active
                .as_ref()
                .is_some_and(|session| session.account == account)
            {
                state.retire().await;
            }
            let root = PathBuf::from(&self.options.storage_root);
            tokio::task::spawn_blocking(move || {
                let directory = root.join(account);
                if cache_only {
                    if !directory
                        .symlink_metadata()
                        .is_ok_and(|meta| meta.file_type().is_dir())
                    {
                        return Err(SocialError::Filesystem);
                    }
                    remove_directory(&directory.join("public"))
                } else {
                    remove_directory(&directory)
                }
            })
            .await
            .map_err(|_| SocialError::Runtime)?
        })
        .await
    }
}

impl State {
    async fn retire(&mut self) {
        if let Some(session) = self.active.take() {
            session.close().await;
        }
    }
}

impl Drop for SocialEngine {
    fn drop(&mut self) {
        if let Some(runtime) = self.runtime.get_mut().unwrap().take() {
            if let Some(session) = self.state.get_mut().active.take() {
                session.invalidate();
                // Runtime drop may occur from an async executor. Drain away from that executor.
                let lock = self.storage_lock.get_mut().unwrap().take();
                std::thread::spawn(move || {
                    runtime.block_on(session.close());
                    drop(lock);
                    runtime.shutdown_background();
                });
            } else {
                runtime.shutdown_background();
            }
        }
    }
}
