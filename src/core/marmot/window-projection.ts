import { z } from "zod";

export const windowRevision = z.object({
  generation: z.string(),
  sequence: z.string().regex(/^\d{1,20}$/),
  hasMoreBefore: z.boolean(),
  hasMoreAfter: z.boolean(),
});
export const windowDelta = z.object({
  base: windowRevision.shape.sequence,
  field: z.enum(["rows", "messages"]),
  metadata: windowRevision.loose(),
  order: z.array(z.string()).max(200),
  changed: z.array(z.unknown()).max(200),
});
export type WindowDelta = z.output<typeof windowDelta>;
export function mergeRows<T extends { id: string }>(
  current: readonly T[],
  delta: WindowDelta,
  row: z.ZodType<T>,
): T[] {
  const entries = new Map(current.map((item) => [item.id, item]));
  for (const item of delta.changed) {
    const parsed = row.parse(item);
    entries.set(parsed.id, parsed);
  }
  const seen = new Set<string>();
  return delta.order.map((id) => {
    const entry = entries.get(id);
    if (!entry || seen.has(id)) throw new Error("InvalidWindowProjection");
    seen.add(id);
    return entry;
  });
}
