const { expect, test } = require("bun:test");
const { transformFileSync } = require("@babel/core");
const { resolve } = require("node:path");

const source = resolve(__dirname, "../packages/react-native-liquid-engine/src");
const caller = { name: "metro", platform: "android", isDev: true };

function loadEngineFile(name, loadDependency = require) {
  const { code } = transformFileSync(resolve(source, name), { caller });
  const exports = {};
  new Function("require", "exports", code)(loadDependency, exports);
  return exports;
}

test("the Expo worklet transform preserves geometry helpers on the first render", () => {
  const materials = loadEngineFile("material.ts");
  const { packScene, packSceneOptics } = loadEngineFile(
    "geometry.ts",
    (name) => (name === "./material" ? materials : require(name)),
  );
  const frame = {
    shapes: [
      {
        x: 4,
        y: 8,
        width: 48,
        height: 24,
        radius: 12,
        material: { blurRadius: 5 },
      },
    ],
  };
  expect(packScene(frame).slice(7)).toEqual([
    4, 8, 48, 24, 12, 12, 12, 12, 0, 0,
  ]);
  expect(packSceneOptics(frame, materials.glassMaterials.clear)[22]).toBe(5);
});

test("Android glass recovers when Expo registers the native module after startup", () => {
  let nativeModule = null;
  const registeredViews = [];
  const dependencies = {
    expo: {
      requireOptionalNativeModule: () => nativeModule,
      requireNativeView: (_module, view) => {
        registeredViews.push(view);
        return () => null;
      },
    },
    "expo-glass-effect": {},
    "react-native": {
      Platform: { OS: "android" },
      StyleSheet: { create: (styles) => styles },
    },
    "react-native-reanimated": {
      createAnimatedComponent: (component) => component,
    },
    "react-native-worklets": {},
    "./geometry": {},
    "./material": {},
  };
  const { getGlassCapabilities } = loadEngineFile(
    "components.tsx",
    (name) => dependencies[name] ?? require(name),
  );

  expect(getGlassCapabilities().backend).toBe("opaque");
  expect(registeredViews).toEqual([]);
  nativeModule = { supportsRecordedBackdrop: true };
  expect(getGlassCapabilities().backend).toBe("android-render-node");
  expect(getGlassCapabilities().backend).toBe("android-render-node");
  expect(registeredViews).toEqual(["GlassBackdropView", "GlassOpticsView"]);
});
