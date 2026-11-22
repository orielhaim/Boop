import { expect, test } from "bun:test";
import { nextTabTravel } from "../src/components/navigation/tab-travel";

test("tab direction follows the physical order, including the optional Calls tab", () => {
  const frame = { to: "index", sign: 1 } as const;
  expect(
    nextTabTravel(
      frame,
      1,
      "calls",
      ["calls", "index", "people", "profile"],
      false,
    ),
  ).toEqual({
    kind: "slide",
    frame: { from: "index", to: "calls", sign: -1 },
    start: 0,
  });
  expect(
    nextTabTravel(
      frame,
      1,
      "calls",
      ["profile", "people", "index", "calls"],
      false,
    ),
  ).toEqual({
    kind: "slide",
    frame: { from: "index", to: "calls", sign: 1 },
    start: 0,
  });
});

test("rapid reversal preserves the positions of the incoming and outgoing tabs", () => {
  expect(
    nextTabTravel(
      { from: "index", to: "profile", sign: 1 },
      0.25,
      "index",
      ["index", "people", "profile"],
      false,
    ),
  ).toEqual({
    kind: "slide",
    frame: { from: "profile", to: "index", sign: -1 },
    start: 0.75,
  });
});

test("a removed Calls tab or reduced motion settles directly to the selected screen", () => {
  const frame = { to: "calls", sign: 1 } as const;
  const expected = {
    kind: "settle",
    frame: { to: "people", sign: 1 },
  } as const;
  expect(
    nextTabTravel(frame, 0.5, "people", ["index", "people", "profile"], false),
  ).toEqual(expected);
  expect(
    nextTabTravel(
      frame,
      0.5,
      "people",
      ["index", "calls", "people", "profile"],
      true,
    ),
  ).toEqual(expected);
});
