const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Keep native build caches and the separate website out of the mobile file map.
const unusedTrees = [
  ".expo/marmot-relay-fixture",
  ".expo/marmotkit",
  "dist",
  "modules/boop-marmot/sdk",
  "website",
];

config.resolver.blockList = [
  ...config.resolver.blockList,
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
