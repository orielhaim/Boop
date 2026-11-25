use std::{
    collections::{HashMap, HashSet},
    net::SocketAddr,
    path::{Component, Path, PathBuf},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use librqbit::{
    AddTorrent, AddTorrentOptions, AddTorrentResponse, DhtSessionConfig, FileStream,
    ManagedTorrent, Session, SessionOptions, api::TorrentIdOrHash,
};
use serde_json::{Value, json};
use tokio::{io::AsyncReadExt, runtime::Runtime, sync::Mutex as AsyncMutex, time::timeout};
use tokio_util::sync::CancellationToken;

const MAX_REQUEST_BYTES: usize = 768 * 1024;
const MAX_METADATA_BYTES: usize = 512 * 1024;
const MAX_FILES: usize = 1024;
const MAX_FILE_SIZE: u64 = 2 * 1024 * 1024 * 1024 * 1024;

static ACCOUNTS: OnceLock<Mutex<HashMap<PathBuf, Arc<Account>>>> = OnceLock::new();
static COMMAND_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static STREAM_LEASES: OnceLock<Mutex<HashMap<String, Arc<StreamLease>>>> = OnceLock::new();
static READERS: OnceLock<Mutex<HashMap<u64, Arc<Reader>>>> = OnceLock::new();
static NEXT_READER_ID: AtomicU64 = AtomicU64::new(1);
const MAX_NATIVE_READ_BYTES: usize = 64 * 1024;
const MAX_STREAM_READERS: usize = 64;

struct Account {
    root: PathBuf,
    runtime: Runtime,
    session: Arc<Session>,
    records: Mutex<HashMap<String, Arc<Record>>>,
    results: Mutex<HashMap<String, Value>>,
    active_torrents: Mutex<HashMap<String, String>>,
    peers: Mutex<HashMap<String, Vec<SocketAddr>>>,
    tasks: Mutex<HashMap<String, tokio::task::JoinHandle<()>>>,
    retiring: AtomicBool,
}

struct Record {
    state: Mutex<Value>,
    cancel: CancellationToken,
    handle: Mutex<Option<Arc<ManagedTorrent>>>,
    done: tokio::sync::watch::Sender<bool>,
    torrent_id: Option<String>,
    file_index: Option<usize>,
    expected_size: Option<u64>,
    file_components: Option<Vec<String>>,
    handle_ready: tokio::sync::watch::Sender<bool>,
    accepting_streams: AtomicBool,
    published: AtomicBool,
}

struct StreamLease {
    account: Arc<Account>,
    record: Arc<Record>,
    file_index: usize,
    size: u64,
    closed: AtomicBool,
}

struct Reader {
    lease: Arc<StreamLease>,
    cancel: CancellationToken,
    state: AsyncMutex<ReaderState>,
}

struct ReaderState {
    position: u64,
    remaining: u64,
    source: Option<ReaderSource>,
}

enum ReaderSource {
    Torrent(FileStream),
    Local(std::fs::File),
}

fn stream_leases() -> &'static Mutex<HashMap<String, Arc<StreamLease>>> {
    STREAM_LEASES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn readers() -> &'static Mutex<HashMap<u64, Arc<Reader>>> {
    READERS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn accounts() -> &'static Mutex<HashMap<PathBuf, Arc<Account>>> {
    ACCOUNTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn string_field<'a>(request: &'a Value, name: &str) -> Result<&'a str, Value> {
    request
        .get(name)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| failed("invalid_request"))
}

fn failed(code: &str) -> Value {
    json!({"kind":"failed", "code":code})
}

fn valid_request_id(value: &str) -> bool {
    value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
}

fn valid_torrent_id(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn explicit_peers(magnet: &str) -> Result<Vec<SocketAddr>, Value> {
    let url = url::Url::parse(magnet).map_err(|_| failed("invalid_magnet"))?;
    let mut peers = Vec::new();
    for (key, value) in url.query_pairs() {
        if key == "x.pe" {
            if peers.len() >= 16 {
                return Err(failed("too_many_peers"));
            }
            let address = value
                .parse::<SocketAddr>()
                .map_err(|_| failed("invalid_peer"))?;
            if address.port() == 0 {
                return Err(failed("invalid_peer"));
            }
            if !librqbit_core::network_policy::is_public_socket_addr(address)
                && !cfg!(all(feature = "torrent-test-fixture", debug_assertions))
            {
                return Err(failed("invalid_peer"));
            }
            peers.push(address);
        }
    }
    Ok(peers)
}

fn safe_relative_file(path: &Path) -> Option<Vec<String>> {
    let components = path.components().collect::<Vec<_>>();
    if components.is_empty()
        || components
            .iter()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return None;
    }
    let components = components
        .into_iter()
        .map(|part| part.as_os_str().to_str().map(str::to_owned))
        .collect::<Option<Vec<_>>>()?;
    if components.len() > 32
        || components.iter().any(|part| {
            part.is_empty()
                || part.len() > 255
                || part == "."
                || part == ".."
                || part.contains('/')
                || part.contains('\\')
                || part.contains('\0')
        })
        || components.iter().map(String::len).sum::<usize>() > 1024
    {
        return None;
    }
    Some(components)
}

fn account_root(root: &str, scope: &str) -> Result<PathBuf, Value> {
    if scope.is_empty()
        || scope.len() > 128
        || !scope
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
    {
        return Err(failed("invalid_scope"));
    }
    let root = PathBuf::from(root);
    std::fs::create_dir_all(&root).map_err(|_| failed("storage"))?;
    let canonical_root = std::fs::canonicalize(&root).map_err(|_| failed("storage"))?;
    let scoped = canonical_root.join(scope);
    std::fs::create_dir_all(&scoped).map_err(|_| failed("storage"))?;
    let scoped = std::fs::canonicalize(scoped).map_err(|_| failed("storage"))?;
    if !scoped.starts_with(&canonical_root) {
        return Err(failed("invalid_scope"));
    }
    Ok(scoped)
}

fn account(root: &str, scope: &str) -> Result<Arc<Account>, Value> {
    let path = account_root(root, scope)?;
    if let Some(account) = accounts()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&path)
        .cloned()
    {
        return Ok(account);
    }

    let session_path = path.join(".engine");
    std::fs::create_dir_all(&session_path).map_err(|_| failed("storage"))?;
    let options = SessionOptions {
        dht: if cfg!(feature = "torrent-test-fixture") {
            None
        } else {
            Some(DhtSessionConfig {
                bootstrap_addrs: None,
                port: None,
                persistence: None,
            })
        },
        disable_trackers: cfg!(feature = "torrent-test-fixture"),
        disable_local_service_discovery: true,
        listen: None,
        disable_upload: true,
        ..Default::default()
    };
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .map_err(|_| failed("engine"))?;
    let session = runtime
        .block_on(Session::new_with_opts(session_path, options))
        .map_err(|_| failed("engine"))?;
    let created = Arc::new(Account {
        root: path.clone(),
        runtime,
        session,
        records: Mutex::new(HashMap::new()),
        results: Mutex::new(HashMap::new()),
        active_torrents: Mutex::new(HashMap::new()),
        peers: Mutex::new(HashMap::new()),
        tasks: Mutex::new(HashMap::new()),
        retiring: AtomicBool::new(false),
    });
    let mut accounts = accounts()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    Ok(accounts
        .entry(path)
        .or_insert_with(|| created.clone())
        .clone())
}

