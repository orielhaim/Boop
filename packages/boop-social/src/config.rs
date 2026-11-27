use std::time::Duration;

use crate::SocialError;

pub(crate) const MAX_EVENT_BYTES: usize = 32 * 1024;
pub(crate) const MAX_NOTE_BYTES: usize = 8 * 1024;
pub(crate) const MAX_QUERY_RESULTS: u32 = 100;
pub(crate) const PUBLIC_KINDS: [u16; 10] = [0, 1, 3, 6, 7, 16, 20, 1111, 10002, 30023];

#[derive(Clone, uniffi::Record)]
pub struct SocialOptions {
    /// An application-owned, non-shared directory.
    pub storage_root: String,
    pub cache_mib: u32,
    pub operation_timeout_ms: u32,
    /// Explicit opt-in to plaintext WebSockets on literal loopback addresses.
    pub allow_loopback_relay: bool,
}

impl SocialOptions {
    pub(crate) fn validate(&self) -> Result<(), SocialError> {
        if !std::path::Path::new(&self.storage_root).is_absolute()
            || !(16..=512).contains(&self.cache_mib)
            || !(250..=30_000).contains(&self.operation_timeout_ms)
        {
            return Err(SocialError::InvalidConfiguration);
        }
        Ok(())
    }

    pub(crate) fn deadline(&self) -> Duration {
        Duration::from_millis(u64::from(self.operation_timeout_ms))
    }
}

#[derive(Clone, Copy, Default, uniffi::Record)]
pub struct SessionPolicy {
    pub enabled: bool,
    pub foreground: bool,
    pub unlocked: bool,
}

impl SessionPolicy {
    pub(crate) fn permits_operations(self) -> bool {
        self.enabled && self.foreground && self.unlocked
    }
}
