import { maxTimeLockDate } from "./timelock";

const dayMs = 86_400_000;
const minuteMs = 60_000;

export type UnlockSelection = { day: number; hours: number; minutes: number };

// An ordinal for a civil date. Arithmetic on it ignores local clock changes.
export function calendarDay(date: Date) {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / dayMs;
}

export function localCalendarDate(day: number) {
  const utc = new Date(day * dayMs);
  return new Date(
    utc.getUTCFullYear(),
    utc.getUTCMonth(),
    utc.getUTCDate(),
    12,
  );
}

export function defaultUnlockSelection(now: number): UnlockSelection {
  const requested = Math.ceil(now / minuteMs) * minuteMs + 5 * minuteMs;
  const clockAt = (time: number) => {
    const date = new Date(time);
    return {
      day: calendarDay(date),
      hours: date.getHours(),
      minutes: date.getMinutes(),
    };
  };
  const selected = clockAt(requested);
  const firstOccurrence = resolveUnlockSelection(selected, -Infinity);
  return firstOccurrence !== null && firstOccurrence < requested
    ? clockAt(requested + requested - firstOccurrence)
    : selected;
}

export function resolveUnlockSelection(
  { day, hours, minutes }: UnlockSelection,
  now: number,
): number | null {
  if (
    !Number.isInteger(day) ||
    !Number.isInteger(hours) ||
    hours < 0 ||
    hours > 23 ||
    !Number.isInteger(minutes) ||
    minutes < 0 ||
    minutes > 59
  )
    return null;
  const utc = new Date(day * dayMs);
  const local = new Date(
    utc.getUTCFullYear(),
    utc.getUTCMonth(),
    utc.getUTCDate(),
    hours,
    minutes,
  );
  const matches = (date: Date) =>
    calendarDay(date) === day &&
    date.getHours() === hours &&
    date.getMinutes() === minutes;
  // Date rolls nonexistent wall times forward. Reject them so the wheels
  // never show a different time from the one that gets encrypted.
  if (!matches(local)) return null;
  // Use the first occurrence on fall-back days. A selection must never
  // silently move an hour later when its original deadline passes.
  const time = local.getTime();
  return time > now && time <= maxTimeLockDate ? time : null;
}