fn cached_account(root: &str, scope: &str) -> Result<Arc<Account>, Value> {
    if scope.is_empty()
        || scope.len() > 128
        || !scope
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
    {
        return Err(failed("invalid_scope"));
    }
    let root = std::fs::canonicalize(root).map_err(|_| failed("unknown_request"))?;
    let scoped = std::fs::canonicalize(root.join(scope)).map_err(|_| failed("unknown_request"))?;
    if !scoped.starts_with(&root) {
        return Err(failed("invalid_scope"));
    }
    accounts()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&scoped)
        .cloned()
        .ok_or_else(|| failed("unknown_request"))
}

fn set_state(record: &Record, value: Value) {
    *record
        .state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = value;
}

fn has_stream_lease(record: &Arc<Record>) -> bool {
    stream_leases()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .values()
        .any(|lease| Arc::ptr_eq(&lease.record, record))
}

fn stop_stream_admission_if_idle(record: &Record) -> bool {
    let leases = stream_leases()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let has_lease = leases
        .values()
        .any(|lease| std::ptr::eq(Arc::as_ptr(&lease.record), record));
    if !has_lease {
        record.accepting_streams.store(false, Ordering::Release);
    }
    has_lease
}

fn join_task(account: &Account, request_id: &str) {
    let handle = account
        .tasks
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(request_id);
    if let Some(handle) = handle {
        let _ = account.runtime.block_on(handle);
    }
}

fn finish_record(account: &Account, request_id: &str, record: &Record, value: Value) {
    set_state(record, value.clone());
    let current_record = account
        .records
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(request_id)
        .cloned();
    let keep_handle = current_record.is_some_and(|candidate| has_stream_lease(&candidate));
    let is_completed = value.get("kind").and_then(Value::as_str) == Some("completed");
    let completed_handle_retired = is_completed
        && record
            .handle
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_none();
    if (!keep_handle || completed_handle_retired)
        && let Some(torrent_id) = &record.torrent_id
    {
        account
            .active_torrents
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(torrent_id);
    }
    let mut results = account
        .results
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    results.insert(request_id.to_owned(), value);
    if results.len() > 16
        && let Some(oldest) = results.keys().next().cloned()
    {
        results.remove(&oldest);
    }
    if !keep_handle {
        account
            .records
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(request_id);
    }
    let _ = record.done.send(true);
}

fn metadata_result(info: &librqbit::ListOnlyResponse) -> Result<Value, Value> {
    if info.torrent_bytes.len() > MAX_METADATA_BYTES {
        return Err(failed("metadata_too_large"));
    }
    let mut files = Vec::new();
    let mut seen = HashSet::new();
    for (index, file) in info.info.iter_file_details().enumerate() {
        if index >= MAX_FILES {
            return Err(failed("too_many_files"));
        }
        let path = safe_relative_file(&file.filename.to_pathbuf())
            .ok_or_else(|| failed("invalid_metadata"))?;
        if file.attrs().symlink {
            return Err(failed("invalid_metadata"));
        }
        if file.len > MAX_FILE_SIZE {
            return Err(failed("file_too_large"));
        }
        let key = path.join("/");
        if !seen.insert(key.clone())
            || (1..path.len()).any(|length| seen.contains(&path[..length].join("/")))
            || seen
                .iter()
                .any(|existing| existing.starts_with(&format!("{key}/")))
        {
            return Err(failed("path_collision"));
        }
        files.push(json!({"index":index, "path":path, "size":file.len}));
    }
    if files.is_empty() {
        return Err(failed("invalid_metadata"));
    }
    Ok(json!({
        "kind":"resolved",
        "torrentId":info.info_hash.as_string(),
        "name":info.info.name().map(|name| name.into_owned()).unwrap_or_default(),
        "files":files,
        "metadata":STANDARD.encode(&info.torrent_bytes),
    }))
}

fn resolve(account: &Arc<Account>, request: &Value) -> Value {
    let request_id = match string_field(request, "requestId") {
        Ok(id) if valid_request_id(id) => id.to_owned(),
        _ => return failed("invalid_request"),
    };
    let magnet = match string_field(request, "magnet") {
        Ok(magnet) if magnet.len() <= 16 * 1024 && magnet.starts_with("magnet:") => {
            magnet.to_owned()
        }
        _ => return failed("invalid_magnet"),
    };
    let expected_hash = match librqbit::Magnet::parse(&magnet)
        .ok()
        .and_then(|magnet| magnet.as_id20())
    {
        Some(hash) => hash.as_string(),
        None => return failed("invalid_magnet"),
    };
    let peers = match explicit_peers(&magnet) {
        Ok(peers) => peers,
        Err(error) => return error,
    };
    let record = Arc::new(Record {
        state: Mutex::new(json!({"kind":"pending"})),
        cancel: CancellationToken::new(),
        handle: Mutex::new(None),
        done: tokio::sync::watch::channel(false).0,
        torrent_id: None,
        file_index: None,
        expected_size: None,
        file_components: None,
        handle_ready: tokio::sync::watch::channel(false).0,
        accepting_streams: AtomicBool::new(true),
        published: AtomicBool::new(false),
    });
    {
        let mut records = account
            .records
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if records.contains_key(&request_id) {
            return failed("duplicate_request");
        }
        records.insert(request_id.clone(), record.clone());
    }
    let session = account.session.clone();
    let task_record = record.clone();
    let task_account = account.clone();
    let task_request_id = request_id.clone();
    let runtime_handle = account.runtime.handle().clone();
    let task = runtime_handle.spawn(async move {
        let opts = AddTorrentOptions {
            list_only: true,
            initial_peers: Some(peers),
            ..Default::default()
        };
        let operation = async {
            tokio::select! {
                _ = task_record.cancel.cancelled() => Err(failed("cancelled")),
                result = timeout(Duration::from_secs(60), session.add_torrent(AddTorrent::from_url(magnet), Some(opts))) => {
                    match result {
                        Ok(Ok(AddTorrentResponse::ListOnly(info))) if info.info_hash.as_string() == expected_hash => {
                            let result = metadata_result(&info);
                            if result.is_ok() {
                                task_account
                                    .peers
                                    .lock()
                                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                                    .insert(expected_hash.clone(), info.seen_peers.clone());
                            }
                            result
                        },
                        Ok(Ok(AddTorrentResponse::ListOnly(_))) => Err(failed("torrent_id_mismatch")),
                        Ok(Ok(_)) => Err(failed("metadata_unavailable")),
                        Ok(Err(_)) => Err(failed("resolve_failed")),
                        Err(_) => Err(failed("resolve_timeout")),
                    }
                }
            }
        };
        match operation.await {
            Ok(value) => finish_record(&task_account, &task_request_id, &task_record, value),
            Err(value) if value.get("code").and_then(Value::as_str) == Some("cancelled") => {
                finish_record(
                    &task_account,
                    &task_request_id,
                    &task_record,
                    json!({"kind":"stopped"}),
                );
            }
            Err(value) => finish_record(&task_account, &task_request_id, &task_record, value),
        }
    });
    account
        .tasks
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(request_id, task);
    json!({"kind":"pending"})
}

