mod engine;

#[cfg(all(feature = "torrent-test-fixture", not(test)))]
compile_error!("torrent-test-fixture is only available to unit tests");

use jni::{
    objects::{JClass, JString},
    sys::{jclass, jint, jstring},
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
