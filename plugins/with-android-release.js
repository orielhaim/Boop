const { withAppBuildGradle } = require("expo/config-plugins");
const {
  mergeContents,
} = require("@expo/config-plugins/build/utils/generateCode");

module.exports = function withAndroidRelease(config) {
  return withAppBuildGradle(config, (mod) => {
    mod.modResults.contents = mergeContents({
      tag: "boop-android-release",
      src: mod.modResults.contents,
      anchor: /^\/\/ Apply static values/,
      offset: 0,
      comment: "//",
      newSrc: `def boopUploadStore = providers.environmentVariable('BOOP_ANDROID_UPLOAD_STORE_FILE').orNull
def boopUploadPassword = providers.environmentVariable('BOOP_ANDROID_UPLOAD_STORE_PASSWORD').orNull
def boopUploadAlias = providers.environmentVariable('BOOP_ANDROID_UPLOAD_KEY_ALIAS').orNull
def boopCmakeStaging = providers.gradleProperty('boop.cmakeStagingDir').orNull
def boopCmakeVersion = providers.gradleProperty('boop.cmakeVersion').orNull

if (boopUploadStore || boopUploadPassword || boopUploadAlias) {
    if (!boopUploadStore || !boopUploadPassword || !boopUploadAlias) {
        throw new GradleException('Set all three BOOP_ANDROID_UPLOAD variables for release signing.')
    }
    def boopUploadFile = file(boopUploadStore)
    if (!boopUploadFile.isFile()) {
        throw new GradleException('The Boop upload keystore file is missing.')
    }
    def boopUpload = android.signingConfigs.create('boopUpload') {
        storeType 'PKCS12'
        storeFile boopUploadFile
        storePassword boopUploadPassword
        keyAlias boopUploadAlias
        keyPassword boopUploadPassword
    }
    android.buildTypes.release.signingConfig = boopUpload
}

if (boopCmakeStaging) {
    android.externalNativeBuild.cmake.buildStagingDirectory = file(boopCmakeStaging)
}
if (boopCmakeVersion) {
    android.externalNativeBuild.cmake.version = boopCmakeVersion
}
`,
    }).contents;
    return mod;
  });
};