fn clean_owned_file(path: &Path) -> Result<(), Value> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err(failed("unsafe_path"))
        }
        Ok(_) => std::fs::remove_file(path).map_err(|_| failed("storage")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(failed("storage")),
    }
}

fn clean_staged_file(root: &Path, torrent_id: &str, components: &[String]) {
    let engine_root = root.join(".engine");
    let Ok(engine_root) = std::fs::canonicalize(&engine_root) else {
        return;
    };
    if !engine_root.starts_with(root) {
        return;
    }
    let Ok(stage) = std::fs::canonicalize(engine_root.join(torrent_id)) else {
        return;
    };
    if !stage.starts_with(&engine_root) {
        return;
    }
    let mut source = stage.clone();
    for component in components {
        source.push(component);
    }
    if !std::fs::symlink_metadata(&source).is_ok_and(|metadata| metadata.is_file()) {
        return;
    }
    let Ok(source) = std::fs::canonicalize(source) else {
        return;
    };
    if !source.starts_with(&stage)
        || !std::fs::symlink_metadata(&source).is_ok_and(|metadata| metadata.is_file())
    {
        return;
    }
    if std::fs::remove_file(&source).is_err() {
        return;
    }
    let mut parent = source.parent();
    while let Some(directory) = parent {
        if directory == stage
            || !directory.starts_with(&stage)
            || std::fs::remove_dir(directory).is_err()
        {
            break;
        }
        parent = directory.parent();
    }
    let _ = std::fs::remove_dir(&stage);
    let _ = std::fs::remove_dir(&engine_root);
}

fn publish_file(
    root: &Path,
    torrent_id: &str,
    file_index: usize,
    file_components: &[String],
    expected_size: u64,
) -> Result<(), Value> {
    let stage = root.join(".engine").join(torrent_id);
    let stage = std::fs::canonicalize(&stage).map_err(|_| failed("incomplete"))?;
    let mut source = stage.clone();
    for component in file_components {
        source.push(component);
    }
    let source_meta = std::fs::symlink_metadata(&source).map_err(|_| failed("incomplete"))?;
    if !source_meta.is_file() || source_meta.len() != expected_size {
        return Err(failed("incomplete"));
    }
    let source = std::fs::canonicalize(source).map_err(|_| failed("incomplete"))?;
    if !source.starts_with(&stage) {
        return Err(failed("unsafe_path"));
    }
    #[cfg(unix)]
    std::fs::File::open(&source)
        .and_then(|file| file.sync_all())
        .map_err(|_| failed("publish_failed"))?;

    let output_dir = root.join(torrent_id);
    std::fs::create_dir_all(&output_dir).map_err(|_| failed("storage"))?;
    let output_dir_canonical = std::fs::canonicalize(&output_dir).map_err(|_| failed("storage"))?;
    if !output_dir_canonical.starts_with(root) {
        return Err(failed("unsafe_path"));
    }
    let part = output_dir.join(format!("{file_index}.part"));
    let complete = output_dir.join(format!("{file_index}.complete"));
    if std::fs::symlink_metadata(&complete).is_ok() {
        return Err(failed("already_published"));
    }
    clean_owned_file(&part)?;
    let staged = match std::fs::hard_link(&source, &part) {
        Ok(()) => &part,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::Unsupported
            ) =>
        {
            // Android storage policy can deny hard links. The engine's open
            // descriptor still reads the same inode after a same-volume move.
            &source
        }
        Err(_) => return Err(failed("publish_failed")),
    };
    if let Err(error) = std::fs::rename(staged, &complete) {
        if staged == &part {
            let _ = std::fs::remove_file(&part);
        }
        return Err(if error.kind() == std::io::ErrorKind::AlreadyExists {
            failed("already_published")
        } else {
            failed("publish_failed")
        });
    }
    #[cfg(unix)]
    {
        std::fs::File::open(&output_dir)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| failed("publish_failed"))?;
        if staged == &source
            && let Some(parent) = source.parent()
        {
            std::fs::File::open(parent)
                .and_then(|directory| directory.sync_all())
                .map_err(|_| failed("publish_failed"))?;
        }
    }
    Ok(())
}

