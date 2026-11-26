// Proportions follow the MIT-licensed Expandable Bottom Tabs reference.
export const EXPANDED_HEIGHT = 62;
export const MINIMIZED_HEIGHT = 46;
export const DOCK_GAP = 10;
export const SCREEN_INSET = 16;
export const STRIP_INSET = 4;
export const AVATAR_SIZE = 46;
export const AVATAR_INSET = (EXPANDED_HEIGHT - AVATAR_SIZE) / 2;
export const MAX_DOCK_WIDTH = 560;
export const MORPH_SPRING = { damping: 20, mass: 0.9, stiffness: 260 };

export function dockLensIntensity(
  position: number,
  target: number,
  pressure: number,
) {
  "worklet";
  const distance = Math.abs(position - target);
  const surface = Math.min(1, Math.max(pressure, distance * 2));
  return { surface, content: Math.min(surface, 0.28 + distance * 1.4) };
}

export function resolveDockFrame(
  width: number,
  expanded: number,
  minimized: number,
  rtl: boolean,
) {
  "worklet";
  const focus = Math.min(Math.max(expanded, 0), 1);
  const scroll = Math.min(Math.max(minimized, 0), 1) * (1 - focus);
  const progress = Math.max(focus, scroll);
  const height =
    EXPANDED_HEIGHT - (EXPANDED_HEIGHT - MINIMIZED_HEIGHT) * scroll;
  const top = (EXPANDED_HEIGHT - height) / 2;
  const collapsedStrip = Math.max(0, width - EXPANDED_HEIGHT - DOCK_GAP);
  const navWidth =
    collapsedStrip +
    (Math.min(EXPANDED_HEIGHT, collapsedStrip) - collapsedStrip) * progress;
  const profileWidth = Math.max(
    0,
    EXPANDED_HEIGHT +
      (collapsedStrip - EXPANDED_HEIGHT) * focus -
      (EXPANDED_HEIGHT - MINIMIZED_HEIGHT) * scroll,
  );
  const profileStart = width - profileWidth;
  const nav = {
    x: rtl ? width - navWidth : 0,
    y: top,
    width: navWidth,
    height,
    radius: height / 2,
  };
  const profile = {
    x: rtl ? 0 : profileStart,
    y: top,
    width: profileWidth,
    height,
    radius: height / 2,
  };
  return { nav, profile, focus, progress, scroll };
}
