use std::{
    collections::{HashMap, HashSet},
    net::SocketAddr,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use librqbit::{
    AddTorrent, AddTorrentOptions, AddTorrentResponse, DhtSessionConfig, ManagedTorrent, Session,
    SessionOptions, api::TorrentIdOrHash,
};
use serde_json::{Value, json};
use tokio::{runtime::Runtime, time::timeout};
use tokio_util::sync::CancellationToken;

const MAX_REQUEST_BYTES: usize = 768 * 1024;
const MAX_METADATA_BYTES: usize = 512 * 1024;
const MAX_FILES: usize = 1024;
const MAX_FILE_SIZE: u64 = 2 * 1024 * 1024 * 1024 * 1024;

static ACCOUNTS: OnceLock<Mutex<HashMap<PathBuf, Arc<Account>>>> = OnceLock::new();
static COMMAND_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

struct Account {
    root: PathBuf,
    runtime: Runtime,
    session: Arc<Session>,
    records: Mutex<HashMap<String, Arc<Record>>>,
    results: Mutex<HashMap<String, Value>>,
    active_torrents: Mutex<HashMap<String, String>>,
    peers: Mutex<HashMap<String, Vec<SocketAddr>>>,
    tasks: Mutex<HashMap<String, tokio::task::JoinHandle<()>>>,
}

struct Record {
    state: Mutex<Value>,
    cancel: CancellationToken,
    handle: Mutex<Option<Arc<ManagedTorrent>>>,
    done: tokio::sync::watch::Sender<bool>,
    torrent_id: Option<String>,
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
    if let Some(torrent_id) = &record.torrent_id {
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
    account
        .records
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(request_id);
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
    let source = std::fs::canonicalize(source).map_err(|_| failed("incomplete"))?;
    if !source.starts_with(&stage) {
        return Err(failed("unsafe_path"));
    }
    let source_meta = std::fs::symlink_metadata(&source).map_err(|_| failed("incomplete"))?;
    if !source_meta.is_file() || source_meta.len() != expected_size {
        return Err(failed("incomplete"));
    }

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
    std::fs::hard_link(source, &part).map_err(|_| failed("publish_failed"))?;
    if let Err(error) = std::fs::rename(&part, &complete) {
        let _ = std::fs::remove_file(&part);
        return Err(if error.kind() == std::io::ErrorKind::AlreadyExists {
            failed("already_published")
        } else {
            failed("publish_failed")
        });
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
    let record = Arc::new(Record {
        state: Mutex::new(json!({"kind":"pending"})),
        cancel: CancellationToken::new(),
        handle: Mutex::new(None),
        done: tokio::sync::watch::channel(false).0,
        torrent_id: Some(torrent_id.clone()),
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
                        let _ = session
                            .delete(TorrentIdOrHash::Id(handle.id()), false)
                            .await;
                        finish_record(
                            &task_account,
                            &task_request_id,
                            &task_record,
                            json!({"kind":"completed"}),
                        );
                    }
                    Err(error) => {
                        let _ = session
                            .delete(TorrentIdOrHash::Id(handle.id()), false)
                            .await;
                        finish_record(&task_account, &task_request_id, &task_record, error);
                    }
                }
                return;
            }
            if matches!(stats.state, librqbit::TorrentStatsState::Error) {
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
        let all = accounts()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .cloned()
            .collect::<Vec<_>>();
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
