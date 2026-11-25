use jni::sys::{jclass, jint};

const DELIVERY_ABI: jint = 1;

#[unsafe(no_mangle)]
pub extern "system" fn Java_app_boop_plugins_TorrentNative_version(
    _env: jni::EnvUnowned<'_>,
    _class: jclass,
) -> jint {
    DELIVERY_ABI
}
