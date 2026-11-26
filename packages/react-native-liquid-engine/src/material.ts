export type GlassColor = readonly [
  red: number,
  green: number,
  blue: number,
  alpha: number,
];

export interface GlassMaterial {
  /** Lengths are in layout points. Color channels are straight alpha, from 0 to 1. */
  blurRadius: number;
  refractionStrength: number;
  refractionDepth: number;
  thickness: number;
  chromaticAberration: number;
  magnification: number;
  saturation: number;
  contrast: number;
  brightness: number;
  vibrancy: number;
  tint: GlassColor;
  fresnelStrength: number;
  specularIntensity: number;
  highlightWidth: number;
  ambientLight: number;
  innerShadow: number;
  outerShadow: number;
  grain: number;
  opacity: number;
}

const clear: GlassMaterial = {
  blurRadius: 2,
  refractionStrength: 1,
  refractionDepth: 14,
  thickness: 6,
  chromaticAberration: 0.12,
  magnification: 0.05,
  saturation: 1.12,
  contrast: 1,
  brightness: 1,
  vibrancy: 0,
  tint: [1, 1, 1, 0.09],
  fresnelStrength: 0.4,
  specularIntensity: 0.35,
  highlightWidth: 1.2,
  ambientLight: 0.03,
  innerShadow: 0.2,
  outerShadow: 0.18,
  grain: 0,
  opacity: 1,
};

export const glassMaterials = {
  clear,
  regular: { ...clear, blurRadius: 6, tint: [1, 1, 1, 0.22] },
  frosted: { ...clear, blurRadius: 14, tint: [1, 1, 1, 0.35], grain: 0.018 },
  thick: {
    ...clear,
    thickness: 12,
    refractionDepth: 22,
    chromaticAberration: 0.22,
  },
  tinted: { ...clear, blurRadius: 6, tint: [0.22, 0.39, 0.82, 0.38] },
  lens: {
    ...clear,
    blurRadius: 0,
    thickness: 10,
    magnification: 0.22,
    tint: [1, 1, 1, 0.04],
  },
  liquid: {
    ...clear,
    thickness: 9,
    refractionDepth: 18,
    specularIntensity: 0.5,
  },
  opaque: {
    ...clear,
    refractionStrength: 0,
    blurRadius: 0,
    tint: [0.16, 0.17, 0.2, 1],
  },
} satisfies Record<string, GlassMaterial>;

export type GlassPreset = keyof typeof glassMaterials;
export type GlassMaterialInput = GlassPreset | Partial<GlassMaterial>;

export function resolveGlassMaterial(
  input: GlassMaterialInput = "regular",
): GlassMaterial {
  return typeof input === "string"
    ? glassMaterials[input]
    : { ...glassMaterials.regular, ...input };
}

export function interpolateGlassMaterial(
  a: GlassMaterial,
  b: GlassMaterial,
  progress: number,
): GlassMaterial {
  "worklet";
  const t = Math.min(1, Math.max(0, progress));
  const mix = (from: number, to: number) => from + (to - from) * t;
  return {
    blurRadius: mix(a.blurRadius, b.blurRadius),
    refractionStrength: mix(a.refractionStrength, b.refractionStrength),
    refractionDepth: mix(a.refractionDepth, b.refractionDepth),
    thickness: mix(a.thickness, b.thickness),
    chromaticAberration: mix(a.chromaticAberration, b.chromaticAberration),
    magnification: mix(a.magnification, b.magnification),
    saturation: mix(a.saturation, b.saturation),
    contrast: mix(a.contrast, b.contrast),
    brightness: mix(a.brightness, b.brightness),
    vibrancy: mix(a.vibrancy, b.vibrancy),
    tint: [
      mix(a.tint[0], b.tint[0]),
      mix(a.tint[1], b.tint[1]),
      mix(a.tint[2], b.tint[2]),
      mix(a.tint[3], b.tint[3]),
    ],
    fresnelStrength: mix(a.fresnelStrength, b.fresnelStrength),
    specularIntensity: mix(a.specularIntensity, b.specularIntensity),
    highlightWidth: mix(a.highlightWidth, b.highlightWidth),
    ambientLight: mix(a.ambientLight, b.ambientLight),
    innerShadow: mix(a.innerShadow, b.innerShadow),
    outerShadow: mix(a.outerShadow, b.outerShadow),
    grain: mix(a.grain, b.grain),
    opacity: mix(a.opacity, b.opacity),
  };
}

export function packMaterial(material: GlassMaterial): number[] {
  "worklet";
  return [
    material.blurRadius,
    material.refractionStrength,
    material.refractionDepth,
    material.thickness,
    material.chromaticAberration,
    material.magnification,
    material.saturation,
    material.contrast,
    material.brightness,
    material.vibrancy,
    material.fresnelStrength,
    material.specularIntensity,
    material.highlightWidth,
    material.ambientLight,
    material.innerShadow,
    material.outerShadow,
    material.grain,
    material.opacity,
    ...material.tint,
  ];
}
