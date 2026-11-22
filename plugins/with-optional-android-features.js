const { withAndroidManifest } = require("expo/config-plugins");

module.exports = function withOptionalAndroidFeatures(config) {
  return withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults.manifest;
    const features = (manifest["uses-feature"] ??= []);
    for (const name of [
      "android.hardware.screen.portrait",
      "android.hardware.wifi",
    ]) {
      const feature = features.find(
        (entry) => entry.$["android:name"] === name,
      );
      if (feature) {
        feature.$["android:required"] = "false";
      } else {
        features.push({
          $: { "android:name": name, "android:required": "false" },
        });
      }
    }
    return mod;
  });
};
