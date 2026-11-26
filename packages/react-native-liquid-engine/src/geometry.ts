import { packMaterial, type GlassMaterial } from "./material";

export const MAX_GLASS_SHAPES = 8;

export type GlassCorners = readonly [
  topLeft: number,
  topRight: number,
  bottomRight: number,
  bottomLeft: number,
];

export interface GlassShape {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number | GlassCorners;
  rotation?: number;
  kind?: "roundedRect" | "ellipse" | "continuous";
  /** Overrides this shape's share of the optical field where shapes meet. */
  material?: Partial<GlassMaterial>;
}

export interface GlassLight {
  x: number;
  y: number;
  intensity?: number;
}

export interface GlassScene {
  shapes: readonly GlassShape[];
  mergeSmoothness?: number;
  light?: GlassLight;
  lights?: readonly GlassLight[];
  material?: GlassMaterial;
}

export function shapeCorners(shape: GlassShape): GlassCorners {
  "worklet";
  const radius =
    shape.kind === "ellipse"
      ? Math.min(shape.width, shape.height) / 2
      : shape.radius;
  return typeof radius === "number" ? [radius, radius, radius, radius] : radius;
}

function hasArea(shape: GlassShape) {
  "worklet";
  return (
    Number.isFinite(shape.x) &&
    Number.isFinite(shape.y) &&
    Number.isFinite(shape.width) &&
    Number.isFinite(shape.height) &&
    shape.width > 0 &&
    shape.height > 0
  );
}

export function packScene(scene: GlassScene): number[] {
  "worklet";
  const lights = scene.lights ?? (scene.light ? [scene.light] : []);
  const first = lights[0] ?? { x: -100, y: -140, intensity: 1 };
  const second = lights[1] ?? { x: 300, y: 200, intensity: 0 };
  const props = [
    scene.mergeSmoothness ?? 0,
    first.x,
    first.y,
    first.intensity ?? 1,
    second.x,
    second.y,
    second.intensity ?? 1,
  ];
  for (let i = 0; i < Math.min(scene.shapes.length, MAX_GLASS_SHAPES); i++) {
    const shape = scene.shapes[i];
    if (!shape || !hasArea(shape)) continue;
    props.push(
      shape.x,
      shape.y,
      shape.width,
      shape.height,
      ...shapeCorners(shape),
      shape.rotation ?? 0,
      shape.kind === "ellipse" ? 1 : shape.kind === "continuous" ? 2 : 0,
    );
  }
  return props;
}

export function packSceneOptics(
  scene: GlassScene,
  fallback: GlassMaterial,
): number[] {
  "worklet";
  const material = scene.material ?? fallback;
  const optics = packMaterial(material);
  const shapes = scene.shapes.slice(0, MAX_GLASS_SHAPES);
  if (shapes.some((shape) => shape?.material)) {
    for (const shape of shapes) {
      if (shape && hasArea(shape))
        optics.push(...packMaterial({ ...material, ...shape.material }));
    }
  }
  return optics;
}

/** The smoothing radius is in points. Two disjoint equal contours join below radius / 2. */
export function smoothUnion(a: number, b: number, radius: number): number {
  "worklet";
  if (radius <= 0) return Math.min(a, b);
  const overlap = Math.max(radius - Math.abs(a - b), 0) / radius;
  return Math.min(a, b) - overlap * overlap * radius * 0.25;
}

/** Velocity is in points per second. Stretch decays to zero when velocity settles. */
export function stretchGlassShape(
  shape: GlassShape,
  velocityX: number,
  velocityY: number,
  elasticity: number,
): GlassShape {
  "worklet";
  const stretchX = Math.min(24, Math.abs(velocityX) * 0.009) * elasticity;
  const stretchY = Math.min(24, Math.abs(velocityY) * 0.009) * elasticity;
  return {
    ...shape,
    x: shape.x - stretchX / 2,
    y: shape.y - stretchY / 2,
    width: shape.width + stretchX,
    height: shape.height + stretchY,
  };
}
