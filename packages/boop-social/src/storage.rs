use std::path::{Path, PathBuf};
use std::time::Duration;

use nostr::prelude::{Event, EventId, Timestamp};
use nostrdb::{Config, Filter, Ndb, Transaction};
use rusqlite::{Connection, OptionalExtension};
use zeroize::Zeroizing;

use crate::SocialError;
use crate::config::{MAX_EVENT_BYTES, MAX_QUERY_RESULTS, PUBLIC_KINDS};

pub(crate) struct PublicStore {
    db: Ndb,
}

pub(crate) fn admit_event(raw: &str) -> Result<Event, SocialError> {
    if raw.len() > MAX_EVENT_BYTES {
        return Err(SocialError::InvalidEvent);
    }
    let event = Event::from_json(raw).map_err(|_| SocialError::InvalidEvent)?;
    let kind = event.kind.as_u16();
    if !PUBLIC_KINDS.contains(&kind)
        || event.created_at.as_secs() > Timestamp::now().as_secs().saturating_add(600)
        || event.tags.len() > 128
        || event.tags.iter().any(|tag| {
            let fields = tag.as_slice();
            fields.len() > 16
                || fields
                    .iter()
                    .any(|field| field.len() > 4096 || field.contains('\0'))
        })
        || event.content.contains('\0')
        || event.as_json().len() > MAX_EVENT_BYTES
    {
        return Err(SocialError::InvalidEvent);
    }
    event.verify().map_err(|_| SocialError::InvalidSignature)?;
    Ok(event)
}

impl PublicStore {
    pub(crate) fn open(path: &Path, cache_mib: u32) -> Result<Self, SocialError> {
        ensure_directory(path)?;
        regular_file_or_missing(&path.join("data.mdb"))?;
        regular_file_or_missing(&path.join("lock.mdb"))?;
        let config = Config::new()
            .set_mapsize(cache_mib as usize * 1024 * 1024)
            .set_ingester_threads(2);
        let db = Ndb::new(path.to_str().ok_or(SocialError::Filesystem)?, &config)
            .map_err(public_error)?;
        Ok(Self { db })
    }

    pub(crate) fn event(&self, id: EventId) -> Result<Option<String>, SocialError> {
        let transaction = Transaction::new(&self.db).map_err(public_error)?;
        match self.db.get_note_by_id(&transaction, id.as_bytes()) {
            Ok(note) => note
                .json_with_bufsize(MAX_EVENT_BYTES * 2)
                .map(Some)
                .map_err(public_error),
            Err(nostrdb::Error::NotFound) => Ok(None),
            Err(error) => Err(public_error(error)),
        }
    }

    pub(crate) fn recent(&self, limit: u32) -> Result<Vec<String>, SocialError> {
        if !(1..=MAX_QUERY_RESULTS).contains(&limit) {
            return Err(SocialError::InvalidConfiguration);
        }
        let filter = Filter::new().kinds([1]).limit(u64::from(limit)).build();
        let transaction = Transaction::new(&self.db).map_err(public_error)?;
        self.db
            .query(&transaction, &[filter], limit as i32)
            .map_err(public_error)?
            .into_iter()
            .map(|row| {
                row.note
                    .json_with_bufsize(MAX_EVENT_BYTES * 2)
                    .map_err(public_error)
            })
            .collect()
    }

    pub(crate) fn enqueue(&self, event: &Event) -> Result<(), SocialError> {
        let message = format!("[\"EVENT\",{}]", event.as_json());
        self.db.process_client_event(&message).map_err(public_error)
    }
}

fn public_error(error: nostrdb::Error) -> SocialError {
    tracing::warn!(category = ?std::mem::discriminant(&error), "public cache operation failed");
    SocialError::PublicStorage
}

fn private_error(error: rusqlite::Error) -> SocialError {
    tracing::warn!(code = ?error.sqlite_error_code(), "private state operation failed");
    SocialError::PrivateStorage
}

pub(crate) struct AccountStore {
    pub(crate) public: Option<PublicStore>,
    pub(crate) unconfirmed: Option<EventId>,
    pub(crate) private: Connection,
    pub(crate) directory: PathBuf,
}

