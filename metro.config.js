const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Keep generated native projects, local exports and the website out of Metro.
const unusedTrees = [
  ".expo/marmot-relay-fixture",
  ".expo/marmotkit",
  "android",
  "dist",
  "ios",
  "modules/boop-marmot/sdk",
  "web-build",
  "website",
];

config.resolver.blockList = [
  ...config.resolver.blockList,
  /(?:^|[\\/])(?:modules|node_modules)[\\/](?:@[^\\/]+[\\/])?[^\\/]+[\\/]android[\\/](?:build|\.cxx|\.gradle)(?:[\\/]|$)/,
  ...unusedTrees.map((directory) => {
    const absolutePath = path
      .resolve(__dirname, directory)
      .split(path.sep)
      .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("[\\\\/]");
    return new RegExp(`^${absolutePath}(?:[\\\\/]|$)`);
  }),
];

module.exports = config;
