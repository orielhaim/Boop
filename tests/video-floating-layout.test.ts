import { expect, test } from "bun:test";
import {
  dragFloatingAnchor,
  floatingVideoLayout,
  videoAspectRatio,
} from "../src/core/video/floating-layout";

const phone = {
  viewport: { width: 390, height: 844 },
  insets: { top: 24, bottom: 20, left: 0, right: 0 },
  keyboard: false,
  background: false,
};

test("portrait playback uses the current display ratio and stays inside the available area", () => {
  const first = floatingVideoLayout({
    ...phone,
    aspectRatio: videoAspectRatio(null, null),
  });
  expect(first.width / first.height).toBeCloseTo(16 / 9);

  const portrait = floatingVideoLayout({
    ...phone,
    aspectRatio: videoAspectRatio({ width: 1080, height: 1920 }, "1920x1080"),
  });
  expect(portrait.width / portrait.height).toBeCloseTo(9 / 16);
  expect(portrait.width).toBeLessThan(first.width);
  expect(portrait.left + portrait.travelX + portrait.width).toBe(
    phone.viewport.width - 12,
  );
  expect(portrait.top + portrait.travelY + portrait.height).toBeLessThan(
    phone.viewport.height - phone.insets.bottom,
  );
  expect(videoAspectRatio({ width: 0, height: 0 }, "1080x1920")).toBe(9 / 16);
});

test("dragging keeps the drop position through keyboard and viewport changes", () => {
  const input = { ...phone, aspectRatio: 9 / 16 };
  const { travelX, travelY } = floatingVideoLayout(input);
  const x = dragFloatingAnchor(1, -travelX / 4, travelX);
  const y = dragFloatingAnchor(1, -travelY / 2, travelY);
  expect([x, y]).toEqual([0.75, 0.5]);
  expect(dragFloatingAnchor(x, 10_000, travelX)).toBe(1);
  expect(dragFloatingAnchor(y, -10_000, travelY)).toBe(0);

  const keyboard = floatingVideoLayout({ ...input, keyboard: true });
  expect(keyboard.travelY).toBe(0);
  expect(dragFloatingAnchor(y, -120, keyboard.travelY)).toBe(0.5);

  const landscape = floatingVideoLayout({
    ...input,
    viewport: { width: 844, height: 390 },
    insets: { left: 24, top: 0, right: 24, bottom: 20 },
  });
  expect(landscape.width / landscape.height).toBeCloseTo(9 / 16);
  expect(landscape.left + landscape.travelX * x + landscape.width).toBeLessThan(
    820,
  );
  expect(landscape.top + landscape.travelY * y + landscape.height).toBeLessThan(
    370,
  );
});
