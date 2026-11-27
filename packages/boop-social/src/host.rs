use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use nostr::event::{AsyncSignEvent, Signature};
use nostr::prelude::{Event, Kind, PublicKey, UnsignedEvent};

use crate::{HostError, SocialError};

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum SigningPurpose {
    PublicTextNote,
}

#[derive(Clone, uniffi::Record)]
pub struct SignEventRequest {
    pub version: u16,
    pub account: String,
    pub generation: u64,
    pub purpose: SigningPurpose,
    pub unsigned_json: String,
}

#[uniffi::export(with_foreign)]
#[async_trait::async_trait]
pub trait HostSigner: Send + Sync {
    async fn authorize(&self, account: String, generation: u64) -> Result<(), HostError>;
    async fn public_key(&self) -> Result<String, HostError>;
    async fn sign_event(&self, request: SignEventRequest) -> Result<String, HostError>;
}

pub(crate) struct AccountSigner {
    pub(crate) account: PublicKey,
    pub(crate) generation: u64,
    pub(crate) host: Arc<dyn HostSigner>,
}

impl std::fmt::Debug for AccountSigner {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AccountSigner")
            .finish_non_exhaustive()
    }
}

pub(crate) fn parse_account(account: &str) -> Result<PublicKey, SocialError> {
    let key = PublicKey::from_hex(account).map_err(|_| SocialError::InvalidAccount)?;
    if key.to_hex() != account || key.xonly().is_err() {
        return Err(SocialError::InvalidAccount);
    }
    Ok(key)
}

impl AccountSigner {
    pub(crate) async fn authorize(&self) -> Result<(), SocialError> {
        let actual = self.host.public_key().await?;
        if parse_account(&actual).ok() != Some(self.account) {
            return Err(SocialError::IdentityMismatch);
        }
        self.host
            .authorize(self.account.to_hex(), self.generation)
            .await?;
        Ok(())
    }
}

impl AsyncSignEvent for AccountSigner {
    type Error = SocialError;

    fn sign_event_async(
        &self,
        mut unsigned: UnsignedEvent,
    ) -> Pin<Box<dyn Future<Output = Result<Event, SocialError>> + Send + '_>> {
        Box::pin(async move {
            if unsigned.pubkey != self.account {
                return Err(SocialError::IdentityMismatch);
            }
            if unsigned.kind != Kind::TextNote || !unsigned.tags.is_empty() {
                return Err(SocialError::Unauthorized);
            }
            unsigned
                .verify_id()
                .map_err(|_| SocialError::InvalidEvent)?;
            unsigned.ensure_id();
            self.authorize().await?;
            let signature = self
                .host
                .sign_event(SignEventRequest {
                    version: 1,
                    account: self.account.to_hex(),
                    generation: self.generation,
                    purpose: SigningPurpose::PublicTextNote,
                    unsigned_json: unsigned.as_json(),
                })
                .await?;
            let signature =
                Signature::from_hex(&signature).map_err(|_| SocialError::InvalidSignature)?;
            let event = unsigned
                .add_signature(signature)
                .map_err(|_| SocialError::InvalidSignature)?;
            self.authorize().await?;
            Ok(event)
        })
    }
}
