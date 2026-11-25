mod engine;

#[cfg(all(feature = "torrent-test-fixture", not(test)))]
compile_error!("torrent-test-fixture is only available to unit tests");

use jni::{
    objects::{JByteArray, JClass, JString},
    sys::{JNI_FALSE, JNI_TRUE, jboolean, jclass, jint, jlong, jstring},
};

const DELIVERY_ABI: jint = 1;

#[unsafe(no_mangle)]
pub extern "system" fn Java_app_boop_plugins_TorrentNative_version(
    _env: jni::EnvUnowned<'_>,
    _class: jclass,
) -> jint {
    DELIVERY_ABI
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_app_boop_plugins_TorrentNative_execute<'caller>(
    mut unowned_env: jni::EnvUnowned<'caller>,
    _class: JClass<'caller>,
    root: JString<'caller>,
    scope: JString<'caller>,
    request: JString<'caller>,
) -> jstring {
    unowned_env
        .with_env(|env| -> jni::errors::Result<jstring> {
            let root = root.try_to_string(env)?;
            let scope = scope.try_to_string(env)?;
            let request = request.try_to_string(env)?;
            let response = engine::execute(&root, &scope, &request);
            Ok(env.new_string(response)?.into_raw())
        })
        .resolve::<jni::errors::ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_app_boop_plugins_TorrentNative_openTorrentStream<'caller>(
    mut unowned_env: jni::EnvUnowned<'caller>,
    _class: JClass<'caller>,
    root: JString<'caller>,
    scope: JString<'caller>,
    request_id: JString<'caller>,
    size: jlong,
) -> jstring {
    unowned_env
        .with_env(|env| -> jni::errors::Result<jstring> {
            let response = if size < 0 {
                Err("invalid_size".to_owned())
            } else {
                let root = root.try_to_string(env)?;
                let scope = scope.try_to_string(env)?;
                let request_id = request_id.try_to_string(env)?;
                engine::open_stream_for_playback(&root, &scope, &request_id, size as u64)
            };
            let response = response.unwrap_or_else(|code| format!("error:{code}"));
            Ok(env.new_string(response)?.into_raw())
        })
        .resolve::<jni::errors::ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_app_boop_plugins_TorrentNative_torrentStreamSize<'caller>(
    mut unowned_env: jni::EnvUnowned<'caller>,
    _class: JClass<'caller>,
    token: JString<'caller>,
) -> jlong {
    unowned_env
        .with_env(|env| -> jni::errors::Result<jlong> {
            let token = token.try_to_string(env)?;
            Ok(engine::playback_stream_size(&token)
                .ok()
                .and_then(|size| jlong::try_from(size).ok())
                .unwrap_or(-1))
        })
        .resolve::<jni::errors::ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_app_boop_plugins_TorrentNative_torrentStreamCompleted<'caller>(
    mut unowned_env: jni::EnvUnowned<'caller>,
    _class: JClass<'caller>,
    token: JString<'caller>,
) -> jboolean {
    unowned_env
        .with_env(|env| -> jni::errors::Result<jboolean> {
            let token = token.try_to_string(env)?;
            Ok(if engine::playback_stream_completed(&token) {
                JNI_TRUE
            } else {
                JNI_FALSE
            })
        })
        .resolve::<jni::errors::ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_app_boop_plugins_TorrentNative_openReader<'caller>(
    mut unowned_env: jni::EnvUnowned<'caller>,
    _class: JClass<'caller>,
    token: JString<'caller>,
    position: jlong,
    length: jlong,
) -> jlong {
    unowned_env
        .with_env(|env| -> jni::errors::Result<jlong> {
            let token = token.try_to_string(env)?;
            Ok(engine::open_playback_reader(&token, position, length)
                .ok()
                .and_then(|id| jlong::try_from(id).ok())
                .unwrap_or(-1))
        })
        .resolve::<jni::errors::ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_app_boop_plugins_TorrentNative_read<'caller>(
    mut unowned_env: jni::EnvUnowned<'caller>,
    _class: JClass<'caller>,
    reader_id: jlong,
    destination: JByteArray<'caller>,
    offset: jint,
    length: jint,
) -> jint {
    unowned_env
        .with_env(|env| -> jni::errors::Result<jint> {
            if reader_id <= 0 || offset < 0 || length < 0 || length as usize > 64 * 1024 {
                return Ok(-2);
            }
            let array_length = destination.len(env)?;
            if offset as usize > array_length || length as usize > array_length - offset as usize {
                return Ok(-2);
            }
            let mut bytes = vec![0_u8; length as usize];
            match engine::read_playback_reader(reader_id as u64, &mut bytes) {
                Ok(count) => {
                    let bytes = bytes[..count]
                        .iter()
                        .map(|byte| *byte as i8)
                        .collect::<Vec<_>>();
                    destination.set_region(env, offset, &bytes)?;
                    Ok(count as jint)
                }
                Err(()) => Ok(-1),
            }
        })
        .resolve::<jni::errors::ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_app_boop_plugins_TorrentNative_cancelReader(
    _env: jni::EnvUnowned<'_>,
    _class: jclass,
    reader_id: jlong,
) {
    if let Ok(reader_id) = u64::try_from(reader_id) {
        engine::cancel_playback_reader(reader_id);
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_app_boop_plugins_TorrentNative_closeReader(
    _env: jni::EnvUnowned<'_>,
    _class: jclass,
    reader_id: jlong,
) {
    if let Ok(reader_id) = u64::try_from(reader_id) {
        engine::close_playback_reader(reader_id);
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_app_boop_plugins_TorrentNative_closeTorrentStream<'caller>(
    mut unowned_env: jni::EnvUnowned<'caller>,
    _class: JClass<'caller>,
    token: JString<'caller>,
) {
    let _ = unowned_env.with_env(|env| -> jni::errors::Result<()> {
        let token = token.try_to_string(env)?;
        let _ = engine::close_playback_stream(&token);
        Ok(())
    });
}