fn start(account: &Arc<Account>, request: &Value) -> Value {
    let request_id = match string_field(request, "requestId") {
        Ok(id) if valid_request_id(id) => id.to_owned(),
        _ => return failed("invalid_request"),
    };
    let torrent_id = match string_field(request, "torrentId") {
        Ok(id) if valid_torrent_id(id) => id.to_ascii_lowercase(),
        _ => return failed("invalid_torrent_id"),
    };
    let file_index = match request.get("fileIndex").and_then(Value::as_u64) {
        Some(index) if index < MAX_FILES as u64 => index as usize,
        _ => return failed("invalid_file_index"),
    };
    let expected_size = match request.get("size").and_then(Value::as_u64) {
        Some(size) if size <= MAX_FILE_SIZE => size,
        _ => return failed("invalid_size"),
    };
    let metadata = match string_field(request, "metadata")
        .ok()
        .and_then(|encoded| STANDARD.decode(encoded).ok())
    {
        Some(metadata) if !metadata.is_empty() && metadata.len() <= MAX_METADATA_BYTES => metadata,
        _ => return failed("invalid_metadata"),
    };
    let opts = AddTorrentOptions {
        list_only: true,
        ..Default::default()
    };
    let parsed = match account.runtime.block_on(
        account
            .session
            .add_torrent(AddTorrent::from_bytes(metadata.clone()), Some(opts)),
    ) {
        Ok(AddTorrentResponse::ListOnly(info)) => info,
        _ => return failed("invalid_metadata"),
    };
    if parsed.info_hash.as_string() != torrent_id {
        return failed("torrent_id_mismatch");
    }
    let Some(file) = parsed.info.iter_file_details().nth(file_index) else {
        return failed("invalid_file_index");
    };
    if metadata_result(&parsed).is_err() {
        return failed("invalid_metadata");
    }
    let Some(file_components) = safe_relative_file(&file.filename.to_pathbuf()) else {
        return failed("invalid_metadata");
    };
    if file.len != expected_size {
        return failed("size_mismatch");
    }
    if let Some(active_request_id) = account
        .active_torrents
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&torrent_id)
        .cloned()
    {
        let Some(existing) = account
            .records
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&active_request_id)
            .cloned()
        else {
            return failed("torrent_busy");
        };
        if active_request_id != request_id
            || existing.file_index != Some(file_index)
            || existing.expected_size != Some(expected_size)
        {
            return failed("torrent_busy");
        }
        if existing
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get("kind")
            .and_then(Value::as_str)
            == Some("paused")
        {
            let Some(handle) = existing
                .handle
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
            else {
                return failed("start_failed");
            };
            if account
                .runtime
                .block_on(account.session.unpause(&handle))
                .is_err()
            {
                return failed("resume_failed");
            }
            let received = handle
                .stats()
                .file_progress
                .get(file_index)
                .copied()
                .unwrap_or_default();
            set_state(
                &existing,
                json!({"kind":"progress", "received":received, "torrentId":torrent_id}),
            );
        }
        return json!({"kind":"pending"});
    }
    let record = Arc::new(Record {
        state: Mutex::new(json!({"kind":"pending"})),
        cancel: CancellationToken::new(),
        handle: Mutex::new(None),
        done: tokio::sync::watch::channel(false).0,
        torrent_id: Some(torrent_id.clone()),
        file_index: Some(file_index),
        expected_size: Some(expected_size),
        file_components: Some(file_components.clone()),
        handle_ready: tokio::sync::watch::channel(false).0,
        accepting_streams: AtomicBool::new(true),
        published: AtomicBool::new(false),
    });
    {
        let mut active = account
            .active_torrents
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if active.contains_key(&torrent_id) {
            return failed("torrent_busy");
        }
        active.insert(torrent_id.clone(), request_id.clone());
    }
    let inserted = {
        let mut records = account
            .records
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if records.contains_key(&request_id) {
            false
        } else {
            records.insert(request_id.clone(), record.clone());
            true
        }
    };
    if !inserted {
        account
            .active_torrents
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&torrent_id);
        return failed("duplicate_request");
    }
    let stage = account.root.join(".engine").join(&torrent_id);
    if std::fs::create_dir_all(&stage).is_err() {
        finish_record(account, &request_id, &record, failed("storage"));
        return failed("storage");
    }
    let stage = match std::fs::canonicalize(&stage) {
        Ok(stage) if stage.starts_with(account.root.join(".engine")) => stage,
        _ => {
            finish_record(account, &request_id, &record, failed("unsafe_path"));
            return failed("unsafe_path");
        }
    };
    let initial_peers = account
        .peers
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&torrent_id)
        .cloned();
    let opts = AddTorrentOptions {
        only_files: Some(vec![file_index]),
        output_folder: Some(stage.to_string_lossy().into_owned()),
        overwrite: true,
        initial_peers,
        ..Default::default()
    };
    if let Some(previous) = account.session.get(TorrentIdOrHash::Hash(parsed.info_hash))
        && account
            .runtime
            .block_on(
                account
                    .session
                    .delete(TorrentIdOrHash::Id(previous.id()), false),
            )
            .is_err()
    {
        finish_record(account, &request_id, &record, failed("start_failed"));
        return failed("start_failed");
    }
    let response = account.runtime.block_on(
        account
            .session
            .add_torrent(AddTorrent::from_bytes(metadata), Some(opts)),
    );
    let handle = match response {
        Ok(AddTorrentResponse::Added(_, handle)) => handle,
        _ => {
            finish_record(account, &request_id, &record, failed("start_failed"));
            return json!({"kind":"pending"});
        }
    };
    *record
        .handle
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(handle.clone());
    let _ = record.handle_ready.send(true);
    set_state(
        &record,
        json!({"kind":"progress", "received":handle.stats().file_progress.get(file_index).copied().unwrap_or_default(), "torrentId":torrent_id}),
    );
    let root = account.root.clone();
    let task_account = account.clone();
    let task_request_id = request_id.clone();
    let task_map_request_id = request_id.clone();
    let task_record = record.clone();
    let session = account.session.clone();
    let task = account.runtime.handle().spawn(async move {
        loop {
            if task_record.cancel.is_cancelled() {
                let _ = session.delete(TorrentIdOrHash::Id(handle.id()), false).await;
                let _ =
                    clean_owned_file(&root.join(&torrent_id).join(format!("{file_index}.part")));
                finish_record(
                    &task_account,
                    &task_request_id,
                    &task_record,
                    json!({"kind":"stopped"}),
                );
                return;
            }
            let stats = handle.stats();
            if stats.finished {
                match publish_file(
                    &root,
                    &torrent_id,
                    file_index,
                    &file_components,
                    expected_size,
                ) {
                    Ok(()) => {
                        task_record.published.store(true, Ordering::Release);
                        let has_lease = stop_stream_admission_if_idle(&task_record);
                        let readers_ready = !has_lease
                            || switch_record_readers_to_published(&task_record).await;
                        let released = readers_ready
                            && session
                                .delete(TorrentIdOrHash::Id(handle.id()), false)
                                .await
                                .is_ok();
                        if released {
                            *task_record
                                .handle
                                .lock()
                                .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
                            clean_staged_file(&root, &torrent_id, &file_components);
                        }
                        let result = if released {
                            json!({"kind":"completed"})
                        } else {
                            failed("stream_release_failed")
                        };
                        finish_record(&task_account, &task_request_id, &task_record, result);
                    }
                    Err(error) => {
                        revoke_record_streams(&task_record).await;
                        let _ = session
                            .delete(TorrentIdOrHash::Id(handle.id()), false)
                            .await;
                        finish_record(&task_account, &task_request_id, &task_record, error);
                    }
                }
                return;
            }
            if matches!(stats.state, librqbit::TorrentStatsState::Error) {
                revoke_record_streams(&task_record).await;
                let _ = session
                    .delete(TorrentIdOrHash::Id(handle.id()), false)
                    .await;
                finish_record(
                    &task_account,
                    &task_request_id,
                    &task_record,
                    failed("download_failed"),
                );
                return;
            }
            if matches!(stats.state, librqbit::TorrentStatsState::Paused) {
                set_state(&task_record, json!({"kind":"paused", "torrentId":torrent_id}));
                tokio::select! {
                    _ = task_record.cancel.cancelled() => {},
                    _ = tokio::time::sleep(Duration::from_millis(300)) => {},
                }
                continue;
            }
            set_state(
                &task_record,
                json!({"kind":"progress", "received":stats.file_progress.get(file_index).copied().unwrap_or_default(), "torrentId":torrent_id}),
            );
            tokio::select! {
                _ = task_record.cancel.cancelled() => {},
                _ = tokio::time::sleep(Duration::from_millis(300)) => {},
            }
        }
    });
    account
        .tasks
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(task_map_request_id, task);
    json!({"kind":"pending"})
}

fn cancel(account: &Arc<Account>, request: &Value) -> Value {
    let request_id = match string_field(request, "requestId") {
        Ok(id) => id,
        Err(error) => return error,
    };
    let record = account
        .records
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(request_id)
        .cloned();
    let Some(record) = record else {
        join_task(account, request_id);
        return account
            .results
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(request_id)
            .cloned()
            .unwrap_or_else(|| failed("unknown_request"));
    };
    let mut done = record.done.subscribe();
    if !*done.borrow() && !record.published.load(Ordering::Acquire) {
        account.runtime.block_on(revoke_record_streams(&record));
    }
    record.cancel.cancel();
    let completed = account.runtime.block_on(async {
        timeout(Duration::from_secs(30), async {
            while !*done.borrow() {
                if done.changed().await.is_err() {
                    break;
                }
            }
        })
        .await
        .is_ok()
    });
    if !completed {
        return failed("cancel_timeout");
    }
    join_task(account, request_id);
    account
        .results
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(request_id)
        .cloned()
        .unwrap_or_else(|| json!({"kind":"stopped"}))
}

