const {
  AndroidConfig,
  withAndroidManifest,
  withInfoPlist,
  withMainActivity,
} = require("expo/config-plugins");
const {
  mergeContents,
} = require("@expo/config-plugins/build/utils/generateCode");

module.exports = function withSystemCalling(config) {
  config = AndroidConfig.Permissions.withPermissions(config, [
    "android.permission.MANAGE_OWN_CALLS",
    "android.permission.FOREGROUND_SERVICE",
    "android.permission.FOREGROUND_SERVICE_PHONE_CALL",
    "android.permission.FOREGROUND_SERVICE_MICROPHONE",
    "android.permission.POST_PROMOTED_NOTIFICATIONS",
  ]);
  config = withAndroidManifest(config, (mod) => {
    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(
      mod.modResults,
    );
    activity.$["android:supportsPictureInPicture"] = "true";
    const changes = new Set(activity.$["android:configChanges"]?.split("|"));
    for (const change of [
      "screenSize",
      "smallestScreenSize",
      "screenLayout",
      "orientation",
    ])
      changes.add(change);
    activity.$["android:configChanges"] = [...changes].join("|");
    return mod;
  });
  config = withMainActivity(config, (mod) => {
    if (mod.modResults.language !== "kt")
      throw new Error("Boop system calling requires a Kotlin MainActivity.");
    mod.modResults.contents = mergeContents({
      tag: "boop-system-pip",
      src: mod.modResults.contents,
      anchor: /class MainActivity : ReactActivity\(\) \{/,
      offset: 1,
      comment: "//",
      newSrc: `  override fun onPictureInPictureModeChanged(active: Boolean, config: android.content.res.Configuration) {
    super.onPictureInPictureModeChanged(active, config)
    com.oney.WebRTCModule.SystemCallPip.modeChanged(this, active)
  }

  override fun onPictureInPictureUiStateChanged(state: android.app.PictureInPictureUiState) {
    super.onPictureInPictureUiStateChanged(state)
    if (Build.VERSION.SDK_INT >= 35 && state.isTransitioningToPip)
      com.oney.WebRTCModule.SystemCallPip.transitioning(this)
  }
`,
    }).contents;
    return mod;
  });
  return withInfoPlist(config, (mod) => {
    mod.modResults.UIBackgroundModes = [
      ...new Set([...(mod.modResults.UIBackgroundModes ?? []), "audio"]),
    ];
    return mod;
  });
};
