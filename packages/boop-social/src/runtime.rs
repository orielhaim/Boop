use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use tokio::runtime::{Builder, Handle, Runtime};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::SocialError;

#[derive(Default, uniffi::Object)]
pub struct SocialCancellation(CancellationToken);

#[uniffi::export]
impl SocialCancellation {
    #[uniffi::constructor]
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn cancel(&self) {
        self.0.cancel();
    }
}

pub(crate) fn runtime() -> Result<Runtime, SocialError> {
    Builder::new_multi_thread()
        .thread_name("boop-social")
        .worker_threads(2)
        .max_blocking_threads(2)
        .enable_all()
        .build()
        .map_err(|_| SocialError::Runtime)
}

pub(crate) async fn spawn<T: Send + 'static>(
    runtime: &Handle,
    future: impl Future<Output = Result<T, SocialError>> + Send + 'static,
) -> Result<T, SocialError> {
    runtime
        .spawn(future)
        .await
        .map_err(|_| SocialError::Runtime)?
}

#[derive(Clone, Debug)]
pub(crate) struct Operation {
    policy: CancellationToken,
    caller: CancellationToken,
    dropped: CancellationToken,
    deadline: Instant,
}

impl Operation {
    pub(crate) fn new(
        policy: CancellationToken,
        caller: Arc<SocialCancellation>,
        dropped: CancellationToken,
        duration: Duration,
    ) -> Self {
        Self {
            policy,
            caller: caller.0.clone(),
            dropped,
            deadline: Instant::now() + duration,
        }
    }

    pub(crate) fn check(&self) -> Result<(), SocialError> {
        if self.policy.is_cancelled() || self.caller.is_cancelled() || self.dropped.is_cancelled() {
            return Err(SocialError::Cancelled);
        }
        if Instant::now() >= self.deadline {
            return Err(SocialError::Deadline);
        }
        Ok(())
    }

    pub(crate) async fn wait<T>(
        &self,
        future: impl Future<Output = Result<T, SocialError>>,
    ) -> Result<T, SocialError> {
        tokio::select! {
            biased;
            () = self.policy.cancelled() => Err(SocialError::Cancelled),
            () = self.caller.cancelled() => Err(SocialError::Cancelled),
            () = self.dropped.cancelled() => Err(SocialError::Cancelled),
            () = tokio::time::sleep_until(self.deadline) => Err(SocialError::Deadline),
            result = future => {
                self.check()?;
                result
            }
        }
    }
}