fn poll(account: &Arc<Account>, request: &Value) -> Value {
    let request_id = match string_field(request, "requestId") {
        Ok(id) => id,
        Err(error) => return error,
    };
    let active = account
        .records
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(request_id)
        .map(|record| {
            record
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
        });
    if let Some(active) = active {
        return active;
    }
    join_task(account, request_id);
    account
        .results
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(request_id)
        .cloned()
        .unwrap_or_else(|| failed("unknown_request"))
}

fn forget(account: &Arc<Account>, request: &Value) -> Value {
    let torrent_id = match string_field(request, "torrentId") {
        Ok(id) if valid_torrent_id(id) => id.to_ascii_lowercase(),
        _ => return failed("invalid_torrent_id"),
    };
    let request_id = account
        .active_torrents
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&torrent_id)
        .cloned();
    if let Some(request_id) = request_id {
        let response = cancel(account, &json!({"requestId":request_id}));
        if response.get("kind").and_then(Value::as_str) == Some("failed") {
            return response;
        }
    }
    revoke_torrent_streams(account, &torrent_id);
    account
        .results
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .retain(|_, value| value.get("torrentId").and_then(Value::as_str) != Some(&torrent_id));
    account
        .peers
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&torrent_id);
    let engine_root = account.root.join(".engine");
    if let Ok(engine_root) = std::fs::canonicalize(&engine_root)
        && engine_root.starts_with(&account.root)
        && let Ok(torrent_root) = std::fs::canonicalize(engine_root.join(&torrent_id))
        && torrent_root.starts_with(&engine_root)
    {
        let _ = std::fs::remove_dir_all(torrent_root);
    }
    json!({"kind":"stopped"})
}

fn open_torrent_stream(
    root: &str,
    scope: &str,
    request_id: &str,
    size: u64,
) -> Result<String, Value> {
    if !valid_request_id(request_id) || size > MAX_FILE_SIZE {
        return Err(failed("invalid_request"));
    }
    let account = cached_account(root, scope)?;
    if account.retiring.load(Ordering::Acquire) {
        return Err(failed("account_retiring"));
    }
    let record = account
        .records
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(request_id)
        .cloned()
        .ok_or_else(|| failed("unknown_request"))?;
    let (Some(file_index), Some(expected_size)) = (record.file_index, record.expected_size) else {
        return Err(failed("not_a_file_download"));
    };
    if expected_size != size || !record.accepting_streams.load(Ordering::Acquire) {
        return Err(failed("stream_unavailable"));
    }
    let mut entropy = [0_u8; 32];
    getrandom::fill(&mut entropy).map_err(|_| failed("secure_random_unavailable"))?;
    let token = entropy
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let lease = Arc::new(StreamLease {
        account,
        record,
        file_index,
        size,
        closed: AtomicBool::new(false),
    });
    let mut leases = stream_leases()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if lease.account.retiring.load(Ordering::Acquire)
        || !lease.record.accepting_streams.load(Ordering::Acquire)
    {
        return Err(failed("stream_unavailable"));
    }
    leases.insert(token.clone(), lease);
    Ok(format!("boop-media://{token}"))
}

fn token_from_uri(uri_or_token: &str) -> Result<&str, Value> {
    let token = uri_or_token
        .strip_prefix("boop-media://")
        .unwrap_or(uri_or_token);
    if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(failed("invalid_stream_token"));
    }
    Ok(token)
}

fn open_reader(uri_or_token: &str, position: i64, length: i64) -> Result<u64, Value> {
    let token = token_from_uri(uri_or_token)?;
    if position < 0 || length < -1 {
        return Err(failed("invalid_range"));
    }
    let lease_map = stream_leases()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let lease = lease_map
        .get(token)
        .cloned()
        .filter(|lease| !lease.closed.load(Ordering::Acquire))
        .ok_or_else(|| failed("stream_unavailable"))?;
    let position = position as u64;
    if position > lease.size {
        return Err(failed("invalid_range"));
    }
    let remaining = if length == -1 {
        lease.size - position
    } else {
        (length as u64).min(lease.size - position)
    };
    let reader_id = NEXT_READER_ID.fetch_add(1, Ordering::Relaxed);
    if reader_id == 0 {
        return Err(failed("reader_limit"));
    }
    let reader = Arc::new(Reader {
        lease: lease.clone(),
        cancel: CancellationToken::new(),
        state: AsyncMutex::new(ReaderState {
            position,
            remaining,
            source: None,
        }),
    });
    let mut active_readers = readers()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if active_readers.len() >= MAX_STREAM_READERS {
        return Err(failed("reader_limit"));
    }
    active_readers.insert(reader_id, reader);
    drop(active_readers);
    drop(lease_map);
    Ok(reader_id)
}

fn open_published_reader(lease: &StreamLease, position: u64) -> Result<std::fs::File, ()> {
    let torrent_id = lease.record.torrent_id.as_deref().ok_or(())?;
    let path = lease
        .account
        .root
        .join(torrent_id)
        .join(format!("{}.complete", lease.file_index));
    let metadata = std::fs::symlink_metadata(&path).map_err(|_| ())?;
    if !metadata.is_file() || metadata.len() != lease.size {
        return Err(());
    }
    let path = std::fs::canonicalize(path).map_err(|_| ())?;
    if !path.starts_with(&lease.account.root) {
        return Err(());
    }
    let mut file = std::fs::File::open(path).map_err(|_| ())?;
    std::io::Seek::seek(&mut file, std::io::SeekFrom::Start(position)).map_err(|_| ())?;
    Ok(file)
}

fn switch_reader_to_published(reader: &Reader, state: &mut ReaderState) -> Result<(), ()> {
    if matches!(state.source, Some(ReaderSource::Local(_))) {
        return Ok(());
    }
    let file = open_published_reader(&reader.lease, state.position)?;
    state.source = Some(ReaderSource::Local(file));
    Ok(())
}

