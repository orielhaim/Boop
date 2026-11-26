import { expect, test } from "bun:test";
import {
  MAX_GLASS_SHAPES,
  packScene,
  packSceneOptics,
  smoothUnion,
  stretchGlassShape,
} from "../src/geometry";
import {
  glassMaterials,
  interpolateGlassMaterial,
  packMaterial,
  resolveGlassMaterial,
} from "../src/material";

test("smooth union closes a narrow gap and preserves distant contours", () => {
  expect(smoothUnion(2, 2, 16)).toBe(-2);
  expect(smoothUnion(-5, 20, 16)).toBe(-5);
  expect(smoothUnion(2, 2, 0)).toBe(2);
});

test("scene holds bounded shape and light slots in renderer-local units", () => {
  const shape = { x: 10, y: 20, width: 50, height: 30, radius: 15 };
  const packed = packScene({
    shapes: [
      { ...shape, width: 0 },
      { ...shape, radius: [2, 4, 8, 12], kind: "continuous", rotation: 0.5 },
    ],
    mergeSmoothness: 12,
    lights: [
      { x: 3, y: 9, intensity: 0.7 },
      { x: 8, y: 12, intensity: 0.3 },
    ],
  });
  expect(packed).toEqual([
    12, 3, 9, 0.7, 8, 12, 0.3, 10, 20, 50, 30, 2, 4, 8, 12, 0.5, 2,
  ]);
  expect(
    packScene({ shapes: Array.from({ length: 20 }, () => shape) }),
  ).toHaveLength(7 + 10 * MAX_GLASS_SHAPES);
});

test("velocity stretches the shape in local axes while preserving its center", () => {
  const shape = { x: 10, y: 20, width: 50, height: 30, radius: 15 };
  expect(stretchGlassShape(shape, -4000, 0, 1)).toEqual({
    ...shape,
    x: -2,
    width: 74,
  });
  expect(stretchGlassShape(shape, 1000, 1000, 0)).toEqual(shape);
});

test("an opted-in shape adds a material without shifting slots for hidden shapes", () => {
  const plain = { x: 12, y: 10, width: 44, height: 32, radius: 12 };
  const fallback = glassMaterials.clear;
  const tint = glassMaterials.tinted.tint;
  const frame = {
    shapes: [{ ...plain, width: 0 }, { ...plain, material: { tint } }, plain],
  };
  expect(packSceneOptics({ shapes: [plain] }, fallback)).toEqual(
    packMaterial(fallback),
  );
  expect(packSceneOptics(frame, fallback)).toEqual([
    ...packMaterial(fallback),
    ...packMaterial({ ...fallback, tint }),
    ...packMaterial(fallback),
  ]);
});

test("material interpolation blends every packed optical parameter and preserves endpoints", () => {
  const a = glassMaterials.clear;
  const b = resolveGlassMaterial({
    blurRadius: 15,
    tint: [0, 0.5, 0, 0.8],
    opacity: 0.5,
  });
  const expected = packMaterial(a).map(
    (value, i) => (value + packMaterial(b)[i]) / 2,
  );
  for (const [index, parameter] of packMaterial(
    interpolateGlassMaterial(a, b, 0.5),
  ).entries()) {
    expect(parameter).toBeCloseTo(expected[index]);
  }
  expect(interpolateGlassMaterial(a, b, -1)).toEqual(a);
  expect(interpolateGlassMaterial(a, b, 2)).toEqual(b);
});