impl AccountStore {
    pub(crate) fn open(
        root: &Path,
        account: &str,
        key: Zeroizing<Vec<u8>>,
        cache_mib: u32,
    ) -> Result<Self, SocialError> {
        let directory = root.join(account);
        ensure_directory(&directory)?;
        let private_path = directory.join("private.sqlite3");
        regular_file_or_missing(&private_path)?;
        let mut private = Connection::open(private_path).map_err(private_error)?;
        private
            .busy_timeout(Duration::from_millis(500))
            .map_err(private_error)?;
        let mut raw_key = Zeroizing::new(String::from("x'"));
        use std::fmt::Write;
        for byte in key.iter() {
            write!(raw_key, "{byte:02x}").expect("formatting into String");
        }
        raw_key.push('\'');
        private
            .key::<&str, _>(None, raw_key.as_bytes(), false)
            .map_err(private_error)?;
        drop(raw_key);
        drop(key);
        let _: String = private
            .pragma_query_value(None, "cipher_version", |row| row.get(0))
            .map_err(private_error)?;
        // Read the encrypted schema before making any changes. A wrong key fails here.
        let version: u32 = private
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(private_error)?;
        if version > 1 {
            return Err(SocialError::UnsupportedSchema);
        }
        if version == 0 {
            let transaction = private.transaction().map_err(private_error)?;
            transaction.execute_batch(
                "CREATE TABLE signed_events (id TEXT PRIMARY KEY, event TEXT NOT NULL) WITHOUT ROWID;
                 PRAGMA user_version=1;",
            ).map_err(private_error)?;
            transaction.commit().map_err(private_error)?;
        }
        // Bound retained signed test events independently of the rebuildable cache.
        let pages: u32 = private
            .pragma_update_and_check(None, "max_page_count", 16_384, |row| row.get(0))
            .map_err(private_error)?;
        if pages != 16_384 {
            return Err(SocialError::PrivateStorage);
        }
        let public = PublicStore::open(&directory.join("public"), cache_mib)?;
        Ok(Self {
            public: Some(public),
            unconfirmed: None,
            private,
            directory,
        })
    }

    pub(crate) fn public(&self) -> Result<&PublicStore, SocialError> {
        self.public.as_ref().ok_or(SocialError::PublicStorage)
    }

    pub(crate) fn persist_signed(&self, event: &Event) -> Result<Event, SocialError> {
        self.private
            .execute(
                "INSERT INTO signed_events (id, event) VALUES (?1, ?2) ON CONFLICT(id) DO NOTHING",
                (event.id.to_hex(), event.as_json()),
            )
            .map_err(private_error)?;
        let stored = self.signed(event.id)?.ok_or(SocialError::PrivateStorage)?;
        let stored = admit_event(&stored).map_err(|_| SocialError::PrivateStorage)?;
        if stored.id != event.id {
            return Err(SocialError::PrivateStorage);
        }
        Ok(stored)
    }

    pub(crate) fn signed(&self, id: EventId) -> Result<Option<String>, SocialError> {
        self.private
            .query_row(
                "SELECT event FROM signed_events WHERE id=?1",
                [id.to_hex()],
                |row| row.get(0),
            )
            .optional()
            .map_err(private_error)
    }

    pub(crate) fn reset_cache(&mut self, cache_mib: u32) -> Result<(), SocialError> {
        drop(self.public.take());
        let path = self.directory.join("public");
        remove_directory(&path)?;
        self.unconfirmed = None;
        self.public = Some(PublicStore::open(&path, cache_mib)?);
        Ok(())
    }
}

fn ensure_directory(path: &Path) -> Result<(), SocialError> {
    match path.symlink_metadata() {
        Ok(meta) if meta.file_type().is_dir() => Ok(()),
        Ok(_) => Err(SocialError::Filesystem),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir_all(path).map_err(|_| SocialError::Filesystem)
        }
        Err(_) => Err(SocialError::Filesystem),
    }
}

fn regular_file_or_missing(path: &Path) -> Result<(), SocialError> {
    match path.symlink_metadata() {
        Ok(meta) if meta.file_type().is_file() => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        _ => Err(SocialError::Filesystem),
    }
}

pub(crate) fn lock_root(root: &Path) -> Result<std::fs::File, SocialError> {
    ensure_directory(root)?;
    let path = root.join(".lock");
    regular_file_or_missing(&path)?;
    let lock = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|_| SocialError::Filesystem)?;
    fs2::FileExt::try_lock_exclusive(&lock).map_err(|_| SocialError::Busy)?;
    Ok(lock)
}

pub(crate) fn remove_directory(path: &Path) -> Result<(), SocialError> {
    match path.symlink_metadata() {
        Ok(meta) if meta.file_type().is_dir() => {
            std::fs::remove_dir_all(path).map_err(|_| SocialError::Filesystem)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        _ => Err(SocialError::Filesystem),
    }
}