async fn read_from_reader(reader: &Reader, output: &mut [u8]) -> Result<usize, ()> {
    if reader.cancel.is_cancelled() || reader.lease.closed.load(Ordering::Acquire) {
        return Err(());
    }
    let mut state = reader.state.lock().await;
    if state.source.is_none() {
        let record = &reader.lease.record;
        let completed = record.published.load(Ordering::Acquire);
        if completed {
            switch_reader_to_published(reader, &mut state)?;
        }
    }
    if state.source.is_none() {
        let record = &reader.lease.record;
        let mut ready = record.handle_ready.subscribe();
        let handle = loop {
            if let Some(handle) = record
                .handle
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
            {
                break handle;
            }
            tokio::select! {
                _ = reader.cancel.cancelled() => return Err(()),
                changed = ready.changed() => {
                    if changed.is_err() {
                        return Err(());
                    }
                }
            }
        };
        let mut stream = tokio::select! {
            _ = reader.cancel.cancelled() => return Err(()),
            result = handle.stream(reader.lease.file_index) => result.map_err(|_| ())?,
        };
        tokio::select! {
            _ = reader.cancel.cancelled() => return Err(()),
            result = tokio::io::AsyncSeekExt::seek(
                &mut stream,
                std::io::SeekFrom::Start(state.position),
            ) => result.map_err(|_| ())?,
        };
        state.source = Some(ReaderSource::Torrent(stream));
    }
    if state.remaining == 0 || output.is_empty() {
        return Ok(0);
    }
    let limit = output
        .len()
        .min(state.remaining.min(usize::MAX as u64) as usize);
    let completed = reader.lease.record.published.load(Ordering::Acquire);
    if completed {
        switch_reader_to_published(reader, &mut state)?;
    }
    let result = match state.source.as_mut().ok_or(())? {
        ReaderSource::Local(file) => {
            std::io::Read::read(file, &mut output[..limit]).map_err(|_| ())?
        }
        ReaderSource::Torrent(stream) => tokio::select! {
            _ = reader.cancel.cancelled() => return Err(()),
            result = stream.read(&mut output[..limit]) => result.map_err(|_| ())?,
        },
    };
    if result > 0 {
        state.position = state.position.saturating_add(result as u64);
        state.remaining -= result as u64;
    }
    Ok(result)
}

async fn switch_record_readers_to_published(record: &Record) -> bool {
    let active_readers = readers()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .values()
        .filter(|reader| std::ptr::eq(Arc::as_ptr(&reader.lease.record), record))
        .cloned()
        .collect::<Vec<_>>();
    for reader in active_readers {
        let Ok(mut state) =
            tokio::time::timeout(Duration::from_secs(25), reader.state.lock()).await
        else {
            return false;
        };
        if reader.cancel.is_cancelled() {
            state.source.take();
            continue;
        }
        if switch_reader_to_published(&reader, &mut state).is_err() {
            return false;
        }
    }
    true
}

fn read_reader(reader_id: u64, output: &mut [u8]) -> Result<usize, ()> {
    if output.len() > MAX_NATIVE_READ_BYTES {
        return Err(());
    }
    let reader = readers()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&reader_id)
        .cloned()
        .ok_or(())?;
    reader
        .lease
        .account
        .runtime
        .block_on(async {
            timeout(Duration::from_secs(25), read_from_reader(&reader, output)).await
        })
        .map_err(|_| ())?
}

fn cancel_reader(reader_id: u64) {
    if let Some(reader) = readers()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&reader_id)
        .cloned()
    {
        reader.cancel.cancel();
    }
}

fn take_reader(reader_id: u64) -> Option<Arc<Reader>> {
    let reader = readers()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&reader_id)?;
    reader.cancel.cancel();
    Some(reader)
}

async fn drain_reader(reader: &Reader) {
    reader.state.lock().await.source.take();
}

fn close_reader(reader_id: u64) {
    if let Some(reader) = take_reader(reader_id) {
        reader.lease.account.runtime.block_on(drain_reader(&reader));
    }
}

async fn close_torrent_stream_async(token: &str) -> Result<(), Value> {
    let (lease, retire_record) = {
        let mut leases = stream_leases()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let lease = leases
            .remove(token)
            .ok_or_else(|| failed("unknown_stream"))?;
        lease.closed.store(true, Ordering::Release);
        let is_last_lease = !leases
            .values()
            .any(|candidate| Arc::ptr_eq(&candidate.record, &lease.record));
        let terminal = lease
            .record
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get("kind")
            .and_then(Value::as_str)
            .is_some_and(|kind| kind == "completed" || kind == "failed");
        let retire_record = is_last_lease && terminal;
        if retire_record {
            lease
                .record
                .accepting_streams
                .store(false, Ordering::Release);
        }
        (lease, retire_record)
    };
    let reader_ids = readers()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .iter()
        .filter_map(|(id, reader)| Arc::ptr_eq(&reader.lease, &lease).then_some(*id))
        .collect::<Vec<_>>();
    let readers = reader_ids
        .into_iter()
        .filter_map(take_reader)
        .collect::<Vec<_>>();
    for reader in readers {
        drain_reader(&reader).await;
    }
    if retire_record {
        retire_completed_record(&lease.account, &lease.record).await;
    }
    Ok(())
}

fn close_torrent_stream(uri_or_token: &str) -> Result<(), Value> {
    let token = token_from_uri(uri_or_token)?;
    let account = stream_leases()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(token)
        .map(|lease| lease.account.clone())
        .ok_or_else(|| failed("unknown_stream"))?;
    account.runtime.block_on(close_torrent_stream_async(token))
}

async fn retire_completed_record(account: &Account, record: &Arc<Record>) {
    let request_id = account
        .records
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .iter()
        .find_map(|(request_id, current)| Arc::ptr_eq(current, record).then(|| request_id.clone()));
    let (Some(torrent_id), Some(file_components), Some(request_id)) =
        (&record.torrent_id, &record.file_components, request_id)
    else {
        return;
    };
    let handle = record
        .handle
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    if let Some(handle) = handle {
        if account
            .session
            .delete(TorrentIdOrHash::Id(handle.id()), false)
            .await
            .is_err()
        {
            record.accepting_streams.store(true, Ordering::Release);
            return;
        }
        if record.published.load(Ordering::Acquire) {
            clean_staged_file(&account.root, torrent_id, file_components);
        }
    }
    account
        .records
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&request_id);
    let mut active = account
        .active_torrents
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if active.get(torrent_id).is_some_and(|id| id == &request_id) {
        active.remove(torrent_id);
    }
}

pub fn open_stream_for_playback(
    root: &str,
    scope: &str,
    request_id: &str,
    size: u64,
) -> Result<String, String> {
    open_torrent_stream(root, scope, request_id, size).map_err(|error| {
        error
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("stream_failed")
            .to_owned()
    })
}

pub fn playback_stream_size(uri_or_token: &str) -> Result<u64, String> {
    let token = token_from_uri(uri_or_token).map_err(|error| {
        error
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("stream_failed")
            .to_owned()
    })?;
    stream_leases()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(token)
        .filter(|lease| !lease.closed.load(Ordering::Acquire))
        .map(|lease| lease.size)
        .ok_or_else(|| "stream_unavailable".to_owned())
}

pub fn playback_stream_completed(uri_or_token: &str) -> bool {
    let Ok(token) = token_from_uri(uri_or_token) else {
        return false;
    };
    let lease = stream_leases()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(token)
        .cloned();
    let Some(lease) = lease.filter(|lease| !lease.closed.load(Ordering::Acquire)) else {
        return false;
    };
    lease
        .record
        .state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get("kind")
        .and_then(Value::as_str)
        == Some("completed")
}

pub fn open_playback_reader(uri_or_token: &str, position: i64, length: i64) -> Result<u64, String> {
    open_reader(uri_or_token, position, length).map_err(|error| {
        error
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("stream_failed")
            .to_owned()
    })
}

