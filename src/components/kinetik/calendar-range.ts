export type DateRange =
  { start: null; end: null } | { start: Date; end: Date | null };

export const emptyDateRange: DateRange = { start: null, end: null };

export const dayKey = (day: Date) =>
  day.getFullYear() * 10000 + day.getMonth() * 100 + day.getDate();

export function selectCalendarDay(range: DateRange, day: Date): DateRange {
  const { start, end } = range;
  if (!start) return { start: day, end: null };

  const key = dayKey(day);
  const first = dayKey(start);
  if (key === first) return end ? { start: end, end: null } : emptyDateRange;
  if (end) {
    if (key === dayKey(end)) return { start, end: null };
    return { start: day, end: null };
  }

  return key < first ? { start: day, end: start } : { start, end: day };
}
