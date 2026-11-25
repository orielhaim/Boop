const {
  withAppBuildGradle,
  withMainActivity,
  withMainApplication,
  withSettingsGradle,
  withStringsXml,
} = require("expo/config-plugins");
const {
  mergeContents,
} = require("@expo/config-plugins/build/utils/generateCode");

function insert(mod, tag, anchor, newSrc) {
  mod.modResults.contents = mergeContents({
    tag,
    src: mod.modResults.contents,
    anchor,
    newSrc,
    offset: 1,
    comment: "//",
  }).contents;
  return mod;
}

module.exports = function withPluginDelivery(config) {
  config = withSettingsGradle(config, (mod) =>
    insert(
      mod,
      "boop-plugin-projects",
      /^include ':app'/,
      "include ':torrents'\nproject(':torrents').projectDir = new File(rootDir, '../extensions/torrents/android')",
    ),
  );
  config = withAppBuildGradle(config, (mod) =>
    insert(
      mod,
      "boop-dynamic-features",
      /^android \{/,
      "    dynamicFeatures = [':torrents']",
    ),
  );
  config = withMainApplication(config, (mod) =>
    insert(
      mod,
      "boop-split-compat-app",
      /^class MainApplication /,
      `  override fun attachBaseContext(base: android.content.Context) {
    super.attachBaseContext(base)
    com.google.android.play.core.splitcompat.SplitCompat.install(this)
  }`,
    ),
  );
  config = withMainActivity(config, (mod) =>
    insert(
      mod,
      "boop-split-compat-activity",
      /^class MainActivity /,
      `  override fun attachBaseContext(base: android.content.Context) {
    super.attachBaseContext(base)
    com.google.android.play.core.splitcompat.SplitCompat.installActivity(this)
  }`,
    ),
  );
  return withStringsXml(config, (mod) => {
    const strings = (mod.modResults.resources.string ??= []);
    if (!strings.some((entry) => entry.$.name === "boop_feature_torrents")) {
      strings.push({
        $: { name: "boop_feature_torrents", translatable: "false" },
        _: "Torrents",
      });
    }
    return mod;
  });
};