pub fn read_playback_reader(reader_id: u64, output: &mut [u8]) -> Result<usize, ()> {
    read_reader(reader_id, output)
}

pub fn cancel_playback_reader(reader_id: u64) {
    cancel_reader(reader_id);
}

pub fn close_playback_reader(reader_id: u64) {
    close_reader(reader_id);
}

pub fn close_playback_stream(uri_or_token: &str) -> Result<(), String> {
    close_torrent_stream(uri_or_token).map_err(|error| {
        error
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("stream_failed")
            .to_owned()
    })
}

fn revoke_torrent_streams(account: &Arc<Account>, torrent_id: &str) {
    let tokens = stream_leases()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .iter()
        .filter(|(_, lease)| {
            Arc::ptr_eq(&lease.account, account)
                && lease.record.torrent_id.as_deref() == Some(torrent_id)
        })
        .map(|(token, _)| token.clone())
        .collect::<Vec<_>>();
    for token in tokens {
        let _ = close_torrent_stream(&token);
    }
}

async fn revoke_record_streams(record: &Record) {
    record.accepting_streams.store(false, Ordering::Release);
    let tokens: Vec<_> = stream_leases()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .iter()
        .filter(|(_, lease)| std::ptr::eq(Arc::as_ptr(&lease.record), record))
        .map(|(token, _)| token.clone())
        .collect::<Vec<_>>();
    for token in tokens {
        let _ = close_torrent_stream_async(&token).await;
    }
}

pub fn execute(root: &str, scope: &str, request: &str) -> String {
    if request.len() > MAX_REQUEST_BYTES {
        return failed("request_too_large").to_string();
    }
    let request: Value = match serde_json::from_str(request) {
        Ok(request) => request,
        Err(_) => return failed("invalid_json").to_string(),
    };
    let _command_guard = COMMAND_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let kind = match string_field(&request, "kind") {
        Ok(kind) => kind,
        Err(error) => return error.to_string(),
    };
    if kind == "shutdown" {
        let (all, leases) = {
            let mut leases = stream_leases()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let all = accounts()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .values()
                .cloned()
                .collect::<Vec<_>>();
            for account in &all {
                account.retiring.store(true, Ordering::Release);
            }
            let leases = leases.drain().map(|(_, lease)| lease).collect::<Vec<_>>();
            (all, leases)
        };
        for lease in leases {
            lease.closed.store(true, Ordering::Release);
        }
        let active_readers = readers()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .drain()
            .map(|(_, reader)| reader)
            .collect::<Vec<_>>();
        for reader in active_readers {
            reader.cancel.cancel();
            reader
                .lease
                .account
                .runtime
                .block_on(async { reader.state.lock().await.source.take() });
        }
        for account in &all {
            {
                let records = account
                    .records
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                for record in records.values() {
                    record.cancel.cancel();
                }
            }
            account.runtime.block_on(account.session.stop());
            let tasks = account
                .tasks
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .drain()
                .map(|(_, task)| task)
                .collect::<Vec<_>>();
            account.runtime.block_on(async {
                for task in tasks {
                    let _ = task.await;
                }
            });
        }
        accounts()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
        return json!({"kind":"stopped"}).to_string();
    }
    let account = match kind {
        "poll" | "cancel" | "stop" | "forget" => cached_account(root, scope),
        _ => account(root, scope),
    };
    let account = match account {
        Ok(account) => account,
        Err(error) => return error.to_string(),
    };
    let response = match kind {
        "resolve" => resolve(&account, &request),
        "cancel" | "stop" => cancel(&account, &request),
        "start" => start(&account, &request),
        "poll" => poll(&account, &request),
        "forget" => forget(&account, &request),
        _ => failed("unknown_command"),
    };
    response.to_string()
}

#[cfg(test)]
mod tests {
    use super::{execute, safe_relative_file, valid_request_id, valid_torrent_id};
    use std::path::Path;

