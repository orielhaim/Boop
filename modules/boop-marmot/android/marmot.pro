-keep class com.sun.jna.** { *; }
# JNA resolves UniFFI exports by the interface method's JVM name. Both the
# API-checksum interface and the account API are implemented by runtime proxies.
-keep interface dev.ipf.marmotkit.** extends com.sun.jna.Library { *; }
-keep class dev.ipf.marmotkit.** implements com.sun.jna.Callback { *; }
-keep class dev.ipf.marmotkit.** extends com.sun.jna.Structure { *; }
-keepnames class dev.ipf.marmotkit.MarmotKitException$*
-keep class io.crates.keyring.Keyring { *; }

# JNA's desktop window helpers reference AWT. MarmotKit uses JNA only for native bindings on Android.
-dontwarn java.awt.Component
-dontwarn java.awt.GraphicsEnvironment
-dontwarn java.awt.HeadlessException
-dontwarn java.awt.Window
