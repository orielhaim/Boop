#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum HostError {
    #[error("Host authorization denied")]
    Unauthorized,
    #[error("Host identity does not match")]
    IdentityMismatch,
    #[error("Host signing operation was cancelled")]
    Cancelled,
    #[error("Host signing failed")]
    SigningFailed,
}

impl From<uniffi::UnexpectedUniFFICallbackError> for HostError {
    fn from(_: uniffi::UnexpectedUniFFICallbackError) -> Self {
        Self::SigningFailed
    }
}

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum SocialError {
    #[error("Invalid configuration")]
    InvalidConfiguration,
    #[error("Invalid account public key")]
    InvalidAccount,
    #[error("Engine is closed")]
    Closed,
    #[error("Session is retired")]
    Retired,
    #[error("Session is disabled, locked, or backgrounded")]
    Unauthorized,
    #[error("Resource already in use")]
    Busy,
    #[error("Operation was cancelled")]
    Cancelled,
    #[error("Operation timed out")]
    Deadline,
    #[error("Host identity does not match")]
    IdentityMismatch,
    #[error("Host signing failed")]
    HostSigning,
    #[error("Invalid or unsupported public event")]
    InvalidEvent,
    #[error("Invalid event signature")]
    InvalidSignature,
    #[error("Relay address is not admitted")]
    UnsafeRelay,
    #[error("Relay operation failed")]
    Relay,
    #[error("Storage path or I/O failure")]
    Filesystem,
    #[error("Public event cache failed")]
    PublicStorage,
    #[error("Event was not observed in committed storage")]
    CommitUnconfirmed,
    #[error("Encrypted private state could not be opened or updated")]
    PrivateStorage,
    #[error("Storage key must contain 32 bytes")]
    InvalidStorageKey,
    #[error("Unsupported private state schema")]
    UnsupportedSchema,
    #[error("SDK runtime failure")]
    Runtime,
}

impl From<HostError> for SocialError {
    fn from(error: HostError) -> Self {
        match error {
            HostError::Unauthorized => Self::Unauthorized,
            HostError::IdentityMismatch => Self::IdentityMismatch,
            HostError::Cancelled => Self::Cancelled,
            HostError::SigningFailed => Self::HostSigning,
        }
    }
}
