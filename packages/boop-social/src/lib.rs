mod config;
mod engine;
mod error;
mod host;
mod relay;
mod runtime;
mod session;
mod storage;

pub use config::{SessionPolicy, SocialOptions};
pub use engine::SocialEngine;
pub use error::{HostError, SocialError};
pub use host::{HostSigner, SignEventRequest, SigningPurpose};
pub use runtime::SocialCancellation;
pub use session::SocialSession;

uniffi::setup_scaffolding!();
