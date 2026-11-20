const { copyFile, mkdir, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const {
  IOSConfig,
  withDangerousMod,
  withXcodeProject,
} = require("expo/config-plugins");

const ringback = "incallmanager_ringback.mp3";
const ringtone = "incallmanager_ringtone.mp3";

async function copyTones({ projectRoot }, destination, files) {
  await mkdir(destination, { recursive: true });
  await Promise.all(
    files.map((file) =>
      copyFile(
        join(projectRoot, "assets", "audio", file),
        join(destination, file),
      ),
    ),
  );
}

module.exports = function withCallTones(config) {
  config = withDangerousMod(config, [
    "android",
    async (mod) => {
      const raw = join(
        mod.modRequest.platformProjectRoot,
        "app",
        "src",
        "main",
        "res",
        "raw",
      );
      await copyTones(
        mod.modRequest,
        raw,
        [ringback], // Android resolves the incoming ringtone from system settings.
      );
      await writeFile(
        join(raw, "boop_keep.xml"),
        '<resources xmlns:tools="http://schemas.android.com/tools" tools:keep="@raw/incallmanager_ringback" />\n',
      );
      return mod;
    },
  ]);
  return withXcodeProject(config, async (mod) => {
    const group = IOSConfig.XcodeUtils.getProjectName(
      mod.modRequest.projectRoot,
    );
    const files = [ringback, ringtone];
    await copyTones(
      mod.modRequest,
      IOSConfig.Paths.getSourceRoot(mod.modRequest.projectRoot),
      files,
    );
    for (const file of files) {
      IOSConfig.XcodeUtils.addResourceFileToGroup({
        filepath: `${group}/${file}`,
        groupName: group,
        isBuildFile: true,
        project: mod.modResults,
      });
    }
    return mod;
  });
};
