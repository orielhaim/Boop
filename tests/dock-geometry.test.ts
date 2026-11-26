import { expect, test } from "bun:test";
import {
  dockLensIntensity,
  resolveDockFrame,
} from "../src/components/navigation/dock-geometry";

test("the lens fades into its spring target without waiting for navigation", () => {
  expect(dockLensIntensity(1.5, 2, 0)).toEqual({ surface: 1, content: 0.98 });
  expect(dockLensIntensity(1.875, 2, 0)).toEqual({
    surface: 0.25,
    content: 0.25,
  });
  expect(dockLensIntensity(2, 2, 0)).toEqual({ surface: 0, content: 0 });
  expect(dockLensIntensity(2, 2, 0.5)).toEqual({ surface: 0.5, content: 0.28 });
});

test("the profile expands in the same 62 point row and the gap stays constant", () => {
  for (const [focus, navWidth, profileWidth] of [
    [0, 288, 62],
    [0.5, 175, 175],
    [1, 62, 288],
  ]) {
    const { nav, profile } = resolveDockFrame(360, focus, 0, false);
    expect(nav).toEqual({
      x: 0,
      y: 0,
      width: navWidth,
      height: 62,
      radius: 31,
    });
    expect(profile).toEqual({
      x: navWidth + 10,
      y: 0,
      width: profileWidth,
      height: 62,
      radius: 31,
    });
  }
});

test("right-to-left mirrors both segments without moving the row vertically", () => {
  const { nav, profile } = resolveDockFrame(360, 1, 0, true);
  expect(nav.x).toBe(298);
  expect(profile.x).toBe(0);
  expect(profile.width).toBe(288);
  expect(nav.y).toBe(profile.y);
});

test("scroll minimization releases its height when the account opens", () => {
  const scrolled = resolveDockFrame(360, 0, 1, false);
  const opened = resolveDockFrame(360, 1, 1, false);
  expect(scrolled.nav.height).toBe(46);
  expect(opened.nav.height).toBe(62);
  expect(opened).toEqual(resolveDockFrame(360, 1, 0, false));
});