    #[cfg(feature = "torrent-test-fixture")]
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
        time::{Duration, Instant},
    };

    #[cfg(feature = "torrent-test-fixture")]
    use super::{
        cancel_playback_reader, close_playback_reader, close_playback_stream, open_playback_reader,
        playback_stream_completed, playback_stream_size, read_playback_reader,
    };

    #[cfg(feature = "torrent-test-fixture")]
    use librqbit::{CreateTorrentOptions, ListenerMode, ListenerOptions, Session, SessionOptions};

    #[cfg(feature = "torrent-test-fixture")]
    static FIXTURE_ID: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn validates_request_and_torrent_identifiers() {
        assert!(valid_request_id("request_1-abc"));
        assert!(!valid_request_id("../request"));
        assert!(valid_torrent_id("0123456789abcdef0123456789abcdef01234567"));
        assert!(!valid_torrent_id("../etc/passwd"));
    }

    #[test]
    fn validates_every_metainfo_path_component() {
        assert_eq!(
            safe_relative_file(Path::new("folder/file.bin")),
            Some(vec!["folder".to_owned(), "file.bin".to_owned()])
        );
        assert_eq!(safe_relative_file(Path::new("../escape.bin")), None);
        assert_eq!(safe_relative_file(Path::new("..\\escape.bin")), None);
        assert_eq!(safe_relative_file(Path::new("")), None);
    }

    #[test]
    fn stale_poll_does_not_construct_a_session() {
        let response = execute(
            "not-created",
            "account-1",
            r#"{"kind":"poll","requestId":"missing"}"#,
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&response).unwrap(),
            serde_json::json!({"kind":"failed","code":"unknown_request"})
        );
    }

    #[cfg(feature = "torrent-test-fixture")]
    #[test]
    fn resolves_metadata_and_downloads_from_a_local_peer() {
        let fixture_root = std::env::temp_dir().join(format!(
            "boop-torrent-{}-{}",
            std::process::id(),
            FIXTURE_ID.fetch_add(1, Ordering::Relaxed)
        ));
        let seed_root = fixture_root.join("seed");
        let data = b"verified local torrent fixture".repeat(1024);
        let sibling_data = b"unselected sibling payload".repeat(1024);
        fs::create_dir_all(&seed_root).unwrap();
        let source_file = seed_root.join("fixture.bin");
        fs::write(&source_file, &data).unwrap();
        fs::write(seed_root.join("sibling.bin"), &sibling_data).unwrap();

        let seeder_runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        let seeder_options = SessionOptions {
            dht: None,
            disable_trackers: true,
            listen: Some(ListenerOptions {
                mode: ListenerMode::TcpOnly,
                listen_addr: "127.0.0.1:0".parse().unwrap(),
                ipv4_only: true,
                ..Default::default()
            }),
            ..Default::default()
        };
        let seeder = seeder_runtime
            .block_on(Session::new_with_opts(seed_root.clone(), seeder_options))
            .unwrap();
        let (torrent, seed_handle) = seeder_runtime
            .block_on(seeder.create_and_serve_torrent(
                &seed_root,
                CreateTorrentOptions {
                    piece_length: Some(1024),
                    ..Default::default()
                },
            ))
            .unwrap();
        let address = seeder.listen_addr().unwrap();
        let magnet = format!(
            "magnet:?xt=urn:btih:{}&x.pe=127.0.0.1%3A{}",
            torrent.info_hash().as_string(),
            address.port()
        );
        let root = fixture_root.join("downloads");
        let root = root.to_str().unwrap();
        assert_eq!(
            execute(
                root,
                "fixture-account",
                &serde_json::json!({
                    "kind":"resolve",
                    "requestId":"resolve-1",
                    "magnet":magnet
                })
                .to_string()
            ),
            r#"{"kind":"pending"}"#
        );

        let deadline = Instant::now() + Duration::from_secs(15);
        let resolved = loop {
            let state = serde_json::from_str::<serde_json::Value>(&execute(
                root,
                "fixture-account",
                r#"{"kind":"poll","requestId":"resolve-1"}"#,
            ))
            .unwrap();
            if state.get("kind").and_then(serde_json::Value::as_str) == Some("resolved") {
                break state;
            }
            assert_ne!(
                state.get("kind").and_then(serde_json::Value::as_str),
                Some("failed"),
                "{state}"
            );
            assert!(Instant::now() < deadline, "metadata resolution timed out");
            std::thread::sleep(Duration::from_millis(50));
        };
        assert_eq!(resolved["torrentId"], torrent.info_hash().as_string());
        let files = resolved["files"].as_array().unwrap();
        assert_eq!(files.len(), 2);
        let file_index = files
            .iter()
            .position(|file| {
                file["path"]
                    .as_array()
                    .and_then(|path| path.last())
                    .and_then(serde_json::Value::as_str)
                    == Some("fixture.bin")
            })
            .unwrap();
        let sibling_index = files
            .iter()
            .position(|file| {
                file["path"]
                    .as_array()
                    .and_then(|path| path.last())
                    .and_then(serde_json::Value::as_str)
                    == Some("sibling.bin")
            })
            .unwrap();
        assert_eq!(files[file_index]["size"], data.len() as u64);
        assert_eq!(seed_handle.stats().uploaded_bytes, 0);

        seeder_runtime.block_on(seeder.pause(&seed_handle)).unwrap();
        let download_started = Instant::now();
        assert_eq!(
            execute(
                root,
                "fixture-account",
                &serde_json::json!({
                    "kind":"start",
                    "requestId":"download-1",
                    "torrentId":resolved["torrentId"],
                    "fileIndex":file_index,
                    "size":data.len(),
                    "metadata":resolved["metadata"]
                })
                .to_string()
            ),
            r#"{"kind":"pending"}"#
        );
        let stream_uri = super::open_stream_for_playback(
            root,
            "fixture-account",
            "download-1",
            data.len() as u64,
        )
        .unwrap();
        assert!(stream_uri.starts_with("boop-media://"));
        assert_eq!(
            playback_stream_size(&stream_uri).unwrap(),
            data.len() as u64
        );
        let blocked_reader =
            open_playback_reader(&stream_uri, data.len() as i64 - 1024, 1024).unwrap();
        let (cancel_tx, cancel_rx) = std::sync::mpsc::channel();
        let blocked_thread = std::thread::spawn(move || {
            let mut blocked_buffer = [0_u8; 1024];
            cancel_tx
                .send(read_playback_reader(blocked_reader, &mut blocked_buffer))
                .unwrap();
        });
        std::thread::sleep(Duration::from_millis(100));
        let cancel_started = Instant::now();
        cancel_playback_reader(blocked_reader);
        assert_eq!(
            cancel_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            Err(())
        );
        let blocked_read_cancel_elapsed = cancel_started.elapsed();
        blocked_thread.join().unwrap();
        close_playback_reader(blocked_reader);
        let active_after_reader_cancel = serde_json::from_str::<serde_json::Value>(&execute(
            root,
            "fixture-account",
            r#"{"kind":"poll","requestId":"download-1"}"#,
        ))
        .unwrap();
        assert!(matches!(
            active_after_reader_cancel["kind"].as_str(),
            Some("progress" | "pending")
        ));
        assert_eq!(
            super::cached_account(root, "fixture-account")
                .unwrap()
                .active_torrents
                .lock()
                .unwrap()
                .get(&torrent.info_hash().as_string())
                .map(String::as_str),
            Some("download-1")
        );
        seeder_runtime
            .block_on(seeder.unpause(&seed_handle))
            .unwrap();

        let reader = open_playback_reader(&stream_uri, 4096, 8192).unwrap();
        let mut streamed = Vec::new();
        let mut buffer = [0_u8; 2048];
        let offset_read_started = Instant::now();
        while streamed.len() < 8192 {
            let count = read_playback_reader(reader, &mut buffer).unwrap();
            assert!(count > 0, "stream reached EOF before its requested range");
            streamed.extend_from_slice(&buffer[..count]);
        }
        let offset_read_elapsed = offset_read_started.elapsed();
        assert_eq!(streamed, data[4096..4096 + 8192]);

        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let state = serde_json::from_str::<serde_json::Value>(&execute(
                root,
                "fixture-account",
                r#"{"kind":"poll","requestId":"download-1"}"#,
            ))
            .unwrap();
            match state.get("kind").and_then(serde_json::Value::as_str) {
                Some("completed") => break,
                Some("failed") => panic!("download failed: {state}"),
                _ => {}
            }
            assert!(Instant::now() < deadline, "data transfer timed out");
            std::thread::sleep(Duration::from_millis(50));
        }
        let completion_elapsed = download_started.elapsed();
        assert!(playback_stream_completed(&stream_uri));
        let completed_reader = open_playback_reader(&stream_uri, 20_000, 4096).unwrap();
        let mut completed_range = Vec::new();
        let cached_read_started = Instant::now();
        while completed_range.len() < 4096 {
            let count = read_playback_reader(completed_reader, &mut buffer).unwrap();
            assert!(
                count > 0,
                "completed reader ended before its requested range"
            );
            completed_range.extend_from_slice(&buffer[..count]);
        }
        let cached_read_elapsed = cached_read_started.elapsed();
        assert_eq!(completed_range, data[20_000..24_096]);
        println!(
            "progressive fixture timings: blocked read cancel {blocked_read_cancel_elapsed:?}, 8 KiB offset read {offset_read_elapsed:?}, completed local read {cached_read_elapsed:?}, transfer completion {completion_elapsed:?}"
        );
        close_playback_reader(completed_reader);
        close_playback_reader(reader);
        close_playback_stream(&stream_uri).unwrap();
        let downloaded = Path::new(root)
            .join("fixture-account")
            .join(torrent.info_hash().as_string())
            .join(format!("{file_index}.complete"));
        assert_eq!(fs::read(downloaded).unwrap(), data);
        assert!(
            !Path::new(root)
                .join("fixture-account")
                .join(torrent.info_hash().as_string())
                .join(format!("{sibling_index}.complete"))
                .exists()
        );

        let _ = execute("", "", r#"{"kind":"shutdown"}"#);
        seeder_runtime.block_on(seeder.stop());
        fs::remove_dir_all(fixture_root).unwrap();
    }
}
