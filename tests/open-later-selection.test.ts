import { expect, test } from "bun:test";
import {
  calendarDay,
  defaultUnlockSelection,
  localCalendarDate,
  resolveUnlockSelection,
} from "../src/core/messaging/special-messages/unlock-selection";
import { scheduleUnlock } from "../src/core/messaging/special-messages/timelock";

test("the date column follows local calendar days over year boundaries and leap days", () => {
  const yearEnd = new Date(2027, 11, 31, 23, 58, 47);
  const selection = defaultUnlockSelection(yearEnd.getTime());
  expect(selection).toEqual({
    day: calendarDay(new Date(2028, 0, 1)),
    hours: 0,
    minutes: 4,
  });
  const requested = resolveUnlockSelection(selection, yearEnd.getTime());
  expect(requested).toBe(new Date(2028, 0, 1, 0, 4).getTime());
  expect(resolveUnlockSelection(selection, requested ?? 0)).toBeNull();
  const leap = calendarDay(new Date(2028, 1, 29, 12));
  expect(localCalendarDate(leap + 1).getMonth()).toBe(2);
  expect(localCalendarDate(leap - 1).getDate()).toBe(28);
  expect(scheduleUnlock(requested ?? 0).roundTime).toBeGreaterThanOrEqual(
    requested ?? 0,
  );
});

test("rejects spring-forward gaps and never moves a fall-back deadline silently", () => {
  const previousZone = process.env.TZ;
  try {
    process.env.TZ = "America/New_York";
    const spring = {
      day: calendarDay(new Date(2027, 2, 14, 12)),
      hours: 2,
      minutes: 30,
    };
    expect(
      resolveUnlockSelection(spring, Date.parse("2027-03-14T05:00Z")),
    ).toBeNull();
    const fall = {
      day: calendarDay(new Date(2027, 10, 7, 12)),
      hours: 1,
      minutes: 30,
    };
    const early = Date.parse("2027-11-07T05:30Z");
    expect(resolveUnlockSelection(fall, early - 1)).toBe(early);
    expect(resolveUnlockSelection(fall, early)).toBeNull();
    const repeatedHour = Date.parse("2027-11-07T06:30Z");
    expect(
      resolveUnlockSelection(
        defaultUnlockSelection(repeatedHour),
        repeatedHour,
      ),
    ).toBe(Date.parse("2027-11-07T07:35Z"));

    process.env.TZ = "Europe/London";
    expect(resolveUnlockSelection(fall, Date.parse("2027-11-07T00:00Z"))).toBe(
      Date.parse("2027-11-07T01:30Z"),
    );
  } finally {
    if (previousZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousZone;
  }
});
