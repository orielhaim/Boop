-keep class com.sun.jna.** { *; }
-keep class dev.ipf.marmotkit.** implements com.sun.jna.Callback { *; }
-keep class dev.ipf.marmotkit.** extends com.sun.jna.Structure { *; }
-keep class io.crates.keyring.Keyring { *; }

# JNA's desktop window helpers reference AWT. MarmotKit uses JNA only for native bindings on Android.
-dontwarn java.awt.Component
-dontwarn java.awt.GraphicsEnvironment
-dontwarn java.awt.HeadlessException
-dontwarn java.awt.Window
