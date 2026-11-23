import { Easing } from "react-native-reanimated";
import { M3_LOADING_SEQUENCE, STEPS_PER_SEGMENT, VIEWBOX } from "./const";
import { Morph } from "./morph";
import { getShape } from "./shape-registry";
import { toPathD } from "./svg-path";

let frames: string[] | undefined;

export function getMorphFrames() {
  if (frames) return frames;
  const ease = Easing.bezier(0.2, 0, 0, 1).factory();
  frames = M3_LOADING_SEQUENCE.flatMap((shape, index) => {
    const next = M3_LOADING_SEQUENCE[(index + 1) % M3_LOADING_SEQUENCE.length];
    const morph = new Morph(getShape(shape), getShape(next));
    return Array.from({ length: STEPS_PER_SEGMENT }, (_, step) =>
      toPathD(morph.asCubics(ease(step / STEPS_PER_SEGMENT)), VIEWBOX),
    );
  });
  return frames;
}
