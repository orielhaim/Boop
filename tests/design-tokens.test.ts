import { describe, expect, test } from "bun:test";
import { avatarGradients, themes } from "@/theme/tokens";

function luminance(color: string) {
  const channel = (start: number) => {
    const srgb = Number.parseInt(color.slice(start, start + 2), 16) / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(ink: string, surface: string) {
  const a = luminance(ink);
  const b = luminance(surface);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe("design theme contrast", () => {
  test("avatar initials remain readable across all identity gradients", () => {
    for (const gradient of avatarGradients) {
      for (const stop of gradient) {
        expect(
          contrast(themes.light.colors.onMedia, stop),
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  for (const theme of Object.values(themes)) {
    test(`${theme.name} back glyph remains visible over light and dark backdrops`, () => {
      const [red, green, blue, alpha] = theme.glass.lens.frost
        .slice(5, -1)
        .split(",")
        .map(Number);
      for (const backdrop of [0, 255]) {
        const fill = [red, green, blue]
          .map((channel) =>
            Math.round(channel * alpha + backdrop * (1 - alpha))
              .toString(16)
              .padStart(2, "0"),
          )
          .join("");
        expect(contrast(theme.colors.text, `#${fill}`)).toBeGreaterThanOrEqual(
          3,
        );
      }
    });

    test(`${theme.name} text remains readable across matte surfaces`, () => {
      const { colors } = theme;
      for (const surface of [
        colors.background,
        colors.grouped,
        colors.raised,
        colors.recessed,
        colors.overlay,
        colors.selected,
      ]) {
        for (const ink of [
          colors.text,
          colors.muted,
          colors.accent,
          colors.danger,
        ]) {
          expect(contrast(ink, surface)).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(contrast(colors.onAccent, colors.accent)).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(contrast(colors.onDanger, colors.danger)).toBeGreaterThanOrEqual(
        4.5,
      );
    });

    test(`${theme.name} outgoing message text meets contrast throughout its gradient`, () => {
      for (const stop of theme.conversation.outgoing) {
        expect(contrast(theme.colors.outgoingInk, stop)).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    });
  }
});
