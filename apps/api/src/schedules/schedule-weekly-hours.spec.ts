import { describe, expect, it } from "vitest";
import {
  aggregateExistingWeeklyMinutes,
  calendarWeekRange,
} from "./schedule-weekly-hours";

describe("schedule weekly hours", () => {
  it("uses location-local Monday boundaries across spring DST", () => {
    const weeks = calendarWeekRange(
      "2026-03-04T08:00:00.000Z",
      "2026-03-10T07:00:00.000Z",
      "America/Los_Angeles",
    );

    expect(
      weeks.weekStarts.map((week) => ({
        date: week.date,
        start: week.start.toISOString(),
        end: week.end.toISOString(),
        elapsedMinutes: (week.end.getTime() - week.start.getTime()) / 60_000,
      })),
    ).toEqual([
      {
        date: "2026-03-02",
        start: "2026-03-02T08:00:00.000Z",
        end: "2026-03-09T07:00:00.000Z",
        elapsedMinutes: 10_020,
      },
      {
        date: "2026-03-09",
        start: "2026-03-09T07:00:00.000Z",
        end: "2026-03-16T07:00:00.000Z",
        elapsedMinutes: 10_080,
      },
    ]);
  });

  it("splits existing shift minutes at the local calendar-week boundary", () => {
    const weeks = calendarWeekRange(
      "2026-03-04T08:00:00.000Z",
      "2026-03-10T07:00:00.000Z",
      "America/Los_Angeles",
    );

    expect(
      aggregateExistingWeeklyMinutes(
        [
          {
            userId: "u1",
            startTime: "2026-03-09T06:00:00.000Z",
            endTime: "2026-03-09T09:00:00.000Z",
          },
        ],
        weeks,
        ["u1"],
      ),
    ).toEqual({
      u1: {
        "2026-03-02": 60,
        "2026-03-09": 120,
      },
    });
  });
});
