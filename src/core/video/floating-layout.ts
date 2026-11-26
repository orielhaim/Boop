type Size = { width: number; height: number };
type Insets = { left: number; right: number; top: number; bottom: number };

export function videoAspectRatio(
  track: Size | null | undefined,
  dimensions: string | null | undefined,
) {
  const ratio = (width: number, height: number) =>
    Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
      ? width / height
      : undefined;
  const hint = dimensions?.match(/^(\d+)x(\d+)$/u);
  return (
    (track && ratio(track.width, track.height)) ??
    (hint && ratio(Number(hint[1]), Number(hint[2]))) ??
    16 / 9
  );
}

export function floatingVideoLayout({
  viewport,
  insets,
  aspectRatio,
  keyboard,
  background,
}: {
  viewport: Size;
  insets: Insets;
  aspectRatio: number;
  keyboard: boolean;
  background: boolean;
}) {
  const left = insets.left + 12;
  const top = insets.top + 14;
  const maxRight = viewport.width - insets.right - 12;
  const maxBottom = viewport.height - insets.bottom - 88;
  const availableWidth = Math.max(1, maxRight - left);
  const availableHeight = Math.max(1, maxBottom - top);
  const width = background
    ? Math.min(310, availableWidth)
    : Math.min(260, viewport.width * 0.62, availableWidth);
  const height = background
    ? Math.min(72, availableHeight)
    : Math.min(238, viewport.height * 0.43, availableHeight);
  const fittedWidth = background
    ? width
    : Math.min(width, height * aspectRatio);
  const fittedHeight = background ? height : fittedWidth / aspectRatio;
  return {
    width: fittedWidth,
    height: fittedHeight,
    left,
    top,
    travelX: Math.max(0, maxRight - left - fittedWidth),
    travelY: keyboard ? 0 : Math.max(0, maxBottom - top - fittedHeight),
  };
}

export function dragFloatingAnchor(
  anchor: number,
  delta: number,
  travel: number,
) {
  "worklet";
  return travel > 0
    ? Math.min(1, Math.max(0, anchor + delta / travel))
    : anchor;
}
