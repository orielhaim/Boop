const { expect, test } = require("bun:test");
const { transformFileSync } = require("@babel/core");
const { resolve } = require("node:path");

const source = resolve(__dirname, "../packages/react-native-liquid-engine/src");
const caller = { name: "metro", platform: "android", isDev: true };

function loadWorklets(name, loadDependency = require) {
  const { code } = transformFileSync(resolve(source, name + ".ts"), { caller });
  const exports = {};
  new Function("require", "exports", code)(loadDependency, exports);
  return exports;
}

test("the Expo worklet transform preserves geometry helpers on the first render", () => {
  const materials = loadWorklets("material");
  const { packScene, packSceneOptics } = loadWorklets("geometry", (name) =>
    name === "./material" ? materials : require(name),
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
