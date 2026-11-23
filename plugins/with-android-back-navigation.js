const { withMainActivity } = require("expo/config-plugins");

module.exports = function withAndroidBackNavigation(config) {
  return withMainActivity(config, (mod) => {
    // Expo's template overrides back navigation for Android 11 and earlier.
    mod.modResults.contents = mod.modResults.contents.replace(
      /\r?\n  \/\*\*\r?\n +\* Align the back button behavior with Android S\b[\s\S]*?\r?\n  override fun invokeDefaultOnBackPressed\(\) \{[\s\S]*?\r?\n  \}\r?\n/,
      "\n",
    );
    return mod;
  });
};
